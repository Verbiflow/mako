import type { ControlVideoPacket } from "@mako/control-runtime/contracts"
import type {
  SimulatorAction,
  SimulatorCaller,
  SimulatorHostKind,
  SimulatorHostSummary,
  SimulatorReadKind,
  SimulatorsActInput,
  SimulatorsActResult,
  SimulatorsOpenInput,
  SimulatorsOpenResult,
  SimulatorsReadInput,
  SimulatorsReadResult,
  SimulatorsRecordInput,
  SimulatorsRecordResult,
  SimulatorsReleaseInput,
  SimulatorsReleaseResult,
  SimulatorsShot,
  SimulatorsShotInput,
  SimulatorsShotResult,
  SimulatorSummary,
  SimulatorsWatchInput,
  SimulatorsWatchResult,
  ListedSimulator,
} from "../../contracts/simulators.js"

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
  /**
   * The screen as it changes, for `SimulatorStreams` to share among every viewer: started for the first viewer and
   * stopped after the last. A host without it can't be watched, only shot.
   */
  frames?(simulator: string, sink: SimulatorFrameSink): Promise<SimulatorFrameSource>
}

/** Where a host sends its screen: each packet as it's made, and the end with why. */
export interface SimulatorFrameSink {
  packet(packet: ControlVideoPacket): void
  ended(reason: string): void
}

/** A host's running stream of one screen. */
export interface SimulatorFrameSource {
  /** A viewer joined or fell behind and needs a key frame to start from; the host sends one soon. */
  keyFrame(): void
  /** The largest box any viewer draws in, so the host encodes no more than that. */
  resize(box: { width: number; height: number }): void
  /** A viewer's decoder drew this stream's picture `sequence`: until one does, a host may switch to a format it can show. */
  decoded?(sequence: number): void
  stop(): Promise<void>
}

/**
 * Another Mako host's simulators, reached by their verbs, not their host operations: its claims, its consent and its
 * log are its own, so whatever drives one of them is decided once, where it runs. `Simulators` checks this Mac's
 * project consent for its own agents, then hands the call on with the Thread this Mac already resolved.
 */
export interface RemoteSimulatorHost {
  readonly id: string
  readonly label: string
  list(caller: SimulatorCaller): Promise<{ hosts: SimulatorHostSummary[]; simulators: ListedSimulator[] }>
  open(caller: SimulatorCaller, input: SimulatorsOpenInput): Promise<SimulatorsOpenResult>
  act(caller: SimulatorCaller, input: SimulatorsActInput): Promise<SimulatorsActResult>
  read(caller: SimulatorCaller, input: SimulatorsReadInput): Promise<SimulatorsReadResult>
  shot(caller: SimulatorCaller, input: SimulatorsShotInput): Promise<SimulatorsShotResult>
  record(caller: SimulatorCaller, input: SimulatorsRecordInput): Promise<SimulatorsRecordResult>
  release(caller: SimulatorCaller, input: SimulatorsReleaseInput): Promise<SimulatorsReleaseResult>
  watch(caller: SimulatorCaller, input: SimulatorsWatchInput): Promise<SimulatorsWatchResult>
}

/** A host that can't do this operation: its words go to the caller as the refusal's reason. */
export class SimulatorUnsupported extends Error {
  override readonly name = "SimulatorUnsupported"
}
