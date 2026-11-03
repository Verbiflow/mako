import { spawn, type ChildProcess } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"
import { z } from "zod"
import { BackfillProgressSchema } from "../packages/sessions/src/record-backfill.ts"
import { ON_DEMAND_CATALOG_ENV, ON_DEMAND_CATALOG_NODE_ARGS } from "../packages/host/src/threads/daemon-command.ts"
import { connectDaemon, type DaemonClient } from "../packages/sessions/src/daemon.ts"
import { largeCursorChat, type ChatRow } from "../packages/sessions/test/large-cursor-chat.mjs"
import { RecordsStandIn } from "./lib/records-stand-in.ts"
import { removeScratch } from "./lib/scratch-processes.mjs"

/**
 * How long the sync daemon holds its loop while a large Cursor Session goes on: `npm run bench:syncd-loop`.
 *
 * A scratch home holds a Cursor chat of some 25 MB as `cursor-agent` keeps one (`store.db`: content-addressed blobs,
 * a root naming the messages rewritten at each step, large tool outputs and file snapshots among them), or a copy of a
 * real one (`--store <store.db>`, read once; the bench writes only its own copy), or a Cursor SDK agent as a Fin's
 * runs (`--sdk <dir>`: copies of its `store.db` and of an `index.db` holding its rows, its newest run going on as the
 * turn goes on, its events streamed into the index between checkpoints). The real sync daemon (this
 * checkout's build, or `--daemon <daemon-main.js>` for another's) runs on it as the host starts it, with the chat in
 * its scope and both links at a gateway stand-in in this process. Once the backfill has taken the chat and the account
 * holds it, the chat goes on: `--steps` steps of a turn, each its blobs and a new root, `--every-ms` apart. Meanwhile a
 * window reads it (a page of its newest entries whenever it moves, and the whole of it a page at a time, as the host
 * reads a history), the host asks the sync status every 250 ms with its 3 s timeout, and a client of its own pings the
 * daemon every 20 ms: a ping's round trip is how long the daemon's loop kept it waiting.
 *
 * `--writer-holds-ms` plays a backfill pass's process meanwhile, taking the record store's write lock that long at a
 * time, as its captures do between commits.
 *
 * It fails (exit 1) when the longest ping waited past `--hold-ms` (50) or a status read timed out. `--cpu-prof <dir>`
 * writes the daemon's CPU profile there; `--out <file>` keeps the report.
 *
 *   npm run bench:syncd-loop [-- --daemon <daemon-main.js>] [--store <store.db> [--rows <n>] | --sdk <dir> | --turns 2 --turn-steps 80] [--steps 40] [--every-ms 250] [--hold-ms 50] [--writer-holds-ms 2000] [--cpu-prof <dir>] [--out <file>] [--keep]
 */
const { values } = parseArgs({
  options: {
    daemon: { type: "string" },
    store: { type: "string" },
    sdk: { type: "string" },
    turns: { type: "string", default: "2" },
    "turn-steps": { type: "string", default: "80" },
    rows: { type: "string" },
    steps: { type: "string", default: "40" },
    "every-ms": { type: "string", default: "250" },
    "hold-ms": { type: "string", default: "50" },
    "writer-holds-ms": { type: "string", default: "0" },
    "play-writer": { type: "string" },
    port: { type: "string", default: "0" },
    "cpu-prof": { type: "string" },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
  },
})
const daemonScript = resolve(values.daemon ?? join(import.meta.dirname, "../packages/sessions/dist/daemon-main.js"))
const steps = Number(values.steps)
const everyMs = Number(values["every-ms"])
const holdBudget = Number(values["hold-ms"])
const say = (line: string) => process.stderr.write(`${line}\n`)
const writerHolds = Number(values["writer-holds-ms"])
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms))
const percentile = (sorted: readonly number[], share: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!) : null)
const summary = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return { n: sorted.length, p50: percentile(sorted, 0.5), p99: percentile(sorted, 0.99), max: sorted.length ? Math.round(sorted.at(-1)!) : null }
}

const BlobRowSchema = z.object({ id: z.string(), data: z.instanceof(Uint8Array) })
const ChatMetaSchema = z.object({ agentId: z.string().optional() })

/** The rows of a real chat, in the order its harness wrote them, and where each step of its turns ended (a root written). */
function rowsOf(store: string) {
  const db = new DatabaseSync(store, { readOnly: true })
  try {
    const rows = BlobRowSchema.array().parse(db.prepare("SELECT id, data FROM blobs ORDER BY rowid").all()).map((row): ChatRow => {
      const data = Buffer.from(row.data)
      // A root is the protobuf whose repeated field 1 names the messages, 32 bytes each.
      return { id: row.id, data, root: data[0] === 0x0a && data[1] === 0x20 && (data.length <= 34 || data[34] === 0x0a) }
    })
    const meta = db.prepare("SELECT value FROM meta WHERE key = '0'").get()
    const text = String(meta?.value ?? "")
    const parsed = ChatMetaSchema.parse(JSON.parse(/^[0-9a-f]+$/i.test(text) ? Buffer.from(text, "hex").toString("utf8") : text))
    return { rows, agentId: parsed.agentId ?? randomUUID() }
  } finally {
    db.close()
  }
}

/** The chat in the scratch home, holding its rows up to `upTo`; `write` adds the next step's, as its harness would. */
function scratchChat(home: string, rows: readonly ChatRow[], agentId: string, upTo: number) {
  const folder = join(home, ".cursor", "chats", "c".repeat(32), agentId)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, "store.db")
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  const insert = db.prepare("INSERT OR IGNORE INTO blobs VALUES (?, ?)")
  const pointAt = db.prepare("INSERT INTO meta VALUES ('0', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
  const meta = (root: string) => Buffer.from(JSON.stringify({ agentId, latestRootBlobId: root, name: "A long chat", mode: "default", createdAt: Date.now() })).toString("hex")
  let next = 0
  /** Writes rows through the next root; false once there are none. */
  const write = () => {
    if (next >= rows.length) return false
    db.exec("BEGIN")
    for (; next < rows.length; next++) {
      const row = rows[next]!
      insert.run(row.id, row.data)
      if (row.root) {
        pointAt.run(meta(row.id))
        next += 1
        break
      }
    }
    db.exec("COMMIT")
    return true
  }
  while (next < upTo && write());
  writeFileSync(join(folder, "meta.json"), JSON.stringify({ schemaVersion: 1, createdAtMs: Date.now(), hasConversation: true, updatedAtMs: Date.now(), cwd: home }))
  return { path, agentId, write, close: () => db.close() }
}

const IndexRowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null(), z.instanceof(Uint8Array)]))
type IndexRow = z.infer<typeof IndexRowSchema>

/** A Cursor SDK agent as copies of its stores hold it (`--sdk <dir>`: its `store.db`, and an `index.db` of its rows). */
function sdkAgentOf(dir: string) {
  const index = new DatabaseSync(join(dir, "index.db"), { readOnly: true })
  try {
    const all = (sql: string) => IndexRowSchema.array().parse(index.prepare(sql).all())
    const agent = all("SELECT * FROM agents")[0]
    if (!agent || typeof agent["agent_id"] !== "string") throw new Error(`${dir}/index.db names no agent`)
    return {
      ...rowsOf(join(dir, "store.db")),
      agentId: agent["agent_id"],
      schema: all("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").map((row) => String(row["sql"])),
      agent,
      runs: all("SELECT * FROM runs ORDER BY turn_number"),
      events: all("SELECT * FROM run_events ORDER BY run_id, seq"),
    }
  }
  finally {
    index.close()
  }
}

/**
 * The SDK agent in the scratch home as the Cursor SDK keeps one: its blobs in `agents/agent-<sha256(id)>/store.db`,
 * and in `index.db` its row, its runs and what its newest run streamed. Each `write` adds a step's blobs, points the
 * agent and its run at the step's root, and adds the step's share of the run's events, as the SDK does at a checkpoint.
 */
function scratchSdkAgent(home: string, source: ReturnType<typeof sdkAgentOf>, upTo: number, steps: number) {
  const root = join(home, ".mako", "cursor-sdk")
  const folder = join(root, "agents", `agent-${createHash("sha256").update(source.agentId).digest("hex")}`)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, "store.db")
  const db = new DatabaseSync(path)
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  db.prepare("INSERT INTO meta VALUES ('0', ?)").run(Buffer.from(JSON.stringify({ agentId: source.agentId, latestRootBlobId: "", name: "New Agent", mode: "default", createdAt: Date.now() })).toString("hex"))
  const index = new DatabaseSync(join(root, "index.db"))
  index.exec("PRAGMA journal_mode = WAL")
  for (const sql of source.schema) index.exec(sql)
  const insertRow = (table: string, row: IndexRow) => {
    const columns = Object.keys(row)
    index.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((column) => row[column] ?? null))
  }
  const live = source.runs.at(-1)?.["run_id"]
  const checkpoint = (blobId: string) => JSON.stringify({ blobId, storeKind: "local-agent-store" })
  insertRow("agents", { ...source.agent, status: "RUNNING", active_run_id: live ?? null, latest_checkpoint_ref_json: null })
  for (const run of source.runs) insertRow("runs", run["run_id"] === live ? { ...run, status: "RUNNING", latest_checkpoint_ref_json: null } : run)
  const liveEvents = source.events.filter((event) => event["run_id"] === live)
  for (const event of source.events) if (event["run_id"] !== live) insertRow("run_events", event)
  let events = 0
  const addEvents = (until: number) => {
    for (; events < Math.min(until, liveEvents.length); events++) insertRow("run_events", liveEvents[events]!)
  }
  addEvents(Math.round((liveEvents.length * upTo) / Math.max(1, source.rows.length)))
  const perStep = Math.ceil((liveEvents.length - events) / Math.max(1, steps))
  const insert = db.prepare("INSERT OR IGNORE INTO blobs VALUES (?, ?)")
  const pointAt = (rootId: string) => {
    const now = new Date().toISOString()
    index.prepare("UPDATE agents SET latest_checkpoint_ref_json = ?, updated_at = ?").run(checkpoint(rootId), now)
    index.prepare("UPDATE runs SET latest_checkpoint_ref_json = ?, updated_at = ? WHERE run_id = ?").run(checkpoint(rootId), now, live ?? "")
  }
  let next = 0
  /** Writes rows through the next root; false once there are none. */
  const write = () => {
    if (next >= source.rows.length) return false
    let rootId: string | undefined
    db.exec("BEGIN")
    for (; next < source.rows.length; next++) {
      const row = source.rows[next]!
      insert.run(row.id, row.data)
      if (row.root) {
        rootId = row.id
        next += 1
        break
      }
    }
    db.exec("COMMIT")
    index.exec("BEGIN")
    if (rootId) pointAt(rootId)
    addEvents(events + perStep)
    index.exec("COMMIT")
    return true
  }
  while (next < upTo && write());
  return { path, agentId: source.agentId, write, close: () => {
    index.prepare("UPDATE runs SET status = 'FINISHED' WHERE run_id = ?").run(live ?? "")
    index.prepare("UPDATE agents SET status = 'IDLE', active_run_id = NULL").run()
    index.close()
    db.close()
  } }
}

/** Every `everyMs`, `ask` timed; a request that failed or timed out is counted apart. */
function probe<Answer>(everyMs: number, ask: () => Promise<Answer>) {
  const ms: number[] = []
  let failed = 0
  let running = true
  const done = (async () => {
    while (running) {
      const started = performance.now()
      if (await ask().then(() => true, () => false)) ms.push(performance.now() - started)
      else failed += 1
      await delay(everyMs)
    }
  })()
  return {
    stop: async () => {
      running = false
      await done
      return { ...summary(ms), failed, over: ms.filter((each) => each > holdBudget).length }
    },
  }
}

/**
 * Another process writing the record store, as a backfill pass's process does: its capture takes the store's write
 * lock and keeps it until its next commit (`SLICE_MS` in `record-store.ts`), then takes it again (`--writer-holds-ms`).
 */
async function playWriter(store: string): Promise<void> {
  const db = new DatabaseSync(store, { timeout: 60_000 })
  for (;;) {
    db.exec("BEGIN IMMEDIATE")
    const until = performance.now() + writerHolds
    while (performance.now() < until);
    db.exec("COMMIT")
    await delay(200)
  }
}
if (values["play-writer"]) await playWriter(values["play-writer"])

const home = mkdtempSync("/tmp/mako-sl-")
const stand = new RecordsStandIn(Number(values.port))
let daemon: ChildProcess | undefined
const clients: DaemonClient[] = []
let failed = false
try {
  await stand.start()
  const sdk = values.sdk ? sdkAgentOf(resolve(values.sdk)) : undefined
  const read = sdk ?? (values.store ? rowsOf(resolve(values.store)) : largeCursorChat({ turns: Number(values.turns), steps: Number(values["turn-steps"]) }))
  const source = values.rows ? { ...read, rows: read.rows.slice(0, Number(values.rows)) } : read
  // The turn that goes on while the bench watches: the last `--steps` roots and what each step wrote before its root.
  const roots = source.rows.flatMap((row, at) => (row.root ? [at] : []))
  const liveFrom = (roots[Math.max(0, roots.length - steps - 1)] ?? 0) + 1
  const chat = sdk ? scratchSdkAgent(home, { ...sdk, rows: source.rows }, liveFrom, steps) : scratchChat(home, source.rows, source.agentId, liveFrom)
  const env: NodeJS.ProcessEnv = { ...process.env, ...ON_DEMAND_CATALOG_ENV, HOME: home }
  for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME", "OPENCODE_DB", "MAKO_DATA_ROOT", "CURSOR_CONFIG_DIR"]) delete env[name]
  mkdirSync(join(home, ".mako"), { recursive: true })
  const profile = values["cpu-prof"] ? ["--cpu-prof", `--cpu-prof-dir=${resolve(values["cpu-prof"])}`] : []
  daemon = spawn(process.execPath, [...ON_DEMAND_CATALOG_NODE_ARGS, ...profile, daemonScript], { env, stdio: "ignore" })
  const socket = join(home, ".mako", "syncd.sock")
  const connect = async () => {
    for (let tries = 0; tries < 100; tries++) {
      await delay(200)
      const client = await connectDaemon(socket).catch(() => undefined)
      if (client) {
        clients.push(client)
        return client
      }
    }
    throw new Error("the sync daemon didn't answer")
  }
  const host = await connect()
  const links = stand.links()
  await host.syncOriginals(links.originals)
  await host.syncCopies(links.copies)
  // The backfill's pass, in a process of its own, takes the chat as it stood when the daemon started.
  for (let waited = 0; waited < 600; waited++) {
    let text = "{}"
    try {
      text = readFileSync(join(home, ".mako", "records", "backfill.json"), "utf8")
    } catch {
      // Not written until the pass has begun.
    }
    if (BackfillProgressSchema.safeParse(JSON.parse(text)).data?.endedAt) break
    await delay(500)
  }
  const nativeId = chat.agentId
  await host.scopeSync({ sessions: [{ harness: "cursor", nativeId, path: chat.path, thread: "t-1", busy: true, tier: "now" }], paused: false })
  const caughtUp = performance.now()
  const whole = async () => (await host.syncStatus().then((status) => status.tiers.now.whole >= 1 && !status.originals?.sending.length && !status.copies?.sending.length, () => false))
  for (let waited = 0; !(await whole()) && waited < 1_800; waited++) await delay(100)
  const firstUpload = { ms: Math.round(performance.now() - caughtUp), mib: +((stand.sent.originals + stand.sent.copies) / 1048576).toFixed(1) }
  say(`in the account: ${JSON.stringify(firstUpload)}`)

  // The window: it follows the chat, reads its newest page whenever the daemon says it moved, and follows it again from
  // that page when the daemon ends the follow for a fresh one (`reload`), as the host does.
  const window = await connect()
  let moved = 0
  let reloads = 0
  let following = true
  window.onEvent((event) => {
    if (event.event === "updated" && event.ref.path === chat.path) moved += 1
    if (event.event === "reload" && event.path === chat.path) {
      moved += 1
      reloads += 1
      following = false
    }
  })
  const pinger = await connect()
  const pings = probe(20, () => pinger.refresh())
  const status = probe(250, () => host.syncStatus())
  const newest = () => window.page(chat.path, undefined, 100, { toolOutputChars: 2_000 }).catch(() => null)
  const first = await newest()
  await window.follow(chat.path, first?.checkpoint ?? first?.ref.bytes ?? 0)
  const pages: number[] = []
  let reading = true
  const reader = (async () => {
    let seen = -1
    let reads = 0
    while (reading) {
      if (moved === seen) {
        await delay(50)
        continue
      }
      seen = moved
      const started = performance.now()
      // Every fourth move the whole history, a page of 4 MB at a time, as the host reads it for a journal; else the newest page.
      if (++reads % 4 === 0) {
        let before: number | undefined
        do before = (await window.page(chat.path, before, Number.MAX_SAFE_INTEGER, { maxChars: 4 * 1024 * 1024 }).catch(() => null))?.start
        while (before)
      }
      const page = await newest()
      if (!following && page) {
        following = true
        await window.follow(chat.path, page.checkpoint ?? page.ref.bytes ?? 0).catch(() => undefined)
      }
      pages.push(performance.now() - started)
    }
  })()

  const writer = writerHolds ? spawn(process.execPath, [...process.execArgv, import.meta.filename, "--play-writer", join(home, ".mako", "records", "records.sqlite"), "--writer-holds-ms", String(writerHolds)], { stdio: "ignore" }) : undefined
  const turn = performance.now()
  for (let step = 0; step < steps && chat.write(); step++) await delay(everyMs)
  chat.close()
  const lastMs = Math.round(performance.now() - turn)
  writer?.kill("SIGTERM")
  say(`the turn's ${steps} steps written in ${lastMs} ms; waiting for the account`)
  for (let waited = 0; !(await whole()) && waited < 1_800; waited++) await delay(100)
  await delay(1_000)
  reading = false
  await reader
  const report = {
    daemon: daemonScript,
    ...writerHolds && { writer: { holdsMs: writerHolds } },
    chat: { rows: source.rows.length, mib: +(source.rows.reduce((total, row) => total + row.data.length, 0) / 1048576).toFixed(1), steps, everyMs, turnMs: lastMs, ...values.store && { store: "a copy of a real chat" }, ...sdk && { store: "a copy of a real Cursor SDK agent", events: sdk.events.length } },
    firstUpload,
    pings: await pings.stop(),
    status: await status.stop(),
    pages: { ...summary(pages), reloads },
    held: readFileSync(join(home, ".mako", "logs", "syncd.log"), "utf8").split("\n").filter((line) => line.includes("loop held")).map((line) => line.slice(0, 300)),
    account: { originals: stand.units("originals", nativeId), copies: stand.units("copies", nativeId), duplicates: stand.duplicates },
  }
  failed = (report.pings.max ?? 0) > holdBudget || report.status.failed > 0
  const text = JSON.stringify(report, null, 2)
  if (values.out) writeFileSync(values.out, text)
  process.stdout.write(`${text}\n`)
  say(failed ? `FAIL: the daemon kept a ping waiting ${report.pings.max} ms (budget ${holdBudget} ms), ${report.status.failed} status reads failed` : `ok: the longest ping waited ${report.pings.max} ms`)
} finally {
  for (const client of clients) client.close()
  const exited = daemon && daemon.exitCode === null ? new Promise((done) => daemon?.once("exit", done)) : undefined
  daemon?.kill("SIGTERM")
  await Promise.race([exited, delay(10_000)])
  stand.server?.close()
  if (!values.keep) await removeScratch(home)
  else say(`kept ${home}`)
}
process.exitCode = failed ? 1 : 0
