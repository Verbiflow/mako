/**
 * What opening this Mac's largest saved sessions costs and keeps, per store
 * reader: the first page cold, the whole session, the memory either takes,
 * and how much of the session the reader kept (prompts, calls, characters,
 * and every mark a cap left). Read-only: no view is written or read, and
 * nothing of the harnesses' is changed.
 *
 *   node --expose-gc --import tsx scripts/bench-views.ts                 the 3 largest sessions of each reader
 *   node --expose-gc --import tsx scripts/bench-views.ts --per 5 --only codex
 *   node --expose-gc --import tsx scripts/bench-views.ts --save <file>   keep this run's rows
 *   node --expose-gc --import tsx scripts/bench-views.ts --against <file>   the same sessions, beside a kept run
 */
import { readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { parseArgs } from "node:util"
import { z } from "zod"
import { SessionCatalog, translatorBuild, VIEWER_PAGE } from "@mako/sessions"
import { storeReader } from "./decode-compare"

const { values: options } = parseArgs({
  options: {
    per: { type: "string", default: "3" },
    only: { type: "string" },
    save: { type: "string" },
    against: { type: "string" },
  },
})

const READERS = ["claude", "codex", "cursor", "devin", "devin-ide", "grok", "opencode"]
const MIB = 1024 ** 2

const RowSchema = z.object({
  reader: z.string(),
  path: z.string(),
  /** The native file's size on disk; for a database, the database file's. */
  nativeBytes: z.number(),
  pageMs: z.number(),
  pagePeakMiB: z.number(),
  pageEntries: z.number(),
  openMs: z.number(),
  openPeakMiB: z.number(),
  entries: z.number(),
  prompts: z.number(),
  calls: z.number(),
  chars: z.number(),
  /** Marks a cap left in what the reader returned: an "earlier history not shown" line, a clipped call's notice. */
  cuts: z.object({ earlier: z.number(), clipped: z.number() }),
})
type Row = z.infer<typeof RowSchema>

/** What the benchmark reads of an entry, whichever shape the build returns: a saved message with its blocks, or one item. */
const PartSchema = z.looseObject({ type: z.string().optional(), input: z.string().optional(), output: z.string().optional() })
const ItemSchema = PartSchema.extend({
  kind: z.string().optional(),
  steeringFor: z.string().optional(),
  label: z.string().optional(),
  blocks: z.array(PartSchema).optional(),
})
const CLIPPED = /\n… \[\d+ more characters\]$/

function measured(entries: readonly unknown[]): Pick<Row, "entries" | "prompts" | "calls" | "chars" | "cuts"> {
  let prompts = 0
  let calls = 0
  let chars = 0
  const cuts = { earlier: 0, clipped: 0 }
  for (const raw of entries) {
    const entry = ItemSchema.parse(raw)
    const kind = entry.kind ?? entry.type
    if (kind === "user" && !entry.steeringFor) prompts++
    if (kind === "event" && /earlier history not shown/i.test(entry.label ?? "")) cuts.earlier++
    for (const part of entry.blocks ?? [entry]) {
      if (part.type !== "tool") continue
      calls++
      if (CLIPPED.test(part.input ?? "")) cuts.clipped++
      if (CLIPPED.test(part.output ?? "")) cuts.clipped++
    }
    chars += JSON.stringify(raw).length
  }
  return { entries: entries.length, prompts, calls, chars, cuts }
}

/** `work`'s time and the process's peak resident memory above where it started, sampled every 5 ms. */
async function sampled<T>(work: () => Promise<T>): Promise<{ value: T; ms: number; peakMiB: number }> {
  globalThis.gc?.()
  const base = process.memoryUsage().rss
  let peak = base
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 5)
  const started = performance.now()
  try {
    const value = await work()
    peak = Math.max(peak, process.memoryUsage().rss)
    return { value, ms: performance.now() - started, peakMiB: (peak - base) / MIB }
  } finally {
    clearInterval(timer)
  }
}

const home = homedir()
const translator = translatorBuild()
const kept = options.against ? z.array(RowSchema).parse(JSON.parse(await readFile(options.against, "utf8"))) : undefined
const rows: Row[] = []
for (const reader of READERS.filter((name) => !options.only || name === options.only)) {
  let paths: string[]
  if (kept) paths = kept.filter((row) => row.reader === reader).map((row) => row.path)
  else {
    const catalog = new SessionCatalog([storeReader(reader, home)], { translator, readOnly: true })
    await catalog.scan()
    const sized = await Promise.all(catalog.list().map(async (ref) => ({ path: ref.path, bytes: (await stat(ref.path.split("#")[0]!).catch(() => null))?.size ?? 0 })))
    // A database store holds many sessions, so its file's size ranks none; the reader's own reach does.
    const reach = new Map(catalog.list().map((ref) => [ref.path, ref.bytes ?? 0]))
    paths = sized.sort((a, b) => (reach.get(b.path) ?? 0) - (reach.get(a.path) ?? 0) || b.bytes - a.bytes).slice(0, Number(options.per)).map((row) => row.path)
    await catalog.stop()
  }
  for (const path of paths) {
    const fresh = () => new SessionCatalog([storeReader(reader, home)], { translator, readOnly: true })
    const paging = fresh()
    const page = await sampled(() => paging.page(path, undefined, undefined, VIEWER_PAGE))
    await paging.stop()
    const opening = fresh()
    const opened = await sampled(() => opening.open(path))
    await opening.stop()
    if (!opened.value) {
      console.warn(`${reader}: ${path} did not open`)
      continue
    }
    rows.push({
      reader,
      path,
      nativeBytes: (await stat(path.split("#")[0]!).catch(() => null))?.size ?? 0,
      pageMs: page.ms,
      pagePeakMiB: page.peakMiB,
      pageEntries: page.value?.entries.length ?? 0,
      openMs: opened.ms,
      openPeakMiB: opened.peakMiB,
      ...measured(opened.value.entries),
    })
  }
}

if (options.save) await writeFile(options.save, JSON.stringify(rows, null, 2))
const short = (path: string) => path.split("/").at(-1)!.slice(-36)
const size = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / MIB).toFixed(1)} MiB`)
for (const row of rows) {
  const before = kept?.find((candidate) => candidate.reader === row.reader && candidate.path === row.path)
  const was = (now: number, then: number | undefined, unit = "") => (then === undefined ? `${Math.round(now)}${unit}` : `${Math.round(then)} → ${Math.round(now)}${unit}`)
  console.log(
    `${row.reader.padEnd(9)} ${short(row.path).padEnd(36)} ${size(row.nativeBytes).padStart(10)}` +
    `  page ${was(row.pageMs, before?.pageMs, " ms")} (+${was(row.pagePeakMiB, before?.pagePeakMiB, " MiB")})` +
    `  open ${was(row.openMs, before?.openMs, " ms")} (+${was(row.openPeakMiB, before?.openPeakMiB, " MiB")})` +
    `  prompts ${was(row.prompts, before?.prompts)}  calls ${was(row.calls, before?.calls)}  chars ${was(row.chars / MIB, before && before.chars / MIB, " Mi")}` +
    `  cuts ${row.cuts.earlier + row.cuts.clipped}${before ? ` (was ${before.cuts.earlier + before.cuts.clipped})` : ""}`
  )
}
