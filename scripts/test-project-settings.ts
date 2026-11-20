import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Git } from "@mako/git"
import { PreferenceStore, declarePreferenceMethods } from "@mako/host/harnesses/preferences"
import { WorktreeStarts } from "@mako/host/workspaces/worktree-start"
import { declareProjectSettingsMethods, ProjectSettingsStore, projectSettingsView, saveProjectSettings, type ProjectSettingsDeps } from "@mako/host/workspaces/project-settings"
import { hostCallReplay } from "@mako/host/contracts/host-call-policy"
import { hostCallSchema } from "@mako/host/contracts/host-call-inputs"
import type { MethodTable } from "@mako/host/base/methods"

/**
 * Settings › Projects on the host: the branch a project's new Threads start from, kept per repository in one file that
 * keeps what it doesn't name; every start point (`WorktreeStarts.point`) honoring it, a remote branch fetched first,
 * one that's gone falling back to Mako's own rule; the two host calls' work, their declared names, arguments and replay policy; and Open
 * settings file's `mako:preferences-file`, which makes the file when nothing is kept yet.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-project-settings-")))
test.after(() => rmSync(root, { recursive: true, force: true }))
const runner = new Git()

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function commit(cwd: string, name: string) {
  writeFileSync(join(cwd, `${name}.txt`), `${name}\n`)
  git(cwd, "add", ".")
  git(cwd, "commit", "-q", "-m", name)
}

function identify(cwd: string) {
  git(cwd, "config", "user.email", "test@example.invalid")
  git(cwd, "config", "user.name", "Test")
}

interface Project {
  folder: string
  seed: string
}

/** A project cloned from a bare origin, with `release` on the origin only and `develop` local only. */
function project(name: string): Project {
  const origin = join(root, `${name}.git`)
  git(root, "init", "-q", "--bare", "-b", "main", origin)
  const seed = join(root, `${name}-seed`)
  git(root, "clone", "-q", origin, seed)
  identify(seed)
  commit(seed, "first")
  git(seed, "push", "-q", "origin", "main")
  git(seed, "checkout", "-q", "-b", "release")
  commit(seed, "release-one")
  git(seed, "push", "-q", "origin", "release")
  git(seed, "checkout", "-q", "main")
  const folder = join(root, name)
  git(root, "clone", "-q", origin, folder)
  identify(folder)
  git(folder, "checkout", "-q", "-b", "develop")
  commit(folder, "develop-one")
  git(folder, "checkout", "-q", "main")
  return { folder, seed }
}

/** The channels a domain declares on the host's method table. */
function declared(declare: (methods: MethodTable) => void): string[] {
  const channels: string[] = []
  declare({ handle: (channel) => void channels.push(channel) })
  return channels
}

test("the store keeps a base branch per repository and what it doesn't name", async () => {
  const file = join(root, "store", "project-settings.json")
  const store = new ProjectSettingsStore(file)
  assert.equal(await store.baseBranch("/a"), undefined)
  await store.save("/a", { baseBranch: "origin/main" })
  await store.save("/b", { baseBranch: "develop" })
  assert.equal(await store.baseBranch("/a"), "origin/main")
  // A newer Mako's fields, beside the file's and a project's, survive this build's rewrite.
  const written = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(written.version, 1)
  written.later = { kept: true }
  written.projects["/a"].icon = "fin"
  writeFileSync(file, JSON.stringify(written))
  await store.save("/a", { baseBranch: "main" })
  await store.save("/b", { baseBranch: null })
  const after = JSON.parse(readFileSync(file, "utf8"))
  assert.deepEqual(after.later, { kept: true })
  assert.deepEqual(after.projects["/a"], { icon: "fin", baseBranch: "main" })
  assert.equal(after.projects["/b"], undefined, "a project with nothing set leaves the file")
  assert.equal(await store.baseBranch("/a"), "main")
  // A newer format is a newer Mako's to rewrite: read, never written.
  writeFileSync(file, JSON.stringify({ ...after, version: 2, reads: 2 }))
  await assert.rejects(store.save("/a", { baseBranch: "develop" }), /newer Mako/)
})

test("every start point honors the chosen branch, and falls back when it's gone", async () => {
  const { folder, seed } = project("starts")
  const chosen = new Map<string, string>()
  let now = 1_000_000
  const starts = new WorktreeStarts(runner, () => now, new Map(), async (repoRoot) => chosen.get(repoRoot))
  const main = git(folder, "rev-parse", "main")
  let point = await starts.point(folder, false)
  assert.equal(point.from, "main")
  assert.equal(point.commit, main)

  chosen.set(folder, "develop")
  point = await starts.point(folder, false)
  assert.equal(point.from, "develop")
  assert.equal(point.commit, git(folder, "rev-parse", "develop"))
  assert.deepEqual(point.standing, { kind: "level" })

  // A remote branch: read from refs/remotes, and fetched first when asked to.
  chosen.set(folder, "origin/release")
  point = await starts.point(folder, false)
  assert.equal(point.commit, git(folder, "rev-parse", "origin/release"))
  git(seed, "checkout", "-q", "release")
  commit(seed, "release-two")
  git(seed, "push", "-q", "origin", "release")
  point = await starts.point(folder, true)
  assert.equal(point.commit, git(seed, "rev-parse", "release"), "the fetch brought the remote branch's newest commit")
  assert.ok(point.fetched && point.fetched.failed === null)
  now += 1

  // Gone: Mako's own rule, and the automatic point never reads the choice.
  chosen.set(folder, "no-such-branch")
  point = await starts.point(folder, false)
  assert.equal(point.from, "main")
  assert.equal(await starts.resolves(folder, "no-such-branch"), false)
  assert.equal(await starts.resolves(folder, "develop"), true)
  chosen.set(folder, "develop")
  assert.equal((await starts.automatic(folder, false)).from, "main")
})

test("the host calls read and save a project's settings", async () => {
  const { folder } = project("calls")
  const store = new ProjectSettingsStore(join(root, "calls-store", "project-settings.json"))
  const starts = new WorktreeStarts(runner, Date.now, new Map(), (repoRoot) => store.baseBranch(repoRoot))
  const deps: ProjectSettingsDeps = {
    git: runner,
    store,
    automatic: (repoRoot) => starts.automatic(repoRoot, false),
    resolves: (repoRoot, ref) => starts.resolves(repoRoot, ref),
  }
  assert.deepEqual(declared((methods) => declareProjectSettingsMethods(methods, deps)), ["mako:project-settings", "mako:project-settings-save"])
  assert.deepEqual(hostCallSchema("mako:project-settings-save").parse([folder, { baseBranch: "develop" }]), [folder, { baseBranch: "develop" }])
  assert.throws(() => hostCallSchema("mako:project-settings-save").parse([folder, {}]))
  git(folder, "remote", "set-url", "origin", "git@github.com:acme/calls.git")

  let view = await projectSettingsView(deps, folder)
  assert.deepEqual(view, { folder, repository: folder, baseBranch: null, automatic: "main", missing: false, cloud: "acme/calls" })

  view = await saveProjectSettings(deps, folder, { baseBranch: "develop" })
  assert.equal(view.baseBranch, "develop")
  assert.equal((await starts.point(folder, false)).from, "develop", "a new Thread starts where the person chose")
  await assert.rejects(saveProjectSettings(deps, folder, { baseBranch: "gone" }), /isn't a branch of this repository/)
  await assert.rejects(saveProjectSettings(deps, folder, { baseBranch: "has space" }), /branch name/)

  // A branch deleted after it was chosen: said, and Mako's rule applies meanwhile.
  git(folder, "branch", "-q", "-D", "develop")
  view = await projectSettingsView(deps, folder)
  assert.equal(view.missing, true)
  assert.equal((await starts.point(folder, false)).from, "main")
  view = await saveProjectSettings(deps, folder, { baseBranch: null })
  assert.equal(view.baseBranch, null)

  // A folder that's no one repository keeps no branch of its own.
  const plain = join(root, "plain")
  mkdirSync(plain)
  view = await projectSettingsView(deps, plain)
  assert.equal(view.repository, null)
  await assert.rejects(saveProjectSettings(deps, plain, { baseBranch: "main" }), /isn't one Git repository/)

  assert.equal(hostCallReplay("mako:project-settings"), "read")
  assert.equal(hostCallReplay("mako:project-settings-save"), "replay")
})

test("Open settings file names preferences.json, made when nothing is kept yet", async () => {
  const file = join(root, "user", "preferences.json")
  const store = new PreferenceStore({ file, account: async () => undefined, announce: () => {} })
  assert.ok(declared((methods) => declarePreferenceMethods(methods, store)).includes("mako:preferences-file"))
  assert.deepEqual(hostCallSchema("mako:preferences-file").parse([]), [])
  assert.equal(existsSync(file), false)
  assert.equal(store.file(), file)
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1)
  // A file already there is left as it is.
  await store.set("theme", "light")
  const before = readFileSync(file, "utf8")
  assert.equal(store.file(), file)
  assert.equal(readFileSync(file, "utf8"), before)
  assert.equal(hostCallReplay("mako:preferences-file"), "replay")
})
