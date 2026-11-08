import type { WebSocket } from "ws"
import { z } from "zod"
import { heavy } from "../../base/heavy-packages.js"
import type { SimulatorKey, SimulatorOrientation, SimulatorPoint } from "../../contracts/simulators.js"
import { ORIENTATION_NAMES } from "./simctl.js"

/*
 * serve-sim's input socket (`/helper/ws?device=<udid>`), as its 0.1.48 bundle reads it: each message is one byte, the
 * kind, then JSON. Touches are fractions of the raw framebuffer, which stays portrait whatever the device shows; the
 * helper scales them by its own size. It says the screen's size and orientation (0x82) when a socket joins and each
 * time they change.
 */
const TOUCH = 0x03
const BUTTON = 0x04
const MULTI_TOUCH = 0x05
const KEY = 0x06
const ORIENTATION = 0x07
export const SCREEN_CONFIG = 0x82
/** `ws`'s ready state for an open socket. */
const OPEN = 1

export type TouchPhase = "begin" | "move" | "end"

/** A point as a fraction of the raw portrait framebuffer, what serve-sim's touches take. */
export interface RawPoint {
  x: number
  y: number
}

export const ScreenConfigSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  orientation: z.enum(["portrait", "portrait_upside_down", "landscape_left", "landscape_right"]),
})
export type ScreenConfig = z.infer<typeof ScreenConfigSchema>

function tagged(kind: number, payload: { [field: string]: string | number }): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload))
  const bytes = new Uint8Array(1 + json.byteLength)
  bytes[0] = kind
  bytes.set(json, 1)
  return bytes
}

export function touchMessage(phase: TouchPhase, at: RawPoint): Uint8Array {
  return tagged(TOUCH, { type: phase, x: at.x, y: at.y })
}

export function pinchMessage(phase: TouchPhase, first: RawPoint, second: RawPoint): Uint8Array {
  return tagged(MULTI_TOUCH, { type: phase, x1: first.x, y1: first.y, x2: second.x, y2: second.y })
}

export function buttonMessage(button: "home" | "lock" | "app_switcher"): Uint8Array {
  return tagged(BUTTON, { button })
}

export function keyMessage(phase: "down" | "up", usage: number): Uint8Array {
  return tagged(KEY, { type: phase, usage })
}

export function orientationMessage(orientation: SimulatorOrientation): Uint8Array {
  return tagged(ORIENTATION, { orientation: ORIENTATION_NAMES[orientation] })
}

/** The screen's config from a message the helper sent, or undefined for any other. */
export function readScreenConfig(bytes: Uint8Array): ScreenConfig | undefined {
  if (bytes[0] !== SCREEN_CONFIG) return undefined
  try {
    return ScreenConfigSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes.subarray(1)))).data
  } catch {
    return undefined
  }
}

/**
 * Where a point the device shows now (in points, rotation included) lands on the raw framebuffer. A screen that
 * already reports itself wider than tall is drawn rotated by the helper, so its points are raw as they are.
 */
export function rawPoint(at: SimulatorPoint, shown: { width: number; height: number }, config: ScreenConfig | undefined): RawPoint {
  const x = clamp(at.x / shown.width)
  const y = clamp(at.y / shown.height)
  if (!config || config.width > config.height) return { x, y }
  switch (config.orientation) {
    case "landscape_left":
      return { x: y, y: 1 - x }
    case "landscape_right":
      return { x: 1 - y, y: x }
    case "portrait_upside_down":
      return { x: 1 - x, y: 1 - y }
    default:
      return { x, y }
  }
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** One message of a gesture, `afterMs` from its start. */
export interface Planned {
  afterMs: number
  message: Uint8Array
}

/** How often a finger's moves are sent: the display's 60 Hz, so iOS reads its velocity as a real finger's. */
const FRAME_MS = 1000 / 60
/** A tap's finger stays down this long; quicker reads as a stray touch to some controls. */
const TAP_MS = 60

export function tapPlan(at: RawPoint): Planned[] {
  return [
    { afterMs: 0, message: touchMessage("begin", at) },
    { afterMs: TAP_MS, message: touchMessage("end", at) },
  ]
}

/**
 * A finger down at `from`, moved at an even speed to `to` over `ms`, then lifted where it stopped. iOS takes the
 * speed of its last moves into a fling, as it does a finger's.
 */
export function swipePlan(from: RawPoint, to: RawPoint, ms: number): Planned[] {
  const steps = Math.max(2, Math.round(ms / FRAME_MS))
  const plan: Planned[] = [{ afterMs: 0, message: touchMessage("begin", from) }]
  for (let step = 1; step <= steps; step++) {
    const along = step / steps
    plan.push({ afterMs: Math.round(along * ms), message: touchMessage("move", { x: from.x + (to.x - from.x) * along, y: from.y + (to.y - from.y) * along }) })
  }
  plan.push({ afterMs: Math.round(ms), message: touchMessage("end", to) })
  return plan
}

/** Two fingers about `at`, `spread` apart at the start and `spread * scale` at the end. */
export function pinchPlan(at: RawPoint, scale: number, ms: number, spread = 0.15): Planned[] {
  const fingers = (gap: number): [RawPoint, RawPoint] => [
    { x: clamp(at.x - gap / 2), y: at.y },
    { x: clamp(at.x + gap / 2), y: at.y },
  ]
  const steps = Math.max(2, Math.round(ms / FRAME_MS))
  const plan: Planned[] = [{ afterMs: 0, message: pinchMessage("begin", ...fingers(spread)) }]
  for (let step = 1; step <= steps; step++) plan.push({ afterMs: Math.round((step / steps) * ms), message: pinchMessage("move", ...fingers(spread * (1 + (scale - 1) * (step / steps)))) })
  plan.push({ afterMs: Math.round(ms), message: pinchMessage("end", ...fingers(spread * scale)) })
  return plan
}

/** USB HID usages (keyboard page) for the keys an agent names. */
const NAMED_USAGES = {
  return: 0x28,
  escape: 0x29,
  backspace: 0x2a,
  tab: 0x2b,
  space: 0x2c,
  right: 0x4f,
  left: 0x50,
  down: 0x51,
  up: 0x52,
} satisfies Record<SimulatorKey, number>
const SHIFT = 0xe1

/** On a US keyboard, the usage of each printable ASCII character, and whether Shift is held for it. */
const PRINTABLE: ReadonlyMap<string, { usage: number; shift: boolean }> = (() => {
  const keys = new Map<string, { usage: number; shift: boolean }>()
  for (let index = 0; index < 26; index++) {
    keys.set(String.fromCharCode(97 + index), { usage: 0x04 + index, shift: false })
    keys.set(String.fromCharCode(65 + index), { usage: 0x04 + index, shift: true })
  }
  const rows: Array<[string, string, number]> = [
    ["1", "!", 0x1e], ["2", "@", 0x1f], ["3", "#", 0x20], ["4", "$", 0x21], ["5", "%", 0x22], ["6", "^", 0x23], ["7", "&", 0x24], ["8", "*", 0x25], ["9", "(", 0x26], ["0", ")", 0x27],
    ["-", "_", 0x2d], ["=", "+", 0x2e], ["[", "{", 0x2f], ["]", "}", 0x30], ["\\", "|", 0x31], [";", ":", 0x33], ["'", "\"", 0x34], ["`", "~", 0x35], [",", "<", 0x36], [".", ">", 0x37], ["/", "?", 0x38],
  ]
  for (const [plain, shifted, usage] of rows) {
    keys.set(plain, { usage, shift: false })
    keys.set(shifted, { usage, shift: true })
  }
  keys.set(" ", { usage: 0x2c, shift: false })
  keys.set("\n", { usage: 0x28, shift: false })
  keys.set("\t", { usage: 0x2b, shift: false })
  return keys
})()

export function keyPlan(key: SimulatorKey): Planned[] {
  return [
    { afterMs: 0, message: keyMessage("down", NAMED_USAGES[key]) },
    { afterMs: 20, message: keyMessage("up", NAMED_USAGES[key]) },
  ]
}

/** Text as key presses on a US keyboard, as serve-sim's own `type` does; anything it can't type is said, not skipped. */
export function typePlan(text: string): Planned[] {
  const missing = [...new Set([...text].filter((character) => !PRINTABLE.has(character)))]
  if (missing.length) throw new RangeError(`These can't be typed on the simulator's US keyboard: ${missing.map((character) => JSON.stringify(character)).join(", ")}`)
  const plan: Planned[] = []
  let at = 0
  for (const character of text) {
    // SAFETY: every character was checked against PRINTABLE above.
    const key = PRINTABLE.get(character)!
    if (key.shift) plan.push({ afterMs: at, message: keyMessage("down", SHIFT) })
    plan.push({ afterMs: at, message: keyMessage("down", key.usage) }, { afterMs: at + 15, message: keyMessage("up", key.usage) })
    if (key.shift) plan.push({ afterMs: at + 15, message: keyMessage("up", SHIFT) })
    at += 30
  }
  return plan
}

/** What a plan is sent over: serve-sim's input socket for one simulator. */
export interface InputSocket {
  send(message: Uint8Array): void
  /** The screen as the helper last said it. */
  readonly config: ScreenConfig | undefined
}

/** Sends each message of a plan at its time, and resolves once the last is sent. */
export async function play(socket: InputSocket, plan: readonly Planned[], sleep: (ms: number) => Promise<void> = wait): Promise<void> {
  let elapsed = 0
  for (const step of plan) {
    if (step.afterMs > elapsed) {
      await sleep(step.afterMs - elapsed)
      elapsed = step.afterMs
    }
    socket.send(step.message)
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The input socket to one simulator through the hub; opened again on the next use when it drops. */
export class HidSocket implements InputSocket {
  readonly #url: string
  readonly #headers: Record<string, string>
  #socket: WebSocket | undefined
  #opening: Promise<WebSocket> | undefined
  #config: ScreenConfig | undefined
  #configured: Array<() => void> = []
  #closed = false

  constructor(hub: { origin: string; headers: Record<string, string> }, udid: string) {
    this.#url = `${hub.origin.replace(/^http/, "ws")}/helper/ws?device=${encodeURIComponent(udid)}`
    this.#headers = hub.headers
  }

  get open(): boolean {
    return this.#socket?.readyState === OPEN
  }

  get config(): ScreenConfig | undefined {
    return this.#config
  }

  /** Open, with the screen's config heard: the helper takes touches only once its capture is running. */
  async ready(timeoutMs = 10_000): Promise<void> {
    await this.#open()
    if (this.#config) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The simulator's input didn't say its screen in time.")), timeoutMs)
      this.#configured.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  send(message: Uint8Array): void {
    const socket = this.#socket
    if (socket?.readyState !== OPEN) throw new Error("The simulator's input socket isn't open.")
    socket.send(message)
  }

  #open(): Promise<WebSocket> {
    if (this.#socket?.readyState === OPEN) return Promise.resolve(this.#socket)
    return (this.#opening ??= heavy.ws.load("a simulator's input").then(
      ({ WebSocket }) =>
        new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(this.#url, { headers: this.#headers })
          socket.once("open", () => {
            this.#socket = socket
            this.#opening = undefined
            resolve(socket)
          })
          socket.once("error", () => {
            this.#opening = undefined
            reject(new Error("The simulator's input socket didn't open."))
          })
          socket.on("message", (data, binary) => {
            if (!binary || !Buffer.isBuffer(data)) return
            const config = readScreenConfig(data)
            if (!config) return
            this.#config = config
            for (const heard of this.#configured.splice(0)) heard()
          })
          socket.on("close", () => {
            if (this.#socket === socket) this.#socket = undefined
            if (!this.#closed) this.#config = undefined
          })
        })
    ))
  }

  close(): void {
    this.#closed = true
    this.#socket?.close()
    this.#socket = undefined
  }
}
