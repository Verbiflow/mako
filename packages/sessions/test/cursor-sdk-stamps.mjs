import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { CursorProvider } from "../dist/providers/cursor.js"

// One index.db serves every SDK agent. A running agent streams its events
// into it every few seconds; the other agents' stores must not read as
// changed, or the catalog re-reads and re-archives every one of them.
const home = await mkdtemp(join(tmpdir(), "mako-cursor-sdk-stamps-"))
try {
  const sdkRoot = join(home, ".mako", "cursor-sdk")
  const directory = (id) => join(sdkRoot, "agents", `agent-${createHash("sha256").update(id).digest("hex")}`)
  for (const id of ["running", "idle"]) {
    await mkdir(directory(id), { recursive: true })
    await writeFile(join(directory(id), "store.db"), "")
    const past = new Date("2026-09-26T00:00:00.000Z")
    await utimes(join(directory(id), "store.db"), past, past)
  }
  const index = new DatabaseSync(join(sdkRoot, "index.db"))
  index.exec(
    "CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT NOT NULL, status TEXT NOT NULL, active_run_id TEXT, latest_checkpoint_ref_json TEXT, name TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
      "CREATE TABLE runs (run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL, status TEXT NOT NULL, model TEXT, model_params_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
      "CREATE TABLE run_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL);"
  )
  for (const id of ["running", "idle"]) {
    index.prepare("INSERT INTO agents (agent_id, workspace_ref, status, latest_checkpoint_ref_json, created_at, updated_at) VALUES (?, '/repo', 'IDLE', ?, '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:01.000Z')").run(id, JSON.stringify({ blobId: `root-${id}-1` }))
    index.prepare("INSERT INTO runs (run_id, agent_id, turn_number, status, created_at, updated_at) VALUES (?, ?, 1, 'FINISHED', '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:01.000Z')").run(`run-${id}-1`, id)
  }

  const cursor = new CursorProvider(home, {})
  const stamps = async () => {
    const files = await cursor.discover()
    return Object.fromEntries(
      ["running", "idle"].map((id) => {
        const file = files.find((candidate) => candidate.path === join(directory(id), "store.db"))
        assert.ok(file, `${id} store is discovered`)
        return [id, { revision: file.revision, mtimeMs: file.mtimeMs }]
      })
    )
  }
  const first = await stamps()
  assert.notEqual(first.running.revision, first.idle.revision)

  // A turn starts: the running agent gets a new run, then streams.
  index.prepare("INSERT INTO runs (run_id, agent_id, turn_number, status, created_at, updated_at) VALUES ('run-running-2', 'running', 2, 'RUNNING', '2026-09-27T00:01:00.000Z', '2026-09-27T00:01:00.000Z')").run()
  index.prepare("UPDATE agents SET status = 'RUNNING', active_run_id = 'run-running-2', updated_at = '2026-09-27T00:01:00.000Z' WHERE agent_id = 'running'").run()
  const started = await stamps()
  assert.notEqual(started.running.revision, first.running.revision, "a started run changes its agent")
  assert.equal(started.running.mtimeMs, Date.parse("2026-09-27T00:01:00.000Z"), "the agent's newest index time is its store's time")
  assert.deepEqual(started.idle, first.idle, "another agent's run changes nothing for this one")

  for (let seq = 1; seq <= 50; seq++)
    index.prepare("INSERT INTO run_events (run_id, seq, event_type, payload_json, created_at) VALUES ('run-running-2', ?, 'message', '{}', '2026-09-27T00:01:01.000Z')").run(seq)
  assert.deepEqual(await stamps(), started, "streamed events change no agent's revision")

  // The checkpoint lands and the run finishes: only the running agent moves.
  index.prepare("UPDATE agents SET status = 'IDLE', active_run_id = NULL, latest_checkpoint_ref_json = ?, updated_at = '2026-09-27T00:02:00.000Z' WHERE agent_id = 'running'").run(JSON.stringify({ blobId: "root-running-2" }))
  index.prepare("UPDATE runs SET status = 'FINISHED', updated_at = '2026-09-27T00:02:00.000Z' WHERE run_id = 'run-running-2'").run()
  const finished = await stamps()
  assert.notEqual(finished.running.revision, started.running.revision)
  assert.deepEqual(finished.idle, first.idle)

  // A run row that moves on its own still counts, without its agent's row.
  index.prepare("UPDATE runs SET status = 'CANCELLED', updated_at = '2026-09-27T00:03:00.000Z' WHERE run_id = 'run-idle-1'").run()
  const cancelled = await stamps()
  assert.notEqual(cancelled.idle.revision, first.idle.revision)
  assert.deepEqual(cancelled.running, finished.running)
  // A catalog cached by the file-stamp rule held every SDK store at the
  // index's time. The new, older times must replace it once, then settle,
  // with no peek-rule bump to re-peek every Cursor store.
  const cachePath = join(home, "catalog.json")
  const { CATALOG_CACHE_VERSION } = await import("../dist/catalog-cache.js")
  const entries = {}
  for (const id of ["running", "idle"]) {
    const path = join(directory(id), "store.db")
    entries[path] = { bytes: 0, mtimeMs: Date.parse("2026-09-28T00:00:00.000Z"), revision: "old-rule", peek: 2, ref: { harness: "cursor", nativeId: id, path, title: id } }
  }
  await writeFile(cachePath, JSON.stringify({ version: CATALOG_CACHE_VERSION, entries }))
  const { SessionCatalog } = await import("../dist/catalog.js")
  const upgraded = new CursorProvider(home, {})
  let peeks = 0
  const peek = upgraded.peek.bind(upgraded)
  upgraded.peek = (file) => { peeks++; return peek(file) }
  const catalog = new SessionCatalog([upgraded], { cachePath })
  await catalog.scan()
  const afterUpgrade = peeks
  await catalog.scan()
  await catalog.reconcileActive()
  assert.equal(peeks, afterUpgrade, "after one pass, unchanged stores are not peeked again")
  await catalog.stop()
  index.close()
  console.log("cursor-sdk-stamps: ok")
} finally {
  await rm(home, { recursive: true, force: true })
}
