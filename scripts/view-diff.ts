/**
 * Whether a decode continued from a resume point holds what a whole decode
 * does, on this Mac's own sessions. For each session of each reader that
 * continues decodes (`readFrom`), and each cut: a clone of its record cut at
 * a line, in a home of its own, decoded whole; the rest of the record
 * appended to the clone; the decode continued from where the first said it
 * can; and the two parts beside a whole decode of the grown clone, entry by
 * entry. Read-only for the harnesses: the clones are in a temporary folder.
 *
 *   npx tsx scripts/view-diff.ts                       10 newest sessions of each reader, cut at 50%, 90% and 99%
 *   npx tsx scripts/view-diff.ts --only codex --per 40 --cuts 0.3,0.97
 *   npx tsx scripts/view-diff.ts --largest --per 3     the largest sessions instead of the newest
 *   npx tsx scripts/view-diff.ts --path <record>       one record, at every --cuts
 *   npx tsx scripts/view-diff.ts --fixtures            every decoding fixture's records, cut at every line
 *   npx tsx scripts/view-diff.ts --save <file>         the run's rows as JSON
 *
 * Outcomes: `exact` (the parts equal the whole decode), `whole` (the reader
 * asked for a whole decode, as the catalog then does: no resume point, a
 * line reaching back, or an id the prefix holds), and `differs`, a bug.
 */
import assert from "node:assert/strict"
import { constants, createReadStream, createWriteStream } from "node:fs"
import { copyFile, cp, glob, mkdir, mkdtemp, open, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { parseArgs } from "node:util"
import { pipeline } from "node:stream/promises"
import type { Entry, SessionProvider, Thread } from "@mako/sessions"
import { z } from "zod"
import { storeReader } from "./decode-compare"
import { FIXTURE_ROOT } from "./native-decoding"

const { values: options } = parseArgs({
  options: {
    only: { type: "string" },
    per: { type: "string", default: "10" },
    cuts: { type: "string", default: "0.5,0.9,0.99" },
    path: { type: "string" },
    "max-mib": { type: "string", default: "4096" },
    largest: { type: "boolean", default: false },
    fixtures: { type: "boolean", default: false },
    save: { type: "string" },
  },
})

const READERS = ["claude", "codex", "cursor", "devin-ide", "grok"]
/** Readers whose record is one file of a folder its session owns. */
const OWN_FOLDER = new Set(["grok", "devin-ide"])
const MIB = 1024 ** 2
const cuts = options.cuts.split(",").map(Number)
const maxBytes = Number(options["max-mib"]) * MIB

interface Row {
  reader: string
  path: string
  bytes: number
  cut: number
  outcome: "exact" | "whole" | "differs"
  why?: string
  prefixEntries?: number
  resumedAt?: number
  tailEntries?: number
  wholeMs?: number
  tailMs?: number
}

/** The first line boundary at or after `at`. */
async function lineEnd(path: string, at: number, size: number): Promise<number> {
  const handle = await open(path, "r")
  try {
    const chunk = Buffer.alloc(1 << 16)
    for (let offset = at; offset < size; offset += chunk.length) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset)
      const newline = chunk.subarray(0, bytesRead).indexOf(0x0a)
      if (newline >= 0) return offset + newline + 1
    }
    return size
  } finally {
    await handle.close()
  }
}

/** A resume point as compared: a read that began later seals fewer of the bytes before its end, as it read fewer. */
function point(resume: Thread["resume"]) {
  if (!resume) return null
  const { seal, ...rest } = resume
  return { ...rest, identity: seal.identity, to: seal.to }
}

/** Entries as compared: ids, types and content, in order. */
function shown(entries: readonly Entry[]): string[] {
  return entries.map((entry) => JSON.stringify(entry))
}

function firstDifference(a: string[], b: string[]): string | undefined {
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index++) {
    if (a[index] === b[index]) continue
    return `entry ${index} of ${a.length}/${b.length}: ${(a[index] ?? "(none)").slice(0, 300)} ≠ ${(b[index] ?? "(none)").slice(0, 300)}`
  }
  return undefined
}

/** `cut` is a fraction of the record, or with `exactly` the byte to cut at. */
async function diffAt(reader: string, source: string, sourceHome: string, cut: number, exactly = false): Promise<Row> {
  const size = (await stat(source)).size
  const at = exactly ? cut : await lineEnd(source, Math.floor(size * cut), size)
  const row: Omit<Row, "outcome"> = { reader, path: source, bytes: size, cut }
  const home = await mkdtemp(join(tmpdir(), `mako-view-diff-${reader}-`))
  try {
    const path = join(home, relative(sourceHome, source))
    await mkdir(dirname(path), { recursive: true })
    // A record that is one file of its session's folder reads the rest of the folder too.
    if (OWN_FOLDER.has(reader)) await cp(dirname(source), dirname(path), { recursive: true })
    await copyFile(source, path, constants.COPYFILE_FICLONE)
    await truncate(path, at)
    const provider: SessionProvider = storeReader(reader, home)
    const prefix = await provider.read(path)
    if (!prefix) return { ...row, outcome: "whole", why: "the cut record doesn't read" }
    row.prefixEntries = prefix.entries.length
    // The rest of the record, appended to the same file: a session that grew.
    if (at < size) await pipeline(createReadStream(source, { start: at, end: size - 1 }), createWriteStream(path, { flags: "a" }))
    let started = performance.now()
    const whole = await provider.read(path)
    row.wholeMs = Math.round(performance.now() - started)
    assert.ok(whole, "the grown record reads")
    const from = prefix.resume
    if (!from) return { ...row, outcome: "whole", why: "no resume point" }
    row.resumedAt = from.entry
    if (!provider.readFrom) return { ...row, outcome: "whole", why: "no readFrom" }
    started = performance.now()
    const tail = await provider.readFrom(path, from, prefix.entries[from.entry - 1]?.id)
    row.tailMs = Math.round(performance.now() - started)
    if (!tail) return { ...row, outcome: "whole", why: "the reader asked for a whole decode" }
    row.tailEntries = tail.entries.length
    const kept = new Set(prefix.entries.slice(0, from.entry).flatMap((entry) => entry.id ? [entry.id] : []))
    const taken = tail.entries.find((entry) => entry.id !== undefined && kept.has(entry.id))
    if (taken) return { ...row, outcome: "whole", why: `the prefix holds id ${taken.id}` }
    const joined: Thread = { ref: tail.ref, entries: [...prefix.entries.slice(0, from.entry), ...tail.entries] }
    const difference = firstDifference(shown(joined.entries), shown(whole.entries))
      ?? (JSON.stringify(tail.unread ?? null) === JSON.stringify(whole.unread ?? null) ? undefined : `unread ${JSON.stringify(tail.unread)} ≠ ${JSON.stringify(whole.unread)}`)
      ?? (tail.checkpoint === whole.checkpoint ? undefined : `checkpoint ${tail.checkpoint} ≠ ${whole.checkpoint}`)
      ?? (JSON.stringify(point(tail.resume)) === JSON.stringify(point(whole.resume)) ? undefined : `resume ${JSON.stringify(tail.resume)} ≠ ${JSON.stringify(whole.resume)}`)
    return difference ? { ...row, outcome: "differs", why: difference } : { ...row, outcome: "exact" }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

/** Cursor's plain agent transcripts: its only records that grow, and children, so no listing names them. */
async function cursorTranscripts(home: string): Promise<{ path: string; bytes: number; mtimeMs: number }[]> {
  const files: { path: string; bytes: number; mtimeMs: number }[] = []
  for await (const path of glob(join(home, ".cursor/projects/*/agent-transcripts/*/subagents/*.jsonl"))) {
    const info = await stat(path)
    files.push({ path, bytes: info.size, mtimeMs: info.mtimeMs })
  }
  return files
}

/** Where each line of `path` ends. */
async function lineEnds(path: string): Promise<number[]> {
  const bytes = await readFile(path)
  const ends: number[] = []
  for (let at = bytes.indexOf(0x0a); at >= 0; at = bytes.indexOf(0x0a, at + 1)) ends.push(at + 1)
  return ends
}

const PairSchema = z.object({ stores: z.array(z.object({ reader: z.string(), path: z.string() })) })
const rows: Row[] = []
const home = homedir()
if (options.fixtures) {
  const only = options.only ? new Set(options.only.split(",")) : undefined
  for (const harness of await readdir(FIXTURE_ROOT)) {
    for (const name of await readdir(join(FIXTURE_ROOT, harness, "pairs")).catch(() => [])) {
      const pair = join(FIXTURE_ROOT, harness, "pairs", name)
      const parsed = PairSchema.safeParse(JSON.parse(await readFile(join(pair, "pair.json"), "utf8").catch(() => "{}")))
      for (const store of parsed.data?.stores ?? []) {
        if (!READERS.includes(store.reader) || (only && !only.has(store.reader)) || store.path.includes("#") || store.path.endsWith(".db")) continue
        const source = join(pair, "home", store.path)
        for (const end of await lineEnds(source).catch(() => [])) {
          const row = await diffAt(store.reader, source, join(pair, "home"), end, true).catch((error: Error): Row => ({ reader: store.reader, path: source, bytes: 0, cut: end, outcome: "differs", why: `threw: ${error.message}` }))
          rows.push(row)
          if (row.outcome === "differs") console.log(`differs ${store.reader} ${harness}/${name} @${end}: ${row.why}`)
        }
      }
    }
  }
  for (const reader of READERS) {
    const mine = rows.filter((row) => row.reader === reader)
    if (mine.length) console.log(`${reader}: ${mine.filter((row) => row.outcome === "exact").length} exact, ${mine.filter((row) => row.outcome === "whole").length} whole, ${mine.filter((row) => row.outcome === "differs").length} differ of ${mine.length} cuts`)
  }
}
for (const reader of options.fixtures ? [] : options.only ? options.only.split(",") : READERS) {
  const provider = storeReader(reader, home)
  if (!provider.readFrom) {
    console.log(`${reader}: no readFrom`)
    continue
  }
  const sources = options.path
    ? [options.path]
    : (reader === "cursor" ? await cursorTranscripts(home) : await provider.discover())
        // A compressed record is a finished one, and a database no file that grows: no decode of either continues.
        .filter((file) => !file.path.includes("#") && !file.path.endsWith(".zst") && !file.path.endsWith(".db") && file.bytes <= maxBytes)
        .sort((a, b) => options.largest ? b.bytes - a.bytes : b.mtimeMs - a.mtimeMs)
        .slice(0, Number(options.per))
        .map((file) => file.path)
  for (const source of sources) {
    for (const cut of cuts) {
      const row = await diffAt(reader, source, home, cut).catch((error: Error): Row => ({ reader, path: source, bytes: 0, cut, outcome: "differs", why: `threw: ${error.message}` }))
      rows.push(row)
      if (row.outcome !== "exact") console.log(`${row.outcome.padEnd(7)} ${reader} ${relative(home, source)} @${cut}: ${row.why}`)
    }
  }
  const mine = rows.filter((row) => row.reader === reader)
  const count = (outcome: Row["outcome"]) => mine.filter((row) => row.outcome === outcome).length
  const tails = mine.filter((row) => row.tailMs !== undefined && row.wholeMs !== undefined)
  const speedup = tails.length ? tails.reduce((sum, row) => sum + row.wholeMs!, 0) / Math.max(1, tails.reduce((sum, row) => sum + row.tailMs!, 0)) : 0
  console.log(`${reader}: ${count("exact")} exact, ${count("whole")} whole, ${count("differs")} differ of ${mine.length} cuts; a continued decode ${speedup.toFixed(1)}x a whole one`)
}
if (options.save) await writeFile(options.save, JSON.stringify(rows, null, 2))
const differs = rows.filter((row) => row.outcome === "differs").length
if (differs) {
  console.log(`FAIL: ${differs} continued decodes differ from a whole one`)
  process.exitCode = 1
} else console.log(`PASS: every continued decode of ${rows.length} equals a whole one (${rows.filter((row) => row.outcome === "whole").length} asked for a whole decode)`)
