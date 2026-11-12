import { hostLog, hostWarn } from "../base/host-log.js"
import type { AwayEnd, OwnerCheckReading } from "../contracts/sync-readings.js"

/**
 * A check gives up this long after it asked the account, since its latest away ended: a read answers in a second or
 * two, and a wake's network comes back in a few.
 */
export const OWNER_CHECK_MS = 10_000
/** And at most this long after it began, asked or not: the account at a launch can't be asked before its sign-in is read. */
export const OWNER_CHECK_MOST_MS = 30_000
const KEPT = 8

type Check = { why: AwayEnd; since: number; generation: number; askedAt?: number; read: boolean; timer?: ReturnType<typeof setTimeout> }

/**
 * Whether a conversation of this Mac's waits before it runs anything (`Dependencies.ownerCheck`): one begun before this
 * Mac was last back from away, until it hears its account (`CloudConversations.ownerCheck`), an away a turn about to
 * run (`turn`) may begin; and one of a continue this Mac joins now, until the join ends (`CloudMoves.joining`). Since
 * when it waits; undefined when it may run.
 */
export function ownerHold(parts: {
  account(): { ownerCheck(turn: boolean): number | undefined } | undefined
  moves(): { joinsAny(): boolean; joining(session: string): boolean } | undefined
  session(conversationId: string): string | undefined
  /** Since when a Session waits for the account's word after a going-away the account took, with no timer (`AwayNotes.holds`). */
  away?(session: string): number | undefined
}): (conversationId: string, createdAt: number, turn: boolean) => number | undefined {
  return (conversationId, createdAt, turn) => {
    const since = parts.account()?.ownerCheck(turn)
    if (since !== undefined && createdAt < since) return since
    const held = parts.away ? parts.session(conversationId) : undefined
    const away = held === undefined ? undefined : parts.away?.(held)
    if (away !== undefined) return away
    const moves = parts.moves()
    if (!moves?.joinsAny()) return undefined
    const session = parts.session(conversationId)
    return session !== undefined && moves.joining(session) ? Date.now() : undefined
  }
}

export type OwnerCheckOptions = {
  /** The check ended, heard or given up: what it held runs now, here or where the account said. */
  ended(): void
  now?(): number
  checkMs?: number
  mostMs?: number
}

/**
 * Whether this Mac has heard its account since it was last away. While it was, the account may have continued one of
 * its Sessions in the cloud (`beginContinue`, only while this Mac is quiet to it) or moved it, and this Mac can't know
 * until it hears: a turn run here before then could be one the cloud runs too. So each end of an away begins a check,
 * heard once a whole read of the account's list begun after it answers and that list doesn't hold this Mac quiet (the
 * account takes no continue of this Mac's from then: it's reachable). A check gives up `OWNER_CHECK_MS` after it first
 * asked, or `OWNER_CHECK_MOST_MS` after it began: an offline Mac works on.
 */
export class OwnerCheck {
  readonly #options: OwnerCheckOptions
  readonly #now: () => number
  #generation = 0
  #check: Check | undefined
  /** The list holds this Mac quiet, as its last read or event said. */
  #quiet = false
  readonly #readings: OwnerCheckReading[] = []

  constructor(options: OwnerCheckOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  /** Since when what this Mac owns waits for its account; undefined once it heard, gave up, or has none to hear. */
  waiting(): number | undefined {
    return this.#check?.since
  }

  /** An away ended (`AwayEnd`): what this Mac owns waits until a read begun from now is heard. */
  away(why: AwayEnd): void {
    const now = this.#now()
    this.#generation += 1
    const earlier = this.#check
    if (earlier) clearTimeout(earlier.timer)
    this.#check = { why: earlier?.why ?? why, since: earlier?.since ?? now, generation: this.#generation, read: false }
    this.#schedule()
    if (!earlier) hostLog("owner-check", "this Mac checks with its account before it runs a turn of its own", { why })
  }

  /** A read of the account's list begins: the number it answers for (`read`). The first ask starts the check's bound. */
  asking(): number {
    const check = this.#check
    if (check && check.askedAt === undefined) {
      check.askedAt = this.#now()
      this.#schedule()
    }
    return this.#generation
  }

  /** Whether a read begun at `generation` is older than the latest away's end, and another must follow it. */
  behind(generation: number): boolean {
    return generation < this.#generation
  }

  /** A whole read begun at `generation` answered, with whether its list holds this Mac quiet. */
  read(generation: number, quiet: boolean): void {
    this.#quiet = quiet
    const check = this.#check
    if (!check || generation < check.generation) return
    check.read = true
    this.#settle()
  }

  /** The account's stream said this Mac is quiet to it, or reachable again (`device-quiet`). */
  quiet(quiet: boolean): void {
    this.#quiet = quiet
    if (quiet && !this.#check) {
      this.away("quiet")
      this.asking()
      this.#check!.read = true
      return
    }
    this.#settle()
  }

  /**
   * The account's link was tried at once for a check begun while it was down (`unheard`), and didn't open: this Mac is
   * offline, not merely behind its link's backoff, so it works on now rather than wait out the bound.
   */
  unreached(): void {
    const check = this.#check
    if (check?.why === "unheard" && !check.read) this.#end("gave-up", "the account can't be reached")
  }

  /** There's no account to hear: signed out, or a build without the cloud. Nothing waits. */
  none(): void {
    this.#quiet = false
    if (this.#check) this.#end("heard", "no account")
  }

  readings(): OwnerCheckReading[] {
    const check = this.#check
    return check ? [...this.#readings, { why: check.why, at: check.since, outcome: "waiting" }] : [...this.#readings]
  }

  close(): void {
    clearTimeout(this.#check?.timer)
    this.#check = undefined
  }

  #settle(): void {
    if (this.#check?.read && !this.#quiet) this.#end("heard")
  }

  #schedule(): void {
    const check = this.#check
    if (!check) return
    clearTimeout(check.timer)
    const most = check.since + (this.#options.mostMs ?? OWNER_CHECK_MOST_MS)
    const deadline = check.askedAt === undefined ? most : Math.min(most, check.askedAt + (this.#options.checkMs ?? OWNER_CHECK_MS))
    check.timer = setTimeout(() => {
      if (this.#check === check) this.#end("gave-up")
    }, Math.max(0, deadline - this.#now()))
    check.timer.unref?.()
  }

  #end(outcome: "heard" | "gave-up", why?: string): void {
    const check = this.#check!
    clearTimeout(check.timer)
    this.#check = undefined
    const ms = this.#now() - check.since
    this.#readings.push({ why: check.why, at: check.since, outcome, ms })
    if (this.#readings.length > KEPT) this.#readings.splice(0, this.#readings.length - KEPT)
    const fields = { why: check.why, ms, ...check.askedAt !== undefined && { askedAfterMs: check.askedAt - check.since }, ...why && { because: why } }
    if (outcome === "heard") hostLog("owner-check", "this Mac heard its account; what it held runs where the account says", fields)
    else hostWarn("owner-check", "this Mac didn't hear its account in time; what it held runs here", { ...fields, quiet: this.#quiet })
    this.#options.ended()
  }
}
