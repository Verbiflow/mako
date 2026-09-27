import assert from "node:assert/strict"
import { claudeVersionedLabel } from "../packages/sessions/src/model-catalog.ts"
import { classify } from "../src/lib/attachments.ts"
import { mediaTypeForPath } from "../src/lib/transcript-media.ts"
import { groupThreadFolders } from "../src/lib/thread-folders.ts"
import type { AcpPresence } from "../src/state/acp-presence.ts"

assert.equal(claudeVersionedLabel("claude-fable-5-1", "Fable"), "Fable 5.1")
assert.equal(
  claudeVersionedLabel("claude-fable-5.1[1m]", "Fable (1M context)"),
  "Fable 5.1 (1M context)"
)
assert.equal(claudeVersionedLabel("claude-fable-5", "Fable"), "Fable 5")
assert.equal(
  claudeVersionedLabel("claude-sonnet-4-20250514", "Sonnet"),
  "Sonnet 4"
)
assert.equal(classify(new File(["fixture"], "Screenshot.PNG")), "image")
assert.equal(classify(new File(["fixture"], "notes.txt")), "text")
assert.equal(classify(new File(["fixture"], "unknown.bin")), "binary")
assert.equal(mediaTypeForPath("second-screenshot.png"), "image/png")
assert.equal(mediaTypeForPath("clip.mp4"), "video/mp4")
const presence: AcpPresence = {
  key: "local-1",
  harness: "devin",
  cwd: "/project/only-live",
  createdAt: Date.now(),
  status: "running",
  title: "Live without a native file",
}
const folders = groupThreadFolders({
  refs: [],
  live: [presence],
  pinnedThreads: [],
  pinnedFolders: [],
  sortBy: "recent",
})
assert.equal(folders.length, 1)
assert.equal(folders[0]?.cwd, presence.cwd)
assert.equal(folders[0]?.running, 1)
assert.equal(folders[0]?.priority, 2)
assert.equal(
  folders[0]?.refs.length,
  0,
  "An unbound live session must not invent a native path"
)
const failed = groupThreadFolders({
  refs: [],
  live: [{ ...presence, status: "failed" }],
  pinnedThreads: [],
  pinnedFolders: [],
  sortBy: "recent",
})
assert.equal(failed[0]?.failed, 1)
assert.equal(failed[0]?.running, 0)

// A Thread in a worktree files under the project folder it was made from.
const worktree = "/Users/me/.mako/worktrees/shop-1a2b3c4d/fix-login"
const inWorktree = groupThreadFolders({
  refs: [
    { harness: "codex", nativeId: "a", path: "/a.jsonl", cwd: "/Users/me/shop/web", updatedAt: "2026-09-27T01:00:00Z" },
    { harness: "claude", nativeId: "b", path: "/b.jsonl", cwd: `${worktree}/web`, updatedAt: "2026-09-27T02:00:00Z" },
  ],
  live: [{ ...presence, cwd: worktree }],
  pinnedThreads: [],
  pinnedFolders: ["/Users/me/shop"],
  sortBy: "recent",
  folderMap: (path) => (path === worktree || path.startsWith(`${worktree}/`) ? `/Users/me/shop${path.slice(worktree.length)}` : undefined),
})
assert.deepEqual(inWorktree.map((folder) => [folder.cwd, folder.refs.map((ref) => ref.path)]).sort(), [
  ["/Users/me/shop", []],
  ["/Users/me/shop/web", ["/b.jsonl", "/a.jsonl"]],
])
assert.equal(inWorktree.find((folder) => folder.cwd === "/Users/me/shop")?.running, 1, "a live agent at the worktree's root counts for the project")
console.log(
  "UI contracts: versioned Fable labels, date suffixes, screenshots without MIME metadata, project-owned live/failed sessions, and worktree Threads under their project verified"
)
