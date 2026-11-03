import type { SimulatorAction, SimulatorHostKind, SimulatorHostSummary, SimulatorReadKind, SimulatorsShot, SimulatorSummary } from "../../contracts/simulators.js"

/**
 * Everything one kind of host does with its simulators, so `Simulators` (claims, consent, refusals, the log) is the
 * same over this Mac, another Mac of the person's, a remote Mac, or the suite's stand-in. A host does only what it
 * can and throws `SimulatorUnsupported` for the rest, with its own reason: never a pretend success.
 */
export interface SimulatorHost {
  readonly id: string
  readonly label: string
  readonly kind: SimulatorHostKind
  /** What it can run and why not; cheap, since Diagnostics and the panel ask it. */
  summary(): Promise<SimulatorHostSummary>
  list(): Promise<SimulatorSummary[]>
  /** Up and showing its home screen; a booted one is left as it is. */
  boot(simulator: string): Promise<void>
  act(simulator: string, action: SimulatorAction): Promise<void>
  /** What `read` returns, as JSON, and for `console` the cursor to read on from. */
  read(simulator: string, what: SimulatorReadKind, after?: number): Promise<{ state: unknown; cursor?: number }>
  /** A PNG of the screen as it is now, written where `show` can read it. */
  screenshot(simulator: string): Promise<SimulatorsShot>
  /** Starting one that records, or stopping one that doesn't, answers as it stands: a client replays this call. */
  record(simulator: string, recording: "start" | "stop"): Promise<{ path?: string }>
}

/** A host that can't do this operation: its words go to the caller as the refusal's reason. */
export class SimulatorUnsupported extends Error {
  override readonly name = "SimulatorUnsupported"
}
