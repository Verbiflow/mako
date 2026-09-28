import assert from "node:assert/strict"
import { mkdtemp, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaudeProvider } from "../dist/index.js"

const home = await mkdtemp(join(tmpdir(), "mako-claude-title-"))
const line = (value) => `${JSON.stringify(value)}\n`
const user = (text, uuid) =>
  line({
    type: "user",
    uuid,
    sessionId: "session-1",
    cwd: home,
    timestamp: "2026-09-08T21:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  })

async function peek(name, content) {
  const path = join(home, name)
  await writeFile(path, content)
  const info = await stat(path)
  return new ClaudeProvider(home).peek({
    path,
    bytes: info.size,
    mtimeMs: info.mtimeMs,
  })
}

// Claude Code writes its own title after the fact and rewrites it as the
// conversation moves on. The rail shows the latest one, not the first prompt.
const titled = await peek(
  "titled.jsonl",
  user("[CleanShot 2026-09-08.png] Dude, why is Devin failing?", "u1") +
    line({ type: "ai-title", aiTitle: "Devin ACP failure", sessionId: "session-1" }) +
    user("Also the provider list is slow", "u2") +
    line({
      type: "ai-title",
      aiTitle: "Mako provider loading and harness issues",
      sessionId: "session-1",
    }) +
    line({ type: "last-prompt", lastPrompt: "Also the provider list is slow", sessionId: "session-1" })
)
assert.equal(titled?.title, "Mako provider loading and harness issues")

// Older files carried a summary record instead.
const summarized = await peek(
  "summary.jsonl",
  user("first prompt", "u1") +
    line({ type: "summary", summary: "Summarized title", leafUuid: "u1" })
)
assert.equal(summarized?.title, "Summarized title")

// With no written title the first prompt still names the thread.
const prompted = await peek("prompted.jsonl", user("Only a prompt here", "u1"))
assert.equal(prompted?.title, "Only a prompt here")

// The written title survives the transcript translation untouched.
const thread = await new ClaudeProvider(home).read(join(home, "titled.jsonl"))
assert.ok(thread)
assert.equal(
  thread.entries.filter((entry) => entry.kind === "user").length,
  2,
  "title records are not transcript entries"
)
console.log("Claude titles: written titles win over prompts, latest wins, legacy summary honored")

// `/rename` writes a custom-title record, and Claude Code writes it again
// right before each title of its own. The user's name wins wherever it sits.
const custom = (name) => line({ type: "custom-title", customTitle: name, sessionId: "session-1" })
const aiTitle = (name) => line({ type: "ai-title", aiTitle: name, sessionId: "session-1" })
const renamed = await peek(
  "renamed.jsonl",
  user("first prompt", "u1") + aiTitle("Claude's name") + custom("Login redirect fix") + aiTitle("Claude's newer name")
)
assert.equal(renamed?.title, "Login redirect fix", "a later ai-title does not replace the /rename name")
const renamedPath = join(home, "renamed.jsonl")
let renamedBytes = (await stat(renamedPath)).size
await writeFile(renamedPath, user("go on", "u2") + custom("Login redirect fix") + aiTitle("Yet another name"), { flag: "a" })
const kept = await new ClaudeProvider(home).refine(renamed, renamedBytes)
assert.equal(kept.title, "Login redirect fix", "appended ai-title with its custom-title keeps the name")
renamedBytes = (await stat(renamedPath)).size
await writeFile(renamedPath, aiTitle("Written alone"), { flag: "a" })
const split = await new ClaudeProvider(home).refine(kept, renamedBytes)
assert.equal(split.title, "Login redirect fix", "an ai-title appended in a later write than its custom-title keeps the name")
renamedBytes = (await stat(renamedPath)).size
await writeFile(renamedPath, custom("Renamed again"), { flag: "a" })
assert.equal((await new ClaudeProvider(home).refine(split, renamedBytes)).title, "Renamed again")
const unrenamed = await peek("unrenamed.jsonl", user("first prompt", "u1") + aiTitle("Claude's name"))
const unrenamedBytes = (await stat(join(home, "unrenamed.jsonl"))).size
await writeFile(join(home, "unrenamed.jsonl"), aiTitle("Claude's newer name"), { flag: "a" })
assert.equal((await new ClaudeProvider(home).refine(unrenamed, unrenamedBytes)).title, "Claude's newer name", "without a rename Claude's latest title still lands")
const renamedThread = await new ClaudeProvider(home).read(renamedPath)
assert.equal(renamedThread?.entries.filter((entry) => entry.kind === "user").length, 2, "custom-title records are not transcript entries")
console.log("Claude titles: a /rename name outranks Claude Code's titles in the peek and in every refine")

// Claude Code composes some assistant messages itself ("API error", "no
// response requested") and stamps them `<synthetic>`. The row keeps the model
// the conversation actually ran on, in the peek and in a later refine.
const assistant = (model, uuid) =>
  line({
    type: "assistant",
    uuid,
    sessionId: "session-1",
    cwd: home,
    timestamp: "2026-09-08T21:01:00.000Z",
    message: { role: "assistant", model, content: [{ type: "text", text: "ok" }] },
  })
const real = user("hello", "u1") + assistant("claude-fable-5-1", "a1")
const synthetic = await peek("synthetic.jsonl", real + assistant("<synthetic>", "a2"))
assert.equal(synthetic?.model, "claude-fable-5-1")
assert.equal(synthetic?.settings?.model, "claude-fable-5-1")
const onlySynthetic = await peek("only-synthetic.jsonl", user("hello", "u1") + assistant("<synthetic>", "a1"))
assert.equal(onlySynthetic?.model, undefined, "a synthetic message alone records no model")
const grown = join(home, "synthetic.jsonl")
const before = (await stat(grown)).size
await writeFile(grown, assistant("<synthetic>", "a3"), { flag: "a" })
const refined = await new ClaudeProvider(home).refine(synthetic, before)
assert.equal(refined.model, "claude-fable-5-1", "an appended synthetic message does not move the model")
console.log("Claude titles: synthetic assistant messages never become the row's model")

// EnterWorktree moves a session into a worktree mid-conversation; every line
// after it records the new folder. The row starts where it started (that's
// where it resumes) and says where it works now; ExitWorktree brings it back.
const worktree = join(home, ".claude", "worktrees", "fix-login")
const at = (cwd, text, uuid) => user(text, uuid).replace(JSON.stringify(home), JSON.stringify(cwd))
assert.equal(synthetic?.currentCwd, undefined, "a session that never moved has no current folder of its own")
const moved = await peek("moved.jsonl", user("fix the login redirect", "u1") + at(worktree, "go on", "u2"))
assert.equal(moved?.cwd, home)
assert.equal(moved?.currentCwd, worktree)
const movedPath = join(home, "moved.jsonl")
const movedBytes = (await stat(movedPath)).size
await writeFile(movedPath, user("back in the project", "u3"), { flag: "a" })
const back = await new ClaudeProvider(home).refine(moved, movedBytes)
assert.equal(back.currentCwd, undefined, "back in the folder it started in")
assert.equal(back.cwd, home)
console.log("Claude titles: a session moved into a worktree says where it works now")

// `claude -p` writes its worktree state and queued prompt before the first
// message; until a line says where it runs, the file isn't listed.
const early =
  line({ type: "worktree-state", worktreeSession: { originalCwd: home, worktreePath: worktree, worktreeName: "fix-login" }, sessionId: "session-1" }) +
  line({ type: "queue-operation", operation: "enqueue", timestamp: "2026-09-08T21:00:00.000Z", sessionId: "session-1", content: "fix it" })
assert.equal(await peek("early.jsonl", early), null, "not listed before it says where it runs")
const started = await peek("early.jsonl", early + at(worktree, "fix it", "u1"))
assert.equal(started?.cwd, worktree, "listed with its folder from the first message on")
assert.equal(started?.title, "fix it")
console.log("Claude titles: a session is listed once it says where it runs")
