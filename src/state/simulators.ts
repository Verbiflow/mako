import type { ListedSimulator, SimulatorAction, SimulatorPoint, SimulatorsListed } from "@mako/host/contracts/simulators"
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
}

export const simulatorsStore = createStore<SimulatorsState>({ frames: {} })
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
