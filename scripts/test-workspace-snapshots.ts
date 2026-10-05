import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { importSnapshotObjects } from "../electron/workspace-snapshot-git.js"
import { WorkspaceSnapshots } from "../electron/workspace-snapshots.js"
import { TreeComparison } from "@mako/git"
import {
  RewindPlanSchema,
  type RewindPlan,
} from "../electron/contracts/workspace-snapshots.js"

if (process.argv[2] === "--crash-after-files") {
  const child = new WorkspaceSnapshots(process.argv[3])
  const input = RewindPlanSchema.parse(
    JSON.parse(readFileSync(process.argv[4], "utf8"))
  )
  await child.restore(input, () => process.exit(74))
  throw new Error("Crash checkpoint was not reached")
}

const root = mkdtempSync(join(tmpdir(), "mako-snapshots-test-"))
const cwd = join(root, "workspace")
mkdirSync(cwd)
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
git("init", "-q")
git("config", "user.email", "test@localhost")
git("config", "user.name", "Test")
const file = (path: string, content: string) =>
  writeFileSync(join(cwd, path), content)
const read = (path: string) => readFileSync(join(cwd, path), "utf8")
const store = new WorkspaceSnapshots(join(root, "store"))
function plan(targetId: string, expectedId: string): RewindPlan {
  return {
    sourceId: randomUUID(),
    targetId,
    expectedId,
    fork: {
      id: randomUUID(),
      provider: "test",
      point: { kind: "run", requestId: randomUUID() },
    },
  }
}
try {
  file("tracked", "committed\n")
  file(".gitignore", "ignored\n")
  git("add", ".")
  git("commit", "-qm", "initial")
  file("tracked", "staged\n")
  git("add", "tracked")
  file("tracked", "unstaged\n")
  file("untracked", "original untracked\n")
  file("ignored", "private\n")
  const indexBefore = readFileSync(join(cwd, ".git", "index"))
  const original = await store.capture(cwd)
  assert.deepEqual(
    readFileSync(join(cwd, ".git", "index")),
    indexBefore,
    "capture leaves user index byte-identical"
  )
  file("tracked", "agent changed\n")
  git("add", "tracked")
  rmSync(join(cwd, "untracked"))
  file("created", "agent new\n")
  // Only the private checkpoint index retains the earlier staged bytes now.
  // Git must still consider those objects reachable after the live index changes.
  git("gc", "--prune=now")
  const turnEnd = await store.capture(cwd)
  const turn = store.trees(original.id, turnEnd.id)
  assert.equal(turn.scope, original.scope)
  const compared = new TreeComparison({ root: turn.scope, from: turn.from, to: turn.to, stores: turn.stores })
  try {
    assert.deepEqual(await compared.files(), [
      { path: "created", change: "added", lines: { insertions: 1, deletions: 0 } },
      { path: "tracked", change: "modified", lines: { insertions: 1, deletions: 1 } },
      { path: "untracked", change: "deleted", lines: { insertions: 0, deletions: 1 } },
    ])
    assert.deepEqual(await compared.preview("tracked"), { kind: "files", before: "unstaged\n", after: "agent changed\n" })
  } finally {
    compared.close()
  }
  console.log("PASS: a turn's changes compare its two checkpoints through their private stores")
  const preview = await store.preview(original.id)
  assert.equal(preview.changedFileCount, 3)
  let completed = 0
  const rewind = plan(original.id, preview.current.id)
  await store.restore(rewind, () => {
    completed++
  })
  assert.equal(read("tracked"), "unstaged\n")
  assert.equal(git("show", ":tracked"), "staged")
  assert.equal(read("untracked"), "original untracked\n")
  assert.equal(read("ignored"), "private\n")
  assert.equal(existsSync(join(cwd, "created")), false)
  assert.equal(completed, 1)
  file("tracked", "later edit\n")
  await store.restore(rewind, () => {
    completed++
  })
  assert.equal(
    read("tracked"),
    "later edit\n",
    "completed replay does not restore again"
  )
  assert.equal(completed, 2)
  console.log(
    "PASS: staged/unstaged/untracked restoration, ignored files, capture index isolation, idempotent receipt"
  )

  const damaged = await store.capture(cwd)
  const damagedPreview = await store.preview(damaged.id)
  writeFileSync(join(root, "store", damaged.id, "index"), "damaged index")
  const currentIndex = readFileSync(join(cwd, ".git", "index"))
  await assert.rejects(
    store.restore(plan(damaged.id, damagedPreview.current.id), () => {
      assert.fail("A damaged checkpoint must never commit a conversation fork")
    }),
    /saved staging checkpoint is damaged/
  )
  assert.equal(read("tracked"), "later edit\n")
  assert.deepEqual(readFileSync(join(cwd, ".git", "index")), currentIndex)
  assert.deepEqual(store.pending(), [])
  console.log("PASS: damaged saved index rejects before files or fork change")

  const stale = await store.preview(original.id)
  file("tracked", "newer than preview\n")
  await assert.rejects(
    store.restore(plan(original.id, stale.current.id), () => {}),
    /changed after the preview/
  )
  assert.equal(read("tracked"), "newer than preview\n")
  const failurePreview = await store.preview(original.id)
  await assert.rejects(
    store.restore(plan(original.id, failurePreview.current.id), () => {
      throw new Error("journal failed")
    }),
    /journal failed/
  )
  assert.equal(
    read("tracked"),
    "newer than preview\n",
    "failed conversation commit restores safety backup"
  )
  assert.deepEqual(store.pending(), [])
  console.log(
    "PASS: stale preview rejects and conversation-commit failure compensates files"
  )

  const changedHead = await store.capture(cwd)
  git("checkout", "-qb", "another-branch")
  await assert.rejects(store.preview(changedHead.id), /branch or HEAD changed/)
  git("checkout", "-q", "-")
  writeFileSync(join(cwd, ".git", "index.lock"), "external git lock")
  await assert.rejects(store.capture(cwd), /workspace is busy/)
  assert.equal(read(".git/index.lock"), "external git lock")
  rmSync(join(cwd, ".git", "index.lock"))
  console.log(
    "PASS: changed branch and external Git lock reject before mutation"
  )

  symlinkSync("tracked", join(cwd, "link"))
  const linked = await store.capture(cwd)
  rmSync(join(cwd, "link"))
  const linkPreview = await store.preview(linked.id)
  await store.restore(plan(linked.id, linkPreview.current.id), () => {})
  assert.equal(read("link"), read("tracked"))
  console.log("PASS: symlink checkpoint round trip")

  file("tracked", "before crash\n")
  file("new-after-baseline", "before crash new file\n")
  const crashPreview = await store.preview(original.id)
  const crashPlan = plan(original.id, crashPreview.current.id)
  const crashInput = join(root, "crash-plan.json")
  writeFileSync(crashInput, JSON.stringify(crashPlan))
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      process.argv[1],
      "--crash-after-files",
      join(root, "store"),
      crashInput,
    ],
    { encoding: "utf8" }
  )
  assert.equal(result.status, 74, result.stderr)
  const recovered = new WorkspaceSnapshots(join(root, "store"))
  try {
    assert.equal(recovered.pending().length, 1)
    await assert.rejects(recovered.assertAvailable(cwd), /unfinished/)
    file("tracked", "external edit after crash\n")
    await assert.rejects(
      recovered.restore(crashPlan, () => {}),
      /File changed after rewind began/
    )
    assert.equal(read("tracked"), "external edit after crash\n")
    // Simulate interruption midway through the file set: this path is still at
    // the backup state while the other paths are already at the target state.
    file("tracked", "before crash\n")
    await recovered.restore(crashPlan, () => {
      completed++
    })
    assert.equal(read("tracked"), "unstaged\n")
    assert.equal(existsSync(join(cwd, "new-after-baseline")), false)
    assert.deepEqual(recovered.pending(), [])
    console.log(
      "PASS: process death, stale owned locks, partial restore recovery, and post-crash edits preserved"
    )
  } finally {
    recovered.close()
  }

  const activeId = randomUUID()
  await store.beginRun(activeId, cwd)
  await assert.rejects(store.preview(original.id), /every agent/)
  await store.endRun(activeId)
  const overlappingA = randomUUID(),
    overlappingB = randomUUID()
  await store.beginRun(overlappingA, cwd)
  await assert.rejects(store.beginRun(overlappingB, cwd), /Another agent/)
  await assert.rejects(store.endRun(overlappingA), /Another agent/)
  await assert.rejects(store.endRun(overlappingB), /Another agent/)
  console.log(
    "PASS: active writers block rewind and overlapping runs cannot claim coordinated checkpoints"
  )

  git("update-index", "--assume-unchanged", "tracked")
  await assert.rejects(store.capture(cwd), /assume-unchanged/)
  git("update-index", "--no-assume-unchanged", "tracked")
  console.log("PASS: index flags cannot silently omit changed files")
} finally {
  store.close()
  rmSync(root, { recursive: true, force: true })
}

const unbornRoot = mkdtempSync(join(tmpdir(), "mako-unborn-snapshots-"))
const unbornCwd = join(unbornRoot, "workspace")
mkdirSync(unbornCwd)
execFileSync("git", ["init", "-q"], { cwd: unbornCwd })
const unbornStore = new WorkspaceSnapshots(join(unbornRoot, "store"))
try {
  writeFileSync(join(unbornCwd, "draft"), "first paragraph")
  const first = await unbornStore.capture(unbornCwd)
  writeFileSync(join(unbornCwd, "draft"), "changed")
  execFileSync("git", ["add", "."], { cwd: unbornCwd })
  const preview = await unbornStore.preview(first.id)
  await unbornStore.restore(plan(first.id, preview.current.id), () => {})
  assert.equal(
    readFileSync(join(unbornCwd, "draft"), "utf8"),
    "first paragraph"
  )
  assert.equal(existsSync(join(unbornCwd, ".git", "index")), false)
  console.log("PASS: repository without HEAD or an index")
} finally {
  unbornStore.close()
  rmSync(unbornRoot, { recursive: true, force: true })
}

const legacyRoot = mkdtempSync(join(tmpdir(), "mako-legacy-snapshots-"))
const legacyCwd = join(legacyRoot, "workspace")
mkdirSync(legacyCwd)
const legacyGit = (...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@localhost", ...args],
    { cwd: legacyCwd, encoding: "utf8" }
  ).trim()
legacyGit("init", "-q")
const legacyStore = new WorkspaceSnapshots(join(legacyRoot, "store"))
try {
  const path = join(legacyCwd, "tracked")
  writeFileSync(path, "old staged content\n")
  legacyGit("add", ".")
  writeFileSync(path, "old working content\n")
  const saved = await legacyStore.capture(legacyCwd)
  await importSnapshotObjects(legacyCwd, join(legacyRoot, "store", saved.id))
  const metadata = new DatabaseSync(join(legacyRoot, "store/snapshots.sqlite"))
  metadata
    .prepare(
      "UPDATE snapshots SET value=json_remove(value, '$.storage') WHERE id=?"
    )
    .run(saved.id)
  metadata.close()
  // Reproduce the previous checkpoint format: only the working tree is rooted.
  const ref = `refs/mako/checkpoints/${saved.id}`
  const tree = legacyGit(
    `--git-dir=${join(legacyRoot, "store", saved.id, "git")}`,
    "rev-parse",
    `${ref}^{tree}`
  )
  const commit = legacyGit("commit-tree", tree, "-m", "Legacy checkpoint")
  legacyGit("update-ref", ref, commit)
  writeFileSync(path, "new content to preserve\n")
  legacyGit("add", ".")
  legacyGit("gc", "--prune=now")
  const before = readFileSync(join(legacyCwd, ".git", "index"))
  const current = await legacyStore.capture(legacyCwd)
  await assert.rejects(
    legacyStore.restore(plan(saved.id, current.id), () => assert.fail()),
    /saved staging checkpoint has missing Git objects/
  )
  assert.equal(readFileSync(path, "utf8"), "new content to preserve\n")
  assert.deepEqual(readFileSync(join(legacyCwd, ".git", "index")), before)
  assert.deepEqual(legacyStore.pending(), [])
  console.log(
    "PASS: legacy checkpoint with pruned staging objects refuses before mutation"
  )
} finally {
  legacyStore.close()
  rmSync(legacyRoot, { recursive: true, force: true })
}
