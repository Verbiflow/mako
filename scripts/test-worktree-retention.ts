import "./lib/scratch-git.mjs"
import { readBranchPull } from "@mako/host/git"
import { Git } from "@mako/git"
import { ThreadStore } from "@mako/host/threads/store"
import { ThreadWorktreeService } from "@mako/host/workspaces/thread-worktrees"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, realpath, rm, rmdir, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import type { ThreadWorktree } from "@mako/host/contracts/thread-worktrees"
import { WorktreeRetention, MIN_RETIREMENT_PASS_MS, MAX_RETIREMENT_PULL_LOOKUPS } from "@mako/host/workspaces/worktree-retention"

const root = await realpath(await mkdtemp(join(tmpdir(), "mako-retirement-")))
try {
  const path = join(root, "checkouts", "finished")
  await mkdir(join(path, "node_modules", "example"), { recursive: true })
  await writeFile(join(path, "node_modules", "example", "index.js"), "module.exports = 1")
  await writeFile(join(path, "source.ts"), "export {}")
  const oldSource = new Date(Date.now() - 8 * 86_400_000)
  await utimes(join(path, "source.ts"), oldSource, oldSource)
  const git = new Git()
  const project = join(root, "project")
  await mkdir(project)
  await git.output(project, ["init", "-q", "-b", "main"])
  await git.output(project, ["config", "user.name", "Test"])
  await git.output(project, ["config", "user.email", "test@example.invalid"])
  await writeFile(join(project, ".gitignore"), "node_modules/\n.env.local\n")
  await git.output(project, ["add", "."])
  await git.output(project, ["commit", "-qm", "base"])
  const base = await git.output(project, ["rev-parse", "HEAD"])
  const checkout = join(root, "git-checkout")
  await git.output(project, ["worktree", "add", "-b", "finished", checkout])
  const store = new ThreadStore(join(root, "threads.sqlite"))
  try {
    const service = new ThreadWorktreeService(git, root, store)
    const record: ThreadWorktree = { path: checkout, project, repoRoot: project, branch: "finished", base, createdAt: 1, thread: ThreadIdSchema.parse("11111111-1111-4111-8111-111111111111") }
    const unavailable = async () => null
    assert.equal((await service.retirementRepository(record, unavailable)).landed, true, "an unchanged branch is actually in main")
    await writeFile(join(checkout, ".env.local"), "FIXTURE_ONLY=1")
    assert.ok((await service.retirementRepository(record, unavailable)).ignored.includes(".env.local"), "Git-ignored private data is identified separately from packages")
    await writeFile(join(checkout, "source.ts"), "export {}")
    assert.match((await service.retirementRepository(record, unavailable)).blocked ?? "", /committed/)
    await git.output(checkout, ["add", "."])
    await git.output(checkout, ["commit", "-qm", "change"])
    const tip = await git.output(checkout, ["rev-parse", "HEAD"])
    assert.equal((await service.retirementRepository(record, unavailable)).landed, false)
    const pull = { number: 1, title: "Test", url: "https://example.com/pull/1", branch: "finished", state: "closed" as const, head: tip, checks: null }
    assert.equal((await service.retirementRepository(record, async () => pull)).landed, true)
    assert.equal((await service.retirementRepository(record, async () => ({ ...pull, head: base }))).landed, false, "a closed PR at an older head cannot authorize retirement")
    assert.match((await service.retirementRepository({ ...record, branch: "other" }, unavailable)).blocked ?? "", /branch changed/)
    await git.output(checkout, ["checkout", "-b", "changed"])
    assert.match((await service.retirementRepository(record, unavailable)).blocked ?? "", /branch changed/)
  } finally { store.close() }
  const thread = ThreadIdSchema.parse("11111111-1111-4111-8111-111111111111")
  const other = ThreadIdSchema.parse("22222222-2222-4222-8222-222222222222")
  let rows: ThreadWorktree[] = [{ thread, path, project: join(root, "project"), repoRoot: join(root, "project"), branch: "finished", base: "a", createdAt: 1 }]
  let worktreeReads = 0
  let swapOwnerAt = Infinity
  let finished = true
  let users: string[] = []
  let landed = true
  let ignored: string[] = []
  let blocked: string | null = null
  let head = "a"
  let repositoryReads = 0
  let changeHeadAt = Infinity
  let failInvalidation = false
  let now = Date.now()
  let failUsers = false
  let resumeDuringRead = false
  let reads = 0
  const removed: string[] = []
  let invalidated = 0
  const retention = new WorktreeRetention({
    file: join(root, "settings.json"), root: join(root, "checkouts"), worktrees: () => {
      if (++worktreeReads >= swapOwnerAt) rows = rows.map((row) => ({ ...row, thread: other }))
      return rows
    },
    finished: () => finished ? 1 : undefined,
    using: async () => {
      reads++
      if (failUsers) throw new Error("Terminal state unavailable")
      if (resumeDuringRead) finished = false
      return users
    },
    repository: async () => {
      if (++repositoryReads >= changeHeadAt) head = "b"
      return { head, landed, blocked, ignored }
    },
    pull: async () => null,
    remove: async (folder) => { removed.push(folder) },
    packagesRemoved: async () => {
      invalidated++
      if (failInvalidation) throw new Error("Prepared receipt could not be invalidated")
    },
    now: () => now,
  })
  const run = () => { now += MIN_RETIREMENT_PASS_MS; return retention.run() }
  const skip = async () => (await retention.preview()).checkouts[0]!.skip
  const configure = async (mode: "preview" | "packages" | "checkout") => retention.configure({ mode, days: 7, kept: [] })
  assert.equal(await skip(), null)
  const beforePreviewRun = worktreeReads
  assert.equal((await run()).settings.mode, "preview")
  assert.equal(worktreeReads, beforePreviewRun, "default background preview does not inspect any checkout")
  assert.equal(invalidated, 0, "hourly preview does not delete packages")
  assert.deepEqual(removed, [])
  finished = false
  assert.match(await skip() ?? "", /active|unknown/)
  finished = true
  users = ["terminal"]
  assert.match(await skip() ?? "", /still uses/)
  users = []
  failUsers = true
  assert.match(await skip() ?? "", /unavailable/)
  failUsers = false
  blocked = "dirty"
  assert.equal(await skip(), "dirty")
  blocked = null
  landed = false
  assert.match(await skip() ?? "", /not merged/)
  landed = true
  rows.push({ ...rows[0]!, thread: other })
  assert.match(await skip() ?? "", /Shared/)
  rows.pop()
  await retention.configure({ mode: "packages", days: 7, kept: [path] })
  assert.match(await skip() ?? "", /Explicitly kept/)
  await configure("preview")
  resumeDuringRead = true
  assert.match(await skip() ?? "", /resumed/)
  resumeDuringRead = false
  finished = true
  const external = join(root, "shared")
  await mkdir(external)
  await symlink(external, join(path, "linked"))
  // Symlinked sources are never followed, and a symlink at the package root is refused.
  await rm(join(path, "node_modules"), { recursive: true })
  await symlink(external, join(path, "node_modules"))
  assert.match(await skip() ?? "", /shared or linked/)
  await rm(join(path, "node_modules"))
  await mkdir(join(path, "node_modules"))
  await writeFile(join(path, "node_modules", "marker"), "owned")
  const plan = await retention.preview()
  assert.deepEqual(plan.checkouts[0]!.packages, [join(path, "node_modules")])
  await configure("packages")
  await mkdir(join(root, "settings.json.lock"))
  const held = await run()
  assert.match(held.checkouts[0]!.skip ?? "", /Another retirement/)
  assert.equal(invalidated, 0, "another profile's claim is never stolen")
  await rmdir(join(root, "settings.json.lock"))
  worktreeReads = 0
  swapOwnerAt = 3
  const changedOwner = await run()
  assert.match(changedOwner.checkouts[0]!.skip ?? "", /conditions changed/)
  assert.equal(invalidated, 0, "a new owner cannot reuse the old owner's preview")
  swapOwnerAt = Infinity
  rows = rows.map((row) => ({ ...row, thread }))
  repositoryReads = 0
  changeHeadAt = 3
  const changed = await run()
  assert.match(changed.checkouts[0]!.skip ?? "", /conditions changed/)
  assert.equal(invalidated, 0, "a branch change after preview cannot retire packages")
  changeHeadAt = Infinity
  await Promise.all([run(), run()])
  assert.equal(invalidated, 1, "concurrent passes retire an install once")
  assert.deepEqual(removed, [])
  assert.equal(await readFile(join(path, "source.ts"), "utf8"), "export {}")
  const beforeThrottle = worktreeReads
  await retention.run()
  assert.equal(worktreeReads, beforeThrottle, "an automatic pass inside ten minutes reads neither repositories nor GitHub")
  await configure("checkout")
  ignored = [".env.local"]
  await writeFile(join(path, ".env.local"), "PRIVATE_FIXTURE=1")
  await utimes(join(path, ".env.local"), oldSource, oldSource)
  await mkdir(join(path, "node_modules"))
  await writeFile(join(path, "node_modules", "marker"), "reinstallable")
  assert.match((await retention.preview()).checkouts[0]!.checkoutSkip ?? "", /Ignored files/)
  await run()
  assert.deepEqual(removed, [], "ignored private data keeps the checkout")
  assert.equal(await readFile(join(path, ".env.local"), "utf8"), "PRIVATE_FIXTURE=1")
  await assert.rejects(readFile(join(path, "node_modules", "marker")), /ENOENT/, "the install can be reclaimed while the private file stays")
  ignored = []
  await rm(join(path, ".env.local"))
  await run()
  assert.deepEqual(removed, [path])
  await mkdir(join(path, "node_modules"))
  await writeFile(join(path, "node_modules", "marker"), "owned")
  failInvalidation = true
  const failed = await run()
  assert.match(failed.checkouts[0]!.skip ?? "", /could not be invalidated/)
  assert.deepEqual(removed, [path], "a package failure cannot continue into checkout removal")
  failInvalidation = false
  const nested = join(root, "checkouts", "nested")
  await mkdir(join(nested, "web", "node_modules"), { recursive: true })
  await writeFile(join(nested, "source.ts"), "export {}")
  const old = new Date(Date.now() - 8 * 86_400_000)
  await utimes(join(nested, "source.ts"), old, old)
  await utimes(join(nested, "web"), old, old)
  rows = [{ ...rows[0]!, path: nested }]
  now += MIN_RETIREMENT_PASS_MS
  const beforeNested = removed.length
  const nestedReport = await run()
  assert.equal(nestedReport.checkouts[0]!.skip, null, "retiring nested packages must not restart the quiet period through a directory timestamp")
  assert.equal(removed.length, beforeNested + 1)
  const multi = join(root, "checkouts", "multi")
  await mkdir(join(multi, "first", "node_modules"), { recursive: true })
  await mkdir(join(multi, "second"), { recursive: true })
  await writeFile(join(multi, ".env.local"), "PROJECT_PRIVATE=1")
  await utimes(join(multi, ".env.local"), oldSource, oldSource)
  const projectFolder = join(root, "project-folder")
  rows = ["first", "second"].map((name) => ({ ...rows[0]!, path: join(multi, name), project: projectFolder, repoRoot: join(projectFolder, name) }))
  const beforeProject = removed.length
  const privateProject = await run()
  assert.match(privateProject.checkouts[0]!.skip ?? "", /outside the repositories/)
  assert.equal(removed.length, beforeProject)
  assert.equal(await readFile(join(multi, ".env.local"), "utf8"), "PROJECT_PRIVATE=1")
  await rm(join(multi, ".env.local"))
  const marker = join(multi, ".mako-project.json")
  await writeFile(marker, `${JSON.stringify({ project: projectFolder })}\n`)
  await utimes(marker, oldSource, oldSource)
  await run()
  assert.equal(removed.length, beforeProject + 1, "the exact reconstructable project marker is not private data")
  await writeFile(marker, `${JSON.stringify({ project: projectFolder, kept: "PRIVATE_FIXTURE" })}\n`)
  await utimes(marker, oldSource, oldSource)
  const changedMarker = await run()
  assert.match(changedMarker.checkouts[0]!.skip ?? "", /outside the repositories/)
  assert.equal(removed.length, beforeProject + 1, "the marker's name alone never authorizes deleting other data")
  assert.ok(reads > 0)
  head = "changed"
  await retention.configure({ mode: "preview", days: 3650, kept: [] })
  assert.match(await skip() ?? "", /changed within/)
  const argumentsSeen: string[][] = []
  const ancient = await readBranchPull(project, "older-than-the-recent-list", async (_cwd, args) => {
    argumentsSeen.push(args)
    return JSON.stringify({ headRefName: "older-than-the-recent-list", headRefOid: base, state: "MERGED", isDraft: false })
  })
  assert.deepEqual(ancient, { branch: "older-than-the-recent-list", head: base, state: "merged" })
  assert.deepEqual(argumentsSeen, [["pr", "view", "--json", "headRefName,headRefOid,state,isDraft", "--", "older-than-the-recent-list"]])
  assert.equal(await readBranchPull(project, "expected", async () => JSON.stringify({ headRefName: "other", headRefOid: base, state: "CLOSED" })), null)

  const many: ThreadWorktree[] = []
  for (let i = 0; i < MAX_RETIREMENT_PULL_LOOKUPS + 1; i++) {
    const path = join(root, "budget", `checkout-${i}`)
    await mkdir(path, { recursive: true })
    many.push({ ...rows[0]!, path, branch: `branch-${i}` })
  }
  let requests = 0
  const budget = new WorktreeRetention({
    file: join(root, "budget-settings.json"), root: join(root, "budget"), worktrees: () => many,
    finished: () => 1, using: async () => [], now: () => Date.now(),
    repository: async (row, lookup) => {
      const pull = await lookup(row.repoRoot, row.branch)
      return { head: "head", blocked: null, landed: pull?.head === "head", ignored: [] }
    },
    pull: async (_cwd, branch) => { requests++; return { branch, head: "head", state: "closed" } },
    remove: async () => { throw new Error("Only a preview") }, packagesRemoved: async () => { throw new Error("Only a preview") },
  })
  await budget.run()
  assert.equal(requests, 0, "default mode makes zero automatic GitHub requests")
  const firstBudget = await budget.preview()
  assert.equal(requests, MAX_RETIREMENT_PULL_LOOKUPS, "two proof reads per branch share one request")
  assert.equal(firstBudget.githubLookups, MAX_RETIREMENT_PULL_LOOKUPS)
  const keptByBudget = firstBudget.checkouts.find((row) => row.skip?.includes("lookup budget"))!
  const nextBudget = await budget.preview()
  assert.equal(requests, 2 * MAX_RETIREMENT_PULL_LOOKUPS)
  assert.equal(nextBudget.checkouts.find((row) => row.path === keptByBudget.path)?.skip, null, "rotating the bounded pass does not starve older branches")
  await writeFile(join(root, "settings.json"), '{"mode":"packages","days":-1,"kept":[]}')
  await assert.rejects(run(), /Too small/)
  console.log("worktree retention: Git/PR proof, lifecycle, sharing, resumption, ignored/project-private data, preview no-op, ten-minute throttle, per-pass cache/budget/rotation and retirement controls passed")
} finally { await rm(root, { recursive: true, force: true }) }
