import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { mock } from "node:test"
import {
  RewindPlanSchema,
  type RewindPlan,
} from "../electron/contracts/workspace-snapshots.js"
import { WorkspaceSnapshots } from "../electron/workspace-snapshots.js"
import {
  pruneSnapshotRecords,
  SnapshotRetentionPolicySchema,
  type SnapshotRecord,
} from "../electron/workspace-snapshot-retention.js"
import { importSnapshotObjects } from "../electron/workspace-snapshot-git.js"

if (process.argv[2] === "--crash-after-files") {
  const store = new WorkspaceSnapshots(process.argv[3])
  await store.restore(
    RewindPlanSchema.parse(JSON.parse(readFileSync(process.argv[4], "utf8"))),
    () => process.exit(74)
  )
  throw new Error("Restore did not reach its crash boundary")
}

const root = mkdtempSync(join(tmpdir(), "mako-retention-"))
const cwd = join(root, "workspace")
const storage = join(root, "snapshots")
mkdirSync(cwd)
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@localhost",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@localhost",
    },
  }).trim()
git("init", "-q")
writeFileSync(join(cwd, "answer"), "committed\n")
git("add", ".")
git("commit", "-qm", "initial")
const head = git("rev-parse", "HEAD")
const index = readFileSync(join(cwd, ".git/index"))
const policy = SnapshotRetentionPolicySchema.parse({
  maxSnapshots: 3,
  maxAgeMs: 60_000,
  previewTtlMs: 30_000,
})
let store = new WorkspaceSnapshots(storage, policy)
const db = new DatabaseSync(join(storage, "snapshots.sqlite"))
const ref = (id: string) => `refs/mako/checkpoints/${id}`
const refs = (directory = storage) => [
  ...new Set([
    ...git("for-each-ref", "--format=%(refname)", "refs/mako/checkpoints")
      .split("\n")
      .filter(Boolean),
    ...readdirSync(directory).flatMap((id) =>
      existsSync(join(directory, id, "git"))
        ? git(
            `--git-dir=${join(directory, id, "git")}`,
            "for-each-ref",
            "--format=%(refname)",
            "refs/mako/checkpoints"
          )
            .split("\n")
            .filter(Boolean)
        : []
    ),
  ]),
]
async function migrateLegacy(id: string) {
  await importSnapshotObjects(cwd, join(storage, id))
  const commit = git(
    `--git-dir=${join(storage, id, "git")}`,
    "rev-parse",
    ref(id)
  )
  git("update-ref", ref(id), commit)
  db.prepare(
    "UPDATE snapshots SET value=json_remove(value, '$.storage') WHERE id=?"
  ).run(id)
}
const retained = (id: string) =>
  Boolean(db.prepare("SELECT id FROM snapshots WHERE id=?").get(id))
const plan = (targetId: string, expectedId: string): RewindPlan => ({
  sourceId: randomUUID(),
  targetId,
  expectedId,
  fork: {
    id: randomUUID(),
    provider: "test",
    point: { kind: "run", requestId: randomUUID() },
  },
})
mock.timers.enable({ apis: ["Date"], now: Date.now() })
try {
  const oldest = await store.capture(cwd)
  for (let i = 0; i < 4; i++) {
    mock.timers.tick(1)
    await store.capture(cwd)
  }
  assert.equal(
    refs().length,
    3,
    "automatic capture retention caps checkpoint refs"
  )
  assert.equal(retained(oldest.id), false)
  assert.equal(existsSync(join(storage, oldest.id)), false)
  assert.equal(git("rev-parse", "HEAD"), head)
  assert.deepEqual(readFileSync(join(cwd, ".git/index")), index)
  assert.equal(readFileSync(join(cwd, "answer"), "utf8"), "committed\n")
  console.log(
    "PASS: automatic count retention leaves HEAD, workspace and staging unchanged"
  )

  const activeId = randomUUID()
  const before = await store.beginRun(activeId, cwd)
  mock.timers.tick(120_000)
  await store.capture(cwd)
  assert.equal(
    retained(before.id),
    true,
    "an active turn retains its before checkpoint beyond the age limit"
  )
  await store.endRun(activeId)
  await store.prune(cwd)
  assert.equal(retained(before.id), false)
  console.log(
    "PASS: active checkpoints stay protected until their turn settles"
  )

  const target = await store.capture(cwd)
  writeFileSync(join(cwd, "answer"), "preview state\n")
  const preview = await store.preview(target.id)
  store.close()
  store = new WorkspaceSnapshots(storage, policy)
  for (let i = 0; i < 5; i++) {
    mock.timers.tick(1)
    await store.capture(cwd)
  }
  assert.equal(retained(target.id), true)
  assert.equal(retained(preview.current.id), true)
  const rewind = plan(target.id, preview.current.id)
  await store.restore(rewind, () => {})
  mock.timers.tick(120_000)
  await store.prune(cwd)
  assert.equal(retained(target.id), false)
  writeFileSync(join(cwd, "answer"), "newer paragraph\n")
  let completions = 0
  await store.restore(rewind, () => {
    completions++
  })
  assert.equal(completions, 1)
  assert.equal(readFileSync(join(cwd, "answer"), "utf8"), "newer paragraph\n")
  console.log(
    "PASS: previews survive reopen and completed rewind retries survive target expiration"
  )

  const crashTarget = await store.capture(cwd)
  writeFileSync(join(cwd, "answer"), "before interrupted restore\n")
  const crashPreview = await store.preview(crashTarget.id)
  const crashPlan = plan(crashTarget.id, crashPreview.current.id)
  const input = join(root, "restore.json")
  writeFileSync(input, JSON.stringify(crashPlan))
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", process.argv[1], "--crash-after-files", storage, input],
    { encoding: "utf8" }
  )
  assert.equal(child.status, 74, child.stderr)
  mock.timers.tick(120_000)
  await store.prune(cwd)
  assert.equal(retained(crashTarget.id), true)
  assert.equal(retained(crashPreview.current.id), true)
  assert.equal(store.pending().length, 1)
  await store.restore(crashPlan, () => {})
  await store.prune(cwd)
  assert.deepEqual(store.pending(), [])
  console.log(
    "PASS: a real interrupted restore protects target, preview and safety backup beyond retention limits"
  )

  const foreign = new WorkspaceSnapshots(join(root, "other-profile"), policy)
  try {
    const foreignSnapshot = await foreign.capture(cwd)
    mock.timers.tick(120_000)
    await store.prune(cwd)
    assert.ok(
      refs(join(root, "other-profile")).includes(ref(foreignSnapshot.id))
    )
    await foreign.preview(foreignSnapshot.id)
  } finally {
    foreign.close()
  }
  const replaced = await store.capture(cwd)
  await migrateLegacy(replaced.id)
  git("update-ref", ref(replaced.id), head)
  mock.timers.tick(120_000)
  await assert.rejects(store.prune(cwd), /checkpoint ref changed/i)
  assert.equal(git("rev-parse", ref(replaced.id)), head)
  assert.equal(retained(replaced.id), true)
  git("update-ref", "-d", ref(replaced.id), head)
  await store.prune(cwd)
  assert.equal(retained(replaced.id), false)
  console.log(
    "PASS: other profiles and externally replaced refs are never deleted"
  )

  const symbolic = await store.capture(cwd)
  await migrateLegacy(symbolic.id)
  const symbolicCommit = git("rev-parse", ref(symbolic.id))
  const alias = "refs/heads/retention-safety-fixture"
  git("update-ref", alias, symbolicCommit)
  git("symbolic-ref", ref(symbolic.id), alias)
  mock.timers.tick(120_000)
  await assert.rejects(store.prune(cwd), /checkpoint ref changed/i)
  assert.equal(git("rev-parse", alias), symbolicCommit)
  assert.equal(retained(symbolic.id), true)
  git("update-ref", "--no-deref", "-d", ref(symbolic.id))
  await store.prune(cwd)
  assert.equal(git("rev-parse", alias), symbolicCommit)

  const legacy = await store.capture(cwd)
  await migrateLegacy(legacy.id)
  db.prepare(
    "UPDATE snapshots SET value=json_remove(value, '$.commit') WHERE id=?"
  ).run(legacy.id)
  mock.timers.tick(120_000)
  await store.prune(cwd)
  assert.equal(retained(legacy.id), false)
  assert.equal(refs().includes(ref(legacy.id)), false)
  console.log(
    "PASS: symbolic refs are refused and legacy checkpoints are verified before cleanup"
  )

  const retry = await store.capture(cwd)
  db.exec(
    "CREATE TRIGGER fail_retention BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT, 'injected cleanup interruption'); END"
  )
  mock.timers.tick(120_000)
  await assert.rejects(store.prune(cwd), /injected cleanup interruption/)
  assert.equal(retained(retry.id), true)
  assert.equal(refs().includes(ref(retry.id)), false)
  db.exec("DROP TRIGGER fail_retention")
  store.close()
  store = new WorkspaceSnapshots(storage, policy)
  await store.prune(cwd)
  assert.equal(retained(retry.id), false)
  await store.prune(cwd)
  console.log(
    "PASS: partial cleanup converges after reopen and repeated cleanup is idempotent"
  )

  const backlog = new DatabaseSync(":memory:")
  try {
    backlog.exec(
      "CREATE TABLE snapshots (id TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
    for (let i = 0; i < 75; i++) {
      const record: SnapshotRecord = {
        id: randomUUID(),
        scope: cwd,
        gitDir: join(cwd, ".git"),
        createdAt: 0,
        files: 0,
        head,
        tree: head,
        indexDigest: "absent",
      }
      backlog
        .prepare("INSERT INTO snapshots VALUES (?, ?)")
        .run(record.id, JSON.stringify(record))
    }
    const options = {
      db: backlog,
      root: join(root, "backlog"),
      scope: cwd,
      gitDir: join(cwd, ".git"),
      protectedIds: new Set<string>(),
      policy,
      removeRefs: async () => {},
    }
    assert.equal(await pruneSnapshotRecords(options), 64)
    assert.equal(await pruneSnapshotRecords(options), 11)
    assert.equal(await pruneSnapshotRecords(options), 0)
  } finally {
    backlog.close()
  }
  console.log("PASS: large cleanup backlogs are bounded to 64 records per pass")
} finally {
  mock.timers.reset()
  store.close()
  db.close()
  rmSync(root, { recursive: true, force: true })
}
