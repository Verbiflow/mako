import { randomUUID } from "node:crypto"
import type { TokenCounts } from "../contracts/providers-acp.js"
import { addTokens, type HelperRun } from "../contracts/usage-ledger.js"

/** Where a helper run goes once it ends; the host's `HelperRuns`, which prices it. */
export type RecordHelperRun = (run: HelperRun) => void

/** What one helper task's model calls spent, as each call reports it, until the task ends. */
export class HelperTally {
  private readonly started = Date.now()
  private calls = 0
  private tokens?: TokenCounts

  /** One call ended; `tokens` when the provider reported them. */
  readonly add = (tokens: TokenCounts | undefined): void => {
    this.calls += 1
    if (tokens) this.tokens = addTokens(this.tokens, tokens)
  }

  run(fields: Pick<HelperRun, "purpose" | "trigger" | "connection" | "cwd" | "outcome">): HelperRun {
    const run: HelperRun = { id: randomUUID(), at: this.started, durationMs: Date.now() - this.started, calls: this.calls, ...fields }
    if (this.tokens) run.tokens = this.tokens
    return run
  }
}
