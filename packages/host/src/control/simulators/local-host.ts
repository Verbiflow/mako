import type { Json } from "@mako/protocol"
import { mkdir, open as openFile } from "node:fs/promises"
import { join } from "node:path"
import type { SimulatorSetup } from "../../contracts/simulator-setup.js"
import { setupStep } from "../../contracts/simulator-setup.js"
import type {
  SimulatorAction,
  SimulatorAvailability,
  SimulatorHostSummary,
  SimulatorOrientation,
  SimulatorPoint,
  SimulatorReadKind,
  SimulatorsShot,
  SimulatorSummary,
} from "../../contracts/simulators.js"
import { hostWarn } from "../../base/host-log.js"
import {
  HidSocket,
  buttonMessage,
  keyPlan,
  orientationMessage,
  pinchPlan,
  play,
  rawPoint,
  swipePlan,
  tapPlan,
  touchMessage,
  typePlan,
  type InputSocket,
  type ScreenConfig,
} from "./hid.js"
import { ServeSimCapture } from "./capture.js"
import { SimulatorUnsupported, type SimulatorFrameSink, type SimulatorFrameSource, type SimulatorHost } from "./host.js"
import { SimulatorHub, type AxElement, type AxSnapshot, type HubConnection } from "./hub.js"
import { SafariInspector, simulatorOfProcess } from "./inspector.js"
import { developerFolder, runCommand, type Run } from "./setup.js"
import { Simctl, type DeviceScreen, type Recording, screenInPoints } from "./simctl.js"
import { toolPackage, toolsRoot } from "./tools.js"

/** What Settings' try opens: Mako's web app, as a phone opens it. */
export const MAKO_WEB_APP = "https://app.runmako.co"
const TRY_MS = 120_000
const SWIPE_MS = 300
const PINCH_MS = 400
/** How long a screen's config holds before it's asked again: a rotation is said within it. */
const CONFIG_MS = 500
/** How long an element looked for on screen (Safari's Share button, a sheet's row) may take to appear. */
const ELEMENT_MS = 5_000
const ELEMENT_POLL_MS = 300

/** The input socket the host plays touches on: serve-sim's, through the hub. */
export interface LocalInput extends InputSocket {
  readonly open: boolean
  ready(timeoutMs?: number): Promise<void>
  close(): void
}

/** A screen's capture as the host keeps it: a frame source it can end when the simulator goes down. */
export interface LocalCapture extends SimulatorFrameSource {
  end(reason: string): void
}

/** What drives this Mac's simulators, one of each per developer folder, so a test can stand in for any of them. */
export interface LocalDriving {
  simctl: Pick<Simctl, "boot" | "openUrl" | "screenshot" | "record" | "screens">
  hub: Pick<SimulatorHub, "connection" | "accessibility" | "config" | "open" | "stop" | "running">
  inspector: Pick<SafariInspector, "page" | "console" | "evaluate" | "forget" | "close">
  capture(udid: string, sink: SimulatorFrameSink): LocalCapture
  input(hub: HubConnection, udid: string): LocalInput
}

/** This Mac's driving, from Mako's installed tools and its hub entry. */
export function localDriving(options: { dataRoot: string; hub: { entry: string; execArgv?: string[] }; run?: Run }): (developerDir: string) => LocalDriving {
  const run = options.run ?? runCommand
  return (developerDir) => {
    const simctl = new Simctl({ run, developerDir })
    const tools = toolsRoot(options.dataRoot)
    const hub = new SimulatorHub({
      entry: options.hub.entry,
      execArgv: options.hub.execArgv,
      serveSim: toolPackage(tools, "serve-sim"),
      inspectWebkit: toolPackage(tools, "inspect-webkit"),
      folder: join(options.dataRoot, "simulators", "hub"),
      run,
      env: simctl.env,
    })
    return {
      simctl,
      hub,
      inspector: new SafariInspector({ hub: () => hub.connection(), targets: () => hub.targets(), simulatorOf: (pid) => simulatorOfProcess(run, pid) }),
      capture: (udid, sink) => new ServeSimCapture(hub, udid, sink),
      input: (connection, udid) => new HidSocket(connection, udid),
    }
  }
}

export interface LocalSimulatorHostOptions {
  /** The setup line; `refresh` reads it again, as after a boot. */
  setup: (refresh?: boolean) => Promise<SimulatorSetup>
  /** Where shots and recordings are written. */
  folder: string
  /** What drives the simulators, made once the setup says this Mac can; without it the host lists and refuses. */
  driving?: (developerDir: string) => LocalDriving
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

interface Input {
  origin: string
  socket: LocalInput
}

/**
 * This Mac, through Xcode's own tools and Mako's simulator hub. It reads what the setup line read (Xcode, its license,
 * the runtime, Mako's two simulators, the tools), so the panel, Settings and an agent's `simulator_list` say the same
 * thing, and drives a simulator once that line says it can run: `simctl` to boot, open pages, take shots and record,
 * serve-sim's input for real touches, and Safari's web inspector for what the page reports.
 */
export class LocalSimulatorHost implements SimulatorHost {
  readonly id = "local"
  readonly label = "This Mac"
  readonly kind = "local" as const
  readonly #options: LocalSimulatorHostOptions
  readonly #sleep: (ms: number) => Promise<void>
  readonly #now: () => number
  #driving: { developerDir: string; driving: LocalDriving } | undefined
  readonly #inputs = new Map<string, Input>()
  readonly #primed = new Set<string>()
  readonly #configs = new Map<string, { at: number; config: ScreenConfig | undefined }>()
  readonly #recordings = new Map<string, Recording>()
  /** Each screen's running captures, ended when its simulator goes down. */
  readonly #captures = new Map<string, Set<LocalCapture>>()
  #screens: Promise<Map<string, DeviceScreen>> | undefined

  constructor(options: LocalSimulatorHostOptions) {
    this.#options = options
    this.#sleep = this.#options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.#now = this.#options.now ?? Date.now
  }

  async summary(): Promise<SimulatorHostSummary> {
    const setup = await this.#options.setup()
    const xcode = setupStep(setup, "xcode")
    return {
      id: this.id,
      label: this.label,
      kind: this.kind,
      platforms: {
        ios: iosAvailability(setup, this.#options.driving !== undefined),
        android: { ready: false, blocker: "not-built", why: "Android emulators come after iOS." },
      },
      ...(xcode && { detail: [xcode.developerDir && `developer folder ${xcode.developerDir}`, xcode.xcode && `Xcode ${xcode.xcode.version}${xcode.xcode.build ? ` (${xcode.xcode.build})` : ""}`].filter(Boolean).join(", ") }),
    }
  }

  async list(): Promise<SimulatorSummary[]> {
    const setup = await this.#options.setup()
    const runtime = setupStep(setup, "runtime")?.runtime
    const simulators = setupStep(setup, "simulators")?.simulators ?? []
    const driving = iosAvailability(setup, this.#options.driving !== undefined).ready ? this.#drive(setup) : undefined
    const screens = driving ? await (this.#screens ??= driving.simctl.screens(simulators.map((simulator) => simulator.type)).catch(() => new Map())) : new Map<string, DeviceScreen>()
    return Promise.all(
      simulators.flatMap((simulator) => {
        if (!simulator.udid) return []
        const udid = simulator.udid
        const state = simulator.state ?? "shutdown"
        if (state !== "booted") this.#forget(udid)
        const screen = screens.get(simulator.type)
        return [
          (async (): Promise<SimulatorSummary> => {
            const config = state === "booted" && driving?.hub.running ? await this.#config(udid) : undefined
            const orientation = config && orientationOf(config)
            return {
              hostId: this.id,
              id: udid,
              name: simulator.name,
              platform: "ios",
              runtime: runtime?.name ?? simulator.runtime ?? "iOS",
              form: simulator.form,
              state,
              ...(screen && { screen: screenInPoints(screen) }),
              ...(orientation && { orientation }),
            }
          })(),
        ]
      })
    )
  }

  async boot(simulator: string): Promise<void> {
    const driving = await this.#ready()
    await driving.simctl.boot(simulator)
    await this.#options.setup(true)
  }

  async act(simulator: string, action: SimulatorAction): Promise<void> {
    const driving = await this.#ready()
    switch (action.kind) {
      case "open-url":
        return driving.simctl.openUrl(simulator, action.url)
      case "tap":
        return this.#play(simulator, async (shown, config) => tapPlan(rawPoint(action.at, shown, config)))
      case "touch": {
        const input = await this.#input(simulator)
        const shown = await this.#shown(simulator)
        input.send(touchMessage(action.phase, rawPoint(action.at, shown, input.config)))
        return
      }
      case "swipe":
        return this.#play(simulator, async (shown, config) => swipePlan(rawPoint(action.from, shown, config), rawPoint(action.to, shown, config), action.ms ?? SWIPE_MS))
      case "pinch":
        return this.#play(simulator, async (shown, config) => pinchPlan(rawPoint(action.at, shown, config), action.scale, action.ms ?? PINCH_MS))
      case "type": {
        let plan
        try {
          plan = typePlan(action.text)
        } catch (error) {
          throw new SimulatorUnsupported(error instanceof Error ? error.message : String(error))
        }
        return this.#play(simulator, async () => plan)
      }
      case "key":
        return this.#play(simulator, async () => keyPlan(action.key))
      case "rotate":
        ;(await this.#input(simulator)).send(orientationMessage(action.to))
        this.#configs.delete(simulator)
        return
      case "home":
        ;(await this.#input(simulator)).send(buttonMessage("home"))
        return
      case "keyboard":
        return action.shown ? this.#showKeyboard(simulator) : this.#hideKeyboard(driving, simulator)
      case "add-to-home-screen":
        return this.#addToHomeScreen(simulator)
    }
  }

  async read(simulator: string, what: SimulatorReadKind, after?: number): Promise<{ state: unknown; cursor?: number }> {
    const driving = await this.#ready()
    switch (what) {
      case "page":
        return { state: await driving.inspector.page(simulator) }
      case "console": {
        const read = await driving.inspector.console(simulator, after)
        return { state: read.entries, cursor: read.cursor }
      }
      case "accessibility":
        return { state: await driving.hub.accessibility(simulator) }
    }
  }

  /** Runs source in the page Safari shows, for this Mac's own runners (the mobile-behavior suite); agents read, not run. */
  async evaluate(simulator: string, expression: string): Promise<Json> {
    return (await this.#ready()).inspector.evaluate(simulator, expression)
  }

  async screenshot(simulator: string): Promise<SimulatorsShot> {
    const driving = await this.#ready()
    const folder = join(this.#options.folder, "shots")
    await mkdir(folder, { recursive: true })
    const path = join(folder, `${simulator}-${this.#now()}.png`)
    await driving.simctl.screenshot(simulator, path)
    return { path, ...(await pngSize(path)) }
  }

  async record(simulator: string, recording: "start" | "stop"): Promise<{ path?: string }> {
    const driving = await this.#ready()
    const running = this.#recordings.get(simulator)
    if (recording === "start") {
      if (running) return {}
      const folder = join(this.#options.folder, "recordings")
      await mkdir(folder, { recursive: true })
      this.#recordings.set(simulator, await driving.simctl.record(simulator, join(folder, `${simulator}-${this.#now()}.mp4`)))
      return {}
    }
    if (!running) return {}
    this.#recordings.delete(simulator)
    await running.stop()
    return { path: running.path }
  }

  /** A booted simulator's screen from serve-sim, for `SimulatorStreams` to share among its viewers. */
  async frames(simulator: string, sink: SimulatorFrameSink): Promise<SimulatorFrameSource> {
    const setup = await this.#options.setup()
    const ios = iosAvailability(setup, this.#options.driving !== undefined)
    if (!ios.ready) throw new SimulatorUnsupported(ios.why)
    const listed = setupStep(setup, "simulators")?.simulators.find((entry) => entry.udid === simulator)
    if (listed?.state !== "booted") throw new SimulatorUnsupported("The simulator isn't running; open it first.")
    const capture = this.#drive(setup).capture(simulator, sink)
    const captures = this.#captures.get(simulator) ?? new Set<LocalCapture>()
    this.#captures.set(simulator, captures)
    captures.add(capture)
    return {
      keyFrame: () => capture.keyFrame(),
      resize: (box) => capture.resize(box),
      decoded: (sequence) => capture.decoded?.(sequence),
      stop: async () => {
        captures.delete(capture)
        await capture.stop()
      },
    }
  }

  /** Settings' try: Mako's iPhone up, the web app opened in Safari, and how long until its screen streamed. */
  async tryIt(url = MAKO_WEB_APP): Promise<{ firstFrameMs: number }> {
    const started = this.#now()
    const phone = setupStep(await this.#options.setup(), "simulators")?.simulators.find((simulator) => simulator.form === "phone" && simulator.udid)?.udid
    if (!phone) throw new Error("Mako's iPhone simulator isn't made yet.")
    await this.boot(phone)
    await this.act(phone, { kind: "open-url", url })
    let streamed: (outcome: { firstFrameMs: number } | { ended: string }) => void = () => undefined
    const outcome = new Promise<{ firstFrameMs: number } | { ended: string }>((resolve) => (streamed = resolve))
    const source = await this.frames(phone, { packet: () => streamed({ firstFrameMs: this.#now() - started }), ended: (reason) => streamed({ ended: reason }) })
    let timer: NodeJS.Timeout | undefined
    try {
      const first = await Promise.race([outcome, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), TRY_MS)))])
      if (!first) throw new Error(`The iPhone booted, but its screen didn't stream within ${TRY_MS / 1000} s.`)
      if ("ended" in first) throw new Error(`The iPhone booted, but its screen stopped streaming: ${first.ended}`)
      return first
    } finally {
      clearTimeout(timer)
      await source.stop()
    }
  }

  /** A local simulator is the person's: it keeps running once nobody holds it. */
  async release(): Promise<void> {}

  close(): Promise<void> {
    return this.#retire()
  }

  /** Everything running for the simulators stops: recordings are finished, so their files are whole. */
  async #retire(): Promise<void> {
    const driving = this.#driving?.driving
    this.#driving = undefined
    const recordings = [...this.#recordings.values()]
    this.#recordings.clear()
    for (const input of this.#inputs.values()) input.socket.close()
    this.#inputs.clear()
    this.#primed.clear()
    this.#configs.clear()
    for (const captures of this.#captures.values()) for (const capture of captures) capture.end("Mako's host is stopping.")
    this.#captures.clear()
    await Promise.all(recordings.map((recording) => recording.stop().catch(() => undefined)))
    driving?.inspector.close()
    await driving?.hub.stop()
  }

  async #ready(): Promise<LocalDriving> {
    const setup = await this.#options.setup()
    const ios = iosAvailability(setup, this.#options.driving !== undefined)
    if (!ios.ready) throw new SimulatorUnsupported(ios.why)
    return this.#drive(setup)
  }

  #drive(setup: SimulatorSetup): LocalDriving {
    const xcode = setupStep(setup, "xcode")
    // This Xcode's own folder, never the active one, which may be the Command Line Tools: they have no simctl.
    const developerDir = xcode?.xcode ? developerFolder(xcode.xcode) : ""
    if (this.#driving?.developerDir === developerDir) return this.#driving.driving
    if (this.#driving) void this.#retire()
    // SAFETY: #drive is reached only once iosAvailability said ready, which needs `driving`.
    const driving = this.#options.driving!(developerDir)
    this.#driving = { developerDir, driving }
    this.#screens = undefined
    return driving
  }

  #forget(udid: string): void {
    this.#primed.delete(udid)
    this.#configs.delete(udid)
    const input = this.#inputs.get(udid)
    if (input) {
      input.socket.close()
      this.#inputs.delete(udid)
    }
    for (const capture of this.#captures.get(udid) ?? []) capture.end("The simulator is no longer running.")
    this.#captures.delete(udid)
    this.#driving?.driving.inspector.forget(udid)
  }

  async #config(udid: string): Promise<ScreenConfig | undefined> {
    const kept = this.#configs.get(udid)
    if (kept && this.#now() - kept.at < CONFIG_MS) return kept.config
    const config = await this.#driving?.driving.hub.config(udid).catch(() => undefined)
    this.#configs.set(udid, { at: this.#now(), config })
    return config
  }

  /** The screen as it's shown now, in points: the device's own, turned as the simulator is. */
  async #shown(udid: string): Promise<{ width: number; height: number }> {
    const simulator = (await this.list()).find((entry) => entry.id === udid)
    const screen = simulator?.screen
    if (!screen) {
      const ax = await this.#driving?.driving.hub.accessibility(udid).catch(() => undefined)
      if (ax?.screen) return ax.screen
      throw new Error("Mako couldn't read this simulator's screen size from its device type.")
    }
    const sideways = simulator.orientation === "landscape-left" || simulator.orientation === "landscape-right"
    return sideways ? { width: screen.height, height: screen.width } : { width: screen.width, height: screen.height }
  }

  /** Its input socket, open and with the screen said: the capture is started once first, since touches need it running. */
  async #input(udid: string): Promise<LocalInput> {
    const driving = await this.#ready()
    const hub = await driving.hub.connection()
    let input = this.#inputs.get(udid)
    if (input && (input.origin !== hub.origin || !input.socket.open)) {
      input.socket.close()
      input = undefined
    }
    if (!input) {
      input = { origin: hub.origin, socket: driving.input(hub, udid) }
      this.#inputs.set(udid, input)
    }
    if (!this.#primed.has(udid)) {
      await prime(driving, udid)
      this.#primed.add(udid)
    }
    await input.socket.ready()
    return input.socket
  }

  async #play(udid: string, plan: (shown: { width: number; height: number }, config: ScreenConfig | undefined) => Promise<Parameters<typeof play>[1]>): Promise<void> {
    const input = await this.#input(udid)
    const shown = await this.#shown(udid)
    await play(input, await plan(shown, input.config), this.#sleep)
  }

  async #find(udid: string, matches: (element: AxElement) => boolean, timeoutMs = ELEMENT_MS): Promise<{ element: AxElement; snapshot: AxSnapshot } | undefined> {
    const driving = await this.#ready()
    const deadline = this.#now() + timeoutMs
    for (;;) {
      const snapshot = await driving.hub.accessibility(udid).catch(() => undefined)
      const element = snapshot?.elements.find((candidate) => candidate.enabled !== false && matches(candidate))
      if (snapshot && element) return { element, snapshot }
      if (this.#now() >= deadline) return undefined
      await this.#sleep(ELEMENT_POLL_MS)
    }
  }

  async #tap(udid: string, element: AxElement): Promise<void> {
    const at: SimulatorPoint = { x: element.frame.x + element.frame.width / 2, y: element.frame.y + element.frame.height / 2 }
    await this.act(udid, { kind: "tap", at })
  }

  async #showKeyboard(udid: string): Promise<void> {
    const field = await this.#find(udid, (element) => /text ?field|text ?area|search ?field|secure/i.test(`${element.type ?? ""} ${element.role ?? ""}`), 1_500)
    if (field) {
      await this.#tap(udid, field.element)
      return
    }
    // The composer's textarea is on the page, and this iOS doesn't put it in the accessibility tree. Focusing it shows the keyboard.
    const driving = await this.#ready()
    const focused = await driving.inspector.evaluate(
      udid,
      `(() => { const field = document.querySelector("textarea, input:not([type=hidden]), [contenteditable=true]"); if (!field) return false; field.focus(); return true })()`
    )
    if (focused !== true) throw new SimulatorUnsupported("Nothing on screen takes text, so there's no keyboard to show; tap a field first.")
  }

  async #hideKeyboard(driving: LocalDriving, udid: string): Promise<void> {
    await driving.inspector.evaluate(udid, `document.activeElement && document.activeElement !== document.body ? (document.activeElement.blur(), true) : false`)
  }

  /** Safari's Share › Add to Home Screen › Add, then the new icon opened from the home screen, as a person does it. */
  async #addToHomeScreen(udid: string): Promise<void> {
    const label = (pattern: RegExp) => (element: AxElement) => pattern.test(element.label ?? "")
    let share = await this.#find(udid, label(/^Share$/), 2_000)
    if (!share) {
      const more = await this.#find(udid, label(/^(More|Page Menu|Tab Options)$/), 2_000)
      if (more) await this.#tap(udid, more.element)
      share = await this.#find(udid, label(/^Share/))
    }
    if (!share) throw new Error("Safari's Share button isn't on screen: open a page in Safari first.")
    await this.#tap(udid, share.element)
    let add = await this.#find(udid, label(/^Add to Home Screen$/), 3_000)
    for (let scroll = 0; !add && scroll < 3; scroll++) {
      const shown = await this.#shown(udid)
      await this.act(udid, { kind: "swipe", from: { x: shown.width / 2, y: shown.height * 0.8 }, to: { x: shown.width / 2, y: shown.height * 0.4 } })
      add = await this.#find(udid, label(/^Add to Home Screen$/), 1_500)
    }
    if (!add) throw new Error("Safari's share sheet has no Add to Home Screen for this page.")
    await this.#tap(udid, add.element)
    const confirm = await this.#find(udid, label(/^Add$/))
    if (!confirm) throw new Error("Add to Home Screen's sheet didn't offer Add.")
    const name = confirm.snapshot.elements.find((element) => /text ?field/i.test(element.type ?? "") && element.value)?.value
    await this.#tap(udid, confirm.element)
    if (!name) throw new Error("The page was added to the home screen, but its icon's name wasn't readable, so it wasn't opened.")
    await this.#sleep(1_500)
    await this.act(udid, { kind: "home" })
    for (let page = 0; page < 5; page++) {
      const icon = await this.#find(udid, (element) => element.label === name, 1_500)
      if (icon) return this.#tap(udid, icon.element)
      const shown = await this.#shown(udid)
      await this.act(udid, { kind: "swipe", from: { x: shown.width * 0.85, y: shown.height / 2 }, to: { x: shown.width * 0.15, y: shown.height / 2 }, ms: 250 })
    }
    throw new Error(`"${name}" was added to the home screen, but its icon wasn't found to open.`)
  }
}

/** serve-sim's helper takes touches only once its capture runs: a moment of its JPEG stream starts it. */
async function prime(driving: LocalDriving, udid: string): Promise<void> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 5_000)
  try {
    const body = await driving.hub.open(udid, "stream.mjpeg", abort.signal)
    await body[Symbol.asyncIterator]().next()
  } catch (error) {
    if (!abort.signal.aborted) hostWarn("simulators", "starting the capture for touches failed", { simulator: udid, error: error instanceof Error ? error.message : String(error) })
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
}

export function orientationOf(config: ScreenConfig): SimulatorOrientation {
  switch (config.orientation) {
    case "landscape_left":
      return "landscape-left"
    case "landscape_right":
      return "landscape-right"
    case "portrait_upside_down":
      return "portrait-upside-down"
    default:
      return "portrait"
  }
}

/** A PNG's size, from its header. */
export async function pngSize(path: string): Promise<{ width: number; height: number }> {
  const file = await openFile(path, "r")
  try {
    const header = Buffer.alloc(24)
    await file.read(header, 0, 24, 0)
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
  } finally {
    await file.close()
  }
}

/** Whether this Mac can run an iPhone simulator, and if not the first thing missing, from the setup line. */
export function iosAvailability(setup: SimulatorSetup, canDrive = true): SimulatorAvailability {
  if (setup.phase === "unavailable") return { ready: false, blocker: "not-macos", why: "iPhone and iPad simulators run on macOS alone." }
  if (setupStep(setup, "xcode")?.state !== "done") return { ready: false, blocker: "no-xcode", why: "This Mac has no Xcode, so no iOS Simulator.", fix: "Settings › Simulators" }
  if (setupStep(setup, "finish")?.state !== "done") return { ready: false, blocker: "no-xcode", why: "Xcode's first-run setup isn't finished.", fix: "Settings › Simulators" }
  if (setupStep(setup, "runtime")?.state !== "done") return { ready: false, blocker: "no-runtime", why: "Xcode has no iOS simulator runtime yet.", fix: "Settings › Simulators" }
  if (setupStep(setup, "tools")?.state !== "done") return { ready: false, blocker: "no-tools", why: "Mako's simulator tools aren't installed yet.", fix: "Settings › Simulators" }
  if (!canDrive) return { ready: false, blocker: "not-built", why: "This copy of Mako can list simulators but has no way to drive them." }
  return { ready: true }
}
