import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import { foldersOverlap } from "@mako/host/workspaces/snapshots"
import { onWindows } from "@mako/host/base/platform"

/**
 * Which checkpoints and rewinds share folders, in the system's own paths. On Windows `relative` answers `..\x`, and
 * another drive's path whole; read as `/` paths, every two folders overlapped and each rewind held every other.
 * `npx tsx scripts/test-folders-overlap.ts`.
 */
const root = resolve("mako-overlap-root")
const app = join(root, "app")
assert.equal(foldersOverlap(app, app), true, "a folder is itself")
assert.equal(foldersOverlap(root, join(app, "src")), true, "a folder holds what is inside it")
assert.equal(foldersOverlap(join(app, "src"), root), true, "either way round")
assert.equal(foldersOverlap(app, join(root, "api")), false, "siblings")
assert.equal(foldersOverlap(app, join(root, "app-two")), false, "a sibling whose name starts with the other's")
assert.equal(foldersOverlap(join(root, "..app"), app), false, "a sibling whose name starts with dots")
if (onWindows()) {
  assert.equal(foldersOverlap("C:\\work\\app", "D:\\work\\app"), false, "folders on two drives")
  assert.equal(foldersOverlap("C:\\work", "c:\\work\\app"), true, "a drive letter in either case")
}
console.log("Snapshots: folders overlap only when one holds the other, in this system's paths")
