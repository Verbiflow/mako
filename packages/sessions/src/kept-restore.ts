import { z } from "zod"
import { OutdatedRuntimeSchema } from "./record-writers.js"

/**
 * What putting a session its harness deleted back into the harness's own
 * store came to (`SessionCatalog.restoreKept`), so its harness can resume
 * it as the same session.
 */
export const KeptRestoreSchema = z.discriminatedUnion("kind", [
  /** Written back from Mako's records: the harness lists the session at `path` again. */
  z.object({ kind: z.literal("restored"), path: z.string(), files: z.number().int().nonnegative(), rows: z.number().int().nonnegative(), ms: z.number().nonnegative() }),
  /** The harness has the session already; nothing was written. */
  z.object({ kind: z.literal("present"), path: z.string() }),
  /**
   * The harness's store holds a copy that went on without Mako: it was left
   * as it is, and Mako's version was written beside it as the harness's own
   * fork, `nativeId`.
   */
  z.object({ kind: z.literal("forked"), nativeId: z.string() }),
  /**
   * The harness installed here is older than the newest version that wrote
   * the records (`restoreGate`): nothing was written, since it may not read
   * them. An update, then the same restore, resumes it natively.
   */
  OutdatedRuntimeSchema.extend({ kind: z.literal("outdated") }),
  z.object({ kind: z.literal("refused"), reason: z.string() }),
])
export type KeptRestore = z.infer<typeof KeptRestoreSchema>
