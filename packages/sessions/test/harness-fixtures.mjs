import { mkdir } from "node:fs/promises"
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

/**
 * A session of each of the six harnesses, written into a scratch home as that harness lays one out (by Mako's own
 * emitters, or OpenCode's database as its build writes it), with the reader that reads it back: what a test or a
 * proof crosses between stores and checks was restored as it was.
 */

export const FACT = "the deploy key is lyrebird-kingfisher-42"

/** Each harness over `stores`: `provider(home)` reads a home, `emit(home, cwd)` writes a session into one. */
export function harnessFixtures(stores) {
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

  return [
    { name: "claude", provider: (home) => new ClaudeProvider(home), emit: (home, cwd) => emitClaudeSession(stores, thread(cwd), { cwd, home }) },
    { name: "codex", provider: (home) => new CodexProvider(stores, home), emit: (home, cwd) => emitCodexSession(stores, thread(cwd), { cwd, home }) },
    { name: "cursor", provider: (home) => new CursorProvider(stores, home), emit: (home, cwd) => emitCursorSession(stores, thread(cwd), { cwd, home }) },
    { name: "grok", provider: (home) => new GrokProvider(home), emit: (home, cwd) => emitGrokSession(stores, thread(cwd), { cwd, home }) },
    { name: "devin", provider: (home) => new DevinCliProvider(stores, home), emit: async (home, cwd) => (await devinStore(home), emitDevinSession(stores, thread(cwd), { cwd, home })) },
    { name: "opencode", provider: (home) => new OpenCodeProvider(stores, home), emit: async (home, cwd) => (await mkdir(join(home, ".local", "share", "opencode"), { recursive: true }), openCodeSession(home, cwd)) },
  ]
}

/** A conversation as its reader gives it, without what's the reader's own (ids, paths, read times). */
export const conversation = (read) => read.entries.map((entry) => ({ type: entry.type, text: entry.text ?? null, name: entry.name ?? null, input: entry.input ?? null, output: entry.output ?? null }))

export async function sessionIn(provider, nativeId) {
  for (const file of await provider.discover()) {
    const ref = await provider.peek(file)
    if (ref && (nativeId === undefined || ref.nativeId === nativeId)) return { file, ref }
  }
  return undefined
}
