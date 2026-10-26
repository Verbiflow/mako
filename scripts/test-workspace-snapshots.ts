import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  mkdtempSync,
  realpathSync,
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
import { importSnapshotObjects } from "@mako/host/workspaces/snapshot-git"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"
import { Git, TreeComparison } from "@mako/git"
import {
  RewindPlanSchema,
  type RewindPlan,
} from "@mako/host/contracts/workspace-snapshots"

const gitRunner = new Git()

if (process.argv[2] === "--crash-after-files") {
  const child = new WorkspaceSnapshots(gitRunner, process.argv[3])
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
const store = new WorkspaceSnapshots(gitRunner, join(root, "store"))
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
  assert.ok("from" in turn, "one repository's checkpoints compare as one pair of trees")
  const compared = new TreeComparison(gitRunner, { root: turn.scope, from: turn.from, to: turn.to, stores: turn.stores })
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

  const ending = store.capture(cwd)
  await store.assertAvailable(cwd)
  const [ended, begun] = await Promise.all([ending, store.capture(cwd)])
  assert.notEqual(ended.id, begun.id)
  console.log(
    "PASS: a turn starts while another conversation's checkpoint of the workspace is still being written, and its checkpoint waits for that one"
  )

  const repository = await gitRunner.openRepository(cwd)
  assert.ok(repository)
  for (let iteration = 0; iteration < 6; iteration++) {
    file("tracked", `concurrent checkpoint ${iteration}\n`)
    const captures = await Promise.all([
      store.capture(cwd),
      repository.stage(["tracked"]),
      store.capture(cwd),
      repository.unstage(["tracked"]),
      store.capture(cwd),
    ])
    assert.notEqual(captures[0].id, captures[2].id)
    assert.equal(git("show", ":tracked"), "committed")
    for (const name of ["index.lock", "mako-snapshots.lock", "mako-index-write.lock"])
      assert.equal(existsSync(join(cwd, ".git", name)), false)
  }
  console.log("PASS: checkpoints, staging and unstaging share one queue without lock failures or lost index writes")

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
  const recovered = new WorkspaceSnapshots(gitRunner, join(root, "store"))
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
  const beforeA = await store.beginRun(overlappingA, cwd)
  const beforeB = await store.beginRun(overlappingB, cwd)
  assert.equal(beforeA.shared, undefined, "nothing else ran when the first turn began")
  assert.deepEqual(beforeB.shared, [overlappingA], "the second turn's checkpoint names the turn already running")
  file("tracked", "written while two turns ran\n")
  await assert.rejects(store.preview(beforeA.id), /every agent/, "a rewind still waits for both turns")
  const afterA = await store.endRun(overlappingA)
  assert.deepEqual(afterA.shared, [overlappingB], "the first turn's closing checkpoint names the turn that joined it")
  await assert.rejects(store.preview(afterA.id), /every agent/, "one turn still runs there")
  const afterB = await store.endRun(overlappingB)
  assert.deepEqual(afterB.shared, [overlappingA])
  const sharedPreview = await store.preview(beforeA.id)
  assert.deepEqual(sharedPreview.target.shared, undefined)
  assert.ok(sharedPreview.changedFiles.includes("tracked"))
  const sharedTurn = store.compare(store.trees(beforeB.id, afterB.id))
  try {
    assert.deepEqual((await sharedTurn.files()).map((changed) => changed.path), ["tracked"])
  } finally {
    sharedTurn.close()
  }
  const finishing = randomUUID(),
    following = randomUUID()
  await store.beginRun(finishing, cwd)
  const closing = store.endRun(finishing)
  await store.beginRun(following, cwd)
  await closing
  await store.endRun(following)
  console.log(
    "PASS: turns sharing a workspace both get checkpoints that name each other, a rewind waits until neither runs, and a turn that begins while another's closing checkpoint is written overlaps nothing"
  )

  // A file Git was told not to look at (skip-worktree for a local config, assume-unchanged) is still captured and rewound, and keeps its flag.
  file("local.json", '{"port":1}\n')
  git("add", "local.json")
  git("commit", "-qm", "local config")
  git("update-index", "--skip-worktree", "local.json")
  git("update-index", "--assume-unchanged", "tracked")
  file("local.json", '{"port":2}\n')
  file("tracked", "assumed unchanged but edited\n")
  const flaggedBefore = await store.capture(cwd)
  file("local.json", '{"port":3}\n')
  file("tracked", "edited again\n")
  const flaggedAfter = await store.capture(cwd)
  const flaggedTurn = store.compare(store.trees(flaggedBefore.id, flaggedAfter.id))
  try {
    assert.deepEqual((await flaggedTurn.files()).map((changed) => changed.path), ["local.json", "tracked"], "a flagged file's edit is in the turn")
  } finally {
    flaggedTurn.close()
  }
  const flaggedPreview = await store.preview(flaggedBefore.id)
  await store.restore(plan(flaggedBefore.id, flaggedPreview.current.id), () => {})
  assert.equal(read("local.json"), '{"port":2}\n')
  assert.equal(read("tracked"), "assumed unchanged but edited\n")
  assert.match(git("ls-files", "-v", "local.json", "tracked"), /^S local\.json\nh tracked$/, "the flags are the person's as before")
  git("update-index", "--no-assume-unchanged", "tracked")
  git("update-index", "--no-skip-worktree", "local.json")
  console.log("PASS: skip-worktree and assume-unchanged files are captured and rewound, and keep their flags")

  // A repository inside this one that it doesn't track is its own: left out, not refused.
  mkdirSync(join(cwd, "vendor-repo"))
  execFileSync("git", ["init", "-q"], { cwd: join(cwd, "vendor-repo") })
  writeFileSync(join(cwd, "vendor-repo", "lib.js"), "module.exports = 1\n")
  const withEmbedded = await store.capture(cwd)
  assert.ok(withEmbedded.files > 0)
  rmSync(join(cwd, "vendor-repo"), { recursive: true, force: true })
  console.log("PASS: an untracked repository inside the workspace is left out of its checkpoint")
} finally {
  store.close()
  rmSync(root, { recursive: true, force: true })
}

const unbornRoot = mkdtempSync(join(tmpdir(), "mako-unborn-snapshots-"))
const unbornCwd = join(unbornRoot, "workspace")
mkdirSync(unbornCwd)
execFileSync("git", ["init", "-q"], { cwd: unbornCwd })
const unbornStore = new WorkspaceSnapshots(gitRunner, join(unbornRoot, "store"))
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
const legacyStore = new WorkspaceSnapshots(gitRunner, join(legacyRoot, "store"))
try {
  const path = join(legacyCwd, "tracked")
  writeFileSync(path, "old staged content\n")
  legacyGit("add", ".")
  writeFileSync(path, "old working content\n")
  const saved = await legacyStore.capture(legacyCwd)
  await importSnapshotObjects(gitRunner, legacyCwd, join(legacyRoot, "store", saved.id))
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

// A sparse checkout: what's outside the cone stays off disk through a capture and a rewind.
const sparseRoot = mkdtempSync(join(tmpdir(), "mako-sparse-snapshots-"))
const sparseCwd = join(sparseRoot, "workspace")
mkdirSync(sparseCwd)
const sparseGit = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { cwd: sparseCwd, encoding: "utf8" }).trim()
const sparseStore = new WorkspaceSnapshots(gitRunner, join(sparseRoot, "store"))
try {
  sparseGit("init", "-q")
  for (const folder of ["app", "docs"]) {
    mkdirSync(join(sparseCwd, folder))
    writeFileSync(join(sparseCwd, folder, "index.md"), `${folder}\n`)
  }
  sparseGit("add", ".")
  sparseGit("commit", "-qm", "two folders")
  sparseGit("sparse-checkout", "set", "--cone", "app")
  assert.equal(existsSync(join(sparseCwd, "docs")), false)
  const sparseBefore = await sparseStore.capture(sparseCwd)
  writeFileSync(join(sparseCwd, "app", "index.md"), "app changed\n")
  writeFileSync(join(sparseCwd, "app", "new.md"), "new\n")
  const sparseAfter = await sparseStore.capture(sparseCwd)
  const sparseTurn = sparseStore.compare(sparseStore.trees(sparseBefore.id, sparseAfter.id))
  try {
    assert.deepEqual((await sparseTurn.files()).map((changed) => changed.path), ["app/index.md", "app/new.md"])
  } finally {
    sparseTurn.close()
  }
  const sparsePreview = await sparseStore.preview(sparseBefore.id)
  await sparseStore.restore(plan(sparseBefore.id, sparsePreview.current.id), () => {})
  assert.equal(readFileSync(join(sparseCwd, "app", "index.md"), "utf8"), "app\n")
  assert.equal(existsSync(join(sparseCwd, "app", "new.md")), false)
  assert.equal(existsSync(join(sparseCwd, "docs")), false, "the rewind writes nothing outside the cone")
  assert.match(sparseGit("ls-files", "-v", "docs/index.md"), /^S /, "what's outside the cone stays skipped")
  console.log("PASS: a sparse checkout is captured and rewound inside its cone")
} finally {
  sparseStore.close()
  rmSync(sparseRoot, { recursive: true, force: true })
}

// Past the old 20,000-file limit: Git reads again only what changed.
const largeRoot = mkdtempSync(join(tmpdir(), "mako-large-snapshots-"))
const largeCwd = join(largeRoot, "workspace")
mkdirSync(largeCwd)
const largeStore = new WorkspaceSnapshots(gitRunner, join(largeRoot, "store"))
try {
  for (let folder = 0; folder < 25; folder++) {
    mkdirSync(join(largeCwd, `f${folder}`))
    for (let index = 0; index < 1_000; index++) writeFileSync(join(largeCwd, `f${folder}`, `${index}.txt`), `${folder}/${index}\n`)
  }
  execFileSync("git", ["init", "-q"], { cwd: largeCwd })
  execFileSync("git", ["add", "."], { cwd: largeCwd })
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "many"], { cwd: largeCwd })
  const largeBefore = await largeStore.capture(largeCwd)
  assert.equal(largeBefore.files, 25_000)
  writeFileSync(join(largeCwd, "f3", "7.txt"), "changed\n")
  const largeAfter = await largeStore.capture(largeCwd)
  const largeTurn = largeStore.compare(largeStore.trees(largeBefore.id, largeAfter.id))
  try {
    assert.deepEqual((await largeTurn.files()).map((changed) => changed.path), ["f3/7.txt"])
  } finally {
    largeTurn.close()
  }
  const packed = Number(execFileSync("du", ["-sk", join(largeRoot, "store", largeAfter.id, "git", "objects")], { encoding: "utf8" }).split("\t")[0])
  assert.ok(packed < 100, `a checkpoint's objects are what the turn changed, not the commit's: ${packed} KB`)
  console.log("PASS: 25,000 files are captured, and a checkpoint keeps only what changed")
} finally {
  largeStore.close()
  rmSync(largeRoot, { recursive: true, force: true, maxRetries: 3 })
}

// A project folder of two repositories, one with a submodule: a checkpoint of each, compared and rewound as one.
const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "mako-project-snapshots-")))
const project = join(projectRoot, "project")
const projectStore = new WorkspaceSnapshots(gitRunner, join(projectRoot, "store"))
try {
  const repo = (folder: string, files: Record<string, string>) => {
    mkdirSync(folder, { recursive: true })
    for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text)
    const run = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "protocol.file.allow=always", ...args], { cwd: folder, encoding: "utf8" })
    run("init", "-q")
    run("add", ".")
    run("commit", "-qm", "first")
    return run
  }
  const library = join(projectRoot, "library")
  repo(library, { "lib.ts": "export const lib = 1\n" })
  repo(join(project, "api"), { "server.ts": "export const port = 1\n" })
  const web = repo(join(project, "web"), { "page.tsx": "export const title = 'old'\n" })
  web("submodule", "add", "-q", library, "vendor/library")
  web("commit", "-qm", "library")
  const runId = randomUUID()
  const before = await projectStore.beginRun(runId, project)
  assert.equal(before.scope, project)
  writeFileSync(join(project, "api", "server.ts"), "export const port = 2\n")
  writeFileSync(join(project, "web", "page.tsx"), "export const title = 'new'\n")
  writeFileSync(join(project, "web", "vendor", "library", "lib.ts"), "export const lib = 2\n")
  const after = await projectStore.endRun(runId)
  const turn = projectStore.compare(projectStore.trees(before.id, after.id))
  try {
    assert.deepEqual((await turn.files()).map((changed) => changed.path), ["api/server.ts", "web/page.tsx", "web/vendor/library/lib.ts"])
    assert.deepEqual(await turn.preview("web/vendor/library/lib.ts"), { kind: "files", before: "export const lib = 1\n", after: "export const lib = 2\n" })
  } finally {
    turn.close()
  }
  const preview = await projectStore.preview(before.id)
  assert.equal(preview.changedFileCount, 3)
  let forks = 0
  const rewind = plan(before.id, preview.current.id)
  await projectStore.restore(rewind, () => forks++)
  assert.equal(readFileSync(join(project, "api", "server.ts"), "utf8"), "export const port = 1\n")
  assert.equal(readFileSync(join(project, "web", "page.tsx"), "utf8"), "export const title = 'old'\n")
  assert.equal(readFileSync(join(project, "web", "vendor", "library", "lib.ts"), "utf8"), "export const lib = 1\n")
  assert.equal(forks, 1, "the fork is made once, after every repository is restored")
  assert.deepEqual(projectStore.pending(), [])

  // One repository changes after the preview: nothing is rewound and no fork is made.
  writeFileSync(join(project, "api", "server.ts"), "export const port = 3\n")
  const stalePreview = await projectStore.preview(before.id)
  writeFileSync(join(project, "web", "page.tsx"), "export const title = 'newer'\n")
  await assert.rejects(projectStore.restore(plan(before.id, stalePreview.current.id), () => forks++), /changed after the preview/)
  assert.equal(readFileSync(join(project, "api", "server.ts"), "utf8"), "export const port = 3\n", "the repository restored first is put back")
  assert.equal(forks, 1)
  console.log("PASS: a project folder and a submodule are captured, compared and rewound per repository, all or nothing")
} finally {
  projectStore.close()
  rmSync(projectRoot, { recursive: true, force: true })
}

const loose = mkdtempSync(join(tmpdir(), "mako-no-git-snapshots-"))
const looseStore = new WorkspaceSnapshots(gitRunner, join(loose, "store"))
try {
  mkdirSync(join(loose, "notes"))
  writeFileSync(join(loose, "notes", "a.md"), "a\n")
  await assert.rejects(looseStore.capture(join(loose, "notes")), /Rewind needs Git/)
  console.log("PASS: a folder with no repository says why it has no checkpoint")
} finally {
  looseStore.close()
  rmSync(loose, { recursive: true, force: true })
}
