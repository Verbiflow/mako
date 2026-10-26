import { z } from "zod"

/*
 * What one turn changed, as the attribution journal counts it: the one
 * record every surface reads for "what did this turn change". It is keyed
 * by the request the turn answered (`LiveRequest.id`), counted from the
 * journal's entries for that turn, and stored with the request in the
 * conversation's journal (`LiveRequest.changes`) and beside the entries in
 * the attribution journal, so a reopened conversation reads the same record
 * a live one drew, and "changes made" is the sum of them.
 *
 * Lines are net, per file: from the content before the turn's first entry
 * on it to the content after its last, each line counted for whoever wrote
 * it last in between. `own` lines are the Thread's for sure (`side` thread);
 * `maybe` lines only timing or a shared window names it for (`side`
 * uncertain: the person's save while the turn ran fits as well). What Git
 * put back while the turn ran (a branch switch or pull the turn's own
 * command made, a stash: the journal's `git` entries) is nobody's, and
 * counts on no side.
 *
 * For a reader that goes further (a turn's diff, its hunks by writer,
 * undoing it): each file carries the journal's root and path, the content
 * on either side by address, and the entries that span it, so its bodies
 * come from `blob(before)` and `blob(after)` and its writers from the
 * entries in `entries.first..entries.last` (`queries.ts` `turnChanges`),
 * whose by `side`, as `writersSince` reads them; an entry marked `git`
 * there is no writer's, and a version Git put back has the writers it had.
 */

/** Bumped when the record's meaning changes; a reader drops one it doesn't know and counts again. */
export const TURN_CHANGES_VERSION = 1

/** Net lines: added and removed, from the turn's start to its end. */
export interface TurnChangeLines {
  added: number
  removed: number
}

/** Files and net lines of one side of a turn. */
export interface TurnChangeShare {
  files: number
  added: number
  removed: number
}

export interface TurnChangedFile {
  /** Absolute, as it is after the turn: a renamed file's new path. */
  path: string
  /** The journal's root and the path inside it, which its entries and line maps are kept under. */
  root: string
  relative: string
  /**
   * What the turn did to the file as a whole: made it, removed it, moved
   * it, or changed its lines. A file the turn made and removed again isn't listed.
   */
  kind: "create" | "modify" | "delete" | "rename"
  /** A renamed file's path before the turn, absolute. */
  from?: string
  /**
   * The Thread's net lines, present when it changed the file for sure;
   * null when the file isn't counted by lines (binary, too large, or its
   * content not kept), and zero lines for a file it only moved.
   */
  own?: TurnChangeLines | null
  /** Lines that might be the Thread's, present when some might. A file can have both. */
  maybe?: TurnChangeLines | null
  /** The content before the turn's first entry and after its last, by address; null where the file wasn't. */
  before: string | null
  after: string | null
  /** The journal entries the turn's change spans, first and last: others' in between are counted as theirs. */
  entries: { first: number; last: number }
}

export interface TurnChanges {
  version: typeof TURN_CHANGES_VERSION
  /**
   * `settling`: counted at the turn's end, from entries the journal may
   * still give another author (a reported effect arriving late); replaced
   * once it settles. `settled`: what the journal holds for good.
   */
  state: "settling" | "settled"
  /** The Thread and its turn: the request the turn answered. */
  thread: string
  turn: string
  /** What the Thread changed for sure. */
  own: TurnChangeShare
  /** What it might have changed: lines a save of the person's or another app's while the turn ran fits as well. */
  maybe: TurnChangeShare
  /** What others (the person, other Threads) changed in the turn's checkout while it ran: counted, never claimed. */
  others: TurnChangeShare
  /** Every file with own or maybe lines, by path; `more` counts those past the cap. */
  files: TurnChangedFile[]
  more: number
  /** The attribution journal it was counted from, and its last entry then: a later entry of the turn counts it again. */
  journal: string
  through: number
  /** When it was counted (epoch milliseconds). */
  at: number
}

/**
 * A request's changes as its conversation keeps them: `pending` from the
 * moment its turn ends until the journal is first read for it (an instant,
 * unless the journal isn't open), then the counted record.
 */
export type RequestChanges = TurnChanges | { version: typeof TURN_CHANGES_VERSION; state: "pending" }

/** The record, counted, or undefined while it's pending or from a version this build doesn't read. */
export function countedChanges(changes: RequestChanges | undefined): TurnChanges | undefined {
  return changes?.version === TURN_CHANGES_VERSION && changes.state !== "pending" ? changes : undefined
}

const Lines = z.object({ added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() })
const Share = z.object({ files: z.number().int().nonnegative(), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() })

export const TurnChangesSchema: z.ZodType<TurnChanges> = z.object({
  version: z.literal(TURN_CHANGES_VERSION),
  state: z.enum(["settling", "settled"]),
  thread: z.string(),
  turn: z.string(),
  own: Share,
  maybe: Share,
  others: Share,
  files: z.array(z.object({
    path: z.string(),
    root: z.string(),
    relative: z.string(),
    kind: z.enum(["create", "modify", "delete", "rename"]),
    from: z.string().optional(),
    own: Lines.nullable().optional(),
    maybe: Lines.nullable().optional(),
    before: z.string().nullable(),
    after: z.string().nullable(),
    entries: z.object({ first: z.number().int(), last: z.number().int() }),
  })),
  more: z.number().int().nonnegative(),
  journal: z.string(),
  through: z.number().int().nonnegative(),
  at: z.number(),
})

/** A request's changes as its journal keeps them; one of a version this build doesn't read is dropped, and counted again. */
export const RequestChangesSchema: z.ZodType<RequestChanges | undefined> = z.union([
  z.object({ version: z.literal(TURN_CHANGES_VERSION), state: z.literal("pending") }),
  TurnChangesSchema,
]).optional().catch(undefined)
