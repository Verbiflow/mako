import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Git } from "@mako/git"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"
import { SnapshotRecordSchema } from "@mako/host/workspaces/snapshot-retention"
import { snapshotPayloadBytes } from "@mako/host/workspaces/snapshot-git"
import { mock } from "node:test"
import { z } from "zod"
import { Readable } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"

if (process.argv[2] === "--crash-import") {
  const git = new Git(), original = git.run.bind(git)
  mock.method(git, "run", async (options: Parameters<Git["run"]>[0]) => {
    const result = await original(options)
    if (options.args.includes("index-pack")) process.exit(74)
    return result
  })
  await new WorkspaceSnapshots(git, process.argv[4], {}, { objectStorage: "shared" }).capture(process.argv[3])
  throw new Error("The capture did not reach its crash boundary")
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-shared-checkpoints-")))
const cwd = join(root, "workspace")
const storage = join(root, "checkpoints")
mkdirSync(cwd)
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { cwd, encoding: "utf8" }).trim()
git("init", "-q", "-b", "main")
writeFileSync(join(cwd, "file"), "initial\n")
git("add", ".")
git("commit", "-qm", "initial")
writeFileSync(join(cwd, ".gitignore"), "ignored\n")
git("add", ".gitignore")
git("commit", "-qm", "ignore")
git("gc", "--quiet") // Cold ownership must import from user packs as well as loose staged objects.
writeFileSync(join(cwd, "file"), "staged-only\n")
git("add", "file")
const staged = git("rev-parse", ":file")
writeFileSync(join(cwd, "file"), "working-only\n")
writeFileSync(join(cwd, "secret"), "checkpoint-only secret\n")
writeFileSync(join(cwd, "ignored"), "ignored file\n")
const runner = new Git()
const runCapture = runner.run.bind(runner)
const captureInputs = mock.method(runner, "run", async (options: Parameters<Git["run"]>[0]) => {
  if (options.args.includes("index-pack")) {
    if (options.input instanceof Readable) options.input.destroy()
    assert.equal(options.input, undefined, "capture imports a prepared pack file, never a host-buffered stdin stream")
    assert(!options.args.includes("--stdin"))
    assert(options.args.at(-1)?.endsWith(".pack"))
  }
  return runCapture(options)
})
let store = new WorkspaceSnapshots(runner, storage, {}, { objectStorage: "shared" })
const db = new DatabaseSync(join(storage, "snapshots.sqlite"))
const recordOf = (id: string) => {
  const { value } = z.object({ value: z.string() }).parse(db.prepare("SELECT value FROM snapshots WHERE id=?").get(id))
  return SnapshotRecordSchema.parse(JSON.parse(value))
}
const inRepo = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
const has = (repo: string, oid: string) => spawnSync("git", ["-C", repo, "cat-file", "-e", oid], { stdio: "ignore" }).status === 0
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }
const promptly = async (promise: Promise<void>) => {
  const timeout = new AbortController()
  try { await Promise.race([promise, delay(5000, undefined, { signal: timeout.signal }).then(() => { throw new Error("The staging import did not reach its gate") })]) }
  finally { timeout.abort() }
}
try {
  const hook = join(cwd, ".git/hooks/post-index-change"), hookMarker = join(cwd, ".git/mako-capture-hook")
  writeFileSync(hook, '#!/bin/sh\nprintf called > "$(git rev-parse --git-path mako-capture-hook)"\n')
  chmodSync(hook, 0o700)
  git("config", "core.hooksPath", join(cwd, ".git/hooks"))
  git("update-index", "--assume-unchanged", ".gitignore")
  assert(existsSync(hookMarker), "the fixture's user index hook really runs")
  git("update-index", "--no-assume-unchanged", ".gitignore")
  rmSync(hookMarker)
  const originalIndex = readFileSync(join(cwd, ".git/index"))
  const originalObjects = git("count-objects", "-v")
  const originalRefs = git("for-each-ref")
  const point = await store.capture(cwd)
  const record = recordOf(point.id)
  assert.equal(record.storage?.kind, "shared", "the opt-in path uses a Mako-owned repository store")
  assert.ok(record.storage?.kind === "shared" && record.commit)
  const owner = record.storage.owner
  const repository = join(storage, "repositories", owner, "git")
  assert(!readdirSync(join(repository, "objects/pack")).some((name) => name.endsWith(".rev")), "owner admission includes only its explicitly counted pack/index metadata")
  assert(!readdirSync(join(storage, point.id)).some((name) => name.startsWith("owned-")), "prepared import packs and metadata never remain in the checkpoint payload")
  const secret = inRepo(repository, "rev-parse", `${record.commit}:secret`)
  assert.equal(inRepo(repository, "show", `${record.commit}:file`), "working-only")
  assert.equal(inRepo(repository, "show", `${record.commit}^:file`), "staged-only")
  assert.equal(has(repository, git("rev-parse", "HEAD")), false, "ownership imports trees, not unrelated user history")
  assert.equal(has(repository, `${record.commit}:ignored`), false)
  const again = recordOf((await store.capture(cwd)).id)
  assert.ok(again.storage?.kind === "shared")
  assert.equal(again.storage.owner, owner)
  assert.equal(again.tree, record.tree)
  const copies = () => readdirSync(join(repository, "objects/pack")).filter((p) => p.endsWith(".idx"))
    .flatMap((p) => inRepo(repository, "verify-pack", "-v", join(repository, "objects/pack", p)).split("\n"))
    .filter((line) => line.startsWith(`${secret} `)).length
  assert.equal(copies(), 1, "unchanged private content is packed once across captures")
  assert.equal(git("count-objects", "-v"), originalObjects)
  assert.equal(git("for-each-ref"), originalRefs)
  assert.deepEqual(readFileSync(join(cwd, ".git/index")), originalIndex)
  assert.equal(existsSync(hookMarker), false, "private copied-index writes never run the user's index hooks")
  rmSync(hook)
  git("config", "--unset", "core.hooksPath")

  const mirror = join(root, "mirror.git")
  git("init", "--bare", "-q", mirror)
  git("push", "--mirror", mirror)
  const bundle = join(root, "all.bundle")
  git("bundle", "create", bundle, "--all")
  const unpacked = join(root, "bundle.git")
  git("init", "--bare", "-q", unpacked)
  inRepo(unpacked, "bundle", "unbundle", bundle)
  for (const published of [cwd, mirror, unpacked]) {
    assert.equal(has(published, secret), false, "checkpoint-only content is absent from user publication")
    assert.equal(has(published, record.commit), false)
  }
  const backup = join(root, "repository-backup")
  writeFileSync(join(cwd, "secret"), "later user content\n")
  cpSync(cwd, backup, { recursive: true })
  assert.equal(has(backup, secret), false, "a repository backup has no checkpoint-only Git objects")
  assert.equal(has(backup, record.commit), false)
  assert.equal(inRepo(backup, "for-each-ref"), originalRefs)
  assert.equal(readFileSync(join(backup, "secret"), "utf8"), "later user content\n", "the repository backup retains no older checkpoint-only working content")
  console.log("PASS: shared captures own their graph, deduplicate content, preserve the user index and publish no user refs or objects")

  // A second real worktree has the same primary object owner, but its own saved index and HEAD identity.
  const linked = join(root, "linked")
  git("worktree", "add", "-q", "-b", "linked", linked)
  writeFileSync(join(linked, "secret"), "checkpoint-only secret\n")
  const linkedRecord = recordOf((await store.capture(linked)).id)
  assert.ok(linkedRecord.storage?.kind === "shared")
  assert.equal(linkedRecord.storage.owner, owner)
  assert.notEqual(linkedRecord.gitDir, record.gitDir)
  assert.equal(copies(), 1, "linked worktrees share owned blobs without sharing indexes")
  console.log("PASS: linked worktrees share the repository object owner")

  const blocked = deferred(), release = deferred()
  const run = runner.run.bind(runner)
  let waiting = true
  const held = mock.method(runner, "run", async (options: Parameters<Git["run"]>[0]) => {
    if (waiting && options.args.includes("index-pack")) { waiting = false; blocked.resolve(); await release.promise }
    return run(options)
  })
  let frozen = false, ready = false
  const count = db.prepare("SELECT COUNT(*) AS n FROM snapshots").get()!.n
  const pending = store.capture(cwd, undefined, false, () => { frozen = true }).then((point) => { ready = true; return point })
  let next: ReturnType<WorkspaceSnapshots["capture"]> | undefined
  try {
    await blocked.promise
    assert.equal(frozen, true, "file inputs can be handed off while ownership imports")
    assert.equal(ready, false, "ready waits until dependencies are owned")
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM snapshots").get()!.n, count)
    writeFileSync(join(cwd, "file"), "next turn writes while import is held\n")
    const nextFrozen = deferred()
    next = store.capture(linked, undefined, false, nextFrozen.resolve)
    let timer: ReturnType<typeof setTimeout> | undefined
    const offered = await Promise.race([nextFrozen.promise.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 5_000) })]).finally(() => clearTimeout(timer))
    assert.equal(offered, true, "another worktree fixes its inputs without waiting behind this owner's import")
  } finally { release.resolve(); await Promise.allSettled([pending, ...(next ? [next] : [])]) }
  const owned = recordOf((await pending).id)
  held.mock.restore()
  assert.equal(inRepo(repository, "show", `${owned.commit}:file`), "working-only")
  console.log("PASS: ready waits for ownership while a later writer cannot change already-fixed inputs")

  // A failed import must not create a catalog entry, and it must release the owner lock.
  const failed = mock.method(runner, "run", async (options: Parameters<Git["run"]>[0]) => {
    if (options.args.includes("index-pack")) throw new Error("fixture import failure")
    return run(options)
  })
  const beforeFailure = db.prepare("SELECT COUNT(*) AS n FROM snapshots").get()!.n
  try { await assert.rejects(store.capture(cwd), /fixture import failure/) } finally { failed.mock.restore() }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM snapshots").get()!.n, beforeFailure)
  await store.capture(cwd)
  console.log("PASS: failed dependency import never publishes ready or poisons the owner lock")
  const refsBefore = inRepo(repository, "for-each-ref")
  const incomplete = mock.method(runner, "run", async (options: Parameters<Git["run"]>[0]) => options.args.includes("index-pack")
    ? { code: 0, stdout: Buffer.from("fixture false success"), stderr: "", truncated: false } : run(options))
  const beforeIncomplete = db.prepare("SELECT COUNT(*) AS n FROM snapshots").get()!.n
  try { await assert.rejects(store.capture(cwd)) } finally { incomplete.mock.restore() }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM snapshots").get()!.n, beforeIncomplete)
  assert.equal(inRepo(repository, "for-each-ref"), refsBefore, "an incomplete owned graph cannot publish a root")
  console.log("PASS: verification without capture alternates rejects an incomplete import before root publication")

  // Remove the user's last reference to its staged-only blob; private roots must survive both collectors.
  git("read-tree", "HEAD")
  git("reflog", "expire", "--expire=now", "--all")
  git("gc", "--prune=now", "--quiet")
  assert.equal(has(cwd, staged), false)
  assert.equal(has(repository, staged), true)
  inRepo(repository, "gc", "--prune=now", "--quiet")
  inRepo(repository, "fsck", "--full", "--no-reflogs")
  assert.equal(inRepo(repository, "show", `${record.commit}:secret`), "checkpoint-only secret")
  store.close()
  store = new WorkspaceSnapshots(runner, storage) // Reopen with the feature disabled; retained points still work.
  writeFileSync(join(cwd, "file"), "current\n")
  rmSync(join(cwd, "secret"))
  const preview = await store.preview(point.id)
  const installed = deferred(), allowIndex = deferred()
  const peerOffered = deferred()
  let peerImportStarted = false
  let stagingPack = ""
  const stageImport = mock.method(runner, "run", async (options: Parameters<Git["run"]>[0]) => {
    const result = await run(options)
    if (options.cwd === linked && options.args.includes("--git-path") && options.args.includes("objects") && options.args.some((arg) => arg.startsWith("core.hooksPath="))) peerOffered.resolve()
    if (options.cwd === linked && options.args.includes("pack-objects") && options.args.at(-1)?.endsWith("staging")) peerImportStarted = true
    if (options.args.includes("index-pack") && options.args.some((arg) => arg.replaceAll("\\", "/").endsWith("/workspace/.git"))) {
      stagingPack = options.args.at(-1)!
      installed.resolve()
      await allowIndex.promise
    }
    return result
  })
  const restoring = store.restore({ sourceId: randomUUID(), targetId: point.id, expectedId: preview.current.id,
    fork: { id: randomUUID(), provider: "test", point: { kind: "run", requestId: randomUUID() } } }, () => {})
  let peerRestore: Promise<void> | undefined
  try {
    await promptly(installed.promise)
    const peerPreview = await store.preview(linkedRecord.id)
    peerRestore = store.restore({ sourceId: randomUUID(), targetId: linkedRecord.id, expectedId: peerPreview.current.id,
      fork: { id: randomUUID(), provider: "test", point: { kind: "run", requestId: randomUUID() } } }, () => {})
    void peerRestore.catch(() => undefined)
    await promptly(peerOffered.promise)
    await delay(100)
    assert.equal(peerImportStarted, false, "another worktree waits until the first restore publishes its index before importing staging")
    assert.equal(git("show", ":file"), "initial", "the restored index is not published before its staging dependencies")
    git("gc", "--prune=now", "--quiet")
    assert.equal(has(cwd, staged), true, "a temporary keep protects imported staging while the old index is still live")
  } finally { allowIndex.resolve(); await Promise.all([restoring, ...(peerRestore ? [peerRestore] : [])]); stageImport.mock.restore() }
  assert(!readdirSync(join(cwd, ".git/objects/pack")).some((name) => name.endsWith(".keep")), "the restore drops its own GC lease after publishing staging")
  assert.equal(readFileSync(join(cwd, "file"), "utf8"), "working-only\n")
  assert.equal(readFileSync(join(cwd, "secret"), "utf8"), "checkpoint-only secret\n")
  assert.equal(readFileSync(join(cwd, "ignored"), "utf8"), "ignored file\n")
  assert.equal(git("show", ":file"), "staged-only")
  assert.equal(has(cwd, staged), true, "restored staging survives removal of the private store")
  assert.equal(has(cwd, secret), false, "rewinding does not import working-only objects into user Git")
  assert.equal(has(cwd, record.commit), false)
  console.log("PASS: user and private GC, reopen with the flag off, and rewind preserve working/staged/untracked/ignored content")
  const foreignKeep = stagingPack.replace(/\.pack$/, ".keep")
  writeFileSync(foreignKeep, "the person kept this pack\n")
  try {
    writeFileSync(join(cwd, "file"), "later\n")
    const preview = await store.preview(point.id)
    await store.restore({ sourceId: randomUUID(), targetId: point.id, expectedId: preview.current.id,
      fork: { id: randomUUID(), provider: "test", point: { kind: "run", requestId: randomUUID() } } }, () => {})
    assert.equal(readFileSync(foreignKeep, "utf8"), "the person kept this pack\n", "rewind never removes somebody else's pack lease")
  } finally { rmSync(foreignKeep, { force: true }) }
  console.log("PASS: staging imports retain a pre-existing user keep file")

  const alias = join(root, "same-object-directory")
  git("clone", "-q", "--no-hardlinks", cwd, alias)
  rmSync(join(alias, ".git/objects"), { recursive: true, force: true })
  symlinkSync(join(cwd, ".git/objects"), join(alias, ".git/objects"), "junction")
  const aliasStore = new WorkspaceSnapshots(runner, storage, {}, { objectStorage: "shared" })
  try {
    const objectsBefore = git("count-objects", "-v")
    const aliasRecord = recordOf((await aliasStore.capture(alias)).id)
    assert.ok(aliasRecord.storage?.kind === "shared")
    assert.equal(aliasRecord.storage.owner, owner, "canonical primary object directories define ownership")
    assert.equal(git("count-objects", "-v"), objectsBefore)
  } finally { aliasStore.close() }
  const borrowed = join(root, "borrowed-alternate")
  git("clone", "-q", "--shared", cwd, borrowed)
  const borrowedStore = new WorkspaceSnapshots(runner, storage, {}, { objectStorage: "shared" })
  try {
    const borrowedRecord = recordOf((await borrowedStore.capture(borrowed)).id)
    assert.ok(borrowedRecord.storage?.kind === "shared" && borrowedRecord.commit)
    assert.notEqual(borrowedRecord.storage.owner, owner, "a borrowing repository still owns its own primary writes")
    const own = join(storage, "repositories", borrowedRecord.storage.owner, "git")
    assert.equal(existsSync(join(own, "objects/info/alternates")), false)
    inRepo(own, "fsck", "--full", "--no-reflogs")
    assert.equal(inRepo(own, "show", `${borrowedRecord.commit}:file`), "initial")
  } finally { borrowedStore.close() }
  console.log("PASS: shared primary directories deduplicate, while borrowed alternate dependencies become independently owned")

  const fixture = (name: string, format = "sha1") => {
    const folder = join(root, name)
    mkdirSync(folder)
    inRepo(folder, "init", "-q", "-b", "main", `--object-format=${format}`)
    const command = (...args: string[]) => inRepo(folder, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args)
    writeFileSync(join(folder, "file"), "base\n")
    command("add", ".")
    command("commit", "-qm", "base")
    return { folder, command }
  }
  const restorePoint = async (snapshots: WorkspaceSnapshots, id: string) => {
    const preview = await snapshots.preview(id)
    await snapshots.restore({ sourceId: randomUUID(), targetId: id, expectedId: preview.current.id,
      fork: { id: randomUUID(), provider: "test", point: { kind: "run", requestId: randomUUID() } } }, () => {})
  }

  const sparse = fixture("sparse")
  mkdirSync(join(sparse.folder, "inside"))
  mkdirSync(join(sparse.folder, "outside"))
  writeFileSync(join(sparse.folder, "inside/file"), "inside base\n")
  writeFileSync(join(sparse.folder, "outside/file"), "outside base\n")
  sparse.command("add", ".")
  sparse.command("commit", "-qm", "two cones")
  sparse.command("sparse-checkout", "set", "inside")
  writeFileSync(join(sparse.folder, "inside/file"), "captured inside\n")
  const sparseStore = new WorkspaceSnapshots(runner, storage, {}, { objectStorage: "shared" })
  try {
    const sparsePoint = await sparseStore.capture(sparse.folder)
    writeFileSync(join(sparse.folder, "inside/file"), "later inside\n")
    await restorePoint(sparseStore, sparsePoint.id)
    assert.equal(readFileSync(join(sparse.folder, "inside/file"), "utf8"), "captured inside\n")
    assert.equal(existsSync(join(sparse.folder, "outside/file")), false)
  } finally { sparseStore.close() }
  console.log("PASS: sparse checkpoints own absent tree dependencies and rewind within the cone")

  const sub = fixture("submodule-source"), parent = fixture("parent")
  parent.command("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.folder, "sub")
  parent.command("commit", "-qm", "submodule")
  writeFileSync(join(parent.folder, "sub/file"), "captured submodule\n")
  const grouped = new WorkspaceSnapshots(runner, storage, {}, { objectStorage: "shared" })
  try {
    const groupPoint = await grouped.capture(parent.folder)
    const group = z.object({ value: z.string() }).parse(db.prepare("SELECT value FROM groups WHERE id=?").get(groupPoint.id))
    const parts = z.object({ parts: z.array(z.object({ id: z.string() })) }).parse(JSON.parse(group.value)).parts.map((part) => recordOf(part.id))
    assert.equal(new Set(parts.map((part) => part.storage?.kind === "shared" && part.storage.owner)).size, 2)
    writeFileSync(join(parent.folder, "sub/file"), "later submodule\n")
    writeFileSync(join(parent.folder, "file"), "later parent\n")
    await restorePoint(grouped, groupPoint.id)
    assert.equal(readFileSync(join(parent.folder, "sub/file"), "utf8"), "captured submodule\n")
    assert.equal(readFileSync(join(parent.folder, "file"), "utf8"), "base\n")
  } finally { grouped.close() }
  console.log("PASS: submodules have independent object owners and a coordinated rewind")

  const sha256 = fixture("sha256", "sha256")
  const hashed = new WorkspaceSnapshots(runner, storage, {}, { objectStorage: "shared" })
  try {
    const shaPoint = await hashed.capture(sha256.folder)
    const shaRecord = recordOf(shaPoint.id)
    assert.equal(shaRecord.tree.length, 64)
    assert.ok(shaRecord.storage?.kind === "shared")
    assert.notEqual(shaRecord.storage.owner, owner)
    writeFileSync(join(sha256.folder, "file"), "later\n")
    await restorePoint(hashed, shaPoint.id)
    assert.equal(readFileSync(join(sha256.folder, "file"), "utf8"), "base\n")
  } finally { hashed.close() }
  console.log("PASS: SHA-256 object owners and restores stay separate from SHA-1")

  const unborn = join(root, "unborn")
  mkdirSync(unborn)
  inRepo(unborn, "init", "-q", "-b", "main")
  writeFileSync(join(unborn, "file"), "first\n")
  writeFileSync(join(unborn, "keep"), "keep\n")
  const unbornStore = new WorkspaceSnapshots(runner, storage, {}, { objectStorage: "shared" })
  try {
    const point = await unbornStore.capture(unborn)
    writeFileSync(join(unborn, "file"), "second\n")
    await unbornStore.capture(unborn)
    await restorePoint(unbornStore, point.id)
    assert.equal(readFileSync(join(unborn, "file"), "utf8"), "first\n")
    assert.equal(readFileSync(join(unborn, "keep"), "utf8"), "keep\n")
    assert.equal(existsSync(join(unborn, ".git/index")), false)
  } finally { unbornStore.close() }
  console.log("PASS: an unborn repository preserves captured files and its absent user index")

  const crashed = fixture("crash")
  const crashRoot = join(root, "crash-store")
  writeFileSync(join(crashed.folder, "file"), "captured after crash\n")
  const child = spawnSync(process.execPath, ["--import", "tsx", process.argv[1]!, "--crash-import", crashed.folder, crashRoot], { encoding: "utf8" })
  assert.equal(child.status, 74, child.stderr)
  const recovered = new WorkspaceSnapshots(runner, crashRoot, {}, { objectStorage: "shared" })
  try {
    const point = await recovered.capture(crashed.folder)
    writeFileSync(join(crashed.folder, "file"), "later\n")
    await restorePoint(recovered, point.id)
    assert.equal(readFileSync(join(crashed.folder, "file"), "utf8"), "captured after crash\n")
    assert.equal(crashed.command("for-each-ref", "refs/mako/checkpoints"), "")
  } finally { recovered.close() }
  console.log("PASS: a crash after owned-pack installation releases the kernel lock and the next checkpoint restores correctly")

  // A partial clone must not lazily fetch a missing dependency into the user's object database.
  const partial = fixture("partial")
  const origin = join(root, "partial-origin.git")
  partial.command("clone", "--bare", "-q", partial.folder, origin)
  partial.command("config", "remote.origin.url", origin)
  partial.command("config", "remote.origin.promisor", "true")
  partial.command("config", "extensions.partialClone", "origin")
  partial.command("config", "core.repositoryformatversion", "1")
  partial.command("config", "core.sparseCheckout", "true")
  partial.command("update-index", "--skip-worktree", "file")
  rmSync(join(partial.folder, "file"))
  const missingBlob = partial.command("rev-parse", "HEAD:file")
  const missingPath = join(partial.folder, ".git/objects", missingBlob.slice(0, 2), missingBlob.slice(2))
  rmSync(missingPath)
  const partialStore = new WorkspaceSnapshots(runner, storage, {}, { objectStorage: "shared" })
  try {
    await assert.rejects(partialStore.capture(partial.folder))
    const absent = spawnSync("git", ["--no-lazy-fetch", "-C", partial.folder, "cat-file", "-e", missingBlob], { stdio: "ignore" })
    assert.ok(absent.status !== null && absent.status !== 0, "capture never fetches a promised blob into user objects")
  } finally { partialStore.close() }
  console.log("PASS: a missing promisor dependency fails safely without a user-object fetch")

  const budgetRoot = join(root, "bounded-store")
  const bounded = new WorkspaceSnapshots(runner, budgetRoot, { maxStorageBytes: 16 * 1024 }, { objectStorage: "shared" })
  try {
    let full = false
    for (let i = 0; i < 30; i++) {
      try { await bounded.capture(cwd) }
      catch (error) { assert.match(String(error), /object storage is full/); full = true; break }
    }
    assert.equal(full, true, "the experimental owner cannot grow indefinitely before retention lands")
    const owners = readdirSync(join(budgetRoot, "repositories"))
    assert.equal(owners.length, 1)
    assert.ok(await snapshotPayloadBytes(join(budgetRoot, "repositories", owners[0]!)) <= 16 * 1024)
  } finally { bounded.close() }
  console.log("PASS: conservative physical owner admission bounds the opt-in store before owner retention")
} finally {
  captureInputs.mock.restore()
  db.close()
  store.close()
  await runner.close()
  rmSync(root, { recursive: true, force: true })
}
