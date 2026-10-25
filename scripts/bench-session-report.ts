import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { z } from "zod"
import type { ExternalThreadActivity } from "@mako/host/contracts/host-events-boot"
import { ThreadRefSchema } from "@mako/sessions/thread-schema"
import { ownedSessions, SessionReporter, type NativeRow, type ReportSources } from "@mako/host/conversations/session-report"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { invokeRuntime } from "@mako/host/transport/connection"
import { appDataFolder, runtimeDataRoot, runtimeLocation } from "@mako/host/transport/service"

/**
 * What telling the account this Mac's Sessions costs, on this Mac's own sessions: the rail and its activity read from
 * the installed host (`mako:threads`, read-only, the same rows its report reads), the report's rows computed from them
 * (`ownedSessions`), and the bytes its first report and a one-row change take on the link. Then the same at 2,000
 * rows, the most one owner lists. Prints counts and timings only, never a title or a path.
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
function timed(runs: number, work: () => void) {
  const samples: number[] = []
  for (let run = 0; run < runs; run++) {
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
    lastMoved: () => undefined,
    placement: () => undefined,
    execution: () => undefined,
    thread: () => undefined,
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
 * many sessions in 30 days lists. Rows the window files as archived (a harness deleted them) are no model of one.
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

const result = {
  at: new Date().toISOString(),
  rail: { rows: real.length, placed, archived: real.filter((row) => row.archived || row.copyOnly).length, active: Object.values(activity).filter((each) => each.status !== "open").length },
  railReadMs: { median: median(reads), p95: Math.max(...reads) },
  thisMac: { ...realBytes, computeMs: realTimed },
  twoThousand: { ...bigBytes, computeMs: bigTimed },
}
const ms = (value: number) => `${value.toFixed(2)} ms`
const kb = (value: number) => `${(value / 1024).toFixed(1)} KB`
console.log(`This Mac's rail: ${result.rail.rows} rows (${result.rail.archived} archived: their harness deleted them), ${placed} placed in Threads, ${result.rail.active} at work now`)
console.log(`Reading the rail from the host (mako:threads, IPC included): median ${ms(result.railReadMs.median)}, worst ${ms(result.railReadMs.p95)}`)
console.table({
  "this Mac": { listed: realBytes.listed, compute: `${ms(realTimed.median)} (p95 ${ms(realTimed.p95)})`, "first report": `${kb(realBytes.firstBytes)} in ${realBytes.firstFrames} frames`, "one change": `${realBytes.changeBytes} B` },
  "2,000 rows": { listed: bigBytes.listed, compute: `${ms(bigTimed.median)} (p95 ${ms(bigTimed.p95)})`, "first report": `${kb(bigBytes.firstBytes)} in ${bigBytes.firstFrames} frames`, "one change": `${bigBytes.changeBytes} B` },
})
if (values.report) await writeFile(values.report, `${JSON.stringify(result, null, 2)}\n`)
process.exit(0)
