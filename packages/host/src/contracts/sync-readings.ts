/**
 * How this device's sync is going, as Diagnostics shows it: for each stream it follows of another device's work, how
 * long a traced update took to arrive, the numbers it skipped, the times it read the conversation again whole, and the
 * times its link was replaced, with why; for the account's list, its stream's number, its gaps, and how long a change
 * took from its owner to here. Kept in memory and small, on a Mac's host and in a phone's page alike.
 *
 * Times across devices are each device's own clock: a lag is as good as the two clocks agree, which on devices that
 * keep time is within a few milliseconds.
 */

/** Why a followed stream was followed again. */
export type FollowAgainReason = "closed" | "silent" | "gap" | "failed"

export type Spread = { samples: number; p50?: number; p95?: number }

export type FollowReading = {
  stream: string
  /** What the person knows it by: the conversation's title, or where it runs. */
  label?: string
  frames: number
  lastHeardAt?: number
  /** From its owner's emitting a traced update to its arrival here. */
  lagMs: Spread
  gaps: number
  rereads: number
  probes: number
  /** The latest few, newest last. */
  reconnects: Array<{ at: number; why: FollowAgainReason }>
}

export type SyncReadings = {
  at: number
  follows: FollowReading[]
  list: {
    seq?: number
    gaps: Array<{ at: number; after: number; seq: number; why: string }>
    /** From its owner's change to its arrival here, for each row that said when it changed (`changedAt`). */
    changeMs: Spread
  }
  /** What this device sends of its own conversations that others watch; absent where it runs none (a phone). */
  owner?: OwnerReading
}

/** What a device sends of its own conversations others watch: how many, and what went again after a reconnect. */
export type OwnerReading = { watched: number; resent: number; notices: number }

const KEPT_SAMPLES = 200
const KEPT_RECONNECTS = 8
const KEPT_FOLLOWS = 50
const KEPT_GAPS = 8

function spread(samples: readonly number[]): Spread {
  if (!samples.length) return { samples: 0 }
  const sorted = [...samples].sort((left, right) => left - right)
  const at = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!)
  return { samples: sorted.length, p50: at(0.5), p95: at(0.95) }
}

const keep = <T>(list: T[], item: T, most: number) => {
  list.push(item)
  if (list.length > most) list.splice(0, list.length - most)
}

/** One followed stream's readings, written as its follower hears and loses it. */
export class FollowRecorder {
  label: string | undefined
  #frames = 0
  #lastHeardAt: number | undefined
  readonly #lag: number[] = []
  #gaps = 0
  #rereads = 0
  #probes = 0
  readonly #reconnects: Array<{ at: number; why: FollowAgainReason }> = []

  readonly stream: string
  readonly #now: () => number

  constructor(stream: string, now: () => number) {
    this.stream = stream
    this.#now = now
  }

  /** An update arrived; with `emittedAt` when its owner traced it. */
  heard(emittedAt?: number): void {
    const at = this.#now()
    this.#frames += 1
    this.#lastHeardAt = at
    if (emittedAt !== undefined) keep(this.#lag, Math.max(0, at - emittedAt), KEPT_SAMPLES)
  }

  gap(): void {
    this.#gaps += 1
  }

  reread(): void {
    this.#rereads += 1
  }

  probe(): void {
    this.#probes += 1
  }

  followedAgain(why: FollowAgainReason): void {
    keep(this.#reconnects, { at: this.#now(), why }, KEPT_RECONNECTS)
  }

  reading(): FollowReading {
    return {
      stream: this.stream,
      ...(this.label && { label: this.label }),
      frames: this.#frames,
      ...(this.#lastHeardAt !== undefined && { lastHeardAt: this.#lastHeardAt }),
      lagMs: spread(this.#lag),
      gaps: this.#gaps,
      rereads: this.#rereads,
      probes: this.#probes,
      reconnects: [...this.#reconnects],
    }
  }
}

export class SyncRecorder {
  readonly #now: () => number
  readonly #follows = new Map<string, FollowRecorder>()
  #seq: number | undefined
  readonly #gaps: SyncReadings["list"]["gaps"] = []
  readonly #changes: number[] = []
  #owner: (() => OwnerReading) | undefined

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** The readings of one followed stream, kept while it's among the latest followed. */
  follow(stream: string, label?: string): FollowRecorder {
    let found = this.#follows.get(stream)
    if (!found) {
      found = new FollowRecorder(stream, this.#now)
      this.#follows.set(stream, found)
      for (const oldest of this.#follows.keys()) {
        if (this.#follows.size <= KEPT_FOLLOWS) break
        this.#follows.delete(oldest)
      }
    }
    if (label) found.label = label
    return found
  }

  /** The account's stream reached `seq`. */
  listHeard(seq: number): void {
    this.#seq = seq
  }

  listGap(gap: { after: number; seq: number; why: string }): void {
    keep(this.#gaps, { at: this.#now(), ...gap }, KEPT_GAPS)
  }

  /** A row arrived that says when its owner changed it. */
  listChanged(changedAt: string): void {
    const at = Date.parse(changedAt)
    if (Number.isFinite(at)) keep(this.#changes, Math.max(0, this.#now() - at), KEPT_SAMPLES)
  }

  /** Where what this device sends of its own watched conversations is read from. */
  ownerFrom(read: () => OwnerReading): void {
    this.#owner = read
  }

  readings(): SyncReadings {
    return {
      at: this.#now(),
      follows: [...this.#follows.values()].map((follow) => follow.reading()),
      list: { ...(this.#seq !== undefined && { seq: this.#seq }), gaps: [...this.#gaps], changeMs: spread(this.#changes) },
      ...(this.#owner && { owner: this.#owner() }),
    }
  }
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const times = (count: number) => (count === 1 ? "once" : count === 2 ? "twice" : `${count} times`)
const spreadText = (what: string, spread: Spread) =>
  spread.p50 === undefined ? undefined : `${what} in ${spread.p50} ms typically, ${spread.p95} ms at worst`
const REASON_TEXT = { closed: "link dropped", silent: "went silent", gap: "skipped an update", failed: "couldn't follow" } as const satisfies Record<FollowAgainReason, string>

/** One followed stream in a line Diagnostics shows: how fast it arrives, and what it took to keep it whole. */
export function describeFollow(follow: FollowReading): string {
  const reasons = [...new Set(follow.reconnects.map((reconnect) => REASON_TEXT[reconnect.why]))]
  return [
    spreadText("updates arrive", follow.lagMs) ?? `${plural(follow.frames, "update")} heard`,
    follow.gaps ? `${plural(follow.gaps, "skipped update")} asked for again` : undefined,
    follow.rereads ? `read again whole ${times(follow.rereads)}` : undefined,
    follow.reconnects.length ? `followed again ${times(follow.reconnects.length)} (${reasons.join(", ")})` : undefined,
  ].filter(Boolean).join(" · ")
}

/** The account's list in a line: where its stream is, how fast a change arrives, and what was read again after a gap. */
export function describeList(list: SyncReadings["list"]): string {
  return [
    list.seq === undefined ? "not followed yet" : `at event ${list.seq}`,
    spreadText("changes arrive", list.changeMs),
    list.gaps.length ? `read whole again after ${plural(list.gaps.length, "gap")}` : undefined,
  ].filter(Boolean).join(" · ")
}

/** What this device sends of its own watched conversations, in a line; undefined when there's nothing to say. */
export function describeOwner(owner: SyncReadings["owner"]): string | undefined {
  if (!owner || (!owner.watched && !owner.resent && !owner.notices)) return undefined
  return [
    `${plural(owner.watched, "conversation")} watched from another device`,
    owner.resent ? `${plural(owner.resent, "update")} sent again after a reconnect` : undefined,
    owner.notices ? `${plural(owner.notices, "watcher")} told to read again` : undefined,
  ].filter(Boolean).join(" · ")
}
