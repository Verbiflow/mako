import type { UnreadReport, UnreadRow } from "@mako/host/contracts/unread-records"

/**
 * The words Settings › Diagnostics uses for records Mako couldn't read.
 * Kept React-free so they can be checked without a renderer. Every number
 * carries its noun.
 */

const plural = (count: number, noun: string, many = `${noun}s`) => `${count.toLocaleString()} ${count === 1 ? noun : many}`

/** The line under the section's title: what the counts are, and how many. */
export function unreadSummary(report: Pick<UnreadReport, "rows" | "records" | "sessions" | "unattributed">): string {
  const live = report.rows.filter((row) => row.from === "live").reduce((sum, row) => sum + row.count, 0)
  if (!report.records && !live) return "Every record Mako has read so far decoded. When a harness release writes something new, it shows here by version until Mako reads it."
  const parts: string[] = []
  if (report.records) parts.push(`${plural(report.records, "saved record")} in ${plural(report.sessions, "session")}`)
  if (live) parts.push(`${plural(live, "live record")} since Mako started`)
  const unknown = report.unattributed ? ` ${plural(report.unattributed, "saved record")} ${report.unattributed === 1 ? "isn't" : "aren't"} in Mako's record store yet, so ${report.unattributed === 1 ? "its" : "their"} version isn't known.` : ""
  return `Mako couldn't read ${parts.join(" and ")}, shown by the harness version that wrote them.${unknown}`
}

export interface UnreadRowWords {
  version: string
  /** Where the version comes from, for its tip. */
  versionDetail: string
  /** How many, with their nouns: records, sessions, and why. */
  counts: string
}

/** What set a range's upper bound, in words. */
const BOUND_WORDS = {
  "build-day": "the day its build was made",
  releases: "the newest release published by its last write",
  pins: "the SDK Mako's repository pinned by then",
  evidence: "its harness's evidence",
} as const

export function unreadRowWords(row: UnreadRow): UnreadRowWords {
  const version = row.version ?? (row.upTo ? `${row.upTo} or older` : "version unknown")
  const versionDetail = row.version === null
    ? row.upTo ? `Nothing names the version that wrote them; ${BOUND_WORDS[row.bound ?? "evidence"]} bounds it at ${row.upTo}.`
      : row.from === "saved" ? "Mako's record store doesn't hold this session yet, or nothing names the version that wrote it." : "The launch reported no version."
    : row.source === "record" ? "The harness's own records state this version."
      : row.source === "observed" ? "Mako saw this version run the session; its records state none."
        : row.source === "log" ? "The harness's own log names the session and this version."
          : row.source === "install" ? "The only install of the harness while the session was written."
            : "The version the live launch reported."
  const why = row.reason === "unknown" ? "new kind" : "couldn't read"
  const counts = row.from === "saved"
    ? `${why} · ${plural(row.count, "record")} in ${plural(row.sessions ?? 0, "session")}`
    : `${why} · ${plural(row.count, "live record")}`
  return { version, versionDetail, counts }
}
