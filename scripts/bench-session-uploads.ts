import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { planRecordImport, RecordConflictError, type RecordVersion, type PackedChunk, type RecordBundle, type RecordHoldings, type RecordPulled, type RecordPushAnswer, type RecordRemote, type RecordSession } from "@mako/protocol/records"
import type { ExternalThreadActivity } from "@mako/host/contracts/host-events-boot"
import { ownedSessions, type NativeRow } from "@mako/host/conversations/session-report"
import { uploadScope } from "@mako/host/conversations/session-uploads"
import { invokeRuntime } from "@mako/host/transport/connection"
import { appDataFolder, runtimeDataRoot, runtimeLocation } from "@mako/host/transport/service"
import { SAVED_HISTORY_READERS, SessionCatalog, type Entry } from "@mako/sessions"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { ReadingCopies, type CopyViews } from "@mako/sessions/reading-copies"
import { ThreadRefSchema } from "@mako/sessions/thread-schema"

/**
 * What keeping this Mac's reading copies in the account costs, on this Mac's own sessions: the Sessions the account
 * lists of it (the installed host's rail, read-only, through `ownedSessions`), each drawn by a read-only catalog as the
 * owner's catalog draws it, written as its copy, captured and pushed by `ReadingCopies` in `uploadScope`'s order to a
 * remote in memory that takes them by the gateway's rule. Measures the first upload (bytes, chunks, requests, wall and
 * CPU time, drawing included), one more turn on the largest Session, and a restart, which should draw and send
 * nothing. The network is left out: bytes are what it carries. The harnesses' stores are only read; the copies go under
 * `$MAKO_THREAD_DATA_DIR` and are removed.
 *
 *   npx tsx scripts/bench-session-uploads.ts [--report <file>] [--keep]
 */
const { values } = parseArgs({ options: { report: { type: "string" }, keep: { type: "boolean", default: false } } })

/** The gateway's records routes in memory, by the same rule: chunks kept once by hash, versions numbered, refusals said. */
class MemoryRemote implements RecordRemote {
  readonly chunks = new Map<string, PackedChunk>()
  readonly units = new Map<string, { kind: RecordVersion["kind"]; chunks: string }[]>()
  bytes = 0
  requests = 0
  readonly kinds: Record<string, number> = {}
  /** When each session's bundle was first taken, by native session. */
  readonly taken = new Map<string, number>()
  constructor(readonly id: string) {}
  #count(kind: string) {
    this.requests++
    this.kinds[kind] = (this.kinds[kind] ?? 0) + 1
  }
  async missing(hashes: string[]) {
    this.#count("missing")
    return hashes.filter((hash) => !this.chunks.has(hash))
  }
  async putChunks(pack: PackedChunk[]) {
    this.#count("chunks")
    for (const chunk of pack) this.#keep(chunk)
    return { taken: pack.length }
  }
  async readChunks(hashes: string[]) {
    return hashes.flatMap((hash) => this.chunks.get(hash) ?? [])
  }
  async push(bundle: RecordBundle) {
    this.#count("push")
    return this.#take(bundle)
  }
  async pushWith(bundle: RecordBundle, chunks: PackedChunk[]): Promise<RecordPushAnswer | { missing: string[] }> {
    this.#count("push with chunks")
    for (const chunk of chunks) this.#keep(chunk)
    return this.#take(bundle)
  }
  async holdings(): Promise<{ holdings: RecordHoldings; next: string | null }> {
    return { holdings: {}, next: null }
  }
  async pull(): Promise<RecordPulled | null> {
    return null
  }
  async sessions(): Promise<RecordSession[]> {
    return []
  }
  #keep(chunk: PackedChunk) {
    if (this.chunks.has(chunk.hash)) return
    this.chunks.set(chunk.hash, chunk)
    this.bytes += chunk.body.length
  }
  #take(bundle: RecordBundle): RecordPushAnswer {
    const key = (unit: string) => `${bundle.harness}\n${bundle.nativeId}\n${unit}`
    try {
      const plan = planRecordImport(bundle, (unit) => {
        const held = this.units.get(key(unit))
        return held && { head: held.length - 1, version: (seq: number) => held[seq] }
      })
      if (!this.taken.has(bundle.nativeId)) this.taken.set(bundle.nativeId, performance.now())
      for (const { unit, version } of plan.taking) {
        const held = this.units.get(key(unit.key)) ?? []
        held.push({ kind: version.kind, chunks: version.chunks })
        this.units.set(key(unit.key), held)
      }
      return { ok: true, versions: plan.taking.length, held: plan.held, through: 0 }
    } catch (error) {
      if (!(error instanceof RecordConflictError)) throw error
      return { ok: false, conflict: error.conflict, key: error.key, seq: error.seq, head: error.head, message: error.message }
    }
  }
}

const RailSchema = z.object({
  threads: z.array(ThreadRefSchema),
  activity: z.record(z.string(), z.object({ provider: z.string(), since: z.number(), status: z.enum(["active", "needs-input", "open"]), detail: z.string().optional() })),
})
const { socket } = runtimeLocation(runtimeDataRoot(appDataFolder(), {}))
const rail = RailSchema.parse(await invokeRuntime(socket, randomUUID(), "mako:threads", [undefined]))
const native: NativeRow[] = rail.threads
const activity: Record<string, ExternalThreadActivity> = rail.activity
const listed = ownedSessions({
  summaries: () => [],
  native: () => native,
  activity: (path) => activity[path],
  work: () => [],
  waitingOn: () => undefined,
  hidden: () => new Set(),
  lastMoved: () => undefined,
  placement: () => undefined,
  execution: () => undefined,
  thread: () => undefined,
  now: Date.now,
})
const pathOf = (harness: string, nativeId: string) => native.find((ref) => ref.harness === harness && ref.nativeId === nativeId)?.path
const scope = uploadScope(listed, { onBattery: false, percent: undefined, lowPower: false }, pathOf, Date.now())

const scratch = join(process.env.MAKO_THREAD_DATA_DIR ?? join(homedir(), ".mako", "tmp"), `bench-session-uploads-${Date.now()}`)
mkdirSync(scratch, { recursive: true })
try {
  // The harnesses' stores, read read-only through the readers the catalog worker runs, drawn as the catalog draws them.
  const stores = new NativeStores(true)
  const catalog = new SessionCatalog(SAVED_HISTORY_READERS.map((reader) => reader(stores)), { readOnly: true })
  await catalog.scan()
  /** The largest Session's entries, held so one more turn can be added to it. */
  const held = new Map<string, Entry[]>()
  const turned = new Set<string>()
  let drawMs = 0
  const views: CopyViews = {
    view: async (path) => {
      const kept = held.get(path)
      const ref = native.find((each) => each.path === path)
      // Drawn once: the owner's catalog keeps a Session's view and draws only what's new, which this one doesn't.
      if (kept && ref) return { view: { total: kept.length, translator: "bench", at: (index: number) => kept[index] ?? null }, ref }
      const began = performance.now()
      const thread = await catalog.open(path, false)
      drawMs += performance.now() - began
      if (!thread) return null
      const entries = held.get(path) ?? thread.entries
      held.set(path, entries)
      return { view: { total: entries.length, translator: "bench", at: (index: number) => entries[index] ?? null }, ref: thread.ref }
    },
    // The records' stamp, and the turn this benchmark adds: what the owner's catalog would read after a write.
    stamp: (path) => `${catalog.stampOf(path)}${turned.has(path) ? ":turned" : ""}`,
    translator: () => "bench",
  }
  const remote = new MemoryRemote("bench/d-1")
  const link = { id: "bench/d-1", base: "https://bench.invalid/v1/devices/d-1/records", authorization: "Bearer bench" }
  // A clock the benchmark moves on, so a turn comes due when it would on the owner.
  let skew = 0
  const open = () => new ReadingCopies(join(scratch, "copies"), views, () => {}, { remote: () => remote, now: () => Date.now() + skew })

  const cpu = process.cpuUsage()
  const started = performance.now()
  const copies = open()
  copies.scope(scope)
  copies.link(link)
  await copies.settled()
  const firstMs = performance.now() - started
  const firstCpu = process.cpuUsage(cpu)
  const first = { bytes: remote.bytes, chunks: remote.chunks.size, requests: remote.requests, kinds: { ...remote.kinds } }

  // One more turn on the largest Session, as its owner would copy it next.
  const [largest] = [...held].sort((left, right) => right[1].length - left[1].length)
  let turn = { bytes: 0, requests: 0, ms: 0 }
  let turnKinds: Record<string, number> = {}
  if (largest) {
    const [path, entries] = largest
    const last = entries.at(-1)
    if (last) entries.push({ ...last, id: `bench-${randomUUID()}` })
    turned.add(path)
    const busy = { ...scope, sessions: scope.sessions.map((each) => ({ ...each, busy: each.path === path })) }
    const before = { bytes: remote.bytes, requests: remote.requests, kinds: { ...remote.kinds } }
    skew += 10 * 60_000
    const began = performance.now()
    copies.scope(busy)
    await copies.settled()
    turn = { bytes: remote.bytes - before.bytes, requests: remote.requests - before.requests, ms: Math.round(performance.now() - began) }
    turnKinds = Object.fromEntries(Object.entries(remote.kinds).map(([kind, count]) => [kind, count - (before.kinds[kind] ?? 0)]).filter(([, count]) => Number(count) > 0))
  }
  copies.stop()

  // A restart: what was copied is read from the copies, and nothing unchanged is drawn or sent again.
  const drawnBefore = drawMs
  const before = remote.requests
  const again = performance.now()
  const restarted = open()
  restarted.scope(scope)
  restarted.link(link)
  await restarted.settled()
  const restart = { ms: Math.round(performance.now() - again), requests: remote.requests - before, drawMs: Math.round(drawMs - drawnBefore) }
  restarted.stop()
  const atWork = listed.filter((row) => row.state === "working" || row.state === "waiting").length

  const result = {
    at: new Date().toISOString(),
    listed: listed.length,
    inScope: scope.sessions.length,
    first: { ms: Math.round(firstMs), drawMs: Math.round(drawnBefore), cpuMs: Math.round((firstCpu.user + firstCpu.system) / 1000), ...first },
    turn,
    restart,
    atWork,
    turnKinds,
    /** How long after the first upload began each Session at work was in the account. */
    atWorkInMs: scope.sessions.filter((each) => each.busy).map((each) => Math.round((remote.taken.get(each.nativeId) ?? Number.NaN) - started)),
  }
  const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  console.log(`Listed on this Mac: ${result.listed} Sessions, ${result.inScope} with a native session to copy (${atWork} at work)`)
  console.log(`First upload: ${mib(first.bytes)} in ${first.chunks} chunks and ${first.requests} requests; ${result.first.ms} ms wall, ${result.first.drawMs} ms of it drawing Sessions, ${result.first.cpuMs} ms CPU (no network)`)
  console.log(`At 20 Mbit/s up, about ${Math.ceil((first.bytes * 8) / 20e6)} s on the wire. Requests: ${JSON.stringify(first.kinds)}`)
  console.log(`Each Session at work was in the account after: ${result.atWorkInMs.map((ms) => `${ms} ms`).join(", ") || "none at work"}`)
  console.log(`One more turn on the largest Session: ${(turn.bytes / 1024).toFixed(1)} KiB in ${turn.requests} requests ${JSON.stringify(turnKinds)}, ${turn.ms} ms`)
  console.log(`A restart: ${restart.requests} requests, ${restart.drawMs} ms drawing, ${restart.ms} ms`)
  if (values.report) writeFileSync(values.report, `${JSON.stringify(result, null, 2)}\n`)
  await catalog.stop()
} finally {
  if (!values.keep) rmSync(scratch, { recursive: true, force: true })
}
process.exit(0)
