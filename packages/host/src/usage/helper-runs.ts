import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { hostWarn } from "../base/host-log.js"
import { HELPER_PURPOSE_LABELS, HELPER_PURPOSES, type HelperRun } from "../contracts/usage-ledger.js"
import { priceEstimate } from "./pricing.js"
import { parseObject, validTimestamp, type JsonlReader, type UsageEvent } from "./scan.js"

/** Files older than this are deleted when the next run is written: the summary reads thirty days. */
const KEEP_MS = 90 * 86_400_000
/** What `HelperRuns.list` reads of a month's file at most, from its end. */
const LIST_TAIL_BYTES = 1024 * 1024

const TokenCountsSchema = z.object({
  input: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  output: z.number().nonnegative(),
  reasoning: z.number().nonnegative().optional(),
})

export const HelperRunSchema = z.object({
  id: z.string(),
  at: z.number(),
  purpose: z.enum(HELPER_PURPOSES),
  trigger: z.string(),
  connection: z.string(),
  cwd: z.string().optional(),
  outcome: z.enum(["completed", "failed", "cancelled"]),
  durationMs: z.number().nonnegative(),
  calls: z.number().int().nonnegative(),
  tokens: TokenCountsSchema.optional(),
  estimate: z.object({ amount: z.number().nonnegative(), currency: z.literal("USD"), table: z.string() }).optional(),
}) satisfies z.ZodType<HelperRun>

/** Where a host's helper runs are kept, one file per month. */
export function helperRunsRoot(dataRoot: string): string {
  return join(dataRoot, "usage", "helper-runs")
}

/**
 * The model calls Mako makes on its own behalf, appended one line each to
 * the month's file and priced from the current table as they are written.
 * Writing never fails the work it records: a run that couldn't be written
 * is logged and dropped.
 */
export class HelperRuns {
  private readonly root: string
  private writes: Promise<void> = Promise.resolve()

  constructor(root: string) {
    this.root = root
  }

  readonly record = (unpriced: HelperRun): void => {
    const estimate = unpriced.tokens && !unpriced.estimate ? priceEstimate(unpriced.connection, { ...unpriced.tokens, summed: unpriced.calls > 1 }) : null
    const run = estimate ? { ...unpriced, estimate } : unpriced
    this.writes = this.writes.then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      await appendFile(join(this.root, monthFile(run.at)), `${JSON.stringify(run)}\n`, { mode: 0o600 })
      await this.prune(run.at)
    }).catch((error) => {
      hostWarn("usage", "helper run unrecorded", { purpose: run.purpose, error: error instanceof Error ? error.message : String(error) })
    })
  }

  /** Waits for every run recorded so far to be written. */
  flushed(): Promise<void> {
    return this.writes
  }

  /** The newest runs at or after `since`, newest first, at most `limit`; each month's file is read from its last megabyte. */
  async list(since = 0, limit = 200): Promise<HelperRun[]> {
    const names = (await readdir(this.root).catch(() => [])).filter((name) => name.endsWith(".jsonl")).sort().reverse()
    const runs: HelperRun[] = []
    for (const name of names) {
      const path = join(this.root, name)
      const { size } = await stat(path)
      const text = size > LIST_TAIL_BYTES
        ? (await readFile(path)).subarray(size - LIST_TAIL_BYTES).toString("utf8").replace(/^[^\n]*\n/, "")
        : await readFile(path, "utf8")
      const month = text.split("\n").flatMap((line) => {
        const parsed = HelperRunSchema.safeParse(parseObject(line))
        return parsed.success && parsed.data.at >= since ? [parsed.data] : []
      })
      runs.push(...month.reverse())
      if (runs.length >= limit) break
    }
    return runs.slice(0, limit)
  }

  private async prune(now: number): Promise<void> {
    const keep = monthFile(now - KEEP_MS)
    for (const name of await readdir(this.root))
      if (name.endsWith(".jsonl") && name < keep) await rm(join(this.root, name), { force: true })
  }
}

function monthFile(at: number): string {
  return `${new Date(at).toISOString().slice(0, 7)}.jsonl`
}

/** The source a helper run counts under, by purpose: "Mako: Commit messages". */
export function helperSource(run: Pick<HelperRun, "purpose">): string {
  return `Mako: ${HELPER_PURPOSE_LABELS[run.purpose]}`
}

/** A helper run's session in the ledger; the summary's session count leaves these out. */
export const HELPER_SESSION_PREFIX = "helper:"

/** A helper run as a usage event: its source names its purpose, so Settings › Usage lists each apart. */
export const HELPER_RUNS: JsonlReader<null> = {
  needles: ['"purpose"'],
  start: () => null,
  restore: () => null,
  line(line, _state, file) {
    const parsed = HelperRunSchema.safeParse(parseObject(line))
    const run = parsed.data
    const tokens = run?.tokens
    if (!run || !tokens) return null
    const event: UsageEvent = {
      key: `Mako helpers:${run.id}`,
      source: helperSource(run),
      session: `${HELPER_SESSION_PREFIX}${run.purpose}`,
      timestamp: validTimestamp(new Date(run.at).toISOString(), file.mtimeMs),
      model: run.connection,
      cwd: run.cwd ?? "unknown",
      input: tokens.input,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
      summed: run.calls > 1,
    }
    if (run.estimate) event.estimate = run.estimate
    return event
  },
}
