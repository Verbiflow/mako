import { z } from "zod"
import { RecordRefSchema } from "@mako/sessions/entries"

/**
 * Records Mako couldn't read, counted by harness, harness version, kind and
 * reason, without their content: what Settings › Diagnostics shows when a
 * harness ships a release. Saved records come from the sessions decoded
 * (`@mako/sessions/unread-index`), each under the version that wrote it;
 * live ones from what this host's drivers received and no decoder read
 * (`NativeUnknown`), under the version their launch reported.
 */

/** The newest record of a row, which its Original opens: an entry of a saved session, or the stream line a live one came in. */
export const UnreadExampleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entry"), path: z.string(), id: z.string(), record: RecordRefSchema.optional() }),
  z.object({ kind: z.literal("stream"), frame: RecordRefSchema }),
  z.object({ kind: z.literal("none") }),
])
export type UnreadExample = z.infer<typeof UnreadExampleSchema>

export const UnreadRowSchema = z.object({
  harness: z.string(),
  /** Null where nothing names the version: the record store doesn't hold the session yet, or the launch reported none. */
  version: z.string().nullable(),
  /** No version known, but the harness's evidence bounds it: the newest that could have written them. */
  upTo: z.string().optional(),
  /** What sets that bound: a build's day, the vendor's release dates, or the SDK Mako's repository pinned (`WriterEvidence.bound`). */
  bound: z.enum(["build-day", "releases", "pins"]).optional(),
  /** `record`: the records state it; `observed`: Mako saw that version run the session; `log`: the harness's log names it; `install`: the only install there was; `reported`: the live launch's handshake. */
  source: z.enum(["record", "observed", "log", "install", "reported"]).nullable(),
  from: z.enum(["saved", "live"]),
  kind: z.string(),
  reason: z.enum(["unknown", "unreadable"]),
  count: z.number().int().nonnegative(),
  /** Saved sessions that hold them; none for live records. */
  sessions: z.number().int().nonnegative().optional(),
  newestAt: z.number().nullable(),
  example: UnreadExampleSchema,
})
export type UnreadRow = z.infer<typeof UnreadRowSchema>

export const UnreadReportSchema = z.object({
  rows: z.array(UnreadRowSchema),
  /** Saved sessions with any unread record, and those records in all. */
  sessions: z.number().int().nonnegative(),
  records: z.number().int().nonnegative(),
  /** Saved records whose version nothing names yet. */
  unattributed: z.number().int().nonnegative(),
  /** When this host started counting live records. */
  liveSince: z.number(),
})
export type UnreadReport = z.infer<typeof UnreadReportSchema>
