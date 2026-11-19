import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { Git } from "@mako/git"
import type { TrackerEventSource } from "@mako/protocol"
import { FakeEventSource } from "@mako/protocol/attribution-conformance"
import { gitRepository, headFromFiles, nodeFileSystem } from "@mako/host/attribution/ports"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { testScratch } from "./lib/test-scratch.mjs"

/*
 * A turn's shell commands and Git: HEAD read from Git's files, and the checkout listed by one `git status` when the
 * root's watch was silent. On a scratch repository, with Git's runs counted.
 */

function scratch() {
  const project = realpathSync(testScratch("mako-shell-quiet-"))
  const repo = join(project, "repo")
  mkdirSync(repo)
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git(repo, "init", "-q", "-b", "main")
  return { project, repo, git, remove: () => rmSync(project, { recursive: true, force: true }) }
}

test("HEAD read from Git's files is the commit Git names", async () => {
  const w = scratch()
  try {
    const asked = (cwd: string) => {
      try {
        return w.git(cwd, "rev-parse", "--verify", "-q", "HEAD")
      } catch {
        return null
      }
    }
    assert.equal(await headFromFiles(w.repo), null, "before the first commit")
    writeFileSync(join(w.repo, "a.ts"), "one\n")
    w.git(w.repo, "add", "-A")
    w.git(w.repo, "commit", "-q", "-m", "one")
    assert.equal(await headFromFiles(w.repo), asked(w.repo), "a branch's own file")
    w.git(w.repo, "pack-refs", "--all")
    assert.equal(await headFromFiles(w.repo), asked(w.repo), "a branch kept in packed-refs")
    writeFileSync(join(w.repo, "a.ts"), "two\n")
    w.git(w.repo, "commit", "-q", "-am", "two")
    assert.equal(await headFromFiles(w.repo), asked(w.repo), "a newer file over the packed line")
    const linked = join(w.project, "linked")
    w.git(w.repo, "worktree", "add", "-q", "-b", "side", linked, "HEAD~1")
    assert.equal(await headFromFiles(linked), asked(linked), "a linked worktree's own HEAD, its branch in the common folder")
    assert.notEqual(await headFromFiles(linked), await headFromFiles(w.repo))
    w.git(linked, "checkout", "-q", "--detach", "main")
    assert.equal(await headFromFiles(linked), asked(linked), "a detached HEAD")
    assert.equal(await headFromFiles(w.project), undefined, "no repository: the caller asks Git")
  } finally {
    w.remove()
  }
})

test("a turn's shell reconciliation costs one Git process: HEAD from its files, both lists from one status", async () => {
  const w = scratch()
  writeFileSync(join(w.repo, "a.ts"), "one\n")
  w.git(w.repo, "add", "-A")
  w.git(w.repo, "commit", "-q", "-m", "one")
  const storage = testScratch("mako-shell-quiet-journal-")
  const git = new Git()
  const runs: string[] = []
  const run = git.run.bind(git)
  git.run = (options) => {
    runs.push(options.args.join(" "))
    return run(options)
  }
  // A watch that hears nothing: the silence a held-back delivery leaves, which the reconciliation is for.
  const history = new FakeEventSource()
  const events: TrackerEventSource = { watch: async () => ({ close() {} }), mark: () => history.mark(), since: (mark, root, options) => history.since(mark, root, options) }
  const tracker = await LaptopTracker.open({ storage, fs: nodeFileSystem(), clock: { now: () => Date.now() }, events, device: "test" }, { repository: async (path) => gitRepository(git, path) })
  try {
    await tracker.track({ id: "repo", path: w.repo, kind: "workspace" })
    await tracker.settled()
    const turn = async (id: string, between: () => void) => {
      const mark = (kind: "turn" | "call", edge: "start" | "end") =>
        tracker.activity({ kind, id: kind === "turn" ? id : `${id}-call`, edge, at: Date.now(), thread: "one", session: "one-session", turn: id, checkout: w.repo })
      mark("turn", "start")
      mark("call", "start")
      const startedAt = Date.now()
      await new Promise((resolve) => setTimeout(resolve, 20))
      between()
      mark("call", "end")
      tracker.reported({ thread: "one", session: "one-session", turn: id, call: `${id}-call`, checkout: w.repo, startedAt, endedAt: Date.now(), status: "completed", effects: [{ kind: "command", command: "python3 generate.py", cwd: w.repo }] })
      mark("turn", "end")
      // The reconciliation waits out the watch's allowance, then the count's wait for it ends.
      assert.equal(await tracker.settled({ rescans: false, checkouts: [w.repo] }), true)
    }
    runs.length = 0
    const entries = tracker.changes(0).length
    await turn("quiet", () => {})
    assert.deepEqual(runs, ["status --porcelain=v1 -z --no-renames --untracked-files=all"], "a command that changed nothing: one listing, where HEAD was asked three times and the lists made by two more")
    assert.equal(tracker.changes(0).length, entries)

    runs.length = 0
    await turn("wrote", () => {
      writeFileSync(join(w.repo, "a.ts"), "two\n")
      writeFileSync(join(w.repo, "new.ts"), "new\n")
    })
    const found = tracker.changes(0).slice(entries)
    assert.deepEqual(found.map((entry) => [entry.path, entry.kind]).sort(), [["a.ts", "modify"], ["new.ts", "create"]], "what the watch never said is found: a changed file and an untracked one")
    assert.ok(found.every((entry) => entry.author.certainty === "window"), "and put on the turn that ran")
    // A file Git never saw is checked against what Git ignores, as any new file is; the checkout isn't listed again.
    assert.deepEqual(runs.filter((args) => /^(rev-parse\b|diff\b|ls-files -z --others --exclude-standard$)/.test(args)), [], "with no other listing of the checkout and no ask for HEAD")
    assert.equal(runs.filter((args) => args.startsWith("status ")).length, 1)
  } finally {
    await tracker.close()
    rmSync(storage, { recursive: true, force: true })
    w.remove()
  }
})
