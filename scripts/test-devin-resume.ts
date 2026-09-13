import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { mock } from "node:test"
import { devinResumePolicy } from "../electron/providers/devin/resume.ts"
import type { ProviderBinding } from "../electron/contracts/conversation-control.ts"

const root = await mkdtemp(join(tmpdir(), "mako-devin-resume-"))
const db = new DatabaseSync(join(root, "sessions.db"))
try {
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, main_chain_id INTEGER, model TEXT, working_directory TEXT, hidden INTEGER)")
  const insert = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, 0)")
  insert.run("one", 12, "model-a", root)
  insert.run("two", 23, "model-b", root)
  await mkdir(join(root, "session_locks"))
  const policy = devinResumePolicy(root)
  const path = `${join(root, "sessions.db")}#one`
  const checkpoint = await policy.checkpoint(path)
  assert.ok(checkpoint)
  const binding: ProviderBinding = {id:"binding",provider:"devin",nativeId:"one",path,checkpoint,coveredBlocks:2,includesBase:true}
  assert.equal(await policy.canResumeBinding(binding), true)
  assert.equal(await policy.canResumeBinding({...binding,checkpoint:undefined}), true, "Legacy records can load an existing unlocked native session")
  db.prepare("UPDATE sessions SET main_chain_id = 99 WHERE id = ?").run("two")
  assert.equal(await policy.checkpoint(path), checkpoint, "Another session cannot invalidate this session's checkpoint")
  assert.equal(await policy.canResumeBinding({...binding,nativeId:"two"}), false)
  await writeFile(join(root, "session_locks", "one.lock"), String(process.pid))
  assert.deepEqual(await policy.resumeVerdict(binding), { kind: "held", by: `a Devin process (pid ${process.pid})` }, "A live native owner cannot be resumed concurrently")
  assert.equal(await policy.canResumeBinding({...binding,checkpoint:undefined}), false, "Legacy recovery must still refuse an existing owner")
  await writeFile(join(root, "session_locks", "one.lock"), "not-a-pid")
  assert.equal((await policy.resumeVerdict(binding)).kind, "unavailable")
  await writeFile(join(root, "session_locks", "one.lock"), "99999999")
  const kill = mock.method(process, "kill", (pid: number, signal?: number | string) => {
    assert.equal(pid, 99999999)
    assert.equal(signal, 0)
    throw Object.assign(new Error("No such process"), {code:"ESRCH"})
  })
  try {
    assert.equal(await policy.canResumeBinding(binding), true)
    db.prepare("UPDATE sessions SET main_chain_id = 13 WHERE id = ?").run("one")
    assert.equal(await policy.canResumeBinding(binding), false, "Native history changes require a new checkpoint before a binding is reused for a switch")
    assert.deepEqual(await policy.resumeVerdict(binding), { kind: "resumable", record: "moved" }, "but the unlocked session itself still reconnects")
  } finally {
    kill.mock.restore()
  }
  assert.equal(await policy.checkpoint(`${join(root,"sessions.db")}#../one`), undefined)
  console.log("Devin resume: per-session native revision, unrelated DB writes, live/stale/malformed locks, changed history and identity boundaries verified")
} finally {
  db.close()
  await rm(root, {recursive:true,force:true})
}
