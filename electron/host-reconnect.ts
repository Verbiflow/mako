import type { HostLogFields } from "@mako/host/base/host-log"
import { HostLaunchFailedError } from "@mako/host/transport/service"

/** What a window's way back to its host needs: attach (start one if none), say there's no host, a timer, whether it still wants one. */
export interface ReconnectDeps {
  /** Attaches to the profile's host, starting one if none runs, and opens the window's stream; settles once that's done or failed. */
  attach(): Promise<void>
  /** No host could be had (`HostLaunchFailedError`): the window's notice offers a restart at once. */
  gone(): void
  /** Runs `run` after `ms`; the returned function cancels it. */
  later(run: () => void, ms: number): () => void
  /** Whether the window still wants its host (not closed, not quitting). */
  wanted(): boolean
}

/** The first try after a drop: a host restarting is usually back by then. */
const FIRST_TRY_MS = 500
/** Each try after one that failed. */
const NEXT_TRY_MS = 2_000

/**
 * A window's way back to its host once its stream ends, as quiet as it can be: it tries again on a backoff, and says
 * there's no host to reach (`gone`) only when one couldn't be had, never while the host that owns the profile is still
 * leaving (`HostLeavingError`, a slow quit, an update or a restart) or doesn't answer, which the window's own stages
 * say as they go (`host-connection.ts`). Try now (`now`) runs the next try at once, or waits on the one under way.
 */
export class HostReconnect {
  readonly #deps: ReconnectDeps
  #cancel: (() => void) | undefined
  #attempt: Promise<void> | undefined
  #goneSaid = false

  constructor(deps: ReconnectDeps) {
    this.#deps = deps
  }

  /** The stream ended: try again after a moment. */
  lost(): void {
    this.#schedule(FIRST_TRY_MS)
  }

  /** The stream is back: a later loss may say `gone` again. */
  reconnected(): void {
    this.#goneSaid = false
  }

  /** Try now: the next try at once, or the one under way; settles when that try does. Nothing pending, nothing to do. */
  now(): Promise<void> {
    if (this.#attempt) return this.#attempt
    if (!this.#cancel) return Promise.resolve()
    this.#cancel()
    this.#cancel = undefined
    return this.#try()
  }

  dispose(): void {
    this.#cancel?.()
    this.#cancel = undefined
  }

  #schedule(ms: number): void {
    this.#cancel?.()
    this.#cancel = this.#deps.later(() => {
      this.#cancel = undefined
      void this.#try()
    }, ms)
  }

  #try(): Promise<void> {
    if (!this.#deps.wanted()) return Promise.resolve()
    const attempt = this.#deps.attach().catch((error) => {
      if (!this.#deps.wanted()) return
      if (error instanceof HostLaunchFailedError && !this.#goneSaid) {
        this.#goneSaid = true
        this.#deps.gone()
      }
      this.#schedule(NEXT_TRY_MS)
    }).finally(() => {
      if (this.#attempt === attempt) this.#attempt = undefined
    })
    this.#attempt = attempt
    return attempt
  }
}

/** What ending a host that answers nothing needs: its probe, the lock's holder, a process's command line, and signals. */
export interface HungHostDeps {
  /** Whether the profile's host answers: `ready`, nothing there (`absent`), or neither within a short wait. */
  answers(): Promise<"ready" | "absent" | "silent">
  /** The live process holding the data root's host lock, read without taking it (`hostLockHolder`). */
  holder(): Promise<number | null>
  /** A process's command line, or "" when it can't be read. */
  commandOf(pid: number): Promise<string>
  /** The host's entry script, which a Mako host's command line names (`hostCommand`). */
  entry: string
  /**
   * Whether `pid` has this profile's host lock or its socket open now (`lsof -a -p <pid> -- <lock> <socket>`): the
   * proof it's this profile's host, which a command line can't give (every profile's host runs the same entry) and the
   * lock file's text can't either (on macOS it names the last pid that wrote it, which may since be another process).
   */
  holds(pid: number): Promise<boolean>
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void
  alive(pid: number): boolean
  wait(ms: number): Promise<void>
  log(message: string, fields: HostLogFields): void
}

/**
 * Whether `pid` has any of `paths` open, each asked on its own: `lsof -a -p <pid> -- <a> <b>` exits 1 when any path
 * named isn't open, so one host holding its lock with its socket closed read as holding neither. `open` answers whether
 * that process has that one path open.
 */
export async function holdsAny(pid: number, paths: readonly string[], open: (pid: number, path: string) => Promise<boolean>): Promise<boolean> {
  const held = await Promise.all(paths.map((path) => open(pid, path).catch(() => false)))
  return held.some(Boolean)
}

/** How long a host asked to quit has to leave before it's ended: its own stop runs in this, saving what it holds. */
export const HUNG_HOST_GRACE_MS = 10_000

/**
 * Restart Mako with a host that answers nothing (alive, holding the profile's lock): the client alone would meet the
 * same host again. It's asked to quit (SIGTERM, its own stop), and ended past `HUNG_HOST_GRACE_MS` (SIGKILL), so the
 * client opened again starts a fresh one. Ending the wrong process is the one thing it must never do, so before each
 * signal the pid must be shown to be this profile's host: its command line names the host's entry, and it holds this
 * profile's lock or socket open (`holds`). A stale pid in the lock file, another profile's host, or a pid the kernel
 * gave another process during the grace is left alone. A host that answers, or none, is left as it is.
 */
export async function endHungHost(deps: HungHostDeps): Promise<"answering" | "none" | "not-mako" | "ended" | "stuck"> {
  // Only a host that answers is left as it is: one whose socket is gone (`absent`) may still hold the lock, hung after it
  // closed its socket, and the client opened again would meet it there. The lock's holder decides, proved below.
  if (await deps.answers() === "ready") return "answering"
  const pid = await deps.holder()
  if (pid === null) return "none"
  const ours = async () => Boolean(deps.entry) && (await deps.commandOf(pid)).includes(deps.entry) && await deps.holds(pid)
  if (!await ours()) {
    deps.log("restart leaves a lock holder that isn't this profile's Mako host", { pid })
    return "not-mako"
  }
  deps.log("restart asks a host that answers nothing to quit", { pid })
  deps.signal(pid, "SIGTERM")
  for (const end = Date.now() + HUNG_HOST_GRACE_MS; deps.alive(pid) && Date.now() < end; ) await deps.wait(200)
  if (!deps.alive(pid)) return "ended"
  // Ten seconds is time for the host to have left and the kernel to give its pid to another process: proved again.
  if (!await ours()) {
    deps.log("restart's host left; its pid is another process's now, left alone", { pid })
    return "ended"
  }
  deps.log("restart ends a host that didn't quit", { pid, graceMs: HUNG_HOST_GRACE_MS })
  deps.signal(pid, "SIGKILL")
  for (const end = Date.now() + 5_000; deps.alive(pid) && Date.now() < end; ) await deps.wait(100)
  return deps.alive(pid) ? "stuck" : "ended"
}
