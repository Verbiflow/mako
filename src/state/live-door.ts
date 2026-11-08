/**
 * The one door by which anything about a live conversation reaches this window's state (`receiveLive`): a batch, one
 * that waited on a snapshot, a listing or a reconnect's summaries, an unlisting, its owner's connection, a move's step,
 * a snapshot (a read's, an action's answer), a history page. Whatever its host says on its own goes on the record of
 * every read of it out, so no answer of a read speaks for what came after it was asked.
 */

/**
 * A read of a conversation's snapshot while it's out: the newest revision this window has taken of it since it was
 * asked, whether anything came for it on the stream meanwhile (`moved`), and the newest batch that came (`heard`).
 */
export type ReadOut = { revision: number; epoch?: string; moved?: true; heard?: { epoch: string; revision: number } }

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
export type Received = { from: "said"; epoch?: string; revision?: number } | { from: "answer" }

/** Conversations whose news is being taken in now, each by how many doors deep. */
const taking = new Map<string, number>()

/**
 * Takes in what reached this window about conversation `id` (`take` writes it into its state). What its host said goes
 * on the record of every read of it out first, whatever it is or becomes (taken, waiting on a read, of another start,
 * or nothing new): the read no longer speaks alone, and an answer behind a batch it heard is past. One that names its
 * start says the start the conversation is of now.
 */
export function receiveLive<T>(id: string, received: Received, take: () => T): T {
  if (received.from === "said") {
    if (received.epoch) currentStarts.set(id, received.epoch)
    for (const read of readsOut.get(id) ?? []) {
      read.moved = true
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

/** Whether what reached this window about `id` is being taken in now, through `receiveLive`: what a test watches by. */
export function receivingLive(id: string): boolean {
  return taking.has(id)
}
