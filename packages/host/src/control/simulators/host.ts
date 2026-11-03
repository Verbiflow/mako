import type { SimulatorAction, SimulatorHostKind, SimulatorHostSummary, SimulatorReadKind, SimulatorsShot, SimulatorSummary } from "../../contracts/simulators.js"

/**
 * Everything one kind of host does with its simulators, so `Simulators` (claims, consent, refusals, the log) is the
 * same over this Mac, another Mac of the person's, a remote Mac, or the suite's stand-in. A host does only what it
 * can and throws `SimulatorUnsupported` for the rest, with its own reason: never a pretend success.
 *
 * A host never hands a client a tool's own server. serve-sim's HTTP API has a shell-exec route whose token its
 * unauthenticated `/api` gives out, and serve-emu's action routes have no auth: they bind loopback, and their screen
 * reaches a viewer only as frames through the host. A setting (appearance, location, status bar) is a typed
 * `SimulatorAction` the host runs itself, never a command sent down such a tool's exec channel.
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
  /**
   * Nobody holds it any more (released, idle, or its Thread archived). A local simulator keeps running, since it's the
   * person's; a billed host stops the session it started for it, so no bill outlives its claim.
   */
  release(simulator: string): Promise<void>
  /**
   * The host is going away. A billed host stops every session it started, and keeps a ledger of them in Mako's data
   * folder so the next host stops any this one left running; sessions others started on the account are never touched.
   */
  close(): Promise<void>
}

/** A host that can't do this operation: its words go to the caller as the refusal's reason. */
export class SimulatorUnsupported extends Error {
  override readonly name = "SimulatorUnsupported"
}
