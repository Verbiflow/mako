import { attentionLine } from "@mako/host/contracts/notifications"
import { formatRelative } from "@/lib/format"
import { CLOUD_WHERE, type WebThread } from "./threads"

/** What a row says under its title, and in which tone. */
export interface RowDetail {
  text: string
  tone: "caution" | "negative" | "working" | "faint"
  /** Where it runs, as a glyph at the line's head: only on a row that says where. */
  place?: "cloud" | "device"
  /** How long its run has gone, after "Working", in figures that hold their width as they count. */
  elapsed?: string
  /** A word before the rest, in the row's own ink: "Done", for a run that finished since the Thread was last opened. */
  lead?: "Done"
}

/** What else a row reads besides its Thread: the time now, when its run started, and whether it finished unread. */
export interface RowContext {
  now?: number
  /** When its run started, as known: its owner's word, or when this browser first saw it at work. */
  workingSince?: number
  /** It finished since it was last on screen here (`read-state.ts`). */
  done?: boolean
}

/** A run's length as a row counts it: seconds in its first minute, then minutes, then hours and minutes. */
export function workingFor(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * What a row says under its title, in as few words as say it: what it waits on, that it failed, that it works and for
 * how long, or its project (and its Mac's name, when the account has more than one Mac), led by "Done" when its run
 * finished since it was last opened. A quiet Mac is said once, at the list's head.
 */
export function rowDetail(thread: WebThread, named: boolean, context: RowContext = {}): RowDetail {
  if (thread.archived) return { text: `Archived ${formatRelative(Date.parse(thread.archived.archivedAt))}`, tone: "faint" }
  if (thread.standing === "waiting") return { text: attentionLine(thread.waitingFor ?? "needs-you", thread.waitingOn), tone: "caution" }
  if (thread.standing === "failed") return { text: "Failed", tone: "negative" }
  if (thread.standing === "working") {
    const since = context.workingSince
    return since !== undefined && context.now !== undefined ? { text: "Working", tone: "working", elapsed: workingFor(context.now - since) } : { text: "Working", tone: "working" }
  }
  if (thread.standing === "moving") return { text: "Moving", tone: "working" }
  if (thread.waitingMessages) return { text: thread.waitingMessages === 1 ? "1 message waiting" : `${thread.waitingMessages} messages waiting`, tone: "faint" }
  const cloud = thread.where === CLOUD_WHERE
  const words = [thread.project, !cloud && named ? thread.where : undefined].filter(Boolean).join(" · ")
  const detail: RowDetail = { text: words || (cloud ? "Cloud" : thread.where), tone: "faint", place: cloud ? "cloud" : "device" }
  if (context.done && !thread.quietSince) detail.lead = "Done"
  return detail
}

