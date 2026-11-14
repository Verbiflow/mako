import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import { FileIndexCore } from "@mako/host/contracts/file-index"
import { FolderIndex } from "@mako/host/workspaces/file-index"
import { FileTreeModel } from "@/state/file-tree"

/*
 * The Files view's index: the tree a folder at a time (folded chains, counts, Git's marks, a folder's limit), names
 * found as they're typed (ranking, narrowing, every word of a query), and the host's index of a real repository kept
 * current path by path (added, deleted, ignored, a new folder), with its text search stopping at its limit.
 */

const core = new FileIndexCore([
  "README.md",
  "package.json",
  "src/components/rail/file-tree.tsx",
  "src/components/rail/session-rail.tsx",
  "src/components/viewer/file-viewer.tsx",
  "src/components/viewer/file-view.tsx",
  "src/lib/fuzzy.ts",
  "src/state/files.ts",
  "docs/deep/only/notes.md",
  "test/file2.ts",
  "test/file10.ts",
])

const root = core.folder("")!
assert.deepEqual(root.folders.map((folder) => [folder.name, folder.path, folder.files]), [["docs/deep/only", "docs/deep/only", 1], ["src", "src", 6], ["test", "test", 2]], "folders come first, a chain of lone folders folds into one row")
assert.deepEqual(root.files.map((file) => file.name), ["package.json", "README.md"], "files follow in name order")
assert.deepEqual(core.folder("test")!.files.map((file) => file.name), ["file2.ts", "file10.ts"], "numbers sort as numbers")
assert.equal(core.folder("src/nothing"), undefined, "a folder that isn't one has no listing")
assert.deepEqual(core.folder("src/components", 1), { path: "src/components", folders: [{ name: "rail", path: "src/components/rail", files: 2, changed: false }], files: [], more: 1 }, "a folder past its limit says how many it left out")

core.setChanged(["src/components/rail/file-tree.tsx"])
assert.equal(core.folder("")!.folders.find((folder) => folder.name === "src")!.changed, true, "a changed file marks every folder above it")
assert.equal(core.folder("src/components/rail")!.files.find((file) => file.name === "file-tree.tsx")!.changed, true, "and its own row")

const before = core.version
assert.equal(core.folders([""], { since: before, epoch: core.epoch }).unchanged, true, "a window holding the current version is told only that")
core.add("src/components/rail/new.tsx")
assert.notEqual(core.version, before, "a change moves the version")
assert.equal(core.folder("src/components/rail")!.files.length, 3)
core.remove("docs/deep/only/notes.md")
assert.equal(core.folder("")!.folders.some((folder) => folder.path.startsWith("docs")), false, "a folder whose last file went is gone")
assert.deepEqual(core.filesUnder("src/components/viewer").sort(), ["src/components/viewer/file-view.tsx", "src/components/viewer/file-viewer.tsx"])

const first = (query: string) => core.find(query).hits[0]?.path
assert.equal(first("fileviewer"), "src/components/viewer/file-viewer.tsx", "a file name typed without its dash")
assert.equal(first("file-view"), "src/components/viewer/file-view.tsx", "the exact name over a longer one")
assert.equal(first("fuzzy"), "src/lib/fuzzy.ts")
assert.equal(first("rail tree"), "src/components/rail/file-tree.tsx", "each word of a query is found on its own")
assert.equal(first("state/files"), "src/state/files.ts", "a folder typed with the name")
assert.equal(core.find("zzzz").total, 0)
const hit = core.find("fuzzy").hits[0]!
assert.deepEqual(hit.at, [8, 9, 10, 11, 12], "the matched characters are where the name is")

// Narrowing: each keystroke's answer is the same as asking afresh.
const big = new FileIndexCore(Array.from({ length: 5_000 }, (_, index) => `pkg${index % 37}/src/module-${index}/item${index % 11}.ts`))
for (const query of ["m", "mo", "mod", "modu", "module-4", "module-42", "module-42 item"]) {
  const narrowed = big.find(query, 20)
  const fresh = new FileIndexCore(big.paths()).find(query, 20)
  assert.equal(narrowed.total, fresh.total, `"${query}" narrowed finds as many as afresh`)
  assert.deepEqual(narrowed.hits.map((each) => each.path), fresh.hits.map((each) => each.path), `"${query}" narrowed ranks as afresh`)
}

// The host's index of a real repository, kept current by the paths a watcher would hear.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "mako-file-index-")))
const git = new Git()
try {
  const run = (...args: string[]) => execFileSync("git", args, { cwd: scratch, stdio: "ignore" })
  run("init", "-q")
  writeFileSync(join(scratch, ".gitignore"), "ignored/\n*.log\n")
  mkdirSync(join(scratch, "src"))
  writeFileSync(join(scratch, "src", "alpha.ts"), "export const alpha = 'needle'\n")
  writeFileSync(join(scratch, "src", "beta.ts"), "export const beta = 2\n")
  for (let index = 0; index < 50; index += 1) writeFileSync(join(scratch, "src", `many-${index}.ts`), "needle\nneedle\n")
  run("add", "-A")
  run("-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-qm", "start")

  writeFileSync(join(scratch, "src", "draft.ts"), "draft\n")
  const index = new FolderIndex({ folder: scratch, git })
  index.feed(true)
  assert.equal((await index.list()).some((file) => file.path === "src/draft.ts"), true, "an untracked file is listed once the untracked listing is in")
  const listed = await index.folders([""])
  assert.equal(listed.total, 54, "Git's files, the ignore file and the untracked one included")
  assert.deepEqual(listed.folders[0]!.folders.map((folder) => folder.name), ["src"])

  writeFileSync(join(scratch, "src", "gamma.ts"), "gamma\n")
  writeFileSync(join(scratch, "debug.log"), "ignored\n")
  mkdirSync(join(scratch, "ignored"))
  writeFileSync(join(scratch, "ignored", "x.ts"), "x\n")
  mkdirSync(join(scratch, "fresh", "inner"), { recursive: true })
  writeFileSync(join(scratch, "fresh", "inner", "one.ts"), "one\n")
  rmSync(join(scratch, "src", "beta.ts"))
  index.noteChanges(["src/gamma.ts", "debug.log", "ignored", "ignored/x.ts", "fresh", "src/beta.ts"])
  const after = await index.folders(["", "src"])
  const src = after.folders.find((folder) => folder.path === "src")!
  assert.equal(src.files.some((file) => file.name === "gamma.ts"), true, "a new file is added")
  assert.equal(src.files.some((file) => file.name === "beta.ts"), false, "a deleted tracked file is removed before its deletion is committed")
  assert.equal(after.folders[0]!.files.some((file) => file.name === "debug.log"), false, "an ignored file stays out")
  assert.equal(after.folders[0]!.folders.some((folder) => folder.name === "ignored"), false, "and an ignored folder")
  assert.deepEqual(after.folders[0]!.folders.map((folder) => folder.name), ["fresh/inner", "src"], "a new folder comes in whole, folded")
  assert.equal((await index.find("gamma")).hits[0]?.path, "src/gamma.ts", "a new file is found by name")

  const limited = await index.grep("needle", { limit: 10 })
  assert.equal(limited.total, 10, "a text search stops at its limit")
  assert.equal(limited.more, true, "and says there are more")
  const all = await index.grep("needle", { limit: 1_000 })
  assert.equal(all.total, 101, "and finds every line when allowed")
  assert.equal(all.more, false)
  writeFileSync(join(scratch, "fresh", "needle.ts"), "needle\n")
  index.noteChanges(["fresh/needle.ts"])
  const untracked = await index.grep("needle", { limit: 1_000 })
  assert.equal(untracked.files.some((file) => file.path === "fresh/needle.ts"), true, "an untracked file's lines are found, read from the index's own list")
  assert.equal(untracked.total, 102)
  assert.equal((await index.grep("[ab", { regex: true })).error !== undefined, true, "a pattern that doesn't parse is the query's problem")

  // A rebuild (a lost event) must not answer a window holding an older version with `unchanged`.
  const held = await index.folders([""])
  rmSync(join(scratch, "src", "gamma.ts"))
  writeFileSync(join(scratch, "rebuilt.ts"), "rebuilt\n")
  index.noteChanges(undefined)
  // The untracked files join a rebuilt index after the tracked ones; the `@` list waits for them.
  await index.list()
  const rebuilt = await index.folders([""], { since: held.version, epoch: held.epoch })
  assert.notEqual(rebuilt.unchanged, true, "a rebuilt index never says a window's older version is current")
  assert.ok(rebuilt.version > held.version, "the version keeps climbing across a rebuild")
  assert.equal(rebuilt.folders[0]?.files.some((file) => file.name === "rebuilt.ts"), true, "and the rebuilt listing comes back")

  // A host started again: its index over the same folder starts at the version a window may still hold. The window's
  // model must drop what it held and take the new index's tree, never be told its old one is current.
  const fresh = new FileIndexCore(["a.ts"])
  assert.notEqual(fresh.folders([""], { since: fresh.version }).unchanged, true, "a version without its epoch is never current")
  assert.notEqual(fresh.folders([""], { since: fresh.version, epoch: "another index" }).unchanged, true, "nor one of another index's epoch")
  assert.equal(fresh.folders([""], { since: fresh.version, epoch: fresh.epoch }).unchanged, true, "while its own version and epoch are")
  const restartRoot = realpathSync(mkdtempSync(join(tmpdir(), "mako-file-index-restart-")))
  try {
    const run = (...args: string[]) => execFileSync("git", args, { cwd: restartRoot, stdio: "ignore" })
    run("init", "-q")
    writeFileSync(join(restartRoot, "before.ts"), "before\n")
    run("add", "-A")
    let host = new FolderIndex({ folder: restartRoot, git })
    host.feed(true)
    const model = new FileTreeModel({
      key: "restart",
      folders: (paths, options) => host.folders(paths, options),
      find: (query, limit) => host.find(query, limit),
      grep: (query, options) => host.grep(query, options),
    })
    const settled = () => new Promise<void>((done) => {
      const stop = model.subscribe(() => {
        stop()
        done()
      })
    })
    const names = () => model.rows(new Set()).flatMap((row) => (row.kind === "file" ? [row.name] : []))
    model.rows(new Set())
    await settled()
    assert.deepEqual(names(), ["before.ts"])
    const heldVersion = model.state.version
    // The host goes away and a new one starts; meanwhile the file was replaced.
    host.close()
    rmSync(join(restartRoot, "before.ts"))
    run("rm", "-q", "--cached", "before.ts")
    writeFileSync(join(restartRoot, "after.ts"), "after\n")
    run("add", "-A")
    host = new FolderIndex({ folder: restartRoot, git })
    host.feed(true)
    assert.equal((await host.folders([""])).version, heldVersion, "the new host's index starts at the version the window holds")
    const reread = settled()
    model.refresh()
    await reread
    assert.deepEqual(names(), ["after.ts"], "the window takes the new host's tree rather than keeping its own")
    host.close()
  } finally {
    rmSync(restartRoot, { recursive: true, force: true })
  }

  // An owner replaced while a split read is in flight: the root's answer comes from the new index, a folder listed
  // past its limit from the old one, both at version 1. Nothing of the old one may be drawn, then or after a later
  // refresh the new index answers `unchanged`.
  {
    const old = new FileIndexCore(["src/before.ts", "top.ts"])
    const replacement = new FileIndexCore(["src/after.ts", "top.ts"])
    assert.equal(old.version, replacement.version, "both indexes are at the same version")
    let route: "old" | "split" | "new" = "old"
    const coreFor = (paths: readonly string[]) => (route === "old" ? old : route === "new" ? replacement : paths.includes("") ? replacement : old)
    const model = new FileTreeModel({
      key: "split",
      folders: async (paths, options) => coreFor(paths).folders(paths, options),
      find: async (query, limit) => replacement.find(query, limit),
      grep: async () => ({ query: "", files: [], total: 0, more: false, ms: 0 }),
    })
    const read = () => new Promise<void>((done) => {
      const stop = model.subscribe(() => {
        if (model.state.status === "loading") return
        stop()
        done()
      })
      model.refresh()
    })
    const open = new Set(["src"])
    const files = () => model.rows(open).flatMap((row) => (row.kind === "file" ? [row.path] : []))
    await read()
    model.rows(open)
    await read()
    assert.deepEqual(files(), ["src/before.ts", "top.ts"], "the old index's tree")
    // "Show all" on src as the owner is replaced: src is read on its own, from the old index, the root from the new.
    route = "split"
    model.showAll("src")
    await read()
    assert.equal(files().includes("src/before.ts"), false, `a split read never draws the old index's rows (${files().join(", ")})`)
    route = "new"
    await read()
    model.rows(open)
    await read()
    assert.deepEqual(files(), ["src/after.ts", "top.ts"], "and once the new index answers alone, its tree is drawn")
    await read()
    assert.deepEqual(files(), ["src/after.ts", "top.ts"], "and stays, through a refresh it answers unchanged")
  }

  // Answers that keep mixing two indexes: the model gives up after a few reads and says so, drawing the failed tree
  // reads nothing more however often it's drawn, a change notification reads once, and only a retry recovers.
  {
    const old = new FileIndexCore(["src/before.ts", "top.ts"])
    const replacement = new FileIndexCore(["src/after.ts", "top.ts"])
    let route: "old" | "split" | "new" = "old"
    let calls = 0
    const model = new FileTreeModel({
      key: "mixed",
      folders: async (paths, options) => {
        calls += 1
        const core = route === "old" ? old : route === "new" ? replacement : paths.includes("") ? replacement : old
        return core.folders(paths, options)
      },
      find: async (query, limit) => replacement.find(query, limit),
      grep: async () => ({ query: "", files: [], total: 0, more: false, ms: 0 }),
    })
    const quiet = () => new Promise<void>((done) => setTimeout(done, 30))
    const open = new Set(["src"])
    model.rows(open)
    await quiet()
    model.rows(open)
    await quiet()
    route = "split"
    model.showAll("src")
    await quiet()
    assert.equal(model.state.status, "failed", "answers that keep mixing end as a failure the tree shows")
    const atFailure = calls
    for (let render = 0; render < 8; render += 1) {
      model.rows(open)
      await quiet()
    }
    assert.equal(calls, atFailure, `drawing a failed tree eight times reads nothing (${calls - atFailure} reads)`)
    model.refresh()
    await quiet()
    assert.ok(calls - atFailure <= 2, `a change notification reads once, both of its parts (${calls - atFailure} reads)`)
    assert.equal(model.state.status, "failed", "and, still mixed, fails again without reading on")
    const afterChange = calls
    for (let render = 0; render < 4; render += 1) {
      model.rows(open)
      await quiet()
    }
    assert.equal(calls, afterChange, "drawing it after that reads nothing either")
    route = "new"
    model.retry()
    await quiet()
    model.rows(open)
    await quiet()
    assert.equal(model.state.status, "ready", "a retry recovers once one index answers")
    assert.deepEqual(model.rows(open).flatMap((row) => (row.kind === "file" ? [row.path] : [])), ["src/after.ts", "top.ts"], "and draws its tree")
  }

  // An untracked symlink to a file outside the folder is never read by a text search, nor one to a folder.
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "mako-file-index-outside-")))
  try {
    writeFileSync(join(outside, "canary.txt"), "outsidecanary\n")
    symlinkSync(join(outside, "canary.txt"), join(scratch, "linked.txt"))
    symlinkSync(outside, join(scratch, "linked-folder"))
    index.noteChanges(["linked.txt", "linked-folder"])
    const escaped = await index.grep("outsidecanary", { limit: 100 })
    assert.equal(escaped.total, 0, `a symlink out of the folder is never followed (${escaped.files.map((file) => file.path).join(", ")})`)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }

  // A huge untracked file is skipped by its size, never read whole into memory.
  writeFileSync(join(scratch, "huge.txt"), `hugeneedle\n${"x".repeat(1023)}\n`.repeat(12 * 1024))
  index.noteChanges(["huge.txt"])
  const huge = await index.grep("hugeneedle", { limit: 100 })
  assert.equal(huge.files.some((file) => file.path === "huge.txt"), false, "a file past the text search's byte bound isn't read")
  writeFileSync(join(scratch, "small.txt"), "hugeneedle\n")
  index.noteChanges(["small.txt"])
  assert.equal((await index.grep("hugeneedle", { limit: 100 })).files.some((file) => file.path === "small.txt"), true, "while a small untracked file still is")
  index.close()
} finally {
  git.close()
  rmSync(scratch, { recursive: true, force: true })
}

console.log("file index: ok")
