import { randomUUID } from "node:crypto"
import { readdirSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"
import { z } from "zod"
import type { ExternalThreadActivity } from "@mako/host/contracts/host-events-boot"
import { ThreadRefSchema } from "@mako/sessions/thread-schema"
import type { LiveSummary } from "@mako/host/contracts/live-conversations"
import { ownedSessions, SessionReporter, type NativeRow, type ReportSources } from "@mako/host/conversations/session-report"
import { windowStart } from "@mako/host/conversations/sync-window"
import { ThreadStore, threadStorePath } from "@mako/host/threads/store"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { invokeRuntime } from "@mako/host/transport/connection"
import { appDataFolder, runtimeDataRoot, runtimeLocation } from "@mako/host/transport/service"

/**
 * What telling the account this Mac's Sessions costs, on this Mac's own sessions: the rail and its activity read from
 * the installed host (`mako:threads`, read-only, the same rows its report reads), the report's rows computed from them
 * (`ownedSessions`), and the bytes its first report and a one-row change take on the link. Then the same at 2,000
 * rows, the most one owner lists. Then the report as the host makes it, against a copy of this Mac's Thread store
 * (`VACUUM INTO`, so the store itself is only read): this host's conversations placed by their journals and the rail's
 * rows in the sync window, with what the store says of every row read in one query each (`executionsOf`, `titlesOf`),
 * once after another process committed and once with nothing committed since; and the Thread groups the window takes
 * whole (`groups`), the same two ways. Prints counts and timings only, never a title or a path.
 *
 *   npx tsx scripts/bench-session-report.ts [--runs 200] [--report <file>]
 */
const { values } = parseArgs({ options: { runs: { type: "string", default: "200" }, report: { type: "string" } } })
const RUNS = Number(values.runs)

/** What `mako:threads` answers: the rail's rows as every window reads them, and each session's activity by path. */
const RailSchema = z.object({
  ready: z.boolean(),
  threads: z.array(ThreadRefSchema),
  activity: z.record(z.string(), z.object({ provider: z.string(), since: z.number(), status: z.enum(["active", "needs-input", "open"]), detail: z.string().optional(), evidence: z.literal("writes").optional() })),
})

const { socket } = runtimeLocation(runtimeDataRoot(appDataFolder(), {}))
const client = randomUUID()
const readRail = async () => RailSchema.parse(await invokeRuntime(socket, client, "mako:threads", [undefined]))

const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)] ?? 0
const p95 = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)] ?? 0
/** `work`'s time, `runs` times; `first` runs before each, untimed. */
function timed(runs: number, work: () => void, first?: () => void) {
  const samples: number[] = []
  for (let run = 0; run < runs; run++) {
    first?.()
    const began = performance.now()
    work()
    samples.push(performance.now() - began)
  }
  return { median: median(samples), p95: p95(samples) }
}

function sources(rows: readonly NativeRow[], activity: Readonly<Record<string, ExternalThreadActivity>>): ReportSources {
  return {
    summaries: () => [],
    native: () => rows,
    activity: (path) => activity[path],
    work: () => [],
    waitingOn: () => undefined,
    hidden: () => new Set(),
    lastMoved: () => undefined,
    placement: () => undefined,
    executions: () => new Map(),
    titles: () => new Map(),
    now: Date.now,
  }
}

const reads: number[] = []
let rail = await readRail()
for (let read = 0; read < 5; read++) {
  const began = performance.now()
  rail = await readRail()
  reads.push(performance.now() - began)
}
if (!rail.ready) console.warn("The host's catalog hasn't finished its first discovery; its rail may be short.")
const real: NativeRow[] = rail.threads
const activity: Record<string, ExternalThreadActivity> = rail.activity

const gateway = createFakeGateway()
async function reportBytes(rows: readonly NativeRow[]) {
  const listed = ownedSessions(sources(rows, activity))
  const reporter = new SessionReporter()
  const link = await gateway.connectRuntime()
  const first = reporter.reports(link, listed)
  reporter.sent(listed)
  const changed = listed.map((row, index) => (index === 0 ? { ...row, state: row.state === "working" ? ("idle" as const) : ("working" as const) } : row))
  const change = reporter.reports(link, changed)
  const bytes = (reports: unknown[]) => reports.reduce<number>((sum, report) => sum + Buffer.byteLength(JSON.stringify({ type: "sessions", report })), 0)
  return { listed: listed.length, firstFrames: first.length, firstBytes: bytes(first), changeBytes: bytes(change) }
}

/**
 * The real rail's listable rows made up to `size`, each copy its own session, newest first: what an owner with that
 * many sessions in its sync window lists. Rows the window files as archived (a harness deleted them) are no model of one.
 */
function scaled(size: number): NativeRow[] {
  const listable = real.filter((row) => !row.archived && !row.copyOnly && !row.nativeArchived)
  const rows: NativeRow[] = []
  for (let index = 0; rows.length < size && listable.length; index++) {
    const base = listable[index % listable.length]!
    rows.push({ ...base, path: `${base.path}#${index}`, sessionId: randomUUID(), threadId: randomUUID(), updatedAt: new Date(Date.now() - index * 60_000).toISOString() })
  }
  return rows
}

const placed = real.filter((row) => row.sessionId && row.threadId).length
const realTimed = timed(RUNS, () => ownedSessions(sources(real, activity)))
const realBytes = await reportBytes(real)
const big = scaled(2_000)
const bigTimed = timed(RUNS, () => ownedSessions(sources(big, activity)))
const bigBytes = await reportBytes(big)

// The report as the host makes it, against a copy of this Mac's Thread store.
const scratch = await mkdtemp(join(tmpdir(), "bench-session-report-"))
const copy = join(scratch, "threads.sqlite")
const original = new DatabaseSync(threadStorePath(join(homedir(), ".mako")), { readOnly: true })
original.prepare("VACUUM INTO ?").run(copy)
original.close()
const store = new ThreadStore(copy, { realPath: (path) => path })
/** Another process's commit, as the sync daemon or another profile's host makes one: what's read of many is read again. */
const other = new DatabaseSync(copy)
other.exec("CREATE TABLE bench_commits (at INTEGER NOT NULL)")
const commitElsewhere = () => void other.prepare("INSERT INTO bench_commits (at) VALUES (?)").run(performance.now())
const conversationIds = [...new Set(readdirSync(join(appDataFolder(), "mako", "conversations")).map((name) => name.split(".")[0] ?? ""))].filter((id) => /^[0-9a-f-]{36}$/.test(id))
const summaries: LiveSummary[] = conversationIds.map((id, index) => ({
  session: { id, harness: "codex", cwd: "/", status: "ready", connection: "hibernated", modes: [], currentMode: null, configOptions: [] },
  revision: 1,
  createdAt: Date.now() - index * 600_000,
}))
const inWindow = real.filter((row) => (row.updatedAt ?? "") >= windowStart(Date.now()))
const stored: ReportSources = {
  ...sources(inWindow, activity),
  summaries: () => summaries,
  placement: (id) => store.journalPlacement(id),
  executions: (ids) => store.executionsOf(ids),
  titles: (ids) => store.titlesOf(ids),
}
const storedRows = ownedSessions(stored).length
const afterCommit = timed(RUNS, () => {
  store.groups()
  ownedSessions(stored)
}, commitElsewhere)
const nothingCommitted = timed(RUNS, () => ownedSessions(stored))
const groupsAfterCommit = timed(RUNS, () => store.groups(), commitElsewhere)
const groups = store.groups().length
other.close()
store.close()
await rm(scratch, { recursive: true, force: true })

const result = {
  at: new Date().toISOString(),
  rail: { rows: real.length, placed, archived: real.filter((row) => row.archived || row.copyOnly).length, active: Object.values(activity).filter((each) => each.status !== "open").length },
  railReadMs: { median: median(reads), p95: Math.max(...reads) },
  thisMac: { ...realBytes, computeMs: realTimed },
  twoThousand: { ...bigBytes, computeMs: bigTimed },
  withThreadStore: {
    conversations: summaries.length,
    windowRows: inWindow.length,
    listed: storedRows,
    groups,
    reportAndGroupsAfterCommitMs: afterCommit,
    reportNothingCommittedMs: nothingCommitted,
    groupsAfterCommitMs: groupsAfterCommit,
  },
}
const ms = (value: number) => `${value.toFixed(2)} ms`
const kb = (value: number) => `${(value / 1024).toFixed(1)} KB`
console.log(`This Mac's rail: ${result.rail.rows} rows (${result.rail.archived} archived: their harness deleted them), ${placed} placed in Threads, ${result.rail.active} at work now`)
console.log(`Reading the rail from the host (mako:threads, IPC included): median ${ms(result.railReadMs.median)}, worst ${ms(result.railReadMs.p95)}`)
console.table({
  "this Mac": { listed: realBytes.listed, compute: `${ms(realTimed.median)} (p95 ${ms(realTimed.p95)})`, "first report": `${kb(realBytes.firstBytes)} in ${realBytes.firstFrames} frames`, "one change": `${realBytes.changeBytes} B` },
  "2,000 rows": { listed: bigBytes.listed, compute: `${ms(bigTimed.median)} (p95 ${ms(bigTimed.p95)})`, "first report": `${kb(bigBytes.firstBytes)} in ${bigBytes.firstFrames} frames`, "one change": `${bigBytes.changeBytes} B` },
})
const withStore = result.withThreadStore
console.log(`With this Mac's Thread store: ${withStore.conversations} conversations and ${withStore.windowRows} rail rows in the sync window, ${withStore.listed} listed, ${withStore.groups} Thread groups`)
console.table({
  "report and groups, after another process's commit": { median: ms(withStore.reportAndGroupsAfterCommitMs.median), p95: ms(withStore.reportAndGroupsAfterCommitMs.p95) },
  "report, nothing committed since": { median: ms(withStore.reportNothingCommittedMs.median), p95: ms(withStore.reportNothingCommittedMs.p95) },
  "groups alone, after a commit": { median: ms(withStore.groupsAfterCommitMs.median), p95: ms(withStore.groupsAfterCommitMs.p95) },
})
if (values.report) await writeFile(values.report, `${JSON.stringify(result, null, 2)}\n`)
process.exit(0)
