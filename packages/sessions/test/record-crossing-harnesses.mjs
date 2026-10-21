import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DEVIN_STORE_VERSION, emitClaudeSession, emitCodexSession, emitCursorSession, emitDevinSession, emitGrokSession } from "../dist/emit.js"
import { entriesFromMessages } from "../dist/entry-sink.js"
import { ClaudeProvider } from "../dist/providers/claude.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { CursorProvider } from "../dist/providers/cursor.js"
import { DevinCliProvider } from "../dist/providers/devin-cli.js"
import { GrokProvider } from "../dist/providers/grok.js"
import { OpenCodeProvider } from "../dist/providers/opencode.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordBundleSchema } from "@mako/protocol/records"
import { RecordStore } from "../dist/record-store.js"

/**
 * Every harness's session crosses between stores as it would from a machine to the cloud and on to a laptop, and
 * the laptop's restore is a session that harness's own reader reads as the conversation the machine had: the same
 * entries, in a home and folders that aren't the machine's.
 */

const stores = new NativeStores(false)
const root = await mkdtemp(join(tmpdir(), "mako-record-crossing-harnesses-"))
const FACT = "the deploy key is lyrebird-kingfisher-42"
const thread = (cwd) => ({
  ref: { harness: "codex", nativeId: "crossing-source", path: "/tmp/crossing.jsonl", cwd, title: "Crossing", startedAt: "2026-10-21T10:00:00.000Z", updatedAt: "2026-10-21T10:05:00.000Z" },
  entries: entriesFromMessages([
    { kind: "user", at: "2026-10-21T10:00:00.000Z", text: `Remember this: ${FACT}. Unicode crosses too: café, 中文, 🦈.` },
    { kind: "assistant", at: "2026-10-21T10:00:10.000Z", blocks: [{ type: "text", text: `Noted. ${"The deploy path runs through src/deploy.ts. ".repeat(400)}` }] },
    { kind: "user", at: "2026-10-21T10:02:00.000Z", text: "What was the deploy key I told you?" },
    { kind: "assistant", at: "2026-10-21T10:02:05.000Z", blocks: [{ type: "text", text: `You said ${FACT}.` }] },
  ]),
})

/** OpenCode's own database, as its current build lays a session out. */
function openCodeSession(home, cwd) {
  const dir = join(home, ".local", "share", "opencode")
  const db = new DatabaseSync(join(dir, "opencode.db"))
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);`)
  db.prepare("INSERT INTO project VALUES ('p1', ?, 'Crossing', 1000, 1000)").run(cwd)
  db.prepare("INSERT INTO session VALUES ('ses_crossing', 'p1', NULL, ?, 'Crossing', 1000, 4000, NULL)").run(cwd)
  const message = db.prepare("INSERT INTO message VALUES (?, 'ses_crossing', ?, ?, ?)")
  const part = db.prepare("INSERT INTO part VALUES (?, ?, 'ses_crossing', ?, ?, ?)")
  const turns = [
    ["user", `Remember this: ${FACT}. Unicode crosses too: café, 中文, 🦈.`],
    ["assistant", `Noted. ${"The deploy path runs through src/deploy.ts. ".repeat(400)}`],
    ["user", "What was the deploy key I told you?"],
    ["assistant", `You said ${FACT}.`],
  ]
  turns.forEach(([role, text], index) => {
    const at = 1000 * (index + 1)
    message.run(`msg_${index}`, at, at, JSON.stringify(role === "user" ? { role, time: { created: at }, agent: "build", model: { modelID: "big-pickle", providerID: "opencode" } } : { role, time: { created: at, completed: at + 500 }, modelID: "big-pickle", providerID: "opencode" }))
    part.run(`prt_${index}`, `msg_${index}`, at, at, JSON.stringify({ type: "text", text }))
  })
  db.close()
  return { path: join(dir, "opencode.db") }
}

/** Devin CLI's store as Devin makes it on its first run, at the version Mako writes (its columns emitting touches). */
async function devinStore(home) {
  const dir = join(home, ".local", "share", "devin", "cli")
  await mkdir(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, "sessions.db"))
  db.exec(`CREATE TABLE refinery_schema_history(version int4 PRIMARY KEY, name VARCHAR(255), applied_on VARCHAR(255), checksum VARCHAR(255));
    CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL, model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER, shell_last_seen_index INTEGER DEFAULT 0, cogs_json TEXT, workspace_dirs TEXT, hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT);
    CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT, FOREIGN KEY (session_id) REFERENCES sessions(id), UNIQUE(session_id, node_id));`)
  for (let version = 1; version <= DEVIN_STORE_VERSION; version++) db.prepare("INSERT INTO refinery_schema_history (version) VALUES (?)").run(version)
  db.close()
}

const HARNESSES = [
  { name: "claude", provider: (home) => new ClaudeProvider(home), emit: (home, cwd) => emitClaudeSession(stores, thread(cwd), { cwd, home }) },
  { name: "codex", provider: (home) => new CodexProvider(stores, home), emit: (home, cwd) => emitCodexSession(stores, thread(cwd), { cwd, home }) },
  { name: "cursor", provider: (home) => new CursorProvider(stores, home), emit: (home, cwd) => emitCursorSession(stores, thread(cwd), { cwd, home }) },
  { name: "grok", provider: (home) => new GrokProvider(home), emit: (home, cwd) => emitGrokSession(stores, thread(cwd), { cwd, home }) },
  { name: "devin", provider: (home) => new DevinCliProvider(stores, home), emit: async (home, cwd) => (await devinStore(home), emitDevinSession(stores, thread(cwd), { cwd, home })) },
  { name: "opencode", provider: (home) => new OpenCodeProvider(stores, home), emit: async (home, cwd) => (await mkdir(join(home, ".local", "share", "opencode"), { recursive: true }), openCodeSession(home, cwd)) },
]

/** What one store hands another, as the wire would carry it. */
async function cross(from, to, harness, nativeId) {
  const started = performance.now()
  const bundle = RecordBundleSchema.parse(JSON.parse(JSON.stringify(from.exportSession(harness, nativeId, to.holdings(harness, nativeId)))))
  const report = await to.importSession(bundle, async function* (hashes) {
    for (const hash of hashes) yield { hash, chunk: await from.readChunk(hash) }
  })
  return { ...report, totalMs: performance.now() - started }
}

/** A conversation as its reader gives it, without what's the reader's own (ids, paths, read times). */
const conversation = (read) => read.entries.map((entry) => ({ type: entry.type, text: entry.text ?? null, name: entry.name ?? null, input: entry.input ?? null, output: entry.output ?? null }))

async function sessionIn(provider, nativeId) {
  for (const file of await provider.discover()) {
    const ref = await provider.peek(file)
    if (ref && (nativeId === undefined || ref.nativeId === nativeId)) return { file, ref }
  }
  return undefined
}

const rows = []
try {
  for (const harness of HARNESSES) {
    const base = join(root, harness.name)
    const machineHome = join(base, "machine-home")
    const laptopHome = join(base, "laptop-home")
    const cwd = join(machineHome, "project")
    await mkdir(cwd, { recursive: true })
    await harness.emit(machineHome, cwd)
    const machineProvider = harness.provider(machineHome)
    const source = await sessionIn(machineProvider)
    assert.ok(source, `${harness.name}: the machine's session is found`)
    const nativeId = source.ref.nativeId
    const original = conversation(await machineProvider.read(source.file.path))
    assert.ok(original.length >= 2 && JSON.stringify(original).includes(FACT), `${harness.name}: the machine's session reads as the conversation`)

    const machine = new RecordStore(join(base, "machine-records"), stores)
    const cloud = new RecordStore(join(base, "cloud-records"), stores)
    const laptop = new RecordStore(join(base, "laptop-records"), stores)
    try {
      await machine.capture({ harness: harness.name, nativeId, home: machineHome, records: await machineProvider.records(source.file.path) })
      const up = await cross(machine, cloud, harness.name, nativeId)
      const down = await cross(cloud, laptop, harness.name, nativeId)
      assert.deepEqual(laptop.holdings(harness.name, nativeId), machine.holdings(harness.name, nativeId), `${harness.name}: the laptop holds what the machine holds`)
      const again = await cross(machine, cloud, harness.name, nativeId)
      assert.equal(again.versions + again.chunks, 0, `${harness.name}: nothing crosses twice`)

      const started = performance.now()
      const restored = await laptop.restore({ harness: harness.name, nativeId, home: laptopHome, installed: null })
      const restoreMs = performance.now() - started
      assert.equal(restored.written, true, `${harness.name}: restored ${JSON.stringify(restored)}`)
      const laptopProvider = harness.provider(laptopHome)
      const arrived = await sessionIn(laptopProvider, nativeId)
      assert.ok(arrived, `${harness.name}: its own reader finds the session on the laptop`)
      assert.deepEqual(conversation(await laptopProvider.read(arrived.file.path)), original, `${harness.name}: the laptop's session is the machine's conversation`)
      rows.push({ harness: harness.name, versions: up.versions, chunks: up.chunks, bytes: up.bytes, stored: up.storedBytes, up: up.totalMs, down: down.totalMs, restore: restoreMs })
    } finally {
      await Promise.all([machine.close(), cloud.close(), laptop.close()])
    }
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

const ms = (value) => `${value.toFixed(1)} ms`.padStart(9)
for (const row of rows)
  console.log(`  ${row.harness.padEnd(8)} ${String(row.versions).padStart(2)} versions ${String(row.chunks).padStart(3)} chunks ${String(row.bytes).padStart(7)} B (${String(row.stored).padStart(6)} B stored)  up ${ms(row.up)}  down ${ms(row.down)}  restore ${ms(row.restore)}`)
console.log("PASS: every harness's session crosses machine → cloud → laptop and its own reader reads the restored conversation as the machine's")
