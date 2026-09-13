import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ProviderBinding } from "../electron/contracts/conversation-control.ts"
import { cursorResumePolicy } from "../electron/providers/cursor/resume.ts"

const home = await mkdtemp(join(tmpdir(), "mako-cursor-resume-"))
try {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
  const directory = join(home, ".cursor", "acp-sessions", id)
  await mkdir(directory, { recursive: true })
  const path = join(directory, "store.db")
  const write = (root: string, blobs: number, hex: boolean) => {
    const db = new DatabaseSync(path)
    try {
      db.exec("CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
      db.exec("DELETE FROM blobs")
      for (let index = 0; index < blobs; index += 1)
        db.prepare("INSERT INTO blobs VALUES (?, ?)").run(`blob-${index}`, Buffer.from("x"))
      const meta = JSON.stringify({ agentId: id, latestRootBlobId: root, name: "Test" })
      db.prepare("INSERT OR REPLACE INTO meta VALUES ('0', ?)").run(hex ? Buffer.from(meta, "utf8").toString("hex") : meta)
    } finally {
      db.close()
    }
  }
  write("root-1", 2, false)
  const policy = cursorResumePolicy(home)
  const first = await policy.checkpoint(path)
  assert.ok(first, "an acp-sessions store has a checkpoint")
  assert.equal(await policy.checkpoint(path), first, "the checkpoint is a function of the store's head")
  write("root-1", 2, true)
  assert.equal(await policy.checkpoint(path), first, "hex-encoded meta reads the same")
  write("root-2", 3, true)
  const second = await policy.checkpoint(path)
  assert.notEqual(second, first, "a new turn moves the root blob and the checkpoint")
  assert.equal(await policy.checkpoint(join(home, ".cursor", "chats", "hash", id, "store.db")), undefined, "a chats store is not loadable over ACP")
  assert.equal(await policy.checkpoint(join(home, ".cursor", "acp-sessions", id, "meta.json")), undefined)

  const binding: ProviderBinding = { id: "binding", provider: "cursor", nativeId: id, path, checkpoint: second, coveredBlocks: 1, includesBase: true }
  assert.equal(await policy.canResumeBinding(binding), true)
  assert.deepEqual(await policy.resumeVerdict(binding), { kind: "resumable", record: "same" })
  assert.equal(await policy.canResumeBinding({ ...binding, checkpoint: undefined }), true, "a legacy binding without a checkpoint loads the unlocked store")
  assert.equal(await policy.canResumeBinding({ ...binding, checkpoint: first }), false, "a provider switch does not reuse a binding whose history moved")
  assert.deepEqual(
    await policy.resumeVerdict({ ...binding, checkpoint: first }),
    { kind: "resumable", record: "moved" },
    "history that moved since the binding is the same unowned session: a reconnect goes on from it"
  )
  assert.equal((await policy.resumeVerdict({ ...binding, nativeId: "other" })).kind, "unavailable")
  assert.equal((await policy.resumeVerdict({ ...binding, path: join(home, ".cursor", "chats", "hash", id, "store.db") })).kind, "unavailable", "a chats store never resumes over ACP")
  await rm(path)
  assert.equal((await policy.resumeVerdict(binding)).kind, "unavailable", "a missing store cannot be resumed")
  console.log("Cursor resume: acp-sessions stores checkpoint by root blob through WAL and hex meta; moved history reconnects but is not reused for a switch; chats stores and missing stores refuse")
} finally {
  await rm(home, { recursive: true, force: true })
}
