import { z } from "zod"

/**
 * A code review's findings, whichever harness wrote them. Claude Code reports
 * them through its `ReportFindings` tool, Codex in the review mode its
 * `review/start` runs, and a harness Mako asks with its own prompt in a
 * `mako-review` block at the end of its reply.
 */

const MAX_FINDINGS = 50
const MAX_TITLE = 300
const MAX_BODY = 4_000
const MAX_SUMMARY = 4_000

const bounded = (limit: number) => z.string().transform((text) => text.trim().slice(0, limit))

export const ReviewFindingSchema = z.object({
  title: bounded(MAX_TITLE).pipe(z.string().min(1)),
  body: bounded(MAX_BODY).optional(),
  /** As the harness wrote it: relative to the project, or absolute. */
  path: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  /** 0 is the most severe, as Codex's P0. */
  priority: z.number().int().min(0).max(3).optional(),
  category: bounded(40).optional(),
})
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>

export const ReviewReportSchema = z.object({
  summary: bounded(MAX_SUMMARY).optional(),
  findings: z.array(ReviewFindingSchema).max(MAX_FINDINGS),
})
export type ReviewReport = z.infer<typeof ReviewReportSchema>

/** The fence a Mako-written review prompt asks the agent to end its reply with. */
export const REVIEW_FENCE = "mako-review"

const PRIORITY_PREFIX = /^\[P([0-3])\]\s*/i

function finding(value: { title: string; body?: string; path?: string; line?: number; endLine?: number; priority?: number; category?: string }): ReviewFinding | undefined {
  const prefix = PRIORITY_PREFIX.exec(value.title)
  const title = prefix ? value.title.slice(prefix[0].length) : value.title
  const priority = value.priority ?? (prefix ? Number(prefix[1]) : undefined)
  const parsed = ReviewFindingSchema.safeParse({
    ...value,
    title,
    priority,
    body: value.body?.trim() ? value.body : undefined,
    endLine: value.endLine !== undefined && value.line !== undefined && value.endLine > value.line ? value.endLine : undefined,
  })
  if (!parsed.success) return undefined
  const entry: ReviewFinding = { title: parsed.data.title }
  for (const key of ["body", "path", "line", "endLine", "priority", "category"] as const)
    if (parsed.data[key] !== undefined) Object.assign(entry, { [key]: parsed.data[key] })
  return entry
}

function report(summary: string | undefined, findings: readonly (ReviewFinding | undefined)[]): ReviewReport {
  const kept = findings.filter((entry): entry is ReviewFinding => entry !== undefined).slice(0, MAX_FINDINGS)
  return ReviewReportSchema.parse(summary?.trim() ? { summary, findings: kept } : { findings: kept })
}

const ClaudeFindings = z.object({
  findings: z.array(z.looseObject({
    file: z.string(),
    line: z.number().int().optional(),
    summary: z.string(),
    short_summary: z.string().optional(),
    failure_scenario: z.string().optional(),
    category: z.string().optional(),
  })),
})

/** Claude Code's `ReportFindings` input: the verified findings, most severe first. */
export function claudeReviewReport(input: string | undefined): ReviewReport | undefined {
  if (!input) return undefined
  const parsed = ClaudeFindings.safeParse(JsonText.safeParse(input).data)
  if (!parsed.success) return undefined
  return report(undefined, parsed.data.findings.map((entry) => {
    const short = entry.short_summary?.trim()
    const body = [short ? entry.summary : undefined, entry.failure_scenario].filter((part) => part?.trim()).join("\n\n")
    return finding({ title: short || entry.summary, body, path: entry.file, line: entry.line && entry.line > 0 ? entry.line : undefined, category: entry.category })
  }))
}

/** Codex's `ReviewOutputEvent`, as its rollout keeps it. */
export const CodexReviewOutputSchema = z.object({
  findings: z.array(z.looseObject({
    title: z.string(),
    body: z.string().optional(),
    priority: z.number().int().optional(),
    code_location: z.looseObject({
      absolute_file_path: z.string(),
      line_range: z.looseObject({ start: z.number().int(), end: z.number().int() }).optional(),
    }).optional(),
  })).default([]),
  overall_explanation: z.string().default(""),
})

export type CodexReviewOutput = z.infer<typeof CodexReviewOutputSchema>

export function codexReviewReport(output: CodexReviewOutput): ReviewReport {
  return report(output.overall_explanation, output.findings.map((entry) => finding({
    title: entry.title,
    body: entry.body,
    path: entry.code_location?.absolute_file_path,
    line: entry.code_location?.line_range?.start || undefined,
    endLine: entry.code_location?.line_range?.end || undefined,
    priority: entry.priority !== undefined && entry.priority >= 0 && entry.priority <= 3 ? entry.priority : undefined,
  })))
}

/** Codex's `REVIEW_FALLBACK_MESSAGE`: the review ended with nothing to show. */
export const CODEX_REVIEW_FALLBACK = "Reviewer failed to output a response."
const CODEX_HEADERS = new Set(["Full review comments:", "Review comment:"])
const CODEX_ITEM = /^- (.*) — (.+):(\d+)-(\d+)$/

/**
 * Codex's review as its app-server sends it: `render_review_output_text`,
 * the explanation then each finding as `- title — path:start-end` with its
 * body indented two spaces. Undefined for the text Codex sends when the
 * review produced nothing.
 */
export function codexReviewText(text: string): ReviewReport | undefined {
  const trimmed = text.trim()
  if (!trimmed || trimmed === CODEX_REVIEW_FALLBACK) return undefined
  const lines = trimmed.split("\n")
  let header = lines.length - 1
  while (header >= 0 && !CODEX_HEADERS.has(lines[header]!)) header--
  if (header < 0) return report(trimmed, [])
  const findings: { title: string; body: string[]; path?: string; line?: number; endLine?: number }[] = []
  for (const line of lines.slice(header + 1)) {
    if (line.startsWith("- ")) {
      const item = CODEX_ITEM.exec(line)
      findings.push(item
        ? { title: item[1]!, path: item[2], line: Number(item[3]), endLine: Number(item[4]), body: [] }
        : { title: line.slice(2), body: [] })
    } else if (line.startsWith("  ")) findings.at(-1)?.body.push(line.slice(2))
  }
  return report(lines.slice(0, header).join("\n"), findings.map((entry) => finding({ ...entry, body: entry.body.join("\n") })))
}

/** The same text from Codex's typed output, so history can tell its echo of the review from the agent's own words. */
export function codexReviewEcho(output: CodexReviewOutput): string {
  const sections: string[] = []
  const explanation = output.overall_explanation.trim()
  if (explanation) sections.push(explanation)
  if (output.findings.length) {
    const lines = ["", output.findings.length > 1 ? "Full review comments:" : "Review comment:"]
    for (const entry of output.findings) {
      const range = entry.code_location?.line_range
      lines.push("", `- ${entry.title} — ${entry.code_location?.absolute_file_path ?? ""}:${range?.start ?? 0}-${range?.end ?? 0}`)
      for (const line of (entry.body ?? "").split("\n")) lines.push(`  ${line}`)
    }
    const block = lines.join("\n").trim()
    if (block) sections.push(block)
  }
  return sections.length ? sections.join("\n\n") : CODEX_REVIEW_FALLBACK
}

const Priority = z.union([
  z.number().int().min(0).max(3),
  z.string().regex(/^P?[0-3]$/i).transform((value) => Number(value.replace(/^P/i, ""))),
])
const MakoFindings = z.object({
  summary: z.string().optional(),
  findings: z.array(z.looseObject({
    title: z.string(),
    body: z.string().optional(),
    path: z.string().optional(),
    line: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    priority: Priority.optional().catch(undefined),
  })).default([]),
})

/** A `mako-review` block's JSON, as the agent wrote it. */
export function makoReviewReport(source: string): ReviewReport | undefined {
  const parsed = MakoFindings.safeParse(JsonText.safeParse(source).data)
  if (!parsed.success) return undefined
  return report(parsed.data.summary, parsed.data.findings.map((entry) => finding({ ...entry, path: entry.path?.trim() || undefined })))
}

const JsonText = z.string().transform((text, context) => {
  try {
    return z.json().parse(JSON.parse(text))
  } catch {
    context.addIssue({ code: "custom", message: "not JSON" })
    return z.NEVER
  }
})
