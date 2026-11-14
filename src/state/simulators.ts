import { decodeControlVideoBatch } from "@mako/control-runtime/contracts"
import type { ListedSimulator, SimulatorAction, SimulatorOrientation, SimulatorPoint, SimulatorsListed } from "@mako/host/contracts/simulators"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

/** The latest picture of a simulator's screen, at its size in points. */
export interface SimulatorFrame {
  src: string
  width: number
  height: number
  at: number
}

/**
 * The simulators the desk panel shows: what the hosts run and who drives each (`mako:simulators-list`), the one the
 * person looks at, and its screen's latest frame. The person acts through the same operations an agent does, as
 * `{ kind: "person" }`, so taking one over is the host's rule and not this window's.
 */
interface SimulatorsState {
  listed?: SimulatorsListed
  /** By `simulatorKey`: a simulator's ID is its host's, so two hosts may both have one. */
  chosen?: string
  frames: Record<string, SimulatorFrame>
  /** Why the host turned the person's last press down, in its words. */
  refused?: string
  /** By `simulatorKey`, simulators whose host took no live touch: a press there is a tap or a swipe once it ends. */
  touchless: Record<string, true>
}

export const simulatorsStore = createStore<SimulatorsState>({ frames: {}, touchless: {} })
export const useSimulators = createHook(simulatorsStore)

export const simulators = {
  async load() {
    if (!hasBridge()) return
    const listed = await getMako().simulatorsList().catch(() => undefined)
    if (!listed) return
    const first = listed.simulators[0]
    simulatorsStore.set((state) => ({ listed, chosen: state.chosen && listed.simulators.some((simulator) => simulatorKey(simulator) === state.chosen) ? state.chosen : first && simulatorKey(first) }))
  },

  choose(key: string) {
    simulatorsStore.set({ chosen: key, refused: undefined })
  },

  /** Takes it over from whichever Thread drives it, and boots it if it's off. */
  async takeOver(simulator: ListedSimulator) {
    const opened = await getMako().simulatorsOpen({ simulator: simulator.id, host: simulator.hostId })
    simulatorsStore.set({ refused: "refused" in opened ? opened.why : undefined })
    await simulators.load()
  },

  async act(simulator: ListedSimulator, action: SimulatorAction) {
    const acted = await getMako().simulatorsAct({ simulator: simulator.id, host: simulator.hostId, action })
    if ("refused" in acted && acted.refused === "unsupported" && action.kind === "touch") {
      simulatorsStore.set((state) => ({ touchless: { ...state.touchless, [simulatorKey(simulator)]: true } }))
      return
    }
    simulatorsStore.set({ refused: "refused" in acted ? acted.why : undefined })
  },

  async release(simulator: ListedSimulator) {
    await getMako().simulatorsRelease({ simulator: simulator.id, host: simulator.hostId })
    await simulators.load()
  },
}

/** One simulator among every host's: its host and its host's own ID. */
export function simulatorKey(simulator: Pick<ListedSimulator, "hostId" | "id">): string {
  return `${simulator.hostId}/${simulator.id}`
}

/**
 * Where a pointer on the drawn screen lands on the simulator's, in its points: the picture keeps its aspect inside
 * the box it's drawn in, so the margins it leaves aren't the screen. Outside the picture is nowhere.
 */
export function pointOnScreen(box: { left: number; top: number; width: number; height: number }, screen: { width: number; height: number }, x: number, y: number): SimulatorPoint | undefined {
  const scale = Math.min(box.width / screen.width, box.height / screen.height)
  const left = box.left + (box.width - screen.width * scale) / 2
  const top = box.top + (box.height - screen.height * scale) / 2
  const point = { x: Math.round((x - left) / scale), y: Math.round((y - top) / scale) }
  return point.x < 0 || point.y < 0 || point.x > screen.width || point.y > screen.height ? undefined : point
}

/** A press that barely moved is a tap; one that travelled is a swipe over the time it took. */
export function touchOf(from: SimulatorPoint, to: SimulatorPoint, ms: number): SimulatorAction {
  return Math.hypot(to.x - from.x, to.y - from.y) < 6 ? { kind: "tap", at: from } : { kind: "swipe", from, to, ms: Math.max(50, Math.round(ms)) }
}

/** Whether any host here can run a simulator now, so the desk offers the panel. */
export function simulatorsRunnable(listed: SimulatorsListed | undefined): boolean {
  return listed?.hosts.some((host) => host.platforms.ios.ready) ?? false
}

/** The screen as it's shown now, in points: the device's own, turned as the simulator is. */
export function shownScreen(screen: { width: number; height: number }, orientation: SimulatorOrientation | undefined): { width: number; height: number } {
  const sideways = orientation === "landscape-left" || orientation === "landscape-right"
  const wide = screen.width > screen.height
  return sideways !== wide ? { width: screen.height, height: screen.width } : screen
}

/**
 * How far a decoded picture is turned to draw it upright. The capture sends the raw framebuffer, which stays
 * portrait however the device is turned; a picture already wider than tall was turned by the capture itself.
 */
export function pictureTurn(picture: { width: number; height: number }, orientation: SimulatorOrientation | undefined): 0 | 90 | -90 | 180 {
  if (picture.width > picture.height) return 0
  switch (orientation) {
    case "landscape-left":
      return 90
    case "landscape-right":
      return -90
    case "portrait-upside-down":
      return 180
    default:
      return 0
  }
}

/**
 * A drag as it goes, one touch at a time to the host and in order: its moves are folded to the latest while one is
 * on its way, so a slow link sends fewer moves rather than a backlog, and the finger lifts where it last was.
 */
export class TouchStream {
  #chain: Promise<void> = Promise.resolve()
  #move: SimulatorPoint | undefined
  #moveQueued = false
  readonly #send: (phase: "begin" | "move" | "end", at: SimulatorPoint) => Promise<void>

  constructor(send: (phase: "begin" | "move" | "end", at: SimulatorPoint) => Promise<void>) {
    this.#send = send
  }

  begin(at: SimulatorPoint) {
    this.#then(() => this.#send("begin", at))
  }

  move(at: SimulatorPoint) {
    this.#move = at
    if (this.#moveQueued) return
    this.#moveQueued = true
    this.#then(() => {
      this.#moveQueued = false
      const at = this.#move
      this.#move = undefined
      return at ? this.#send("move", at) : undefined
    })
  }

  end(at: SimulatorPoint) {
    this.#move = undefined
    this.#then(() => this.#send("end", at))
  }

  /** Until every touch so far has been answered. */
  settled(): Promise<void> {
    return this.#chain
  }

  #then(next: () => Promise<void> | undefined) {
    this.#chain = this.#chain.then(next).catch(() => undefined)
  }
}

/** Units a viewer skips waiting for a key frame before it asks again as a new viewer, which starts at one. */
const SKIPS_BEFORE_REJOIN = 90

export interface SimulatorVideoWatch {
  stop(): void
  /** This viewer's decoder failed: it watches again as a new viewer, which starts at the screen's last key frame. */
  rejoin(): void
}

/**
 * A simulator's screen for one viewer: reads its packets from the host (`mako:simulators-watch`) one batch after
 * another while the screen is shown, and hands each to `push`.
 */
export function watchSimulatorVideo(
  simulator: { id: string; hostId: string },
  push: (packet: Uint8Array) => void,
  stats: () => { decoded: number; skipped: number; sequence?: number },
  ended: (live: boolean) => void
): SimulatorVideoWatch {
  let viewer = crypto.randomUUID()
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  /** What was decoded and skipped when the picture last moved: skipping on with nothing decoded is a viewer without a key frame. */
  let mark = { decoded: 0, skipped: 0 }
  /** The decoded count when the host was last told, which falls back to JPEGs until a viewer decodes its H.264. */
  let told = stats().decoded
  const read = async () => {
    timer = undefined
    if (closed) return
    if (document.hidden) {
      timer = setTimeout(read, 500)
      return
    }
    let live: boolean
    try {
      const { decoded: drawn, sequence } = stats()
      const fresh = drawn > told && sequence !== undefined
      told = drawn
      const watched = await getMako().simulatorsWatch({ simulator: simulator.id, host: simulator.hostId, viewer, ...(fresh && { decoded: sequence }) })
      if (closed) return
      if ("refused" in watched) throw new Error(watched.why)
      const batch = decodeControlVideoBatch(Uint8Array.from(atob(watched.batch), (character) => character.charCodeAt(0)))
      for (const packet of batch.packets) push(packet)
      live = watched.live
      const { decoded, skipped } = stats()
      const now = { decoded, skipped }
      if (now.decoded > mark.decoded) mark = now
      else if (now.skipped - mark.skipped > SKIPS_BEFORE_REJOIN) {
        viewer = crypto.randomUUID()
        mark = now
      }
    } catch {
      live = false
    }
    ended(live)
    if (!closed) timer = setTimeout(read, live ? 0 : 1_000)
  }
  void read()
  return {
    stop() {
      closed = true
      clearTimeout(timer)
      void getMako()
        .simulatorsWatch({ simulator: simulator.id, host: simulator.hostId, viewer, leave: true })
        .catch(() => undefined)
    },
    rejoin() {
      const { decoded, skipped } = stats()
      viewer = crypto.randomUUID()
      mark = { decoded, skipped }
    },
  }
}
