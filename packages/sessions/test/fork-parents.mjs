import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { ClaudeProvider } from "../dist/providers/claude.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { OpenCodeProvider } from "../dist/providers/opencode.js"

// A fork made by the harness's own command names the session it came from,
// so the Thread store can put it in its parent's Thread. Grok's case is in
// grok-catalog.mjs; Cursor and Devin have no fork command.

const jsonl = (...values) => values.map((value) => `${JSON.stringify(value)}\n`).join("")

async function discovered(provider, path) {
  const file = (await provider.discover()).find((candidate) => candidate.path === path)
  assert.ok(file, `${path} is discovered`)
  return provider.peek(file)
}

const home = await mkdtemp(join(tmpdir(), "sessions-fork-parents-"))
try {
  // Claude Code's `--fork-session` copies the parent's lines under the new
  // session id, each stamped with `forkedFrom`.
  const claudeDir = join(home, ".claude", "projects", "-work")
  await mkdir(claudeDir, { recursive: true })
  const parentId = "11111111-1111-4111-8111-111111111111"
  const forkId = "22222222-2222-4222-8222-222222222222"
  const user = (sessionId, extra = {}) => ({
    type: "user", uuid: `${sessionId}-u1`, sessionId, cwd: "/work", timestamp: "2026-09-01T00:00:00.000Z",
    message: { role: "user", content: "Fix the login flow" }, ...extra,
  })
  await writeFile(join(claudeDir, `${parentId}.jsonl`), jsonl(user(parentId)))
  const claudeFork = join(claudeDir, `${forkId}.jsonl`)
  await writeFile(claudeFork, jsonl(user(forkId, { forkedFrom: { sessionId: parentId, messageUuid: `${parentId}-u1` } })))
  const claude = new ClaudeProvider(home, undefined)
  assert.equal((await discovered(claude, claudeFork)).parentNativeId, parentId, "claude: a fork names its parent")
  assert.equal((await discovered(claude, join(claudeDir, `${parentId}.jsonl`))).parentNativeId, undefined, "claude: the parent names none")

  // Codex records `forked_from_id` in the rollout's session_meta.
  const codexDir = join(home, ".codex", "sessions", "2026", "09", "01")
  await mkdir(codexDir, { recursive: true })
  const meta = (id, extra = {}) => ({ timestamp: "2026-09-01T00:00:00.000Z", type: "session_meta", payload: { id, cwd: "/work", timestamp: "2026-09-01T00:00:00.000Z", ...extra } })
  const prompt = { timestamp: "2026-09-01T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "Fix the login flow" } }
  const codexParent = "019a0000-0000-7000-8000-000000000001"
  const codexFork = "019a0000-0000-7000-8000-000000000002"
  await writeFile(join(codexDir, `rollout-2026-09-01T00-00-00-${codexParent}.jsonl`), jsonl(meta(codexParent), prompt))
  const codexForkPath = join(codexDir, `rollout-2026-09-01T00-00-01-${codexFork}.jsonl`)
  await writeFile(codexForkPath, jsonl(meta(codexFork, { forked_from_id: codexParent }), prompt))
  const codex = new CodexProvider(home)
  assert.equal((await discovered(codex, codexForkPath)).parentNativeId, codexParent, "codex: a fork names its parent")

  // OpenCode records no parent: it titles the copy after its source and copies its history.
  const openCodeRoot = join(home, ".local", "share", "opencode")
  await mkdir(openCodeRoot, { recursive: true })
  const db = new DatabaseSync(join(openCodeRoot, "opencode.db"))
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `)
  db.prepare("INSERT INTO project VALUES ('p', '/work', 'work', 1, 1)").run()
  const session = (id, title, created, text) => {
    db.prepare("INSERT INTO session VALUES (?, 'p', NULL, '/work', ?, ?, ?, NULL)").run(id, title, created, created)
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(`${id}-m`, id, created, created, JSON.stringify({ role: "user", time: { created: 1000 } }))
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(`${id}-p`, `${id}-m`, id, created, created, JSON.stringify({ type: "text", text }))
  }
  session("ses_other", "Fix login", 900, "Something else entirely")
  session("ses_parent", "Fix login", 1000, "Fix the login flow")
  session("ses_fork", "Fix login (fork #1)", 2000, "Fix the login flow")
  session("ses_fork2", "Fix login (fork #2)", 3000, "Fix the login flow")
  session("ses_named", "Notes (fork #1)", 4000, "A title that only looks like a fork")
  db.close()
  const openCode = new OpenCodeProvider(home)
  const byId = new Map()
  for (const file of await openCode.discover()) {
    const ref = await openCode.peek(file)
    if (ref) byId.set(ref.nativeId, ref)
  }
  assert.equal(byId.get("ses_fork")?.parentNativeId, "ses_parent", "opencode: a fork names the source with its title and first prompt")
  assert.equal(byId.get("ses_fork2")?.parentNativeId, "ses_fork", "opencode: a fork of a fork names the fork")
  assert.equal(byId.get("ses_parent")?.parentNativeId, undefined)
  assert.equal(byId.get("ses_named")?.parentNativeId, undefined, "opencode: a fork-like title with no source names none")
  console.log("fork parents: claude, codex and opencode forks name their parent")
} finally {
  await rm(home, { recursive: true, force: true })
}
