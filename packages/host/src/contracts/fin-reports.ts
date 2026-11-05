import { z } from "zod"
import { ArtifactSchema, ReportStatusSchema } from "./agents.js"
import { ASK_OPTIONS, AskOptionSchema } from "./native-agents.js"

/**
 * One Fin's report as its Apex's wake carried it, for the person to read: the record the digest's line was written
 * from, never the digest's words. Which Fin (its Thread, name and harness), what it did, the line the digest gave
 * it, and for an ask its question, options and recommendation; for a finished one what it made.
 */
export const FinReportCardSchema = z.object({
  /** The report's own ID, which a Fin's open ask for the person carries too (`FinAsk.id`). */
  report: z.string().min(1).max(600),
  fin: z.string().min(1).max(200),
  name: z.string().min(1).max(400),
  harness: z.string().min(1).max(100).optional(),
  /** Another Apex's reply to a message this one sent it, not a Fin's report. */
  apex: z.literal(true).optional(),
  status: ReportStatusSchema,
  /** What it said, as one paragraph: the question for an ask, the first paragraph of its summary for the rest. */
  line: z.string().max(4_000),
  options: z.array(AskOptionSchema).max(ASK_OPTIONS).optional(),
  recommended: z.number().int().nonnegative().optional(),
  artifacts: z.array(ArtifactSchema).max(64).optional(),
  /** Its Apex left the question to the person, or it was the person's from the start. */
  forPerson: z.literal(true).optional(),
  /** A done report's question: who decides it (`decisionOn`), so the card reads "finished · needs you" for the person's. */
  decides: z.enum(["lead", "person"]).optional(),
  /** What it waits on outside its tree, in words (`waitingWords`): "waiting on #412 checks". */
  waiting: z.string().max(1_000).optional(),
}).strict()
export type FinReportCard = z.infer<typeof FinReportCardSchema>

/** The most cards one wake carries; a digest of more notices than this goes as wakes of this many (`nextBatch`). */
export const FIN_REPORTS_MAX = 64
const BlockSchema = z.object({ version: z.literal(1), reports: z.array(FinReportCardSchema).min(1).max(FIN_REPORTS_MAX) }).strict()
const OPEN = "\n\n<mako-reports>\n"
const CLOSE = "\n</mako-reports>"
const MAX_BLOCK = 256 * 1024

/**
 * The digest with its reports as data after it, the way a prompt carries its attachments (`appendPromptAttachments`).
 * Never throws: a card the schema refuses, or one past `FIN_REPORTS_MAX`, is left to the words, which say every report.
 */
export function appendFinReports(text: string, reports: readonly FinReportCard[]): string {
  const cards = reports.flatMap((report) => {
    const read = FinReportCardSchema.safeParse(report)
    return read.success ? [read.data] : []
  }).slice(0, FIN_REPORTS_MAX)
  if (!cards.length) return text
  const block = JSON.stringify({ version: 1, reports: cards }).replaceAll("<", "\\u003c")
  return block.length > MAX_BLOCK ? text : `${text}${OPEN}${block}${CLOSE}`
}

/** A wake's words and the reports it carried as data. */
export interface FinReportsRead {
  text: string
  reports: FinReportCard[]
}

/** Only a complete, valid block at the very end is data; anything else stays words. */
export function readFinReports(text: string): FinReportsRead {
  const unchanged = { text, reports: [] }
  if (!text.endsWith(CLOSE)) return unchanged
  const start = text.lastIndexOf(OPEN)
  if (start < 0) return unchanged
  const json = text.slice(start + OPEN.length, -CLOSE.length)
  if (json.length > MAX_BLOCK) return unchanged
  try {
    const parsed = BlockSchema.safeParse(JSON.parse(json))
    return parsed.success ? { text: text.slice(0, start), reports: parsed.data.reports } : unchanged
  } catch {
    return unchanged
  }
}
