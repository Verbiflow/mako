import { z } from "zod"

/**
 * What a performance script concluded about the rows it measured beside a
 * reference, written for the local updater (`scripts/perf-reference.ts`):
 * a row is within its allowance, slower, or unsure because the machine was
 * too busy to tell. The updater names a file in `PERFORMANCE_VERDICT_VARIABLE`;
 * each script appends one line to it. Without the variable, an unsure row
 * fails the script, as a slower one does.
 */
export const PERFORMANCE_VERDICT_VARIABLE = "MAKO_PERFORMANCE_VERDICT"

export const MeasuredRowSchema = z.object({
  key: z.string(),
  /** The commit it was measured beside. */
  beside: z.string(),
  outcome: z.enum(["within", "slower", "unsure"]),
  /** Medians in calibration units, and this checkout's change against the reference as a multiple. */
  reference: z.number(),
  head: z.number(),
  change: z.number(),
  /** Where the change lies, as a multiple, at the confidence the rounds allowed; absent with too few rounds. */
  interval: z.tuple([z.number(), z.number()]).optional(),
  rounds: z.number().int().nonnegative(),
  /** The share of its runs measured while the machine was busy. */
  busyShare: z.number().min(0).max(1),
})
export type MeasuredRow = z.infer<typeof MeasuredRowSchema>

export const PerformanceVerdictSchema = z.object({
  script: z.string(),
  /** How much slower a row may be, as a multiple. */
  allowed: z.number(),
  rows: z.array(MeasuredRowSchema),
  /** The machine while the rows were measured, in words, and why it was too busy, if it was. */
  machine: z.string(),
  busy: z.array(z.string()),
})
export type PerformanceVerdict = z.infer<typeof PerformanceVerdictSchema>

function percent(multiple: number): string {
  const change = Math.round((multiple - 1) * 100)
  return `${change >= 0 ? "+" : "−"}${Math.abs(change)}%`
}

/** A row in a line, as Settings › Updates and the host's log say it: `merge/merge large (same): +43% beside 3c2c7d6d, between −5% and +60%, 15 rounds, 12 busy`. */
export function describeRow(row: MeasuredRow): string {
  const between = row.interval ? `, between ${percent(row.interval[0])} and ${percent(row.interval[1])}` : ""
  const busy = Math.round(row.busyShare * row.rounds)
  return `${row.key}: ${percent(row.change)} beside ${row.beside.slice(0, 8)}${between}, ${row.rounds} rounds, ${busy} busy`
}

/** Every verdict a run of the checks appended, oldest first; a line that doesn't parse is skipped. */
export function parseVerdicts(text: string): PerformanceVerdict[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return []
    try {
      const verdict = PerformanceVerdictSchema.safeParse(JSON.parse(line))
      return verdict.success ? [verdict.data] : []
    } catch {
      return []
    }
  })
}
