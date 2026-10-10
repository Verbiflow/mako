import { z } from "zod"

/** A Session's history to read: its conversation running here, or its native record. */
export const TranscriptSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("live"), id: z.string() }),
  z.object({ kind: z.literal("file"), path: z.string() }),
])
export type TranscriptSource = z.infer<typeof TranscriptSourceSchema>

export const TranscriptDepthSchema = z.enum(["concise", "full"])
export type TranscriptDepth = z.infer<typeof TranscriptDepthSchema>

/** A Session's transcript as Markdown, as it stood when read. */
export interface TranscriptDocument {
  title?: string
  harness: string
  markdown: string
}
