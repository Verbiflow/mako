import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { takeHostStart } from "@mako/host/base/host-start"
import { LiveConversations } from "@mako/host/conversations/live-conversations"

/**
 * A host's start on its data root (`takeHostStart`): one past the last, kept on disk before it's used, under the data
 * root's own name, and never read from a clock; a record that can't be read begins again under a new name, which no
 * window orders against the old. Its epoch says both (`LiveConversations.epoch`), and one without a start says neither.
 */
const root = mkdtempSync(join(tmpdir(), "mako-host-start-"))
try {
  const first = takeHostStart(root)
  assert.equal(first.generation, 1, "a data root's first start")
  assert.match(first.root, /^[A-Za-z0-9_-]{8,16}$/)
  const second = takeHostStart(root)
  assert.deepEqual(second, { generation: 2, root: first.root }, "the next is one past it, on the same data root")
  assert.deepEqual(JSON.parse(readFileSync(join(root, "host-start.json"), "utf8")), second, "kept before it's used")
  assert.equal(existsSync(join(root, "host-start.json.next")), false, "written whole, then put in place")
  writeFileSync(join(root, "host-start.json"), "{ not json")
  const lost = takeHostStart(root)
  assert.equal(lost.generation, 1, "a record that can't be read begins again")
  assert.notEqual(lost.root, first.root, "under a new name, so no window orders it against the old")
  assert.equal(takeHostStart(root).generation, 2)

  const epochOf = (start?: { generation: number; root: string }) =>
    // SAFETY: only the epoch is read, which the constructor makes before anything else it holds is used.
    new LiveConversations({ root: join(root, "journals"), ...(start && { start }) } as never).epoch
  const epoch = epochOf({ generation: 7, root: first.root })
  assert.match(epoch, new RegExp(`^g7\\.${first.root}\\.[A-Za-z0-9_-]{8}$`), "an epoch says its start's generation and data root")
  assert.notEqual(epochOf({ generation: 7, root: first.root }), epoch, "and is its own")
  assert.match(epochOf(), /^[A-Za-z0-9_-]{12}$/, "one with no start says neither, as a build before them")
  console.log("Host start: one past the last on its data root, kept before it's used, begun again under a new name when lost, and said in every epoch")
} finally {
  rmSync(root, { recursive: true, force: true })
}
