import "./lib/scratch-git.mjs"
import { Git } from "@mako/git"
import { ThreadStore } from "@mako/host/threads/store"
import { ThreadWorktreeService } from "@mako/host/workspaces/thread-worktrees"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, realpath, rm, rmdir, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import type { ThreadWorktree } from "@mako/host/contracts/thread-worktrees"
import { WorktreeRetention } from "@mako/host/workspaces/worktree-retention"

const root = await realpath(await mkdtemp(join(tmpdir(), "mako-retirement-")))
try {
  const path = join(root, "checkouts", "finished")
  await mkdir(join(path, "node_modules", "example"), { recursive: true })
  await writeFile(join(path, "node_modules", "example", "index.js"), "module.exports = 1")
  await writeFile(join(path, "source.ts"), "export {}")
  const git = new Git()
  const project = join(root, "project")
  await mkdir(project)
  await git.output(project, ["init", "-q", "-b", "main"])
  await git.output(project, ["config", "user.name", "Test"])
  await git.output(project, ["config", "user.email", "test@example.invalid"])
  await writeFile(join(project, ".gitignore"), "node_modules/\n")
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
    await writeFile(join(checkout, "source.ts"), "export {}")
    assert.match((await service.retirementRepository(record, unavailable)).blocked ?? "", /committed/)
    await git.output(checkout, ["add", "."])
    await git.output(checkout, ["commit", "-qm", "change"])
    const tip = await git.output(checkout, ["rev-parse", "HEAD"])
    assert.equal((await service.retirementRepository(record, unavailable)).landed, false)
    const pull = { number: 1, title: "Test", url: "https://example.com/pull/1", branch: "finished", state: "closed" as const, head: tip, checks: null }
    assert.equal((await service.retirementRepository(record, async () => [pull])).landed, true)
    assert.equal((await service.retirementRepository(record, async () => [{ ...pull, head: base }])).landed, false, "a closed PR at an older head cannot authorize retirement")
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
  let blocked: string | null = null
  let head = "a"
  let repositoryReads = 0
  let changeHeadAt = Infinity
  let failInvalidation = false
  let now = Date.now() + 10 * 86_400_000
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
      return { head, landed, blocked }
    },
    remove: async (folder) => { removed.push(folder) },
    packagesRemoved: async () => {
      invalidated++
      if (failInvalidation) throw new Error("Prepared receipt could not be invalidated")
    },
    now: () => now,
  })
  const skip = async () => (await retention.preview()).checkouts[0]!.skip
  const configure = async (mode: "preview" | "packages" | "checkout") => retention.configure({ mode, days: 7, kept: [] })
  assert.equal(await skip(), null)
  assert.equal((await retention.run()).settings.mode, "preview")
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
  const held = await retention.run()
  assert.match(held.checkouts[0]!.skip ?? "", /Another retirement/)
  assert.equal(invalidated, 0, "another profile's claim is never stolen")
  await rmdir(join(root, "settings.json.lock"))
  worktreeReads = 0
  swapOwnerAt = 3
  const changedOwner = await retention.run()
  assert.match(changedOwner.checkouts[0]!.skip ?? "", /conditions changed/)
  assert.equal(invalidated, 0, "a new owner cannot reuse the old owner's preview")
  swapOwnerAt = Infinity
  rows = rows.map((row) => ({ ...row, thread }))
  repositoryReads = 0
  changeHeadAt = 3
  const changed = await retention.run()
  assert.match(changed.checkouts[0]!.skip ?? "", /conditions changed/)
  assert.equal(invalidated, 0, "a branch change after preview cannot retire packages")
  changeHeadAt = Infinity
  await Promise.all([retention.run(), retention.run()])
  assert.equal(invalidated, 1, "concurrent passes retire an install once")
  assert.deepEqual(removed, [])
  assert.equal(await readFile(join(path, "source.ts"), "utf8"), "export {}")
  await configure("checkout")
  await retention.run()
  assert.deepEqual(removed, [path])
  await mkdir(join(path, "node_modules"))
  await writeFile(join(path, "node_modules", "marker"), "owned")
  failInvalidation = true
  const failed = await retention.run()
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
  now = Date.now()
  const beforeNested = removed.length
  const nestedReport = await retention.run()
  assert.equal(nestedReport.checkouts[0]!.skip, null, "retiring nested packages must not restart the quiet period through a directory timestamp")
  assert.equal(removed.length, beforeNested + 1)
  assert.ok(reads > 0)
  head = "changed"
  await retention.configure({ mode: "preview", days: 3650, kept: [] })
  assert.match(await skip() ?? "", /changed within/)
  await writeFile(join(root, "settings.json"), '{"mode":"packages","days":-1,"kept":[]}')
  await assert.rejects(retention.run(), /Too small/)
  console.log("worktree retention: lifecycle, sharing, exact Git proof, live-use failure, resumption, links, keep, age, preview and concurrent retirement passed")
} finally { await rm(root, { recursive: true, force: true }) }
