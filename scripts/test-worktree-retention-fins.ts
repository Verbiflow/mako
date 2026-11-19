import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rename, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { Git } from "@mako/git"
import type { AgentRefused } from "@mako/host/contracts/agents"
import { ThreadIdSchema, type ThreadId } from "@mako/host/contracts/thread-identity"
import type { ThreadWorktree, WorktreeRestored } from "@mako/host/contracts/thread-worktrees"
import { FINISHED_CLOSE_MS } from "@mako/host/conversations/agents"
import { ThreadWorktreeService } from "@mako/host/workspaces/thread-worktrees"
import { MIN_RETIREMENT_PASS_MS, WorktreeRetention, WorktreeRetentionSettingsSchema } from "@mako/host/workspaces/worktree-retention"
import { AgentsWorld } from "./lib/agents-world.ts"

/**
 * The worktrees of Fins closed as finished go by themselves, and come back (`npm run test:thread-worktrees`).
 *
 * On 2026-11-17 no settings file had ever chosen removal, so nothing was ever removed: 76 worktrees belonged to open
 * Fins, 37 of them to Fins that finished over a week before. Now the checkout of a Fin Mako closed as finished is
 * retired in the default mode too, under every guard a checkout's retirement has, and nothing else changes.
 *
 * The pass, on fakes: with nothing chosen, a finished Fin's clean, pushed, quiet checkout goes, and no other Thread's;
 * each guard still keeps it (uncommitted or unpushed work, private ignored files, a process or an open file, the quiet
 * days, a folder shared or kept, several repositories); the person's switch keeps them all, in a file a build from
 * before it never reads, beside settings that build still parses; a Fin opened again as it goes is kept.
 *
 * The worktree, on real Git: retired, what it was is kept, and `restoreRetired` makes it again at its path on its
 * branch; on the branch made again at its commit when that was deleted; detached when another checkout holds the
 * branch; and says exactly why when its project is gone, changing nothing, until the project is back.
 *
 * The Fin, through the engine and the live engine: a message from its Apex, and the person writing in its own Thread
 * after a restart, each find the worktree made again before its harness is sent anything, in the same session; the Fin
 * reads how it went beneath the message and its Apex in the receipt; and when it can't be made again the message is
 * still delivered, saying why.
 */
const root = await realpath(await mkdtemp(join(tmpdir(), "mako-retirement-fins-")))
const git = new Git()
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, done: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}

function kept<T extends object>(value: T | AgentRefused): T {
  assert.ok(!("refused" in value), JSON.stringify(value))
  return value
}

/** A repository with a pushed `main`, and a worktree of it on `branch` holding one pushed commit. */
async function project(name: string, branch: string): Promise<{ repo: string; worktree: string; base: string; head: string }> {
  const repo = join(root, name, "project"), remote = join(root, name, "remote.git"), worktree = join(root, name, "worktrees", "fin")
  await mkdir(repo, { recursive: true })
  await git.output(repo, ["init", "-q", "-b", "main"])
  await git.output(repo, ["config", "user.name", "Test"])
  await git.output(repo, ["config", "user.email", "test@example.invalid"])
  await writeFile(join(repo, ".gitignore"), "node_modules/\n")
  await writeFile(join(repo, "README.md"), "Project\n")
  await git.output(repo, ["add", "."])
  await git.output(repo, ["commit", "-qm", "base"])
  const base = await git.output(repo, ["rev-parse", "HEAD"])
  await git.output(repo, ["init", "-q", "--bare", remote])
  await git.output(repo, ["remote", "add", "origin", remote])
  await git.output(repo, ["push", "-q", "origin", "main"])
  await mkdir(join(root, name, "worktrees"), { recursive: true })
  await git.output(repo, ["worktree", "add", "-q", "-b", branch, worktree])
  await writeFile(join(worktree, "work.ts"), "export const done = true\n")
  await git.output(worktree, ["add", "."])
  await git.output(worktree, ["commit", "-qm", "the Fin's work"])
  await git.output(worktree, ["push", "-q", "origin", branch])
  return { repo, worktree, base, head: await git.output(worktree, ["rev-parse", "HEAD"]) }
}

try {
  // ── The pass ──
  {
    const thread = ThreadIdSchema.parse("11111111-1111-4111-8111-111111111111")
    const person = ThreadIdSchema.parse("22222222-2222-4222-8222-222222222222")
    const checkouts = join(root, "pass", "checkouts")
    const path = join(checkouts, "fin"), own = join(checkouts, "person")
    for (const folder of [path, own]) {
      await mkdir(join(folder, "node_modules", "example"), { recursive: true })
      await writeFile(join(folder, "node_modules", "example", "index.js"), "module.exports = 1")
      await writeFile(join(folder, "source.ts"), "export {}")
    }
    let now = Date.now()
    const old = new Date(now - 8 * 86_400_000)
    for (const folder of [path, own]) await utimes(join(folder, "source.ts"), old, old)
    const row = (at: string, of: ThreadId): ThreadWorktree => ({ thread: of, path: at, project: at, repoRoot: at, branch: "fin/work", base: "a", createdAt: 1 })
    let rows = [row(path, thread), row(own, person)]
    let closed = new Set<ThreadId>([thread])
    let finished: number | undefined = 1
    let users: string[] = [], open: string[] = []
    let blocked: string | null = null, remote = true, ignored: string[] = []
    let reads = 0, invalidated = 0
    let onUse: (() => void) | undefined
    const removed: { path: string; finished: boolean }[] = []
    /** Whether each removal kept a record to make the worktree again, and what each removed. */
    const recorded = (): boolean[] => removed.map((each) => each.finished)
    const paths = (): string[] => removed.map((each) => each.path)
    const file = join(root, "pass", "settings.json")
    const retention = new WorktreeRetention({
      file, root: checkouts, worktrees: () => rows, finished: () => finished,
      closedFinished: (of) => closed.has(of),
      using: async () => { onUse?.(); return users }, openFiles: async () => open,
      repository: async (_row, refresh) => { reads++; await refresh("common"); return { head: "a", blocked, remote, ignored } },
      fetch: async () => {}, remove: async (at, fin) => { removed.push({ path: at, finished: fin }) },
      packagesRemoved: async () => { invalidated++ }, now: () => now,
    })
    const run = () => { now += MIN_RETIREMENT_PASS_MS; return retention.run() }
    assert.deepEqual(await retention.settings(), { mode: "preview", days: 7, kept: [] }, "nothing was ever chosen")
    const plan = async (at = path) => (await retention.preview()).checkouts.find((each) => each.path === at)!
    const keeps = async (what: string, why: RegExp) => {
      const before = removed.length
      const report = await run()
      assert.equal(removed.length, before, `${what}: nothing is removed`)
      const planned = report.checkouts.find((each) => each.path === path) ?? await plan()
      assert.match(planned.skip ?? planned.checkoutSkip ?? "", why, `${what}: ${JSON.stringify(planned)}`)
      console.log(`kept: ${what}`)
    }

    // Each guard a checkout's retirement has still holds it.
    blocked = "It has changes that aren't committed."
    await keeps("uncommitted changes", /aren't committed/)
    blocked = null; remote = false
    await keeps("commits no fetched remote ref holds", /not reachable/)
    remote = true; ignored = [".env.local"]
    await keeps("private ignored files", /Ignored private/)
    ignored = []; users = ["an open provider"]
    await keeps("a running process", /still has the checkout open/)
    users = []; open = [join(path, "source.ts")]
    await keeps("an open file", /still has the checkout open/)
    open = []; finished = now
    await keeps("a Fin that finished within the quiet days", /finished within 7 days/)
    finished = undefined
    await keeps("a Thread not known to have finished", /not finished/)
    finished = 1; rows = [row(path, thread), row(own, person), { ...row(path, person), path: join(path, "inner") }]
    await keeps("a folder another Thread shares", /Shared/)
    rows = [row(path, thread), row(own, person)]
    await retention.configure({ mode: "preview", days: 7, kept: [path] })
    await keeps("a checkout the person keeps", /Explicitly kept/)
    await retention.configure({ mode: "preview", days: 7, kept: [] })
    // A project folder of several repositories: its checkout isn't one worktree Mako can make again.
    const several = join(checkouts, "several")
    await mkdir(join(several, "api"), { recursive: true })
    await writeFile(join(several, "api", "source.ts"), "export {}")
    await utimes(join(several, "api", "source.ts"), old, old)
    const member: ThreadWorktree = { thread, path: join(several, "api"), project: join(root, "pass", "projects"), repoRoot: join(root, "pass", "projects", "api"), branch: "fin/work", base: "a", createdAt: 1 }
    rows = [member, row(own, person)]
    const report = await run()
    assert.deepEqual(removed, [])
    assert.match(report.checkouts.find((each) => each.path === several)?.checkoutSkip ?? "", /several repositories/)
    console.log("kept: a checkout of several repositories")
    rows = [row(path, thread), row(own, person)]

    // The person's switch keeps them all, in a file of its own; the settings beside it stay as a build from before reads them.
    await retention.configure({ mode: "preview", days: 7, kept: [], finishedFins: false })
    assert.deepEqual(await retention.settings(), { mode: "preview", days: 7, kept: [], finishedFins: false })
    assert.deepEqual(WorktreeRetentionSettingsSchema.parse(JSON.parse(await readFile(file, "utf8"))), { mode: "preview", days: 7, kept: [] }, "a build from before the switch still reads the settings")
    assert.deepEqual(JSON.parse(await readFile(join(root, "pass", "settings-fins.json"), "utf8")), { keep: true })
    const readsOff = reads
    await run()
    assert.deepEqual(removed, [])
    assert.equal(reads, readsOff, "turned off, the pass reads nothing, as preview always did")
    assert.equal((await plan()).finished, undefined)
    await retention.configure({ mode: "preview", days: 7, kept: [] })
    assert.equal(existsSync(join(root, "pass", "settings-fins.json")), false, "turned on again, the file goes")

    // A Fin opened again while its retirement is checked keeps its checkout.
    let uses = 0
    onUse = () => { if (++uses === 3) closed = new Set() }
    const reopened = await run()
    assert.deepEqual(removed, [])
    assert.match(reopened.checkouts.find((each) => each.path === path)?.skip ?? "", /opened again|conditions changed/)
    onUse = undefined
    closed = new Set()
    const readsOpen = reads
    await run()
    assert.equal(reads, readsOpen, "with no Fin closed as finished, the default pass reads nothing")
    closed = new Set([thread])

    // Nothing holds it: it goes, by default, and nothing else does.
    assert.equal((await plan()).finished, true)
    assert.equal((await plan()).checkoutSkip, null)
    assert.equal((await plan(own)).finished, undefined)
    assert.deepEqual(removed, [], "a preview removes nothing")
    const passed = await run()
    assert.deepEqual(removed, [{ path, finished: true }], "the finished Fin's checkout is retired, to be made again when it's reached")
    assert.deepEqual(passed.checkouts.map((each) => each.path), [path], "the person's own Thread's checkout isn't looked at in preview")
    assert.equal(invalidated, 0, "installed packages are reclaimed by themselves only where the person chose that")
    assert.equal(existsSync(join(own, "node_modules")), true)
    assert.equal(existsSync(join(path, "node_modules")), true, "the pass removes through `remove` alone")
    // Where the person chose checkout removal every finished Thread's goes, and the Fin's is still kept on record.
    removed.length = 0
    await retention.configure({ mode: "checkout", days: 7, kept: [] })
    await run()
    assert.deepEqual(paths(), [path, own])
    assert.deepEqual(recorded(), [true, false], "the Fin's is made again when it's reached; the person's own Thread's goes as it always did")
    retention.close()
  }
  console.log("the pass: a finished Fin's checkout goes by default under every guard, and nothing else does")

  // ── The worktree ──
  {
    const { repo, worktree, base, head } = await project("worktree", "fin/labels")
    const world = new AgentsWorld({ root: join(root, "worktree", "host"), script: () => "ok" })
    const apex = await world.apex("codex", "full")
    const thread = ThreadIdSchema.parse(world.store.journalPlacement(apex.conversation)!.thread)
    const service = new ThreadWorktreeService(git, join(root, "worktree", "mako"), world.store)
    const attach = () => world.store.attachWorktree({ path: worktree, thread, repoRoot: repo, project: repo, branch: "fin/labels", base })
    const retire = async () => {
      await service.remove(worktree, "finished")
      assert.equal(existsSync(worktree), false, "the folder is gone")
      assert.deepEqual(world.store.worktrees(), [], "and its row")
    }
    const restored = (found: WorktreeRestored | undefined) => {
      assert.ok(found?.kind === "restored", JSON.stringify(found))
      return found
    }
    attach()
    await mkdir(join(worktree, "node_modules", "example"), { recursive: true })
    await writeFile(join(worktree, "node_modules", "example", "index.js"), "module.exports = 1")
    await retire()
    const [record] = world.store.retiredWorktrees()
    assert.deepEqual(record && { path: record.path, thread: record.thread, repoRoot: record.repoRoot, branch: record.branch, head: record.head, base: record.base }, { path: worktree, thread, repoRoot: repo, branch: "fin/labels", head, base }, "what it was is kept")
    assert.equal(await git.succeeds(repo, ["show-ref", "--verify", "--quiet", "refs/heads/fin/labels"]), true, "its branch stays")
    assert.equal(await service.restoreRetired(join(root, "elsewhere")), undefined, "a folder no retired worktree held asks nothing")

    // On its branch, at its path.
    const first = restored(await service.restoreRetired(join(worktree, "src")))
    assert.deepEqual({ path: first.path, branch: first.branch, head: first.head }, { path: worktree, branch: "fin/labels", head })
    assert.match(first.note, /^on its branch fin\/labels\. Its files are that commit's: installed packages and build output went with the folder/)
    assert.equal(await readFile(join(worktree, "work.ts"), "utf8"), "export const done = true\n")
    assert.equal(await git.output(worktree, ["symbolic-ref", "--short", "HEAD"]), "fin/labels")
    assert.equal(await git.output(worktree, ["status", "--porcelain"]), "", "a clean checkout of its commit")
    assert.equal(existsSync(join(worktree, "node_modules")), false, "installed packages aren't brought back")
    assert.deepEqual(world.store.worktrees().map((each) => [each.path, each.thread, each.branch]), [[worktree, thread, "fin/labels"]], "its row is back")
    assert.deepEqual(world.store.retiredWorktrees(), [], "and the record is done with")
    assert.equal(await service.restoreRetired(worktree), undefined, "made again once")

    // Its branch deleted since, as a merged pull request's is: made again at the commit it was at.
    await retire()
    await git.output(repo, ["branch", "-q", "-D", "fin/labels"])
    const second = restored(await service.restoreRetired(worktree))
    assert.equal(second.branch, "fin/labels")
    assert.match(second.note, /^on its branch fin\/labels, which was deleted since and is made again at \w{8}, the commit it was at\./)
    assert.equal(await git.output(worktree, ["rev-parse", "HEAD"]), head)
    assert.equal(await git.output(worktree, ["symbolic-ref", "--short", "HEAD"]), "fin/labels")

    // Another checkout holds its branch: detached at its tip, which says where.
    await retire()
    const other = join(root, "worktree", "worktrees", "other")
    await git.output(repo, ["worktree", "add", "-q", other, "fin/labels"])
    const third = restored(await service.restoreRetired(worktree))
    assert.equal(third.branch, undefined)
    assert.ok(third.note.startsWith(`detached at the tip of fin/labels, because ${other} has that branch checked out.`), third.note)
    assert.equal(await git.output(worktree, ["rev-parse", "HEAD"]), head)
    await git.output(repo, ["worktree", "remove", "--force", other])

    // Its project gone: said exactly, nothing changed, the record kept; back once the project is.
    await git.output(worktree, ["checkout", "-q", "fin/labels"])
    await retire()
    await rename(repo, `${repo}.moved`)
    const gone = await service.restoreRetired(worktree)
    assert.deepEqual(gone, { kind: "failed", path: worktree, why: `its project, ${repo}, isn't a repository on this Mac anymore: it was moved or deleted.` })
    assert.equal(existsSync(worktree), false)
    assert.equal(world.store.retiredWorktrees().length, 1, "the record waits for the next try")
    await rename(`${repo}.moved`, repo)
    // Other files where it was: never written over.
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, "notes.txt"), "someone's notes")
    const taken = await service.restoreRetired(worktree)
    assert.ok(taken?.kind === "failed" && /holds other files now/.test(taken.why), JSON.stringify(taken))
    assert.equal(await readFile(join(worktree, "notes.txt"), "utf8"), "someone's notes")
    await rm(worktree, { recursive: true })
    restored(await service.restoreRetired(worktree))
    assert.equal(await git.output(worktree, ["symbolic-ref", "--short", "HEAD"]), "fin/labels")
    await world.close()
  }
  console.log("the worktree: retired with what it was kept, and made again on its branch, on the branch made again, detached, or not, saying exactly why")

  // ── The Fin ──
  {
    const { repo, worktree, base } = await project("fin", "fin/notes")
    // Six hours pass on the one clock the engine, the journals and the store all read.
    let offset = 0
    const wallNow = Date.now.bind(Date)
    const clock = mock.method(Date, "now", () => wallNow() + offset)
    let service: ThreadWorktreeService | undefined
    const there: { text: string; folder: boolean }[] = []
    const world = new AgentsWorld({
      root: join(root, "fin", "host"),
      // Its sessions say the folder they were started in, as a harness's do.
      elsewhere: true,
      script: (turn) => {
        if (turn.text.includes("You're fin:") || turn.conversation === fin) {
          // What its harness would find as it takes the prompt: its folder there, or not.
          there.push({ text: turn.text, folder: existsSync(join(worktree, "work.ts")) })
          return "Notes written."
        }
        return "ok"
      },
      restoreWorktree: (_conversation, cwd) => service?.restoreRetired(cwd),
    })
    service = new ThreadWorktreeService(git, join(root, "fin", "mako"), world.store)
    const apex = await world.apex("codex", "full")
    let fin = ""
    const started = kept(await world.agents.start(apex.caller, { brief: { objective: "Write the notes" }, harness: "claude", name: "notes", clientKey: "notes", cwd: worktree }))
    fin = started.conversation!
    const child = ThreadIdSchema.parse(started.child)
    await world.settle(400)
    assert.equal(world.live.session(fin)?.cwd, worktree, "the Fin works in its worktree")
    world.store.attachWorktree({ path: worktree, thread: child, repoRoot: repo, project: repo, branch: "fin/notes", base })
    const native = world.live.session(fin)?.nativeId
    /** Six hours on it closes, and its worktree is retired from under it. */
    const closeAndRetire = async () => {
      await world.settle(400)
      offset += FINISHED_CLOSE_MS + 60_000
      await world.agents.closeFinished()
      assert.equal(world.store.edges().of(child)?.closedAt !== undefined, true, `closed: ${world.agents.keptOpenBy(child)}`)
      // As the retention pass does once it's idle: its harness asleep, nothing running in the folder.
      await world.restart()
      // The next host's store, and its worktrees over it.
      service = new ThreadWorktreeService(git, join(root, "fin", "mako"), world.store)
      await service.remove(worktree, "finished")
      assert.equal(existsSync(worktree), false)
      assert.equal(world.live.session(fin)?.cwd, worktree, "its conversation still names its own folder, never the project's")
    }

    // Its Apex's message: the worktree is there before its harness takes the prompt, which says how it came back.
    await closeAndRetire()
    const sent = kept(await world.agents.send(world.caller(apex.conversation), { to: "notes", text: "Add a section on retries.", clientKey: "retries" }))
    assert.match(sent.hears, /Its worktree, removed after it finished, was made again on its branch fin\/notes\.$/, sent.hears)
    await until("its turn", () => there.length === 2)
    assert.equal(there[1]!.folder, true, "its folder was made again before its harness was sent anything")
    assert.ok(there[1]!.text.includes("Add a section on retries."))
    assert.ok(there[1]!.text.includes(`[mako · your worktree was removed after you finished, and is made again at ${worktree} on its branch fin/notes. Its files are that commit's: installed packages and build output went with the folder, so install again before you build or test.]`), there[1]!.text)
    assert.equal(world.live.session(fin)?.nativeId, native, "the same session")
    assert.equal(world.live.session(fin)?.cwd, worktree)
    assert.equal(await git.output(worktree, ["symbolic-ref", "--short", "HEAD"]), "fin/notes")
    assert.equal(world.store.edges().of(child)?.closedAt, undefined)

    // The person writing in its own Thread: the live engine makes it again as it wakes the session.
    await closeAndRetire()
    world.say(fin, "And one on timeouts.")
    await until("its turn for the person", () => there.length === 3)
    assert.equal(there[2]!.folder, true, "made again before its session woke")
    assert.ok(there[2]!.text.includes("And one on timeouts."))
    assert.equal(world.live.session(fin)?.nativeId, native)
    assert.equal(world.live.session(fin)?.cwd, worktree, "in its own folder, not the project's")
    assert.deepEqual(world.store.retiredWorktrees(), [])

    // It can't be made again: the message is delivered all the same, and says exactly why, to the Fin and to its Apex.
    await closeAndRetire()
    await rename(repo, `${repo}.moved`)
    const late = kept(await world.agents.send(world.caller(apex.conversation), { to: "notes", text: "One more pass.", clientKey: "again" }))
    assert.ok(late.hears.includes(`Mako couldn't make notes's worktree again, removed after it finished: its project, ${repo}, isn't a repository on this Mac anymore: it was moved or deleted.`), late.hears)
    await until("its turn without a worktree", () => there.length === 4)
    assert.ok(there[3]!.text.includes("One more pass."), "never refused, never lost")
    assert.ok(there[3]!.text.includes(`[mako · your worktree at ${worktree} was removed after you finished, and Mako couldn't make it again: its project, ${repo}, isn't a repository on this Mac anymore: it was moved or deleted. You may be in the project's own folder`), there[3]!.text)
    assert.equal(world.live.session(fin)?.nativeId, native)
    await rename(`${repo}.moved`, repo)
    await world.settle(400)
    await world.close()
    clock.mock.restore()
  }
  console.log("the Fin: its Apex's message and the person's own each found its worktree made again first, in the same session; one that couldn't be was still delivered, saying why")
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log("finished Fins' worktrees: ok")
