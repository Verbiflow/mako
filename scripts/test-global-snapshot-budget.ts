import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { mock } from "node:test"
import { Git } from "@mako/git"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"
import { LiveJournal, readSnapshotSettlement, storedSnapshotSettlement } from "@mako/host/conversations/live-journal"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { WorkspaceSnapshot } from "@mako/host/contracts/workspace-snapshots"
import { auditSnapshot } from "./performance-audit-fixtures"

const root = await realpath(await mkdtemp(join(tmpdir(), "mako-global-rewind-")))
const storage = join(root, "workspace-snapshots"), journals = join(root, "conversations")
const git = new Git(), policy = { maxStorageBytes: 8 * 1024 ** 2 }
let store = new WorkspaceSnapshots(git, storage, policy)
const db = new DatabaseSync(join(storage, "snapshots.sqlite"))
const rows = () => db.prepare("SELECT id, value FROM snapshots").all()
const residents: { journal: LiveJournal; snapshot: LiveSnapshot; before: WorkspaceSnapshot; after: WorkspaceSnapshot; cwd: string }[] = []
const proof = () => storedSnapshotSettlement(journals)
store.followSettlement(() => readSnapshotSettlement(journals))
mock.timers.enable({ apis: ["Date"], now: Date.now() })
try {
  for (let index = 0; index < 3; index++) {
    const cwd = join(root, `repo-${index}`); await mkdir(cwd)
    await git.output(cwd, ["init", "-q", "-b", "main"])
    await writeFile(join(cwd, "source"), "committed fixture source")
    await git.output(cwd, ["add", "."]); await git.output(cwd, ["commit", "-qm", "fixture"])
    await writeFile(join(cwd, "payload"), randomBytes(384 * 1024))
    const request = randomUUID(); mock.timers.tick(10)
    const before = await store.beginRun(request, cwd)
    await writeFile(join(cwd, "payload"), randomBytes(384 * 1024)); mock.timers.tick(10)
    const after = await store.endRun(request)
    const id = randomUUID(), base = auditSnapshot(0, "fixture", 0, 0)
    const snapshot: LiveSnapshot = { ...base,
      session: { ...base.session, id, cwd, status: "closed", connection: "disconnected" },
      requests: [{ id: request, createdAt: Date.now(), status: "completed", text: "synthetic turn", attachments: [], snapshots: { before: { kind: "ready", snapshot: before }, after: { kind: "ready", snapshot: after } } }],
    }
    const journal = new LiveJournal(journals, id); journal.commit(snapshot)
    residents.push({ journal, snapshot, before, after, cwd })
  }
  assert.equal(proof().valid, true)
  assert.equal(proof().settledIds.length, 6)
  assert.equal((await store.budget.settings()).mode, "preview")
  await store.budget.configure({ mode: "preview", maxBytes: 1024 ** 2 })
  const plan = await store.budget.preview()
  assert.ok(plan.payloadBytes > plan.settings.maxBytes)
  assert.ok(plan.entries.every(row => row.eligible), "actual closed journal turns prove all six checkpoints settled")
  assert.deepEqual(plan.entries.map(row => row.id), residents.flatMap(row => [row.before.id, row.after.id]), "global age order crosses repository boundaries")
  const count = rows().length; await store.budget.run()
  assert.equal(rows().length, count, "preview does not evict")

  const first = residents[0]!
  const running = randomUUID()
  await store.beginRun(running, first.cwd)
  assert.ok((await store.budget.preview()).entries.filter(row => row.scope === first.cwd).every(row => !row.eligible), "the actual active-run map holds its whole scope before journal publication")
  store.abandonRun(running)
  store.trees(first.before.id, first.before.id)
  assert.equal((await store.budget.preview()).entries.find(row => row.id === first.before.id)?.eligible, false, "an actual comparison lease wins over age and budget")
  const previous = first.snapshot
  first.snapshot = { ...first.snapshot, revision: first.snapshot.revision + 1,
    requests: [...first.snapshot.requests, { id: randomUUID(), createdAt: Date.now(), status: "queued", text: "synthetic pending turn", attachments: [] }],
  }
  first.journal.commit(first.snapshot, previous)
  assert.ok((await store.budget.preview()).entries.filter(row => row.scope === first.cwd).every(row => !row.eligible), "pending real request rows protect the whole workspace even without checkpoint IDs")
  const elsewhere = storedSnapshotSettlement(journals, id => id === residents[1]!.snapshot.session.id)
  assert.ok(elsewhere.blockedScopes.includes(residents[1]!.cwd), "continued/cloud ownership is not settled locally")
  const bad = new DatabaseSync(join(journals, `${randomUUID()}.sqlite`)); bad.close()
  assert.equal(proof().valid, false)
  assert.ok((await store.budget.preview()).entries.every(row => !row.eligible), "unknown journal metadata never becomes permission to prune")
  const names = await fs.readdir(journals)
  for (const name of names) if (name.endsWith(".sqlite") && !residents.some(row => `${row.snapshot.session.id}.sqlite` === name)) await rm(join(journals, name))
  assert.equal(proof().valid, true)

  store.close(); store = new WorkspaceSnapshots(git, storage, policy); store.followSettlement(() => readSnapshotSettlement(journals))
  assert.equal((await store.budget.settings()).maxBytes, 1024 ** 2, "the global setting survives reconstruction")
  const selected = (await store.budget.preview()).entries.filter(row => row.selected)
  assert.ok(selected.length >= 2)
  await store.budget.configure({ mode: "evict", maxBytes: 1024 ** 2 })
  let reads = 0, settingsWrite: Promise<void> | undefined
  store.followSettlement(async () => {
    if (++reads === 2) settingsWrite = store.budget.configure({ mode: "preview", maxBytes: 1024 ** 2 })
    return readSnapshotSettlement(journals)
  })
  const beforeToggle = rows().length
  const stopped = await store.budget.run()
  await settingsWrite
  assert.equal(rows().length, beforeToggle, "a Settings change admitted during awaited evidence prevents all new retirements")
  assert.ok(stopped.entries.every(row => !row.removed))
  assert.equal((await store.budget.settings()).mode, "preview")
  store.followSettlement(() => readSnapshotSettlement(journals))
  await store.budget.configure({ mode: "evict", maxBytes: 1024 ** 2 })
  const rename = fs.rename
  let injected = false
  mock.method(fs, "rename", async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    if (!injected && String(to).includes(".budget-retiring-")) { injected = true; throw undefined }
    return rename(from, to)
  }); syncBuiltinESMExports()
  const applied = await store.budget.run()
  mock.restoreAll(); syncBuiltinESMExports()
  assert.equal(injected, true)
  const failed = selected[0]!
  const retained = rows().find(row => row.id === failed.id)
  assert.ok(retained)
  assert.equal(JSON.parse(String(retained.value)).retiring, true, "durable intent precedes the failed rename; no blind retry or resurrection")
  assert.equal(applied.entries.find(row => row.id === failed.id)?.eligible, false)
  assert.ok(applied.entries.some(row => row.removed), "other independent eligible checkpoints are attempted after a falsey failure")
  for (const removed of applied.entries.filter(row => row.removed)) {
    assert.equal(rows().some(row => row.id === removed.id), false)
    await assert.rejects(readFile(join(storage, removed.id, "capture-owner.json")), { code: "ENOENT" })
  }
  assert.ok(rows().some(row => row.id === first.before.id), "active/preview data remains intact")
  assert.equal(store.budget.admit(1024 ** 3, randomUUID()), false, "publication cannot exceed the one global limit")
  store.close(); store = new WorkspaceSnapshots(git, storage, policy); store.followSettlement(() => readSnapshotSettlement(journals))
  assert.equal((await store.budget.preview()).entries.find(row => row.id === failed.id)?.eligible, false)
  assert.throws(() => store.trees(failed.id, failed.id), /retirement is unconfirmed/)
  const otherStorage = join(root, "concurrent-store"), concurrent = new WorkspaceSnapshots(git, otherStorage, policy)
  concurrent.followSettlement(() => ({ valid: true, settledIds: [], blockedScopes: [] }))
  try {
    const orphan = join(otherStorage, "retained-unknown"); await mkdir(orphan); await writeFile(join(orphan, "payload"), randomBytes(100 * 1024))
    await writeFile(join(otherStorage, "unknown-payload"), randomBytes(100 * 1024))
    await concurrent.budget.configure({ mode: "evict", maxBytes: 1024 ** 2 })
    assert.equal((await concurrent.budget.preview()).untrackedBytes, 200 * 1024, "untracked retained payload counts against the limit but is never selected")
    const attempts = await Promise.allSettled(residents.slice(1).map(async resident => {
      await writeFile(join(resident.cwd, "payload"), randomBytes(700 * 1024))
      return concurrent.capture(resident.cwd)
    }))
    assert.equal(attempts.filter(row => row.status === "fulfilled").length, 1, "two concurrent repositories cannot both spend the same global space")
    assert.equal(attempts.filter(row => row.status === "rejected").length, 1)
    assert.ok((await concurrent.budget.preview()).payloadBytes <= 1024 ** 2)
    assert.equal((await readFile(join(orphan, "payload"))).length, 100 * 1024)
  } finally { concurrent.close() }
  const headroomStorage = join(root, "headroom-store")
  const headroom = new WorkspaceSnapshots(git, headroomStorage, { ...policy, maxSnapshotBytes: 384 * 1024 })
  headroom.followSettlement(() => readSnapshotSettlement(journals))
  try {
    await headroom.budget.configure({ mode: "evict", maxBytes: 1024 ** 2 })
    const resident = residents[1]!, captured: WorkspaceSnapshot[] = []
    for (let index = 0; index < 4; index++) {
      if (index === 3) {
        const ordinary = headroom.budget.run(), reserved = headroom.budget.run(384 * 1024)
        assert.equal(ordinary, reserved, "a capture joins the same pass while increasing its reservation")
        await reserved
      }
      await writeFile(join(resident.cwd, "payload"), randomBytes(300 * 1024)); mock.timers.tick(1)
      const snapshot = await headroom.capture(resident.cwd); captured.push(snapshot)
      const previous = resident.snapshot
      resident.snapshot = { ...previous, revision: previous.revision + 1, requests: [...previous.requests, {
        id: randomUUID(), createdAt: Date.now(), status: "completed", text: "synthetic settled headroom turn", attachments: [],
        snapshots: { before: { kind: "ready", snapshot }, after: { kind: "ready", snapshot } },
      }] }
      resident.journal.commit(resident.snapshot, previous)
    }
    await assert.rejects(readFile(join(headroomStorage, captured[0]!.id, "capture-owner.json")), { code: "ENOENT" })
    assert.equal((await headroom.budget.preview()).entries.length, 3, "preflight reserves one bounded capture rather than rescanning at the ceiling or evicting everything")
    assert.ok((await headroom.budget.preview()).payloadBytes <= 1024 ** 2)
  } finally { headroom.close() }
  console.log("Global rewind budget: real Git checkpoints + settled/queued/cloud/unknown journals, cross-repository oldest-first preview, real comparison lease, exact locked retirement, falsey failure/reconstruction and global admission passed")
} finally {
  mock.restoreAll(); syncBuiltinESMExports(); mock.timers.reset()
  for (const row of residents) row.journal.close()
  db.close(); store.close(); git.close()
  await rm(root, { recursive: true, force: true })
}
