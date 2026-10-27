import { z } from "zod"
import { RecordWriterSchema } from "@mako/sessions/record-writers"

/**
 * Whether a session its harness deleted, which Mako keeps the records of,
 * goes back into the harness here and resumes natively, or waits for an
 * update; and the same for records another program wrote that the
 * harness's runtime imports (a `cursor-agent` store, which the Cursor SDK
 * imports). Records go only into the version of their harness that wrote them
 * or a newer one (`restoreGate` in `@mako/sessions/record-writers`): the host
 * decides with that one function, and the restore itself refuses with it
 * too, so the plan the window shows and what a reply does never differ.
 */

/** How the harness installed here gets to the version the records need. */
export const RuntimeUpdateOfferSchema = z.discriminatedUnion("kind", [
  /** Mako runs the update: npm, bun, pnpm, Homebrew or the CLI's own updater, as the runtime's plan says (`RuntimeUpdates.update`). */
  z.object({ kind: z.literal("update"), runtimeId: z.string(), label: z.string() }),
  /** Another app owns the install, or Mako ships the build itself (a bundled SDK): updating that app is the way. */
  z.object({ kind: z.literal("owner"), owner: z.string() }),
  /** An install Mako can't place: the person runs the command. */
  z.object({ kind: z.literal("manual"), command: z.string().optional() }),
])
export type RuntimeUpdateOffer = z.infer<typeof RuntimeUpdateOfferSchema>

/** A restore the gate refused: which version wrote the records, which is installed, and how to update. */
export const OutdatedRestoreSchema = z.object({
  harness: z.string(),
  /** The newest version that wrote the records; absent when nothing names it. */
  wrote: RecordWriterSchema.optional(),
  /** When nothing names the writer: the newest version that could have been it, where something bounds it. */
  upTo: z.string().optional(),
  /** Null: the program the records are of isn't installed here. */
  installed: z.string().nullable(),
  /** The program the records are of, where it isn't the one Mako runs the harness with (`cursor-agent`). */
  line: z.string().optional(),
  /** What reads them here when it isn't that program: the build Mako ships that imports them, in words ("Mako's @cursor/sdk 1.0.31, published 2026.09.03"). */
  reader: z.string().optional(),
  /** Columns the records' rows hold that the store here has no place for (`OutdatedRuntime.lacks`): an older build made it, whatever the versions say. */
  lacks: z.array(z.string()).optional(),
  offer: RuntimeUpdateOfferSchema,
})
export type OutdatedRestore = z.infer<typeof OutdatedRestoreSchema>

export const RestorePlanSchema = z.discriminatedUnion("kind", [
  /** A reply restores the session and its harness resumes it natively: the installed version may read every record, or nothing says otherwise. */
  z.object({ kind: z.literal("native") }),
  /** The installed version is older than the newest that wrote the records: Update, then the reply resumes natively; a reply before that continues from the transcript. */
  z.object({ kind: z.literal("update"), outdated: OutdatedRestoreSchema }),
  /** Not a session Mako restores: its harness has it, or only Mako's copy is left. */
  z.object({ kind: z.literal("none") }),
])
export type RestorePlan = z.infer<typeof RestorePlanSchema>
