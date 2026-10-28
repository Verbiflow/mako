import { formatRelative } from "@/lib/format"
import { CLOUD_WHERE, type WebThread } from "./threads"

/** What a row says under its title, and in which tone. */
export interface RowDetail {
  text: string
  tone: "caution" | "negative" | "working" | "faint"
  /** Where it runs, as a glyph at the line's head: only on a row that says where. */
  place?: "cloud" | "device"
}

/**
 * What a row says under its title, in as few words as say it: what it waits on, that it failed, that it works, or its
 * project (and its Mac's name, when the account has more than one Mac). A quiet Mac is said once, at the list's head.
 */
export function rowDetail(thread: WebThread, named: boolean): RowDetail {
  if (thread.archived) return { text: `Archived ${formatRelative(Date.parse(thread.archived.archivedAt))}`, tone: "faint" }
  if (thread.standing === "waiting") return { text: thread.waitingOn ?? "Waiting for you", tone: "caution" }
  if (thread.standing === "failed") return { text: "Failed", tone: "negative" }
  if (thread.standing === "working") return { text: "Working", tone: "working" }
  if (thread.standing === "moving") return { text: "Moving", tone: "working" }
  if (thread.waitingMessages) return { text: thread.waitingMessages === 1 ? "1 message waiting" : `${thread.waitingMessages} messages waiting`, tone: "faint" }
  const cloud = thread.where === CLOUD_WHERE
  const words = [thread.project, !cloud && named ? thread.where : undefined].filter(Boolean).join(" · ")
  return { text: words || (cloud ? "Cloud" : thread.where), tone: "faint", place: cloud ? "cloud" : "device" }
}

