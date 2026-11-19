import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { retargetGrokSession } from "@mako/host/harnesses/grok/session-source"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * A Grok session moved into another folder (`relocateGrokSession`) is told the new folder: every whole path under the
 * folder `summary.json` saved becomes the same path under the new one, in the context Grok replays to the model
 * (`chat_history.jsonl`'s `<user_info>` and the results that name paths) and in `summary.json`'s own folder. Its
 * transcript (`updates.jsonl`) keeps what happened, a sibling sharing the folder's start is left alone, both of macOS's
 * spellings of a temporary folder are taken, and paths are matched and written as JSON spells them.
 *
 *   npx tsx scripts/test-grok-retarget.ts
 */
const root = testScratch("mako-grok-retarget-")
const session = join(root, "session")
mkdirSync(session)
const main = "/private/tmp/project/main"
const to = '/private/tmp/project/work "tree"'
const userInfo = (path: string) => `<user_info>\nOS Version: macos\nWorkspace Path: ${path}\n</user_info>`
type Line = Record<string, string | Record<string, string> | { type: string; text: string }[]>
const line = (value: Line) => `${JSON.stringify(value)}\n`
const summary = { info: { id: "s1", cwd: main }, git_root_dir: `${main}/`, session_summary: "x" }
writeFileSync(join(session, "summary.json"), JSON.stringify(summary, null, 2))
writeFileSync(join(session, "chat_history.jsonl"), [
  line({ type: "system", content: "You are Grok." }),
  line({ type: "user", content: [{ type: "text", text: userInfo(main) }] }),
  line({ type: "tool", content: "read /tmp/project/main/notes.md and /private/tmp/project/main2/other.md" }),
].join(""))
const transcript = line({ sessionUpdate: "tool_call", rawInput: { path: `${main}/notes.md` } })
writeFileSync(join(session, "updates.jsonl"), transcript)

await retargetGrokSession(session, to)
const history = readFileSync(join(session, "chat_history.jsonl"), "utf8").split("\n").filter(Boolean).map((text) => JSON.parse(text))
assert.equal(history[1].content[0].text, userInfo(to), "the model is told the new folder")
assert.equal(history[2].content, `read ${to}/notes.md and /private/tmp/project/main2/other.md`, "both spellings of a path under it move, a sibling sharing its start doesn't")
const moved = JSON.parse(readFileSync(join(session, "summary.json"), "utf8"))
assert.deepEqual([moved.info.cwd, moved.git_root_dir, moved.session_summary], [to, `${to}/`, "x"], "the catalog lists it under the new folder, the rest as it was")
assert.equal(readFileSync(join(session, "updates.jsonl"), "utf8"), transcript, "the transcript keeps what happened")

// Again, or already there: nothing changes.
const before = readFileSync(join(session, "chat_history.jsonl"), "utf8")
await retargetGrokSession(session, to)
assert.equal(readFileSync(join(session, "chat_history.jsonl"), "utf8"), before)
// A session written by `cwd` with one line of context, moved to each folder in turn; what its context says after each.
const moves = (name: string, cwd: string, context: string, ...folders: string[]) => {
  const at = join(root, name)
  mkdirSync(at)
  writeFileSync(join(at, "summary.json"), JSON.stringify({ info: { cwd } }))
  writeFileSync(join(at, "chat_history.jsonl"), line({ type: "user", content: context }))
  return folders.reduce(async (said: Promise<string[]>, folder) => {
    const before = await said
    await retargetGrokSession(at, folder)
    return [...before, JSON.parse(readFileSync(join(at, "chat_history.jsonl"), "utf8")).content]
  }, Promise.resolve([]))
}
const context = (path: string) => `Workspace Path: ${path}\nread ${path}/x and ${path}/sub/y`

// Into a folder under the old one: a path already there stays, so nothing moves twice, a rerun after a crash
// changes nothing, and the move back takes the longer folder.
// A path already under the new folder counts as moved, so a rerun is safe; the cost is that /repo's own `sub` reads as
// the new folder, which is where the session now works anyway.
assert.deepEqual(await moves("under", "/repo", context("/repo"), "/repo/sub"), [
  "Workspace Path: /repo/sub\nread /repo/sub/x and /repo/sub/y",
], "everything under /repo moves under /repo/sub, and nothing twice")
assert.deepEqual(await moves("under-again", "/repo", "read /repo/sub/x", "/repo/sub", "/repo/sub"), ["read /repo/sub/x", "read /repo/sub/x"],
  "a path already under the new folder is never moved again, however many times it runs")
const rerun = join(root, "rerun")
mkdirSync(rerun)
// A crash after the context was written and before summary.json was: it still names the old folder.
writeFileSync(join(rerun, "summary.json"), JSON.stringify({ info: { cwd: "/repo" } }))
writeFileSync(join(rerun, "chat_history.jsonl"), line({ type: "user", content: "Workspace Path: /repo/sub\nread /repo/sub/x" }))
await retargetGrokSession(rerun, "/repo/sub")
assert.equal(JSON.parse(readFileSync(join(rerun, "chat_history.jsonl"), "utf8")).content, "Workspace Path: /repo/sub\nread /repo/sub/x", "the rerun moves nothing twice")
assert.deepEqual(await moves("there-and-back", "/repo", "read /repo/x", "/repo/sub", "/repo"), ["read /repo/sub/x", "read /repo/x"],
  "A to B under A and back: the way back takes /repo/sub, the longer folder, and lands where it began")

// A path inside a longer one is someone else's: only a path standing on its own moves.
assert.deepEqual(await moves("boundary", "/Users/k/main", "/Volumes/b/Users/k/main/f (/Users/k/main/g) cd=/Users/k/main:'/Users/k/main'<`/Users/k/main`", "/w"),
  ["/Volumes/b/Users/k/main/f (/w/g) cd=/w:'/w'<`/w`"])

// A link to a file under the old folder moves too, as a file:// URI spells a space.
assert.deepEqual(await moves("uri", "/Users/k/my repo", "see file:///Users/k/my%20repo/a.md and /Users/k/my repo/b.md, not file:///Users/k/my%20repo2/c.md", "/Users/k/my tree"),
  ["see file:///Users/k/my%20tree/a.md and /Users/k/my tree/b.md, not file:///Users/k/my%20repo2/c.md"])

console.log("PASS: a moved Grok session's replayed context and summary name the new folder once, whatever the move, rerun or way back; only a path standing on its own, or a file:// link to it, moves; its transcript, siblings and other fields stay")
