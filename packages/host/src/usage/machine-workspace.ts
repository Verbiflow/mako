import { hostLog, hostWarn } from "../base/host-log.js"

/** The Thread's folder on a cloud machine, as its agent last said: made at `path`, or why it couldn't be. */
export type MachineWorkspaceOutcome = { path: string } | { problem: string }

/** How long a move waits for the agent to make the folder again: a clone that's tried again, with room. */
export const WORKSPACE_RETRY_MS = 90_000

/**
 * The Thread's folder on a cloud machine, which its agent makes as the machine boots (a clone of the Thread's
 * repository). A clone can fail on something that passes (the repository's host dropped a fetch), and the machine may
 * wait paused for hours before a move asks for it, so what failed is asked again when a move needs it
 * (`settled`): the agent clones afresh, and the move goes on with the folder or the newest reason it wasn't made.
 */
export class MachineWorkspace {
  #outcome: MachineWorkspaceOutcome | undefined
  readonly #waiters: Array<(outcome: MachineWorkspaceOutcome) => void> = []
  #again: Promise<MachineWorkspaceOutcome> | undefined
  readonly #retry: () => boolean
  readonly #retryMs: number

  /** `retry` asks the agent to make the folder again, answering false when it can't be asked. */
  constructor(retry: () => boolean, retryMs = WORKSPACE_RETRY_MS) {
    this.#retry = retry
    this.#retryMs = retryMs
  }

  /** The agent made the folder. */
  opened(path: string): void {
    this.#settle({ path })
  }

  /** The agent said why it couldn't make the folder. */
  failed(problem: string): void {
    this.#settle({ problem })
  }

  /** Why the folder wasn't made, as the agent last said; undefined while it's made or still being made. */
  get problem(): string | undefined {
    return this.#outcome && "problem" in this.#outcome ? this.#outcome.problem : undefined
  }

  /**
   * The folder once the agent made it, or why it couldn't. One that failed is asked for again, once per ask (several
   * asking at once share it), and the answer is the agent's new word, or the old one if none came in time.
   */
  async settled(): Promise<MachineWorkspaceOutcome> {
    const outcome = this.#outcome ?? (await this.#next())
    if (!("problem" in outcome)) return outcome
    this.#again ??= this.#tryAgain(outcome).finally(() => {
      this.#again = undefined
    })
    return this.#again
  }

  async #tryAgain(failed: { problem: string }): Promise<MachineWorkspaceOutcome> {
    if (!this.#retry()) return failed
    const began = performance.now()
    hostLog("machine", "asked the agent to make the Thread's folder again", { problem: failed.problem })
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.#retryMs)
      timer.unref()
    })
    const next = await Promise.race([this.#next(), late])
    clearTimeout(timer)
    if (!next) {
      hostWarn("machine", "the agent didn't say whether it made the Thread's folder again", { waitedMs: this.#retryMs })
      return failed
    }
    if ("path" in next) hostLog("machine", "the Thread's folder was made on asking again", { ms: Math.round(performance.now() - began) })
    return next
  }

  #next(): Promise<MachineWorkspaceOutcome> {
    return new Promise((resolve) => this.#waiters.push(resolve))
  }

  #settle(outcome: MachineWorkspaceOutcome): void {
    this.#outcome = outcome
    for (const waiter of this.#waiters.splice(0)) waiter(outcome)
  }
}
