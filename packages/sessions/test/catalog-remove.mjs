import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SessionCatalog } from "../dist/catalog.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { ClaudeProvider } from "../dist/providers/claude.js"
import { CursorProvider } from "../dist/providers/cursor.js"
import { GrokProvider } from "../dist/providers/grok.js"

const exists = (path) => stat(path).then(() => true, () => false)
const home = await mkdtemp(join(tmpdir(), "mako-catalog-remove-"))
try {
  // Codex: the rollout, a resumed rollout, a subagent rollout, and the state row all go; a sibling thread stays.
  const sessions = join(home, ".codex", "sessions", "2026", "09", "11")
  await mkdir(sessions, { recursive: true })
  const id = "01a08f72-7734-7cd1-829d-c10f7781531d"
  const other = "01a0577a-3ccd-7e22-b3ad-f6cc2999d7fa"
  const line = (type, payload) => `${JSON.stringify({ timestamp: "2026-09-11T07:50:38Z", type, payload })}\n`
  const rollout = join(sessions, `rollout-2026-09-11T00-50-38-${id}.jsonl`)
  const resumed = join(sessions, `rollout-2026-09-11T01-05-11-${id}_01a08f7f-c74a-7d70-839f-2cf4236d9c57.jsonl`)
  const sibling = join(sessions, `rollout-2026-09-11T02-00-00-${other}.jsonl`)
  for (const [path, sessionId] of [[rollout, id], [resumed, id], [sibling, other]])
    await writeFile(path, line("session_meta", { id: sessionId, cwd: home }) + line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Prompt" }] }))
  const metadataPath = join(home, ".codex", "state_5.sqlite")
  const metadata = new DatabaseSync(metadataPath)
  metadata.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, cwd TEXT, updated_at_ms INTEGER, thread_source TEXT, rollout_path TEXT)")
  metadata.prepare("INSERT INTO threads (id, name, title, cwd, updated_at_ms, thread_source, rollout_path) VALUES (?, ?, ?, ?, ?, 'user', ?)").run(id, "Fixture", "Prompt", home, Date.now(), resumed)
  metadata.prepare("INSERT INTO threads (id, name, title, cwd, updated_at_ms, thread_source, rollout_path) VALUES (?, ?, ?, ?, ?, 'user', ?)").run(other, "Keep", "Prompt", home, Date.now(), sibling)
  metadata.close()
  const codex = new CodexProvider(home)
  const catalog = new SessionCatalog([codex], { cachePath: join(home, "cache.json") })
  const events = []
  catalog.onEvent((event) => events.push(event))
  const before = await catalog.scan()
  assert.equal(before.length, 2)
  const target = before.find((ref) => ref.nativeId === id)
  assert.equal(await catalog.remove(target.path), true)
  assert.deepEqual(await readdir(sessions), [`rollout-2026-09-11T02-00-00-${other}.jsonl`], "every rollout for the thread is gone, the sibling stays")
  const check = new DatabaseSync(metadataPath, { readOnly: true })
  assert.deepEqual(check.prepare("SELECT id FROM threads ORDER BY id").all().map((row) => row.id), [other])
  check.close()
  assert.deepEqual(events.map((event) => event.type), ["removed"])
  assert.equal((await catalog.scan()).length, 1)
  assert.equal(await catalog.remove(join(home, "elsewhere.jsonl")), false, "a path outside the roots is refused")
  await catalog.stop()

  // Claude: only the session file.
  const projects = join(home, ".claude", "projects", "-Users-kashyab-flage")
  await mkdir(projects, { recursive: true })
  const session = join(projects, "62362b25-2460-43e5-9cff-390f9712d579.jsonl")
  await writeFile(session, `${JSON.stringify({ type: "user", sessionId: "62362b25", cwd: home, message: { role: "user", content: "Hi" } })}\n`)
  const claude = new ClaudeProvider(home)
  assert.equal(await claude.remove(session), true)
  assert.equal(await exists(session), false)
  assert.equal(await claude.remove(join(home, "notes.txt")), false)

  // Cursor: an ACP session directory, never a Desktop chat.
  const acp = join(home, ".cursor", "acp-sessions", "c7f8f09a-4d5b-4857-83ad-8b849c69f1df")
  const chat = join(home, ".cursor", "chats", "workspace", "0b1d8a9e")
  await mkdir(acp, { recursive: true })
  await mkdir(chat, { recursive: true })
  await writeFile(join(acp, "store.db"), "")
  await writeFile(join(chat, "store.db"), "")
  const cursor = new CursorProvider(home)
  assert.equal(await cursor.remove(join(acp, "store.db")), true)
  assert.equal(await exists(acp), false)
  assert.equal(await cursor.remove(join(chat, "store.db")), false, "Desktop chats are not removable here")
  assert.equal(await exists(chat), true)

  // Cursor SDK: the agent directory goes and the index forgets the agent, its
  // runs and their events; a sibling agent's rows stay.
  const sdkRoot = join(home, ".mako", "cursor-sdk")
  const sdkAgent = (id) => join(sdkRoot, "agents", `agent-${createHash("sha256").update(id).digest("hex")}`)
  await mkdir(sdkAgent("sdk-gone"), { recursive: true })
  await mkdir(sdkAgent("sdk-kept"), { recursive: true })
  const sdkStore = new DatabaseSync(join(sdkAgent("sdk-gone"), "store.db"))
  sdkStore.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);")
  sdkStore.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(JSON.stringify({ agentId: "sdk-gone", latestRootBlobId: "" }))
  sdkStore.close()
  await writeFile(join(sdkAgent("sdk-kept"), "store.db"), "")
  const index = new DatabaseSync(join(sdkRoot, "index.db"))
  index.exec(
    "CREATE TABLE agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT NOT NULL, status TEXT NOT NULL, latest_checkpoint_ref_json TEXT, name TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
      "CREATE TABLE runs (run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL, status TEXT NOT NULL, model TEXT, model_params_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
      "CREATE TABLE run_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, event_type TEXT NOT NULL, created_at TEXT NOT NULL);"
  )
  for (const agentId of ["sdk-gone", "sdk-kept"]) {
    index.prepare("INSERT INTO agents (agent_id, workspace_ref, status, created_at, updated_at) VALUES (?, '/repo', 'IDLE', 't', 't')").run(agentId)
    index.prepare("INSERT INTO runs (run_id, agent_id, turn_number, status, created_at, updated_at) VALUES (?, ?, 1, 'FINISHED', 't', 't')").run(`run-${agentId}`, agentId)
    index.prepare("INSERT INTO run_events (run_id, seq, event_type, created_at) VALUES (?, 1, 'x', 't')").run(`run-${agentId}`)
  }
  index.close()
  const sdkCursor = new CursorProvider(home, {})
  assert.equal(await sdkCursor.remove(join(sdkAgent("sdk-gone"), "store.db")), true)
  assert.equal(await exists(sdkAgent("sdk-gone")), false)
  const after = new DatabaseSync(join(sdkRoot, "index.db"), { readOnly: true })
  assert.deepEqual(after.prepare("SELECT agent_id FROM agents").all().map((row) => row.agent_id), ["sdk-kept"])
  assert.deepEqual(after.prepare("SELECT agent_id FROM runs").all().map((row) => row.agent_id), ["sdk-kept"])
  assert.deepEqual(after.prepare("SELECT run_id FROM run_events").all().map((row) => row.run_id), ["run-sdk-kept"])
  after.close()
  // An unreadable store is matched through the directory's hash.
  assert.equal(await sdkCursor.remove(join(sdkAgent("sdk-kept"), "store.db")), true)
  const emptied = new DatabaseSync(join(sdkRoot, "index.db"), { readOnly: true })
  assert.equal(emptied.prepare("SELECT count(*) AS n FROM agents").get().n, 0)
  emptied.close()

  // Grok: the session directory under its workspace directory.
  const grokSession = join(home, ".grok", "sessions", "%2FUsers%2Fkashyab%2Fflage", "01a08f77-b6a4-7d82-a7f5-fa1d0cbb7228")
  await mkdir(grokSession, { recursive: true })
  await writeFile(join(grokSession, "updates.jsonl"), "")
  await writeFile(join(grokSession, "summary.json"), "{}")
  const grok = new GrokProvider(home)
  assert.equal(await grok.remove(join(grokSession, "updates.jsonl")), true)
  assert.equal(await exists(grokSession), false)
  assert.equal(await exists(join(home, ".grok", "sessions", "%2FUsers%2Fkashyab%2Fflage")), true, "the workspace directory stays")
  // OpenCode and Devin keep sessions as rows; removal takes the session, its
  // messages and parts, and its child sessions, and leaves neighbours alone.
  const openCodeRoot = join(home, ".local", "share", "opencode")
  await mkdir(openCodeRoot, { recursive: true })
  const openCodeDb = new DatabaseSync(join(openCodeRoot, "opencode.db"))
  openCodeDb.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    INSERT INTO session VALUES ('ses_fixture', 'p', NULL, '/tmp/mako-provider-e2e-x/opencode', 'Fixture', 1, 2);
    INSERT INTO session VALUES ('ses_child', 'p', 'ses_fixture', '/tmp/mako-provider-e2e-x/opencode', 'Child', 1, 2);
    INSERT INTO session VALUES ('ses_keep', 'p', NULL, '/Users/kashyab/flage', 'Keep', 1, 2);
    INSERT INTO message VALUES ('m1', 'ses_fixture', 1, 2, '{}'), ('m2', 'ses_child', 1, 2, '{}'), ('m3', 'ses_keep', 1, 2, '{}');
    INSERT INTO part VALUES ('p1', 'm1', 'ses_fixture', 1, 2, '{}'), ('p3', 'm3', 'ses_keep', 1, 2, '{}');
  `)
  openCodeDb.close()
  const { OpenCodeProvider } = await import("../dist/providers/opencode.js")
  const openCode = new OpenCodeProvider(home)
  assert.equal(await openCode.remove(`${join(openCodeRoot, "opencode.db")}#ses_fixture`), true)
  const openCodeCheck = new DatabaseSync(join(openCodeRoot, "opencode.db"), { readOnly: true })
  assert.deepEqual(openCodeCheck.prepare("SELECT id FROM session ORDER BY id").all().map((row) => row.id), ["ses_keep"], "the session and its child are gone, the neighbour stays")
  assert.deepEqual(openCodeCheck.prepare("SELECT id FROM message ORDER BY id").all().map((row) => row.id), ["m3"])
  assert.deepEqual(openCodeCheck.prepare("SELECT id FROM part ORDER BY id").all().map((row) => row.id), ["p3"])
  openCodeCheck.close()
  assert.equal(await openCode.remove(`${join(home, "other.db")}#ses_keep`), false, "a database outside the store is refused")

  const devinRoot = join(home, ".local", "share", "devin", "cli")
  await mkdir(devinRoot, { recursive: true })
  const devinDb = new DatabaseSync(join(devinRoot, "sessions.db"))
  devinDb.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL, model TEXT NOT NULL, title TEXT, created_at INTEGER, last_activity_at INTEGER, hidden INTEGER DEFAULT 0, main_chain_id INTEGER);
    CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT);
    CREATE TABLE tool_call_state (session_id TEXT, tool_call_id TEXT, tool_call_json TEXT, tool_call_update_json TEXT);
    INSERT INTO sessions VALUES ('inky-cloak', '/tmp/mako-provider-e2e-x/devin', 'local', 'm', 'Fixture', 1, 2, 0, 1);
    INSERT INTO sessions VALUES ('equinox-manner', '/Users/kashyab/pi-ui', 'local', 'm', 'Keep', 1, 2, 0, 1);
    INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES ('inky-cloak', 1, NULL, '{}', 1), ('equinox-manner', 1, NULL, '{}', 1);
    INSERT INTO tool_call_state VALUES ('inky-cloak', 't1', '{}', '{}');
  `)
  devinDb.close()
  const { DevinCliProvider } = await import("../dist/providers/devin-cli.js")
  const devin = new DevinCliProvider(home)
  assert.equal(await devin.remove(`${join(devinRoot, "sessions.db")}#inky-cloak`), true)
  const devinCheck = new DatabaseSync(join(devinRoot, "sessions.db"), { readOnly: true })
  assert.deepEqual(devinCheck.prepare("SELECT id FROM sessions").all().map((row) => row.id), ["equinox-manner"])
  assert.deepEqual(devinCheck.prepare("SELECT session_id FROM message_nodes").all().map((row) => row.session_id), ["equinox-manner"])
  assert.equal(devinCheck.prepare("SELECT COUNT(*) AS n FROM tool_call_state").get().n, 0)
  devinCheck.close()
  assert.equal(await devin.remove(`${join(home, "elsewhere.db")}#inky-cloak`), false)
  console.log("Catalog removal: Codex rollouts and state rows, Claude session files, Cursor ACP sessions and SDK agents with their index rows, Grok session directories, and OpenCode and Devin session rows are removed through their providers; foreign paths and Cursor Desktop chats are refused")
} finally {
  await rm(home, { recursive: true, force: true })
}
