import "./lib/scratch-git.mjs"
import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { mock } from "node:test"
import { z } from "zod"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"
import {
  snapshotPayloadBytes,
  reclaimSnapshotOrphans,
} from "@mako/host/workspaces/snapshot-git"
import { SnapshotRecordSchema } from "@mako/host/workspaces/snapshot-retention"

const gitRunner = new Git()

if (process.argv[2] === "--crash-capture") {
  const prepare = DatabaseSync.prototype.prepare
  mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, sql: string) {
      if (sql.startsWith("INSERT INTO snapshots")) process.exit(74)
      return prepare.call(this, sql)
    }
  )
  await new WorkspaceSnapshots(gitRunner, process.argv[3]).capture(process.argv[4])
  throw new Error("The capture did not reach its crash boundary")
}

const root = mkdtempSync(join(tmpdir(), "mako-snapshot-budget-"))
const cwd = join(root, "workspace with spaces")
const storage = join(root, "store with spaces")
mkdirSync(cwd)
const git = (...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@localhost", ...args],
    { cwd, encoding: "utf8" }
  ).trim()
git("init", "-q")
writeFileSync(join(cwd, "file"), "initial")
git("add", ".")
git("commit", "-qm", "initial")
writeFileSync(join(cwd, "file"), "staged-only content")
git("add", ".")
const policy = { maxStorageBytes: 128 * 1024, maxSnapshotBytes: 96 * 1024 }
let store = new WorkspaceSnapshots(gitRunner, storage, policy)
const db = new DatabaseSync(join(storage, "snapshots.sqlite"))
mock.timers.enable({ apis: ["Date"], now: Date.now() })
try {
  const objectsBefore = git("count-objects", "-v")
  let latest
  for (let i = 0; i < 5; i++) {
    mock.timers.tick(1)
    writeFileSync(join(cwd, "file"), randomBytes(24 * 1024))
    latest = await store.capture(cwd)
  }
  assert.equal(
    git("count-objects", "-v"),
    objectsBefore,
    "captures must not grow the user's Git object database"
  )
  assert.equal(git("for-each-ref", "refs/mako/checkpoints"), "")
  let bytes = 0
  const kept = db.prepare("SELECT id FROM snapshots").all()
  for (const row of kept) {
    const id = z.string().uuid().parse(row.id)
    const payload = await snapshotPayloadBytes(join(storage, id))
    // 24 KiB of new content, its pack's index, the staging index and a ref. Counted in the file system's
    // blocks instead, ext4's 4 KiB a folder made it 98 KB, APFS's 59 KB.
    assert.ok(
      payload < 28 * 1024,
      `A checkpoint of 24 KiB of new content counts ${payload} bytes`
    )
    bytes += payload
  }
  assert.ok(
    bytes <= policy.maxStorageBytes,
    `Retained snapshot payloads use ${bytes} bytes`
  )
  assert.ok(
    kept.length >= 4,
    `A 128 KiB budget keeps ${kept.length} checkpoints of 24 KiB, not four`
  )
  assert.ok(latest)
  const expected = readFileSync(join(cwd, "file"))
  writeFileSync(join(cwd, "file"), "new staging")
  git("add", ".")
  git("gc", "--prune=now")
  const preview = await store.preview(latest.id)
  const protectedBytes =
    (await snapshotPayloadBytes(join(storage, latest.id))) +
    (await snapshotPayloadBytes(join(storage, preview.current.id)))
  const rewind = {
    sourceId: randomUUID(),
    targetId: latest.id,
    expectedId: preview.current.id,
    fork: {
      id: randomUUID(),
      provider: "test",
      point: { kind: "run", requestId: randomUUID() },
    },
  } satisfies Parameters<WorkspaceSnapshots["restore"]>[0]
  const limited = new WorkspaceSnapshots(gitRunner, storage, {
    ...policy,
    maxStorageBytes: protectedBytes,
  })
  try {
    await assert.rejects(limited.capture(cwd), /Checkpoint storage is full/)
    assert.ok(db.prepare("SELECT id FROM snapshots WHERE id=?").get(latest.id))
    assert.ok(
      db.prepare("SELECT id FROM snapshots WHERE id=?").get(preview.current.id)
    )
    assert.equal(readFileSync(join(cwd, "file"), "utf8"), "new staging")
    await assert.rejects(
      limited.restore(rewind, () => {
        throw new Error("fixture commit failure")
      }),
      /fixture commit failure/
    )
    assert.equal(
      readFileSync(join(cwd, "file"), "utf8"),
      "new staging",
      "quota-full compensation must restore the existing safety backup"
    )
    assert.deepEqual(limited.pending(), [])
    await limited.restore(rewind, () => {})
  } finally {
    limited.close()
  }
  await store.restore(rewind, () => {})
  assert.deepEqual(readFileSync(join(cwd, "file")), expected)
  assert.equal(git("show", ":file"), "staged-only content")
  mock.timers.tick(31 * 24 * 60 * 60 * 1000)
  await store.prune(cwd)
  assert.equal(
    git("show", ":file"),
    "staged-only content",
    "the restored index must not depend on an expired private store"
  )
  const stable = readFileSync(join(cwd, "file"))
  const beforeLimit = git("count-objects", "-v")
  writeFileSync(join(cwd, "file"), randomBytes(128 * 1024))
  const oversized = readFileSync(join(cwd, "file"))
  await assert.rejects(store.capture(cwd), /storage limit/)
  assert.deepEqual(readFileSync(join(cwd, "file")), oversized)
  assert.equal(git("count-objects", "-v"), beforeLimit)
  writeFileSync(join(cwd, "file"), stable)
  store.close()
  const crash = spawnSync(
    process.execPath,
    ["--import", "tsx", process.argv[1], "--crash-capture", storage, cwd],
    { encoding: "utf8" }
  )
  store = new WorkspaceSnapshots(gitRunner, storage, policy)
  assert.equal(crash.status, 74, crash.stderr)
  const orphans = readdirSync(storage).filter(
    (id) => z.string().uuid().safeParse(id).success
  )
  assert.equal(orphans.length, 1)
  const recovered = await store.capture(cwd)
  assert.ok(
    orphans.every((id) => !existsSync(join(storage, id))),
    "abandoned capture payloads must be reclaimed on reopen"
  )
  writeFileSync(
    join(storage, recovered.id, "capture-owner.json"),
    JSON.stringify({
      owner: "mako-checkpoint",
      scope: recovered.scope,
      pid: 2147483647,
      state: "committed",
    })
  )
  const activeOrphan = join(storage, randomUUID())
  mkdirSync(activeOrphan)
  writeFileSync(
    join(activeOrphan, "capture-owner.json"),
    JSON.stringify({
      owner: "mako-checkpoint",
      scope: recovered.scope,
      pid: process.pid,
      state: "preparing",
    })
  )
  const retainedBytes = await reclaimSnapshotOrphans(
    storage,
    recovered.scope,
    new Set()
  )
  assert.equal(
    retainedBytes,
    (await snapshotPayloadBytes(join(storage, recovered.id))) +
      (await snapshotPayloadBytes(activeOrphan))
  )
  assert.ok(
    existsSync(join(storage, recovered.id)),
    "a missing catalog row does not authorize deleting a completed checkpoint"
  )
  assert.ok(existsSync(activeOrphan), "a live capture is never reclaimed")

  // A cleanup pass removes at most 64 checkpoints. One whose room takes more passes still gets it,
  // rather than "storage is full" beside checkpoints that could have gone.
  const crowdedRoot = join(root, "crowded store")
  const crowded = new WorkspaceSnapshots(gitRunner, crowdedRoot, policy)
  const crowdedDb = new DatabaseSync(join(crowdedRoot, "snapshots.sqlite"))
  try {
    const seed = await crowded.capture(cwd)
    const template = SnapshotRecordSchema.parse(
      JSON.parse(
        z
          .object({ value: z.string() })
          .parse(
            crowdedDb
              .prepare("SELECT value FROM snapshots WHERE id=?")
              .get(seed.id)
          ).value
      )
    )
    crowdedDb.prepare("DELETE FROM snapshots").run()
    rmSync(join(crowdedRoot, seed.id), { recursive: true })
    // 500 checkpoints of 256 bytes fill all but 3 KiB of the budget; the next one's 24 KiB needs about 100 gone.
    for (let i = 0; i < 500; i++) {
      const record = {
        ...template,
        id: randomUUID(),
        createdAt: template.createdAt - 500 + i,
        storage: { kind: "private" as const, bytes: 256 },
      }
      crowdedDb
        .prepare("INSERT INTO snapshots VALUES (?, ?)")
        .run(record.id, JSON.stringify(record))
    }
    mock.timers.tick(1)
    writeFileSync(join(cwd, "file"), randomBytes(24 * 1024))
    const roomy = await crowded.capture(cwd)
    const left = crowdedDb
      .prepare("SELECT json_extract(value, '$.storage.bytes') AS bytes FROM snapshots")
      .all()
      .reduce((sum, row) => sum + z.number().parse(row.bytes), 0)
    assert.ok(left <= policy.maxStorageBytes, `Retained ${left} bytes`)
    assert.ok(
      crowdedDb.prepare("SELECT id FROM snapshots WHERE id=?").get(roomy.id)
    )
  } finally {
    crowdedDb.close()
    crowded.close()
  }
  console.log(
    "PASS: a checkpoint whose room takes several cleanup passes gets it"
  )
  console.log(
    "PASS: private packs obey a measured byte budget, survive Git GC, retain staged content, reclaim capture crashes, and preserve protected or uncatalogued recovery data"
  )
} finally {
  mock.timers.reset()
  store.close()
  db.close()
  rmSync(root, { recursive: true, force: true })
}
