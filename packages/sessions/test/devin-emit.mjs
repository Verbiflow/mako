import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DEVIN_STORE_VERSION, emitDevinSession } from "../dist/emit.js"
import { DevinCliProvider } from "../dist/providers/devin-cli.js"

// Devin CLI's own tables at store version 17 (the columns emitting touches).
const SCHEMA = `
  CREATE TABLE refinery_schema_history(version int4 PRIMARY KEY, name VARCHAR(255), applied_on VARCHAR(255), checksum VARCHAR(255));
  CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL, model TEXT NOT NULL,
    agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER,
    shell_last_seen_index INTEGER DEFAULT 0, cogs_json TEXT, workspace_dirs TEXT, hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT);
  CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
    parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id), UNIQUE(session_id, node_id));
`

const thread = {
  ref: { harness: "codex", nativeId: "source", path: "/source", title: "Parser work", cwd: "/work", startedAt: "2026-10-01T10:00:00.000Z" },
  entries: [
    { kind: "user", text: "The codeword is heliotrope. Read the parser.", at: "2026-10-01T10:00:00.000Z" },
    { kind: "assistant", at: "2026-10-01T10:00:05.000Z", blocks: [
      { type: "tool", name: "shell", input: "cat parser.ts", output: "export function parse() {}" },
      { type: "text", text: "The parser exports one function." },
    ] },
    { kind: "user", text: "Thanks.", at: "2026-10-01T10:01:00.000Z" },
    { kind: "assistant", at: "2026-10-01T10:01:02.000Z", blocks: [{ type: "text", text: "Anytime." }] },
  ],
}

const store = async (version) => {
  const home = mkdtempSync(join(tmpdir(), "mako-devin-emit-"))
  const dir = join(home, ".local", "share", "devin", "cli")
  await mkdir(dir, { recursive: true })
  const database = new DatabaseSync(join(dir, "sessions.db"))
  database.exec(SCHEMA)
  for (let at = 1; at <= version; at++)
    database.prepare("INSERT INTO refinery_schema_history (version) VALUES (?)").run(at)
  database.close()
  return { home, path: join(dir, "sessions.db") }
}

{
  const { home, path } = await store(DEVIN_STORE_VERSION)
  try {
    const emitted = await emitDevinSession(thread, { home })
    assert.equal(emitted.path, `${path}#${emitted.sessionId}`)
    const database = new DatabaseSync(path)
    const session = database.prepare("SELECT * FROM sessions WHERE id = ?").get(emitted.sessionId)
    assert.equal(session.working_directory, "/work")
    assert.equal(session.title, "Parser work")
    assert.equal(session.main_chain_id, 3, "the session ends at its last message")
    assert.deepEqual(
      database.prepare("SELECT node_id, parent_node_id FROM message_nodes WHERE session_id = ? ORDER BY node_id").all(emitted.sessionId)
        .map((row) => [row.node_id, row.parent_node_id]),
      [[0, null], [1, 0], [2, 1], [3, 2]]
    )
    database.close()

    const read = await new DevinCliProvider(home).read(emitted.path)
    assert.ok(read)
    assert.deepEqual(read.entries.map((entry) => entry.kind), ["user", "assistant", "user", "assistant"])
    assert.match(read.entries[0].text, /codeword is heliotrope/)
    const said = read.entries[1].blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n")
    assert.match(said, /\[tool: shell\]/, "tool activity replays as text")
    assert.match(said, /exports one function/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

{
  const { home, path } = await store(DEVIN_STORE_VERSION + 1)
  try {
    await assert.rejects(emitDevinSession(thread, { home }), /version 18; Mako writes version 17/)
    const database = new DatabaseSync(path)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0, "a newer store is left untouched")
    database.close()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

{
  const home = mkdtempSync(join(tmpdir(), "mako-devin-emit-"))
  try {
    await assert.rejects(emitDevinSession(thread, { home }), /no session store yet/)
    assert.equal(existsSync(join(home, ".local", "share", "devin", "cli", "sessions.db")), false, "no store is created")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

console.log("Devin emit: a thread lands as one chain Devin's reader replays, and only in the store version it matches")
