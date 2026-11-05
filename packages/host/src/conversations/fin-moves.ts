import { hostWarn } from "../base/host-log.js"
import { errorMessage } from "../base/error-message.js"
import type { AccessTier } from "../contracts/access.js"
import { fallbackOrder, placeKey, stepKey, type AccountContinuation, type FallbackAccount, type FallbackConnection, type FallbackStep } from "../contracts/fin-fallback.js"

/** What a Fin's fallback order reads of the host (`contracts/fin-fallback.ts`), each through its existing store. */
export interface FinMovesDeps {
  /** Settings › Fins: "When an account runs out, continue on the next one". */
  on(): boolean
  /** The harness's accounts in the person's order; `on` is the one the Fin runs on, `all` reads every one's room. */
  accounts(harness: string, on?: string, all?: boolean): Promise<readonly FallbackAccount[]>
  /** The person's model connections as `harness`'s declared routes take them. */
  connections?(harness: string): Promise<readonly FallbackConnection[]>
  continuation(harness: string): AccountContinuation | undefined
  /** The person's harnesses, most preferred first (Settings › Models), and those with a live driver here. */
  harnessOrder(): Promise<readonly string[]>
  harnesses(): readonly string[]
  /** Whether `harness` offers a mode at or below `tier` (`childMode`). */
  fits(harness: string, tier: AccessTier): boolean
  signedIn(harness: string, cwd: string | undefined): Promise<boolean>
  /** Whether `harness`'s account in use is at its limit. */
  spent(harness: string): Promise<boolean>
}

/** Where a Fin is: its harness, the account it runs on there and its model. */
export interface FinPlace {
  harness: string
  account?: string
  model?: string
}

/** The order from a place, and the account there as it stands. */
export interface FinOrder {
  steps: FallbackStep[]
  accounts: readonly FallbackAccount[]
  /** The account the Fin runs on, when the harness lists one. */
  from?: FallbackAccount
}

/**
 * A Fin's moves when its harness's account runs out: the order built from the
 * person's setup, and what each Fin's turn already moved through, so it moves
 * at most once for a limit and never back to a place this turn ran on. A turn
 * that ends without a limit clears it (`settled`), and the Fin's next start
 * goes from the person's first choice again.
 */
export class FinMoves {
  private readonly deps: FinMovesDeps
  /** By Fin: the places its turn ran on (`placeKey`), and the failed requests it already moved for. */
  private readonly turns = new Map<string, { visited: Set<string>; moved: Set<string> }>()

  constructor(deps: FinMovesDeps) {
    this.deps = deps
  }

  on(): boolean {
    try {
      return this.deps.on()
    } catch {
      return true
    }
  }

  /** The accounts of `harness` as they stand, the one the Fin runs on read first (`HarnessAccounts.standing`). */
  async accounts(harness: string, on?: string, all = false): Promise<readonly FallbackAccount[]> {
    return this.deps.accounts(harness, on, all).catch((error) => {
      hostWarn("agents", "a harness's accounts couldn't be read; it's taken as having room", { harness, error: errorMessage({ error }) })
      return []
    })
  }

  /** The steps from `from`, at a Fin's start or mid-run, for a Fin at `tier` in `cwd`, past the places its turn ran on. */
  async order(input: { from: FinPlace; when: "start" | "mid-run"; tier: AccessTier; cwd?: string; child?: string; accounts?: readonly FallbackAccount[] }): Promise<FinOrder> {
    const { from, when, tier, cwd } = input
    const live = this.deps.harnesses()
    const ordered = [...new Set([...((await this.deps.harnessOrder().catch(() => undefined)) ?? []), ...live])].filter((harness) => live.includes(harness))
    const [accounts, connections, harnesses] = await Promise.all([
      input.accounts ?? this.accounts(from.harness, from.account, when === "mid-run"),
      this.deps.connections?.(from.harness).catch(() => []) ?? [],
      Promise.all(ordered.filter((harness) => harness !== from.harness).map(async (harness) => {
        const fits = this.deps.fits(harness, tier)
        const [signedIn, spent] = fits ? await Promise.all([this.deps.signedIn(harness, cwd).catch(() => false), this.deps.spent(harness).catch(() => false)]) : [false, false]
        return { harness, fits, signedIn, spent }
      })),
    ])
    const account = from.account ?? accounts.find((each) => each.active)?.name
    const turn = input.child ? this.turns.get(input.child) : undefined
    const steps = fallbackOrder({
      from: { ...from, ...(account !== undefined && { account }) },
      when,
      on: this.on(),
      accounts,
      ...(this.deps.continuation(from.harness) && { continuation: this.deps.continuation(from.harness)! }),
      connections,
      harnesses,
      visited: [placeKey({ harness: from.harness, ...(account !== undefined && { account }) }), ...(turn?.visited ?? [])],
    })
    const standing = accounts.find((each) => each.name === account)
    return { steps, accounts, ...(standing && { from: standing }) }
  }

  /** Whether the Fin's turn already moved for this failed request: one limit, one move. */
  movedFor(child: string, request: string): boolean {
    return this.turns.get(child)?.moved.has(request) ?? false
  }

  /** The Fin moved from `from` to `step` for `request`: neither is a place its turn goes back to. */
  moved(child: string, request: string, from: FinPlace, step: FallbackStep): void {
    const turn = this.turns.get(child) ?? { visited: new Set<string>(), moved: new Set<string>() }
    turn.visited.add(placeKey(from))
    turn.visited.add(stepKey(step))
    turn.moved.add(request)
    this.turns.set(child, turn)
  }

  /** The Fin's turn ended without a limit: its next one starts from the person's first choice. */
  settled(child: string): void {
    this.turns.delete(child)
  }
}
