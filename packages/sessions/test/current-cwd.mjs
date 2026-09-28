import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaudeProvider, CodexProvider } from "../dist/index.js"

/**
 * The folder a session's latest turn ran in, as each harness that records
 * one writes it. A session's `cwd` stays where it started; `currentCwd`
 * follows the harness, and one folder's two spellings are one folder.
 */

const home = await mkdtemp(join(tmpdir(), "mako-current-cwd-"))
const project = "/Users/you/app"
const worktree = "/Users/you/.codex/worktrees/a1b2/app"
const fileOf = async (path) => {
  const info = await stat(path)
  return { path, bytes: info.size, mtimeMs: info.mtimeMs }
}

try {
  // Codex: every turn_context names its folder, and a client may start a turn in another one.
  const sessions = join(home, ".codex", "sessions")
  await mkdir(sessions, { recursive: true })
  const rollout = join(sessions, "rollout-2026-09-28T00-00-00-cx-move.jsonl")
  const codex = (type, payload) => `${JSON.stringify({ timestamp: "2026-09-28T00:00:00Z", type, payload })}\n`
  const prompt = (text) => codex("event_msg", { type: "user_message", message: text })
  await writeFile(rollout, codex("session_meta", { id: "cx-move", cwd: project }) + codex("turn_context", { cwd: project, model: "gpt-5.6" }) + prompt("fix the login redirect"))
  const provider = new CodexProvider(home)
  const still = await provider.peek(await fileOf(rollout))
  assert.equal(still?.cwd, project)
  assert.equal(still?.currentCwd, undefined, "a turn in the folder it started in")

  let bytes = (await stat(rollout)).size
  await appendFile(rollout, codex("turn_context", { cwd: worktree, model: "gpt-5.6" }) + prompt("go on in the worktree"))
  const moved = await provider.refine(still, bytes)
  assert.equal(moved.currentCwd, worktree, "an appended turn in another folder")
  assert.equal(moved.cwd, project, "where it started stays")
  assert.equal((await provider.peek(await fileOf(rollout)))?.currentCwd, worktree, "a fresh peek reads the same from the tail")

  bytes = (await stat(rollout)).size
  await appendFile(rollout, prompt("no new turn context here"))
  assert.equal((await provider.refine(moved, bytes)).currentCwd, worktree, "bytes without a turn leave it where it was")

  bytes = (await stat(rollout)).size
  await appendFile(rollout, codex("turn_context", { cwd: `/private${project}`, model: "gpt-5.6" }))
  assert.equal((await provider.refine(moved, bytes)).currentCwd, undefined, "back, spelled through /private")

  // Claude Code: every line names its folder; EnterWorktree and the shell's cd both change it.
  const claudeDir = join(home, "claude")
  await mkdir(claudeDir)
  const claude = (cwd, uuid) =>
    `${JSON.stringify({ type: "user", uuid, sessionId: "cl-move", cwd, timestamp: "2026-09-28T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }] } })}\n`
  const spelled = join(claudeDir, "spelled.jsonl")
  await writeFile(spelled, claude("/tmp/scratch", "u1") + claude("/private/tmp/scratch", "u2"))
  assert.equal((await new ClaudeProvider(claudeDir).peek(await fileOf(spelled)))?.currentCwd, undefined, "one folder, two spellings")
  const cd = join(claudeDir, "cd.jsonl")
  await writeFile(cd, claude(project, "u1") + claude(`${project}/web`, "u2"))
  assert.equal((await new ClaudeProvider(claudeDir).peek(await fileOf(cd)))?.currentCwd, `${project}/web`, "recorded as the harness wrote it; the window decides what's a move")

  console.log("current cwd: Codex turn in another folder (peek, refine, no turn, back through /private), Claude spellings and cd")
} finally {
  await rm(home, { recursive: true, force: true })
}
