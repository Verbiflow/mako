import type { Json } from "@mako/protocol"
import type { WebSocket } from "ws"
import { z } from "zod"
import { heavy } from "../../base/heavy-packages.js"
import { hostWarn } from "../../base/host-log.js"
import type { HubConnection, InspectorTarget } from "./hub.js"
import type { Run } from "./setup.js"

/*
 * Mobile Safari's pages through WebKit's web inspector, as inspect-webkit bridges it to the Chrome DevTools Protocol
 * inside the hub. A target is a page of an app on some simulator, named by the PID that owns the simulator's
 * `webinspectord_sim` socket; that process runs from the simulator's own folder, `CoreSimulator/Devices/<UDID>`.
 */

export const SAFARI = "com.apple.mobilesafari"
const DEVICE_FOLDER = /\/CoreSimulator\/Devices\/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\//i
const CALL_MS = 15_000
const CONSOLE_KEPT = 500
/** How many of the page's own readings it keeps, as Mako's web client keeps 40 of its own. */
const READINGS_KEPT = 200

/** The simulator a process runs in, from its own command line or its parents'. */
export async function simulatorOfProcess(run: Run, pid: number, depth = 6): Promise<string | undefined> {
  let current = pid
  for (let step = 0; step < depth && current > 1; step++) {
    const { stdout, code } = await run("/bin/ps", ["-o", "ppid=,command=", "-p", String(current)])
    if (code !== 0) return undefined
    const parsed = parsePs(stdout)
    if (!parsed) return undefined
    const udid = DEVICE_FOLDER.exec(parsed.command)?.[1]
    if (udid) return udid.toUpperCase()
    current = parsed.ppid
  }
  return undefined
}

export function parsePs(stdout: string): { ppid: number; command: string } | undefined {
  const match = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim())
  return match ? { ppid: Number(match[1]), command: match[2]!.trim() } : undefined
}

/** Safari's pages (its tabs) among the targets of the simulator processes in `pids`. */
export function safariPages(targets: readonly InspectorTarget[], pids: ReadonlySet<number>): InspectorTarget[] {
  return targets.filter((target) => pids.has(target.pid) && target.bundleId === SAFARI && target.type === "page")
}

type Pending = { resolve: (value: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

/** A message from the page's inspector: an answer to a call (`id`), or an event (`method`). */
const CdpMessageSchema = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.json().optional(),
  result: z.json().optional(),
  error: z.object({ message: z.string().optional() }).loose().optional(),
})
const ConsoleCallSchema = z.object({ type: z.string().optional(), args: z.array(z.object({ value: z.json().optional(), description: z.string().optional() }).loose()).optional() }).loose()
const ExceptionSchema = z.object({ exceptionDetails: z.object({ text: z.string().optional(), url: z.string().optional(), exception: z.object({ description: z.string().optional() }).loose().optional() }).loose().optional() }).loose()
const EvaluatedSchema = z.object({
  result: z.object({ value: z.json().optional() }).loose().optional(),
  exceptionDetails: z.object({ text: z.string().optional(), exception: z.object({ description: z.string().optional() }).loose().optional() }).loose().optional(),
}).loose()

/** A Chrome DevTools Protocol session to one page, over the hub. */
export class CdpSession {
  #socket: WebSocket | undefined
  readonly #pending = new Map<number, Pending>()
  readonly #listeners = new Map<string, Set<(params: Json) => void>>()
  readonly opened: Promise<void>
  #next = 1
  #closed = false

  constructor(hub: HubConnection, target: string) {
    this.opened = this.#connect(`${hub.origin.replace(/^http/, "ws")}/inspector/page/${encodeURIComponent(target)}`, hub.headers)
    this.opened.catch(() => undefined)
  }

  async #connect(url: string, headers: Record<string, string>): Promise<void> {
    const { WebSocket } = await heavy.ws.load("Safari's web inspector")
    const socket = new WebSocket(url, { headers })
    this.#socket = socket
    socket.on("message", (data) => this.#heard(String(data)))
    socket.on("close", () => this.#end(new Error("Safari's web inspector closed for this page.")))
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve())
      socket.once("error", () => reject(new Error("Safari's web inspector didn't open for this page.")))
    })
    if (this.#closed) socket.close()
  }

  get closed(): boolean {
    return this.#closed
  }

  async send(method: string, params: { [name: string]: Json } = {}): Promise<Json> {
    await this.opened
    if (this.#closed) throw new Error("Safari's web inspector closed for this page.")
    const id = this.#next++
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Safari didn't answer ${method} within ${CALL_MS / 1000} s`))
      }, CALL_MS)
      this.#pending.set(id, { resolve, reject, timer })
      this.#socket?.send(JSON.stringify({ id, method, params }))
    })
  }

  on(event: string, listener: (params: Json) => void): void {
    let listeners = this.#listeners.get(event)
    if (!listeners) this.#listeners.set(event, (listeners = new Set()))
    listeners.add(listener)
  }

  close(): void {
    this.#socket?.close()
    this.#end(new Error("Closed"))
  }

  #heard(text: string): void {
    let parsed: Json
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    const message = CdpMessageSchema.safeParse(parsed).data
    if (!message) return
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message ?? "Safari refused the call"))
      else pending.resolve(message.result ?? null)
      return
    }
    if (message.method) for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params ?? null)
  }

  #end(error: Error): void {
    if (this.#closed) return
    this.#closed = true
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}

/** A console message or uncaught error, as `simulator_read` says it. */
export interface ConsoleEntry {
  cursor: number
  at: number
  level: string
  text: string
  url?: string
}

/**
 * The page's own readings (`mako:reading`, which Mako's web client says on `window`), kept on `window` where a read
 * can take them. Run as the page's bootstrap script when WebKit takes one, so a page's first readings are kept too,
 * and again on every read, which is a no-op once it's there.
 */
export const READINGS_SCRIPT = `(() => {
  if (window.__makoReadings) return
  const kept = (window.__makoReadings = [])
  addEventListener("mako:reading", (event) => {
    kept.push({ at: Date.now(), reading: event.detail })
    if (kept.length > ${READINGS_KEPT}) kept.splice(0, kept.length - ${READINGS_KEPT})
  })
})()`

/** What a page read reports, measured in the page. */
export const PAGE_SCRIPT = `(() => {
  ${READINGS_SCRIPT};
  const describe = (element) => {
    if (!element || element === document.body || element === document.documentElement) return element ? element.tagName.toLowerCase() : null
    const test = element.getAttribute("data-testid")
    if (test) return '[data-testid="' + test + '"]'
    const id = element.id ? "#" + element.id : ""
    const classes = typeof element.className === "string" ? element.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).map((name) => "." + name).join("") : ""
    return element.tagName.toLowerCase() + id + classes
  }
  const scrollers = []
  for (const element of document.querySelectorAll("body *")) {
    if (scrollers.length >= 12) break
    if (element.scrollHeight <= element.clientHeight + 1) continue
    const overflow = getComputedStyle(element).overflowY
    if (overflow !== "auto" && overflow !== "scroll") continue
    scrollers.push({ element: describe(element), top: Math.round(element.scrollTop), height: element.scrollHeight, client: element.clientHeight, fromBottom: Math.round(element.scrollHeight - element.clientHeight - element.scrollTop) })
  }
  const visual = window.visualViewport
  const keyboard = visual ? Math.max(0, Math.round(innerHeight - visual.height - visual.offsetTop)) : 0
  const active = document.activeElement
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    visibility: document.visibilityState,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, orientation: screen.orientation ? screen.orientation.type : (innerWidth > innerHeight ? "landscape" : "portrait") },
    visualViewport: visual ? { width: Math.round(visual.width), height: Math.round(visual.height), offsetTop: Math.round(visual.offsetTop), offsetLeft: Math.round(visual.offsetLeft), scale: visual.scale } : null,
    keyboard: { shownPx: keyboard > 80 ? keyboard : 0, estimate: "the layout viewport less the visual viewport" },
    standalone: navigator.standalone === true || matchMedia("(display-mode: standalone)").matches,
    scroll: { x: Math.round(scrollX), y: Math.round(scrollY), height: document.documentElement.scrollHeight },
    scrollers,
    focused: active && active !== document.body ? { element: describe(active), editable: active.isContentEditable || /^(input|textarea|select)$/i.test(active.tagName) } : null,
    readings: window.__makoReadings.slice(),
  }
})()`

interface Attached {
  target: InspectorTarget
  session: CdpSession
  console: ConsoleEntry[]
  /** Whether WebKit took the readings script to run before each page's own. */
  bootstrap: boolean
}

/**
 * Safari's web inspector on each simulator: one session to the page the person sees, which keeps that page's console
 * and readings, attached again when another page or tab is shown.
 */
export class SafariInspector {
  readonly #hub: () => Promise<HubConnection>
  readonly #targets: () => Promise<InspectorTarget[]>
  readonly #simulatorOf: (pid: number) => Promise<string | undefined>
  /** Each target's PID's simulator: a PID is its simulator's until that simulator stops. */
  readonly #simulators = new Map<number, Promise<string | undefined>>()
  readonly #attached = new Map<string, Attached>()
  #cursor = 0

  constructor(options: { hub: () => Promise<HubConnection>; targets: () => Promise<InspectorTarget[]>; simulatorOf: (pid: number) => Promise<string | undefined> }) {
    this.#hub = options.hub
    this.#targets = options.targets
    this.#simulatorOf = options.simulatorOf
  }

  /** What the page Safari shows reports, measured in it. */
  async page(udid: string): Promise<{ inspector: { target: string; bootstrap: boolean }; page: Json }> {
    const attached = await this.#attach(udid)
    const page = await evaluate(attached.session, PAGE_SCRIPT)
    return { inspector: { target: attached.target.title || attached.target.url, bootstrap: attached.bootstrap }, page }
  }

  /** Runs an expression in the page Safari shows and answers its value, as JSON. */
  async evaluate(udid: string, expression: string): Promise<Json> {
    return evaluate((await this.#attach(udid)).session, expression)
  }

  /** Console messages and errors since `after`, with the cursor to read on from. */
  async console(udid: string, after = 0): Promise<{ entries: ConsoleEntry[]; cursor: number }> {
    const attached = await this.#attach(udid)
    const entries = attached.console.filter((entry) => entry.cursor > after)
    return { entries, cursor: entries.at(-1)?.cursor ?? Math.max(after, this.#cursor) }
  }

  /** The simulator stopped: its session ends, and its PIDs may be anyone's next. */
  forget(udid: string): void {
    this.#attached.get(udid)?.session.close()
    this.#attached.delete(udid)
    this.#simulators.clear()
  }

  async #pids(udid: string, targets: readonly InspectorTarget[]): Promise<ReadonlySet<number>> {
    const pids = new Set<number>()
    for (const pid of new Set(targets.map((target) => target.pid))) {
      let simulator = this.#simulators.get(pid)
      if (!simulator) this.#simulators.set(pid, (simulator = this.#simulatorOf(pid)))
      if ((await simulator) === udid) pids.add(pid)
    }
    return pids
  }

  close(): void {
    for (const udid of this.#attached.keys()) this.forget(udid)
  }

  async #attach(udid: string): Promise<Attached> {
    const targets = await this.#targets()
    const pages = safariPages(targets, await this.#pids(udid, targets))
    if (!pages.length) throw new Error("Safari shows no page on this simulator yet: open one with open-url.")
    const current = this.#attached.get(udid)
    const visible = current && !current.session.closed && pages.some((page) => page.id === current.target.id) ? await isVisible(current.session) : false
    if (current && visible) return current
    for (const page of [...pages].reverse()) {
      if (page.inUse) continue
      const attached = await this.#open(page).catch((error) => {
        hostWarn("simulators", "web inspector didn't attach", { simulator: udid, error: error instanceof Error ? error.message : String(error) })
        return undefined
      })
      if (!attached) continue
      if (pages.length === 1 || (await isVisible(attached.session))) {
        current?.session.close()
        if (current && current.target.id === page.id) attached.console.unshift(...current.console)
        this.#attached.set(udid, attached)
        return attached
      }
      attached.session.close()
    }
    if (current && !current.session.closed) return current
    throw new Error("Another inspector (Safari's Develop menu?) holds this simulator's page; close it and read again.")
  }

  async #open(target: InspectorTarget): Promise<Attached> {
    const session = new CdpSession(await this.#hub(), target.id)
    await session.opened
    const attached: Attached = { target, session, console: [], bootstrap: false }
    const keep = (entry: Omit<ConsoleEntry, "cursor">) => {
      attached.console.push({ ...entry, cursor: ++this.#cursor })
      if (attached.console.length > CONSOLE_KEPT) attached.console.splice(0, attached.console.length - CONSOLE_KEPT)
    }
    session.on("Runtime.consoleAPICalled", (params) => {
      const call = ConsoleCallSchema.safeParse(params).data ?? {}
      keep({ at: Date.now(), level: call.type ?? "log", text: (call.args ?? []).map((arg) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? ""))).join(" ").slice(0, 4_000) })
    })
    session.on("Runtime.exceptionThrown", (params) => {
      const details = ExceptionSchema.safeParse(params).data?.exceptionDetails
      keep({ at: Date.now(), level: "exception", text: (details?.exception?.description ?? details?.text ?? "Uncaught error").slice(0, 4_000), url: details?.url })
    })
    await session.send("Runtime.enable")
    // WebKit's own: run before each document's scripts, so the page's first readings are kept. inspect-webkit passes
    // it through; an older WebKit refuses it, and readings are kept from the first read on.
    attached.bootstrap = await session.send("Page.setBootstrapScript", { source: READINGS_SCRIPT }).then(() => true, () => false)
    await evaluate(session, READINGS_SCRIPT).catch(() => undefined)
    return attached
  }
}

async function isVisible(session: CdpSession): Promise<boolean> {
  return (await evaluate(session, `document.visibilityState === "visible"`).catch(() => false)) === true
}

async function evaluate(session: CdpSession, expression: string): Promise<Json> {
  const result = EvaluatedSchema.parse(await session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))
  if (result.exceptionDetails) throw new Error(`The page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "an error"}`)
  return result.result?.value ?? null
}
