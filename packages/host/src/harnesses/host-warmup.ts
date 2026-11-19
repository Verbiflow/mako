import { hostLog } from "../base/host-log.js"

/**
 * What a host's first launch of a harness loads into the host itself, loaded ahead: the launch then finds it in
 * memory. Measured on Claude Code (2026-11-18, `npm run bench:vs-bare -- --scenarios first`): a new host's first
 * launch took about 300 ms a later one doesn't, in the settings reader's worker, the Agent SDK's package, Mako's MCP
 * servers and what `claudeSdkOptions` imports.
 *
 * Only loads and reads the launch reuses: never a harness process, which holds hundreds of megabytes and is the
 * person's to start. Each piece is one the launch runs itself when it gets there first (a lazy package's load, a
 * worker's start), so a send never waits for the warm-up: it finds the piece loaded, joins the load under way, or
 * does it.
 */
export interface HostWarmup {
  via: string
  pieces: readonly WarmPiece[]
}

export interface WarmPiece {
  name: string
  /** Loads it; a piece a launch already loaded answers at once. */
  load(): Promise<void>
}

export interface WarmOutcome {
  name: string
  state: "loaded" | "failed" | "left"
  ms: number
}

export interface HostWarmupDependencies {
  /** Whether a person waits on a start now (`Foreground.busy`), and when none does (`Foreground.idle`). */
  busy(): boolean
  idle(): Promise<void>
  /** Gives the loop back between pieces, so what arrived meanwhile runs first. A turn of the loop unless given. */
  pause?(): Promise<void>
  /** The host is stopping: nothing more is loaded. */
  stopped?(): boolean
  now?(): number
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * Loads each piece in turn, one at a time, only while nobody waits on a start: a start that begins meanwhile holds
 * the pieces after the one under way until it's over, and loads what it needs itself. A piece that fails is logged
 * and the rest go on; the launch that needs it meets the failure itself.
 */
export async function warmHost(pieces: readonly WarmPiece[], dependencies: HostWarmupDependencies): Promise<WarmOutcome[]> {
  const now = dependencies.now ?? (() => performance.now())
  const pause = dependencies.pause ?? turn
  const outcomes: WarmOutcome[] = []
  for (const piece of pieces) {
    await pause()
    if (dependencies.busy()) await dependencies.idle()
    if (dependencies.stopped?.()) {
      outcomes.push({ name: piece.name, state: "left", ms: 0 })
      continue
    }
    const began = now()
    const state = await piece.load().then((): WarmOutcome["state"] => "loaded", (): WarmOutcome["state"] => "failed")
    outcomes.push({ name: piece.name, state, ms: Math.round(now() - began) })
  }
  return outcomes
}

export interface WarmableDriver {
  provider: string
  available(cwd: string): boolean
  hostWarmup?: HostWarmup
}

/**
 * The pieces to load for the harnesses a person has used here and that are installed, the host's own first (every
 * harness's launch needs those, whether or not it declares pieces of its own): a harness never used on this device
 * loads nothing, so its packages and worker cost no memory until it's started.
 */
export function warmPieces(input: { drivers: readonly WarmableDriver[]; used: readonly string[]; cwd: string; shared: readonly WarmPiece[] }): WarmPiece[] {
  const warmed = input.drivers.filter((driver) => input.used.includes(driver.provider) && driver.available(input.cwd))
  if (!warmed.length) return []
  return [...input.shared, ...warmed.flatMap((driver) => (driver.hostWarmup?.pieces ?? []).map((piece) => ({ ...piece, name: `${driver.provider}: ${piece.name}` })))]
}

/**
 * The host's warm-up, run when asked and at most one at a time: once the host is ready, and again when someone starts
 * writing a new conversation's first message (the settings reader's worker stops after ten idle minutes, and a
 * harness first used since is new to it). A run asked for while one is under way is that run.
 */
export class HostWarmer {
  #running: Promise<WarmOutcome[]> | undefined
  readonly #pieces: () => WarmPiece[]
  readonly #dependencies: HostWarmupDependencies

  constructor(pieces: () => WarmPiece[], dependencies: HostWarmupDependencies) {
    this.#pieces = pieces
    this.#dependencies = dependencies
  }

  warm(why: string): Promise<WarmOutcome[]> {
    this.#running ??= this.#run(why).finally(() => { this.#running = undefined })
    return this.#running
  }

  async #run(why: string): Promise<WarmOutcome[]> {
    const began = performance.now()
    const outcomes = await warmHost(this.#pieces(), this.#dependencies)
    // Only a run that loaded something new is worth a line: each later one finds everything in memory.
    const slow = outcomes.filter((outcome) => outcome.state !== "loaded" || outcome.ms >= 5)
    if (slow.length) hostLog("warmup", "loaded ahead of a first launch", { why, ms: Math.round(performance.now() - began), pieces: slow.map((outcome) => `${outcome.name} ${outcome.state === "loaded" ? `${outcome.ms} ms` : outcome.state}`).join(", ") })
    return outcomes
  }
}
