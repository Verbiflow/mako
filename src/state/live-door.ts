/**
 * The one door by which anything about a live conversation reaches this window's state (`receiveLive`): a batch, one
 * that waited on a snapshot, a listing or a reconnect's summaries, an unlisting, its owner's connection, a move's step,
 * a snapshot (a read's, an action's answer), a history page. Whatever its host says on its own goes on the record of
 * every read of it out, so no answer of a read speaks for what came after it was asked.
 */

/**
 * A read of a conversation's snapshot while it's out: the newest revision this window has taken of it since it was
 * asked, whether anything came for it on the stream meanwhile (`moved`), the newest batch that came (`heard`), and
 * whether its host has since stopped listing it here (`unlisted`), after which its answer speaks for nothing held.
 */
export type ReadOut = { revision: number; epoch?: string; moved?: true; heard?: { epoch: string; revision: number }; unlisted?: true }

/**
 * The reads out of each conversation (`readBackLive`, `hydrateLive`): each answer older than what this window took of
 * its conversation while it was out is past, whatever this window holds of it by then (it may have let it go, or no
 * longer list it). Kept only while each read is out.
 */
export const readsOut = new Map<string, Set<ReadOut>>()

/**
 * The host start this window last learned each conversation is of now: from what its host said on its own (a batch, a
 * listing) or a snapshot it took. A reply of that start is the current host's, whatever its order against what's held;
 * one of any other it can't order is past or unknown.
 */
export const currentStarts = new Map<string, string>()

/**
 * What reached this window about a conversation. `said`: its host's own word, unasked (a batch on the stream, a listing
 * or a reconnect's summary, an unlisting, its owner's connection, a move's step), with the start and revision it's of
 * where it names them. `answer`: what this window asked for (a read, an action's answer, a history page, a batch that
 * waited on a snapshot), weighed against what it holds where it's taken.
 */
export type Received = { from: "said"; epoch?: string; revision?: number; unlisted?: true } | { from: "answer" }

/** Conversations whose news is being taken in now, each by how many doors deep. */
const taking = new Map<string, number>()

/**
 * Every conversation unlisted while any read is out, by when (`unlistedSince`), so a read's answer about one it didn't
 * name (a path's owner, a capture of a session another conversation holds, a start another host took, a move that
 * kept the conversation, the rewinds a host recovers) is weighed as one about the conversation it was keyed by is. And
 * how many reads out name no conversation at all.
 */
const unplaced = { out: 0, said: 0, unlisted: new Map<string, number>() }

/** When a read goes out, by what has been unlisted since: what `unlistedSince` weighs its answer against. */
export function readsSince(): number {
  return unplaced.said
}

/** A read out of no conversation the window names yet: when it went out (`readsSince`). */
export function unplacedReadGoesOut(): number {
  unplaced.out += 1
  return unplaced.said
}

/** That read is answered. With no read left out, what was unlisted meanwhile is nobody's to weigh. */
export function unplacedReadAnswered(): void {
  unplaced.out = Math.max(0, unplaced.out - 1)
  readsSettled()
}

/** With no read of any conversation out, what was unlisted meanwhile is nobody's to weigh. */
export function readsSettled(): void {
  if (!unplaced.out && !readsOut.size) unplaced.unlisted.clear()
}

/** Whether conversation `id` was unlisted after a read that went out at `since`: its answer of it speaks for nothing held. */
export function unlistedSince(id: string, since: number): boolean {
  return (unplaced.unlisted.get(id) ?? -1) > since
}

/**
 * Whether a read of conversation `id` is out now (`readLive`, `hydrateLive`), or with no `id`, a read of one the window
 * learns from its answer: what a test watches the bridge by, so no read of a conversation goes around them.
 */
export function readingLive(id?: string): boolean {
  return id === undefined ? unplaced.out > 0 : readsOut.has(id)
}

/**
 * Takes in what reached this window about conversation `id` (`take` writes it into its state). What its host said goes
 * on the record of every read of it out first, whatever it is or becomes (taken, waiting on a read, of another start,
 * or nothing new): the read no longer speaks alone, and an answer behind a batch it heard is past. One that names its
 * start says the start the conversation is of now.
 */
export function receiveLive<T>(id: string, received: Received, take: () => T): T {
  if (received.from === "said") {
    if (received.epoch) currentStarts.set(id, received.epoch)
    if (received.unlisted && (unplaced.out || readsOut.size)) unplaced.unlisted.set(id, (unplaced.said += 1))
    for (const read of readsOut.get(id) ?? []) {
      read.moved = true
      if (received.unlisted) read.unlisted = true
      const { epoch, revision } = received
      if (epoch && revision !== undefined && (read.heard?.epoch !== epoch || read.heard.revision < revision)) read.heard = { epoch, revision }
    }
  }
  taking.set(id, (taking.get(id) ?? 0) + 1)
  try {
    return take()
  } finally {
    const left = (taking.get(id) ?? 1) - 1
    if (left) taking.set(id, left)
    else taking.delete(id)
  }
}

/**
 * The window lets a conversation go on its own (the person closed it): no word of its host's, so it goes on no read's
 * record, but it changes the conversation's state, and only here or through the door (`receiveLive`) does anything.
 */
export function letGoLive<T>(id: string, take: () => T): T {
  return receiveLive(id, { from: "answer" }, take)
}

/**
 * Whether the conversation's state is being changed now through the door (`receiveLive`) or by the window letting it go
 * (`letGoLive`): what a test watches by.
 */
export function receivingLive(id: string): boolean {
  return taking.has(id)
}
