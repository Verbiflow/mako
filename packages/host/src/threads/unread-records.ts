import { readStreamOriginal, type EntryOriginal } from "@mako/sessions/record-original"
import type { RecordRef } from "@mako/sessions/entries"
import { unreadCounts, type UnreadCounts } from "@mako/sessions/unread-index"
import type { MethodTable } from "../base/methods.js"
import type { UnknownKind } from "../base/native-unknown.js"
import type { UnreadReport, UnreadRow } from "../contracts/unread-records.js"

export interface UnreadSources {
  /** The views folder, whose index holds every decoded session's unread records. */
  views: string
  /** The record store's folder, which names the version that wrote each record. */
  records: string
  /** What this host's drivers received and no decoder read. */
  live(): readonly UnknownKind[]
  /** When this host started counting them. */
  since: number
}

/**
 * Every unread record by harness, version, kind and reason, saved and live,
 * newest version first within each harness. The saved counts are read from
 * the index and the record store each time, read-only; nothing is cached.
 */
export function unreadReport(sources: UnreadSources): UnreadReport {
  const saved = savedRows(unreadCounts({ views: sources.views, records: sources.records }))
  return { ...saved, rows: [...saved.rows, ...liveRows(sources.live())], liveSince: sources.since }
}

function savedRows(saved: UnreadCounts): Omit<UnreadReport, "liveSince"> {
  const rows = saved.groups.flatMap((group): UnreadRow[] => group.reason === "unknown" || group.reason === "unreadable" ? [{
    harness: group.harness,
    version: group.version,
    ...group.upTo && { upTo: group.upTo },
    ...group.bound && { bound: group.bound },
    source: group.source,
    from: "saved",
    kind: group.kind,
    reason: group.reason,
    count: group.count,
    sessions: group.sessions,
    newestAt: group.newest.at,
    example: { kind: "entry", path: group.newest.path, id: group.newest.id, ...group.newest.record && { record: group.newest.record } },
  }] : [])
  return { rows, sessions: saved.sessions, records: saved.records, unattributed: saved.unattributed }
}

/** Live kinds a decoder couldn't read; an undeclared tool (`tool <name>`) is the vocabulary's to name, not a record left unread. */
function liveRows(kinds: readonly UnknownKind[]): UnreadRow[] {
  return kinds.filter((kind) => !kind.kind.startsWith("tool ")).map((kind) => ({
    harness: kind.harness,
    version: kind.version ?? null,
    source: kind.version ? "reported" : null,
    from: "live",
    kind: kind.kind,
    reason: kind.reason,
    count: kind.count,
    newestAt: kind.newest.at,
    example: kind.newest.frame ? { kind: "stream", frame: kind.newest.frame } : { kind: "none" },
  }))
}

/** The stream lines a live record came in, as Show original reads them. */
export async function streamOriginal(streams: string, frame: RecordRef): Promise<EntryOriginal> {
  return { kept: false, parts: [], stream: await readStreamOriginal(streams, frame) }
}

/** Unread records by harness, version, kind and reason, and the stream lines a live one came in. */
export function declareUnreadRecordMethods(methods: MethodTable, sources: UnreadSources & { streams: string | undefined }): void {
  methods.handle("mako:unread-records", () => unreadReport(sources))
  methods.handle("mako:stream-original", (frame: RecordRef) => {
    if (!sources.streams) throw new Error("This host keeps no streams.")
    return streamOriginal(sources.streams, frame)
  })
}
