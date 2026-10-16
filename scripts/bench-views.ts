/**
 * What opening this Mac's largest saved sessions costs and keeps, per store
 * reader: the first page cold, the whole session, the memory either takes,
 * and how much of the session the reader kept (prompts, calls, characters,
 * and every mark a cap left). Then its view: the first page decoding and
 * keeping one, a page from it once kept, its size on disk, and the decode
 * continued from its last turn once the record grew (the view's stamp aged,
 * so its last turn is decoded again and the view rewritten from there).
 * Views are kept in a temporary folder; nothing of the harnesses' or of
 * Mako's is written or changed.
 *
 *   node --expose-gc --import tsx scripts/bench-views.ts                 the 3 largest sessions of each reader
 *   node --expose-gc --import tsx scripts/bench-views.ts --per 5 --only codex
 *   node --expose-gc --import tsx scripts/bench-views.ts --save <file>   keep this run's rows
 *   node --expose-gc --import tsx scripts/bench-views.ts --against <file>   the same sessions, beside a kept run
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"
import { z } from "zod"
import { DecodeAside, SAVED_HISTORY_READERS, SessionCatalog, translatorBuild, VIEWER_PAGE, ViewCache } from "@mako/sessions"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
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
  /** The first page with views kept: the decode and the view's write, a large record's in a child process, and this process's peak above where it began. */
  viewPageMs: z.number().optional(),
  viewPagePeakMiB: z.number().optional(),
  viewBytes: z.number().optional(),
  /** A page from the kept view, by a catalog that never decoded the session. */
  warmPageMs: z.number().optional(),
  warmPeakMiB: z.number().optional(),
  /** A page once the record grew, its view continued from the last turn; unset where the reader decodes it whole again. */
  continuedMs: z.number().optional(),
  continuedPeakMiB: z.number().optional(),
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

/** Ages the view at `file`'s stamp, as a record that grew since leaves it. */
function age(file: string): void {
  const db = new DatabaseSync(file)
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'view'").get()
    const meta = z.looseObject({ mtimeMs: z.number() }).parse(JSON.parse(z.string().parse(row?.["value"])))
    db.prepare("UPDATE meta SET value = ? WHERE key = 'view'").run(JSON.stringify({ ...meta, mtimeMs: meta.mtimeMs - 1 }))
  } finally {
    db.close()
  }
}

/** A view's phases for `path`: kept by a first page, paged warm, and continued once aged. */
async function viewPhases(path: string, entries: number): Promise<Partial<Row>> {
  const folder = await mkdtemp(join(tmpdir(), "mako-bench-views-"))
  // Every reader, as the app's catalog has them, so a large record decodes in a child process as it does there.
  const stores = new NativeStores(true)
  const viewing = () => new SessionCatalog(SAVED_HISTORY_READERS.map((make) => make(stores)), { translator, viewsPath: folder, decodeAside: new DecodeAside() })
  try {
    const first = viewing()
    const kept = await sampled(() => first.page(path, undefined, undefined, VIEWER_PAGE))
    await first.stop()
    const views = new ViewCache(folder, () => translator)
    const [view] = await views.list()
    if (!view) return { viewPageMs: kept.ms }
    const warm = viewing()
    const paged = await sampled(() => warm.page(path, undefined, undefined, VIEWER_PAGE))
    await warm.stop()
    const phases: Partial<Row> = { viewPageMs: kept.ms, viewPagePeakMiB: kept.peakMiB, viewBytes: view.size, warmPageMs: paged.ms, warmPeakMiB: paged.peakMiB }
    age(view.file)
    const grown = viewing()
    const continued = await sampled(() => grown.page(path, undefined, undefined, VIEWER_PAGE))
    await grown.stop()
    const [after] = await views.list()
    if (after?.continued) {
      if (continued.value?.total !== entries) throw new Error(`${path}: a continued view holds ${continued.value?.total} entries, a whole decode ${entries}`)
      phases.continuedMs = continued.ms
      phases.continuedPeakMiB = continued.peakMiB
    }
    return phases
  } finally {
    await rm(folder, { recursive: true, force: true })
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
      ...await viewPhases(path, opened.value.entries.length),
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
    `  cuts ${row.cuts.earlier + row.cuts.clipped}${before ? ` (was ${before.cuts.earlier + before.cuts.clipped})` : ""}` +
    (row.viewBytes === undefined ? "" : `  view ${size(row.viewBytes)}, kept by a page of ${Math.round(row.viewPageMs ?? 0)} ms (+${Math.round(row.viewPagePeakMiB ?? 0)} MiB), warm page ${Math.round(row.warmPageMs ?? 0)} ms (+${Math.round(row.warmPeakMiB ?? 0)} MiB)`) +
    (row.continuedMs === undefined ? "" : `, grown ${Math.round(row.continuedMs)} ms (+${Math.round(row.continuedPeakMiB ?? 0)} MiB)`)
  )
}
