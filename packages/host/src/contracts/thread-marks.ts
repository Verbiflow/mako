import { z } from "zod"

/**
 * What the person marks a Thread with, beside its name: where its work stands (a workflow status, as Linear's), and
 * that it's to be read again (Mark as unread). Both are the Thread's, kept in the Thread store, and every window and
 * the person's other devices show the same: the desk's rail, the phone's list. A merged pull request of the Thread's
 * own worktree marks it Done by itself (`by: "pull"`), once per pull request, so moving it back holds.
 */
export const WORK_STATUSES = ["backlog", "in-progress", "in-review", "done"] as const
export const WorkStatusSchema = z.enum(WORK_STATUSES)
export type WorkStatus = z.infer<typeof WorkStatusSchema>

export const WORK_STATUS_WORDS = {
  backlog: "Backlog",
  "in-progress": "In progress",
  "in-review": "In review",
  done: "Done",
} as const satisfies Record<WorkStatus, string>

/** A Done Thread leaves its project's rows for the project's "N done" line once it has been Done this long. */
export const DONE_FOLDS_AFTER_MS = 3 * 24 * 60 * 60_000

export interface ThreadMarkEntry {
  thread: string
  /** Where its work stands; null: no status. */
  status: WorkStatus | null
  /** When the status was set, ms. */
  statusAt: number | null
  /** Who set it: the person, or a merged pull request (`pull`). */
  by: "person" | "pull" | null
  /** When the person marked it to read again; null once it's read. */
  unreadAt: number | null
}

/** A change to a Thread's marks: `status` (null clears it) and `unread`, each only when given. */
export const ThreadMarkChangeSchema = z
  .object({ status: WorkStatusSchema.nullable().optional(), unread: z.boolean().optional() })
  .strict()
  .refine((change) => change.status !== undefined || change.unread !== undefined, "A mark change changes something")
export type ThreadMarkChange = z.infer<typeof ThreadMarkChangeSchema>

/** Whether a Done Thread has been Done long enough to fold into its project's "N done" line. */
export function foldsAsDone(entry: Pick<ThreadMarkEntry, "status" | "statusAt"> | undefined, now: number): boolean {
  return entry?.status === "done" && entry.statusAt !== null && now - entry.statusAt >= DONE_FOLDS_AFTER_MS
}

/** Whether an entry marks nothing, so a window can drop it. */
export function marksNothing(entry: ThreadMarkEntry): boolean {
  return entry.status === null && entry.unreadAt === null
}
