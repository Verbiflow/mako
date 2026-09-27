import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SessionArchive, keepEverything } from "../dist/archive.js"

const root = await mkdtemp(join(tmpdir(), "mako-archive-eviction-"))
const thread = (name) => ({
  ref: { harness: "fixture", nativeId: name, path: `/fixture/${name}`, revision: "one", bytes: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
  entries: [{ kind: "user", text: name }],
})
const capture = async (archive, value) => {
  archive.note(value.ref, async () => value)
  await archive.flush()
}
try {
  const kept = new SessionArchive(join(root, "kept"))
  await capture(kept, thread("old"))
  assert.equal(await kept.evict(), 0, "the default policy keeps every copy")
  assert.ok(await kept.read("/fixture/old"))
  await kept.stop()
  assert.deepEqual(keepEverything.select([thread("old").ref], new Date()), [])

  const offered = []
  const policy = {
    select(refs, now) {
      offered.push(...refs.map((ref) => ref.path))
      assert.ok(now instanceof Date)
      return refs.filter((ref) => ref.nativeId === "old").map((ref) => ref.path)
    },
  }
  const archive = new SessionArchive(join(root, "evicting"), policy)
  await capture(archive, thread("old"))
  await capture(archive, thread("new"))
  assert.equal(await archive.evict(), 1)
  assert.deepEqual(offered.sort(), ["/fixture/new", "/fixture/old"], "the policy sees every kept copy")
  assert.equal(await archive.read("/fixture/old"), null, "the selected copy is gone")
  assert.ok(await archive.read("/fixture/new"), "the rest stay")
  let reads = 0
  archive.note(thread("old").ref, async () => { reads++; return thread("old") })
  await archive.flush()
  assert.equal(reads, 0, "an evicted copy is not captured again")
  await archive.stop()
  console.log("Archive eviction: the default keeps everything; a policy's selection is forgotten and not recaptured")
} finally {
  await rm(root, { recursive: true, force: true })
}
