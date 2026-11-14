import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, realpath, rename, rm, rmdir, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import { ThreadStore } from "@mako/host/threads/store"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import type { ThreadWorktree } from "@mako/host/contracts/thread-worktrees"
import { ThreadWorktreeService } from "@mako/host/workspaces/thread-worktrees"
import { WorktreeRetention, MIN_RETIREMENT_PASS_MS } from "@mako/host/workspaces/worktree-retention"
import { WorktreeThreadState } from "@mako/host/conversations/worktree-thread-state"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { auditSnapshot } from "./performance-audit-fixtures"

const root = await realpath(await mkdtemp(join(tmpdir(), "mako-retirement-")))
const thread = ThreadIdSchema.parse("11111111-1111-4111-8111-111111111111")
const other = ThreadIdSchema.parse("22222222-2222-4222-8222-222222222222")
try {
  // Real Git transport: an unmerged/squashed branch, switched registry branch and detached HEAD.
  const git = new Git()
  const project = join(root, "project"), remote = join(root, "remote.git"), checkout = join(root, "git-checkout")
  await mkdir(project)
  await git.output(project, ["init", "-q", "-b", "main"])
  await git.output(project, ["config", "user.name", "Test"])
  await git.output(project, ["config", "user.email", "test@example.invalid"])
  await writeFile(join(project, ".gitignore"), "node_modules/\n.env.local\n")
  await git.output(project, ["add", "."])
  await git.output(project, ["commit", "-qm", "base"])
  const base = await git.output(project, ["rev-parse", "HEAD"])
  await git.output(project, ["init", "-q", "--bare", remote])
  await git.output(project, ["remote", "add", "origin", remote])
  await git.output(project, ["push", "-q", "origin", "main"])
  await git.output(project, ["worktree", "add", "-b", "finished", checkout])
  const store = new ThreadStore(join(root, "threads.sqlite"))
  try {
    const service = new ThreadWorktreeService(git, root, store)
    const record: ThreadWorktree = { path: checkout, project, repoRoot: project, branch: "stale-recorded-name", base, createdAt: 1, thread }
    const refresh = (common: string) => service.retirementFetch(common)
    await writeFile(join(checkout, "source.ts"), "export {}")
    await git.output(checkout, ["add", "."])
    await git.output(checkout, ["commit", "-qm", "work"])
    assert.equal((await service.retirementRepository(record, refresh)).remote, false, "a local-only HEAD is not disposable")
    await git.output(checkout, ["push", "-q", "origin", "finished"])
    const tip = await git.output(checkout, ["rev-parse", "HEAD"])
    await git.output(project, ["merge", "--squash", "finished"])
    await git.output(project, ["commit", "-qm", "squashed"])
    assert.equal(await git.succeeds(project, ["merge-base", "--is-ancestor", tip, "main"]), false)
    assert.equal((await service.retirementRepository(record, refresh)).remote, true, "remote PR branch retains exact HEAD despite squash and stale registry name")
    await git.output(checkout, ["checkout", "--detach"])
    assert.equal((await service.retirementRepository(record, refresh)).remote, true, "detached HEAD uses the same remote proof")
    await writeFile(join(checkout, ".env.local"), "FIXTURE_ONLY=1")
    assert.ok((await service.retirementRepository(record, refresh)).ignored.includes(".env.local"))
    await writeFile(join(checkout, "dirty.ts"), "uncommitted")
    assert.match((await service.retirementRepository(record, refresh)).blocked ?? "", /committed/)
    await rm(join(checkout, "dirty.ts"))
    await git.output(project, ["push", "-q", "origin", "--delete", "finished"])
    await git.output(project, ["update-ref", "refs/remotes/origin/finished", tip])
    const cachedRefs = await git.output(project, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/"])
    const fetchHead = await readFile(join(project, ".git", "FETCH_HEAD"), "utf8")
    const readOnly = new WorktreeRetention({
      file: join(root, "readonly-settings.json"), root, worktrees: () => [record], finished: () => 1,
      using: async () => [], openFiles: async () => [],
      repository: (row, fetch) => service.retirementRepository(row, fetch),
      fetch: async () => { throw new Error("Preview must not fetch") },
      remove: async () => { throw new Error("Preview must not remove") }, packagesRemoved: async () => {},
    })
    assert.equal((await readOnly.preview()).repositoryFetches, 0)
    assert.equal(await git.output(project, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes/"]), cachedRefs, "preview does not prune even a stale remote ref")
    assert.equal(await readFile(join(project, ".git", "FETCH_HEAD"), "utf8"), fetchHead, "preview leaves fetch metadata untouched")
    readOnly.close()
    assert.equal((await service.retirementRepository(record, refresh)).remote, false, "a real refresh prunes the stale ref before removal")
    await assert.rejects(service.retirementRepository(record, async () => { throw new Error("fetch unavailable") }), /fetch unavailable/)

    // Actual global Thread records and read-only journals, including a top-level Thread with no Fin edge.
    const dataRoot = join(root, "host"), id = randomUUID()
    let snapshot = { ...auditSnapshot(0, "fixture", 0, 0), session: { ...auditSnapshot(0, "fixture", 0, 0).session, id, status: "closed" as const, connection: "disconnected" as const } }
    const journal = new LiveJournal(join(dataRoot, "conversations"), id)
    try {
      journal.commit(snapshot)
      const placed = store.registerJournal({ conversationId: id, createdAt: 1, harness: "codex", bindings: [] }, { kind: "service", name: "migration" })
      const state = new WorktreeThreadState({ store, dataRoot })
      assert.ok(state.finished(placed.thread) !== undefined, "an ended top-level Thread qualifies without a crew or Fin edge")
      assert.ok(state.quietSince(placed.thread) !== undefined, "a settled local journal can age out registered scratch")
      const active = new WorktreeThreadState({ store, dataRoot, busy: () => true })
      assert.equal(active.finished(placed.thread), undefined, "current activity wins over a closed journal")
      assert.equal(active.quietSince(placed.thread), undefined)
      let elsewhere = true
      const continued = new WorktreeThreadState({ store, dataRoot, elsewhere: () => elsewhere })
      assert.equal(continued.finished(placed.thread), undefined, "a closed local journal is not finished while CloudConversations.has routes it elsewhere")
      assert.equal(continued.quietSince(placed.thread), undefined)
      elsewhere = false
      assert.ok(continued.finished(placed.thread) !== undefined, "local completion can qualify after the continued routing has been removed")
      const previous = snapshot
      snapshot = { ...snapshot, revision: snapshot.revision + 1, session: { ...snapshot.session, status: "closed" } }
      journal.commit({ ...snapshot, requests: [{ id: "queued", text: "fixture", createdAt: 1, status: "queued", attachments: [] }] }, previous)
      assert.equal(state.finished(placed.thread), undefined, "queued work keeps an otherwise closed Thread")
      assert.equal(state.quietSince(placed.thread), undefined, "queued work blocks idle scratch cleanup")
      assert.equal(state.finished(other), undefined, "missing records never become finished")
    } finally { journal.close() }
  } finally { store.close() }

  const path = join(root, "checkouts", "finished")
  await mkdir(join(path, "node_modules", "example"), { recursive: true })
  await writeFile(join(path, "node_modules", "example", "index.js"), "module.exports = 1")
  await writeFile(join(path, "source.ts"), "DIRTY_SOURCE_FIXTURE")
  let rows: ThreadWorktree[] = [{ thread, path, project: path, repoRoot: path, branch: "old-name", base, createdAt: Date.now() }]
  let now = Date.now(), finished: number | undefined = now
  let users: string[] = [], open: string[] = []
  let remoteProof = false, blocked: string | null = "dirty", ignored = [".env.local"]
  let head = "a", reads = 0, fetches = 0, invalidated = 0, failInvalidation = false, failOpen = false
  let onUse: (() => Promise<void>) | undefined
  const removed: string[] = []
  const retention = new WorktreeRetention({
    file: join(root, "settings.json"), root: join(root, "checkouts"), worktrees: () => rows,
    finished: () => finished, using: async () => { await onUse?.(); return users },
    openFiles: async () => { if (failOpen) throw new Error("unknown files"); return open },
    repository: async (_row, refresh) => { reads++; await refresh("common"); return { head, blocked, remote: remoteProof, ignored } },
    fetch: async () => { fetches++ },
    remove: async p => { removed.push(p) },
    packagesRemoved: async () => { invalidated++; if (failInvalidation) throw new Error("invalidation failed") },
    now: () => now,
  })
  const configure = (mode: "preview" | "packages" | "checkout", days = 7) => retention.configure({ mode, days, kept: [] })
  const run = () => { now += MIN_RETIREMENT_PASS_MS; return retention.run() }
  const plan = async () => (await retention.preview()).checkouts[0]!
  const dirty = await plan()
  assert.equal(dirty.skip, null)
  assert.equal(dirty.packageSkip, null)
  assert.equal(dirty.packages.length, 1, "recent dirty/unpushed checkout still has a reinstallable package candidate")
  assert.equal(dirty.checkoutSkip, "dirty")
  const before = reads
  await run()
  assert.equal(reads, before, "preview mode does no automatic scans/fetches")
  finished = undefined
  assert.match((await plan()).skip ?? "", /not finished|unknown/)
  finished = now
  users = ["provider"]
  assert.match((await plan()).skip ?? "", /open/)
  users = []
  open = [join(path, "node_modules", "example", "index.js")]
  assert.match((await plan()).skip ?? "", /open/, "an open file protects packages even when process cwd is elsewhere")
  open = []
  failOpen = true
  assert.match((await plan()).skip ?? "", /unavailable/)
  failOpen = false
  rows.push({ ...rows[0]!, thread: other })
  assert.match((await plan()).skip ?? "", /Shared/)
  rows.pop()
  await retention.configure({ mode: "packages", days: 7, kept: [path] })
  assert.match((await plan()).skip ?? "", /Explicitly kept/)
  await configure("packages")
  const gitBeforePackages = reads, fetchBeforePackages = fetches
  await Promise.all([run(), run()])
  assert.equal(invalidated, 1)
  assert.equal(reads, gitBeforePackages, "package-only passes never inspect Git")
  assert.equal(fetches, fetchBeforePackages, "package-only passes never fetch")
  assert.deepEqual(removed, [])
  assert.equal(await readFile(join(path, "source.ts"), "utf8"), "DIRTY_SOURCE_FIXTURE")
  const beforeThrottle = reads
  await retention.run()
  assert.equal(reads, beforeThrottle)

  // Independent Git/age/private guards only hold the checkout.
  await mkdir(join(path, "node_modules"))
  await mkdir(join(path, ".venv"))
  await writeFile(join(path, ".venv", "pyvenv.cfg"), "FIXTURE=1")
  assert.equal((await plan()).packages.length, 2)
  blocked = null
  assert.match((await plan()).checkoutSkip ?? "", /not reachable/)
  remoteProof = true
  await writeFile(join(path, ".env.local"), "PRIVATE_FIXTURE=1")
  assert.match((await plan()).checkoutSkip ?? "", /Ignored private/)
  await configure("checkout")
  await run()
  assert.equal(await readFile(join(path, ".env.local"), "utf8"), "PRIVATE_FIXTURE=1")
  assert.deepEqual(removed, [])
  await rm(join(path, ".env.local")); ignored = []
  assert.match((await plan()).checkoutSkip ?? "", /within 7 days/)
  finished = 1
  rows = rows.map(row => ({ ...row, createdAt: 1 }))
  const old = new Date(now - 8 * 86400000)
  await utimes(join(path, "source.ts"), old, old)
  const eligible = await retention.preview()
  assert.equal(eligible.checkouts[0]!.checkoutSkip, null)
  assert.equal(eligible.repositoryFetches, 0, "Settings preview never fetches or prunes, even when it evaluates remote reachability")
  const beforeAutomaticFetch = fetches
  await run()
  assert.deepEqual(removed, [path])
  assert.equal(fetches - beforeAutomaticFetch, 1, "the automatic checkout pass still refreshes each repository only once")

  // Rechecks preserve ownership and physical install identity without gating packages on Git changes.
  await mkdir(join(path, "node_modules"))
  let uses = 0
  onUse = async () => { if (++uses === 3) rows = rows.map(row => ({ ...row, thread: other })) }
  const ownerChanged = await run()
  assert.match(ownerChanged.checkouts[0]!.skip ?? "", /ownership changed|conditions changed/)
  onUse = undefined; rows = rows.map(row => ({ ...row, thread }))
  uses = 0
  onUse = async () => {
    if (++uses === 3) { await rename(join(path, "node_modules"), join(root, "replaced-install")); await mkdir(join(path, "node_modules")) }
  }
  const replaced = await run()
  assert.match(replaced.checkouts[0]!.skip ?? "", /package folder changed/i)
  onUse = undefined
  failInvalidation = true
  const count = removed.length
  const failure = await run()
  assert.match(failure.checkouts[0]!.skip ?? "", /invalidation failed/)
  assert.equal(removed.length, count, "a failed package action cannot continue into checkout removal")
  failInvalidation = false
  await mkdir(join(path, "node_modules"))
  await mkdir(join(root, "settings.json.lock"))
  assert.match((await run()).checkouts[0]!.skip ?? "", /Another retirement/)
  await rmdir(join(root, "settings.json.lock"))
  await rm(join(path, "node_modules"), { recursive: true })
  await symlink(join(root, "replaced-install"), join(path, "node_modules"))
  assert.match((await plan()).packageSkip ?? "", /shared or linked/)
  await rm(join(path, "node_modules"))
  uses = 0
  onUse = async () => { if (++uses === 2) finished = undefined }
  assert.match((await plan()).skip ?? "", /resumed/)
  onUse = undefined
  retention.close()
  console.log("worktree retention: independent immediate packages; global/top-level Thread records; remote/current/detached HEAD; fetch cache; private data; open files; identity/resumption/claim/failure controls passed")
} finally { await rm(root, { recursive: true, force: true }) }
