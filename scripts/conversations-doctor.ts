import { existsSync, statfsSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { makoViews, translatorBuild, ViewCache, VIEW_CACHE_BYTES } from "@mako/sessions"
import { plainRecordPath } from "@mako/sessions/record-files"
import { recordedPaths } from "@mako/sessions/record-store"
import { makoRecords } from "@mako/sessions/record-streams"
import { inspectJournal, journalIds, type JournalInspection } from "@mako/host/conversations/live-journal"
import { RECLAIM_MIN_BYTES } from "@mako/host/conversations/journal-reclaim"
import { defaultDataDir } from "./harness-doctor-report.ts"

/**
 * What each conversation's journal keeps and why, from local files only:
 * nothing is written, decoded or started.
 *
 *   npm run conversations:doctor                     journals keeping a copy of their history or free space, largest first
 *   npm run conversations:doctor -- --all            every journal
 *   npm run conversations:doctor -- e50f2b71         one conversation, by its id or the start of it
 *   npm run conversations:doctor -- --json           one machine-readable object
 *   npm run conversations:doctor -- --data-dir ~/Library/Application\ Support/mako-dev
 *   npm run conversations:doctor -- --records <dir> --views <dir>   another record store and view cache than ~/.mako's
 *
 * A journal reads its history from the harness's session when the record
 * store holds that session and Mako's turns are all in it; otherwise it
 * keeps a copy, and says why. A copy whose session the store could hold is
 * dropped by the app's sweep a minute after it starts, and a journal left
 * mostly free is compacted once it closes.
 */

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "boolean", default: false },
    all: { type: "boolean", default: false },
    "data-dir": { type: "string" },
    records: { type: "string" },
    views: { type: "string" },
  },
})

type Outlook = "read from its session" | "drops at the next sweep" | "kept" | "none"

interface Row extends JournalInspection {
  outlook: Outlook
  why?: string
  /** Where its session's file is: at the path the journal names, compressed beside it as Codex leaves idle rollouts, or gone. */
  sessionFile?: "present" | "compressed" | "gone"
  heldAt?: number | null
  reclaimable: boolean
}

const dataDir = options["data-dir"] ?? defaultDataDir()
const root = join(dataDir, "conversations")
const recordsFolder = options.records ?? makoRecords()
const held = (() => {
  try {
    return recordedPaths(recordsFolder)
  } catch (error) {
    console.warn(`The record store could not be read: ${error instanceof Error ? error.message : error}`)
    return new Map()
  }
})()
const wanted = positionals[0]
const ids = journalIds(root).filter((id) => !wanted || id.startsWith(wanted))
if (wanted && !ids.length) {
  console.error(`No conversation ${wanted} in ${root}`)
  process.exit(2)
}

const rows: Row[] = []
const unreadable: { id: string; error: string }[] = []
for (const id of ids) {
  try {
    rows.push(assess(inspectJournal(root, id)))
  } catch (error) {
    unreadable.push({ id, error: error instanceof z.ZodError ? z.prettifyError(error).replaceAll("\n", " ") : error instanceof Error ? error.message : String(error) })
  }
}

const views = new ViewCache(options.views ?? makoViews(), translatorBuild)
const viewList = await views.list()
const build = translatorBuild()
const report = {
  dataDir,
  journals: rows.length,
  bytes: sum(rows.map((row) => row.bytes)),
  readFromSession: rows.filter((row) => row.outlook === "read from its session").length,
  copies: { count: count(rows, (row) => row.copiedBaseBytes > 0), bytes: sum(rows.map((row) => row.copiedBaseBytes)) },
  dropsAtSweep: { count: count(rows, (row) => row.outlook === "drops at the next sweep"), bytes: sum(rows.filter((row) => row.outlook === "drops at the next sweep").map((row) => row.copiedBaseBytes)) },
  free: { bytes: sum(rows.map((row) => row.freeBytes)), compactable: count(rows, (row) => row.reclaimable) },
  views: {
    sessions: viewList.length,
    bytes: sum(viewList.map((view) => view.size)),
    budget: VIEW_CACHE_BYTES,
    thisBuild: count(viewList, (view) => view.translator === build),
  },
  recordedPaths: held.size,
  sweepTakes: sweepTakes(),
  unreadable,
  rows: rows
    .filter((row) => options.all || wanted || row.copiedBaseBytes > 0 || row.reclaimable)
    .sort((a, b) => b.copiedBaseBytes - a.copiedBaseBytes || b.freeBytes - a.freeBytes),
}

if (options.json) console.log(JSON.stringify(report, null, 2))
else console.log(format(report))

function assess(journal: JournalInspection): Row {
  const reclaimable = journal.freeBytes >= RECLAIM_MIN_BYTES && journal.freeBytes * 4 >= journal.bytes
  const source = journal.baseSource ?? journal.candidate
  const sessionFile = source ? whereIs(source.path) : undefined
  const heldAt = source ? placesOf(source.path).map((path) => held.get(path)?.capturedAt).find((at) => at !== undefined) : undefined
  const row = { ...journal, reclaimable, sessionFile, heldAt }
  if (journal.baseSource && !journal.keptBecause) return { ...row, outlook: "read from its session" }
  if (!journal.copiedBaseBytes) return { ...row, outlook: "none" }
  if (journal.candidate && journal.keptOnceHeldBecause) return { ...row, outlook: "kept", why: journal.keptOnceHeldBecause }
  if (journal.candidate && sessionFile && sessionFile !== "gone") return { ...row, outlook: "drops at the next sweep", why: "the sweep holds its session in the record store, then drops the copy" }
  if (journal.candidate) return { ...row, outlook: "kept", why: "nothing is at its session's path for the record store to take (its harness deleted it, or Mako made this history)" }
  return { ...row, outlook: "kept", why: journal.keptBecause ?? undefined }
}

/**
 * What the sweep's holds can add to the record store: each session it will
 * hold and the store doesn't yet, at its files' full size (a database with
 * its write-ahead log). A hold that would leave the disk under its margin
 * is refused (`RecordCapture.hold`), and that journal keeps its copy.
 */
function sweepTakes() {
  const paths = new Set(rows.filter((row) => row.outlook === "drops at the next sweep" && !row.heldAt).map((row) => (row.baseSource ?? row.candidate)!.path))
  let bytes = 0
  for (const path of paths) {
    const plain = plainRecordPath(path.split("#")[0] ?? path)
    for (const file of [plain, `${plain}.zst`, `${plain}-wal`]) bytes += statSync(file, { throwIfNoEntry: false })?.size ?? 0
  }
  let folder = recordsFolder
  while (!existsSync(folder) && dirname(folder) !== folder) folder = dirname(folder)
  const disk = statfsSync(folder)
  return { sessions: paths.size, bytes, diskFree: disk.bavail * disk.bsize }
}

function placesOf(path: string): string[] {
  const plain = plainRecordPath(path)
  return [plain, `${plain}.zst`]
}

function whereIs(path: string): Row["sessionFile"] {
  const plain = plainRecordPath(path.split("#")[0] ?? path)
  return existsSync(plain) ? "present" : existsSync(`${plain}.zst`) ? "compressed" : "gone"
}

function format(value: typeof report): string {
  const lines = [
    `Conversations in ${join(value.dataDir, "conversations")}: ${value.journals} journals, ${size(value.bytes)}`,
    `  history read from its session: ${value.readFromSession} · copies kept: ${value.copies.count} (${size(value.copies.bytes)}) · drop at the next sweep: ${value.dropsAtSweep.count} (${size(value.dropsAtSweep.bytes)})`,
    `  free inside journals: ${size(value.free.bytes)}; ${value.free.compactable} worth compacting when they close`,
    `Views: ${value.views.sessions} sessions, ${size(value.views.bytes)} of ${size(value.views.budget)}; ${value.views.thisBuild} by this build, the rest open stale until decoded again`,
    `Records: ${value.recordedPaths} session paths held; the sweep holds ${value.sweepTakes.sessions} more, ${size(value.sweepTakes.bytes)} of session files at most (the store keeps them compressed), on a disk with ${size(value.sweepTakes.diskFree)} free`,
  ]
  if (value.unreadable.length) lines.push(`Unreadable journals: ${value.unreadable.map(({ id, error }) => `${id.slice(0, 8)} (${error})`).join(", ")}`)
  if (value.rows.length) lines.push("")
  for (const row of value.rows) {
    const title = row.session.title ? ` "${row.session.title.slice(0, 60)}"` : ""
    const copy = row.copiedBaseBytes ? `, copy ${size(row.copiedBaseBytes)} (${row.baseEntries} entries)` : ""
    lines.push(`${row.id.slice(0, 8)} ${row.session.harness.padEnd(8)}${title}${row.fork ? " (fork)" : ""}`)
    lines.push(`   ${size(row.bytes)} file, ${size(row.freeBytes)} free${row.reclaimable ? " (compacts on close)" : ""}, ${row.blocks} live blocks${copy}`)
    lines.push(`   history: ${row.outlook}${row.why ? `: ${row.why}` : ""}`)
    const source = row.baseSource ?? row.candidate
    if (source) {
      const holding = row.heldAt ? `held, last captured ${new Date(row.heldAt).toISOString()}` : "not held"
      lines.push(`   session: ${source.harness} ${source.nativeId}, file ${row.sessionFile}, ${holding}`)
      lines.push(`            ${source.path}`)
    }
  }
  return lines.join("\n")
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function count<T>(values: T[], test: (value: T) => boolean): number {
  return values.filter(test).length
}