import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { subscribe } from "node:diagnostics_channel"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { mock } from "node:test"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { Git, type GitTrace } from "@mako/git"
import { HostStopping } from "@mako/host/base/host-stopping"
import type { WorktreeSummary, WorktreeSummaryChanges } from "@mako/host/contracts/thread-worktrees"
import { writtenPaths } from "@mako/host/attribution/written-paths"
import { checkoutStatuses } from "@mako/host/git/checkout-status"
import { forgetGitHubReads, githubStatus, listBranchPulls } from "@mako/host/git/github"
import { ThreadStore } from "@mako/host/threads/store"
import { ThreadWorktreeService } from "@mako/host/workspaces/thread-worktrees"
import type { WatchListener } from "@mako/host/workspaces/watch-backend"
import { WatchedTrees } from "@mako/host/workspaces/watched-trees"
import { WorktreeSummaryCache } from "@mako/host/workspaces/worktree-summary-cache"

/**
 * The worktree summaries as a host with many worktrees pays for them, counted in Git processes: an ask answers at
 * once with what's held while a pass is held open; a pass after a restart with nothing moved starts none; one
 * worktree's commit reads that worktree; the main checkout moving counts every branch in one process and reads the
 * landings a window shows first, the rest spread; an event carries only what changed, and a window that knows only the
 * whole list still gets it; a status is read fresh for what decides and taken from what's held, or from a tab's
 * watcher, for what only shows; a turn editing two hundred files costs a read or two and an edit outside Mako in a
 * shown worktree is counted within seconds, while a worktree nobody shows costs nothing; an inventory asks Git
 * nothing; an older Git counts the same; the file loses nothing between builds; and a merged pull request gets no
 * check read. `npx tsx scripts/test-worktree-summary-passes.ts`
 */

/** A child process as Node says it was made (`child_process` channel): its command line is there once it has started. */
const SpawnedSchema = z.object({ process: z.object({ spawnargs: z.array(z.string()) }) })
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-summary-passes-")))
const WORKTREES = 12
/** Past the wait a write's status read is put off by (`FILES_SETTLE_MS`), with room for the read. */
const FILES_WAIT_MS = 4_500
const noWatch = async () => ({ unsubscribe: async () => {} })

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function repository(name: string): string {
  const path = join(root, name)
  mkdirSync(join(path, "src"), { recursive: true })
  git(path, "init", "-q", "-b", "main")
  git(path, "config", "user.email", "test@example.invalid")
  git(path, "config", "user.name", "Test")
  for (let file = 0; file < 40; file += 1) writeFileSync(join(path, "src", `file-${file}.ts`), `export const value = ${file}\n`)
  // Submodules to set up keep spares from being made, whose own Git processes would be counted with a pass's.
  writeFileSync(join(path, ".gitmodules"), "")
  git(path, "add", ".")
  git(path, "commit", "-q", "-m", "first")
  return path
}

function commit(cwd: string, file: string, text: string, message: string): string {
  writeFileSync(join(cwd, file), text)
  git(cwd, "add", file)
  git(cwd, "commit", "-q", "-m", message)
  return git(cwd, "rev-parse", "HEAD")
}

/** Every Git process a runner finished, with when; the words that name it, without `-c` settings. */
interface Counted { command: string; cwd: string; args: readonly string[]; at: number }
function counting() {
  const ran: Counted[] = []
  const words = (trace: GitTrace) => trace.args.filter((word, index) => word !== "-c" && trace.args[index - 1] !== "-c" && word !== "--no-optional-locks")
  return { git: new Git({ trace: (trace) => ran.push({ command: words(trace).slice(0, 2).join(" "), cwd: trace.cwd, args: words(trace), at: performance.now() }) }), ran }
}
const named = (ran: readonly Counted[], command: string) => ran.filter((each) => each.command.startsWith(command))

const threads = new ThreadStore(join(root, "threads.sqlite"))
const repo = repository("repo")
const worktreesRoot = join(root, "worktrees")
const shown = new Set<string>()
let working: () => Promise<string[]> = async () => []
/** The host's tree watches, over a backend that delivers what the test says changed: no watcher runs here. */
const trees = new WatchedTrees()
const delivering = new Map<string, WatchListener>()
const treeBackend = trees.over(Object.assign(async (watched: string, _ignore: readonly string[], listener: WatchListener) => {
  delivering.set(watched, listener)
  return { unsubscribe: async () => { delivering.delete(watched) } }
}, { recover: () => {}, paced: () => {} }))
const quietListener: WatchListener = { events: () => {}, dropped: () => {}, gone: () => {}, muted: () => {} }
const service = (runner: Git) => new ThreadWorktreeService(runner, worktreesRoot, threads, undefined, undefined, undefined, undefined, undefined, undefined, () => working(), undefined, undefined, noWatch, { shown: (path) => shown.has(path), heard: (path) => trees.covers(path) })

async function make(worktrees: ThreadWorktreeService, from: string, name: string) {
  const id = randomUUID()
  threads.registerJournal({ conversationId: id, createdAt: Date.now(), bindings: [], harness: "codex" }, { kind: "service", name: "migration" })
  const made = await worktrees.prepare(id, from, name)
  await worktrees.attach(id)
  return made
}

const first = counting()
const made: Awaited<ReturnType<typeof make>>[] = []
let before = service(first.git)
for (let n = 0; n < WORKTREES; n += 1) made.push(await make(before, repo, `Work ${n}`))
// Half have work committed, so their landing takes a merge in memory; the others never committed.
const open = made.filter((_, n) => n % 2 === 0)
for (const [n, worktree] of open.entries()) commit(worktree.path, `own-${n}.txt`, `${n}\n`, `work ${n}`)

try {
  // --- A cold pass, for what the numbers below are measured against: nothing held, every worktree read.
  first.ran.length = 0
  const coldBegan = performance.now()
  const cold = await before.summaries()
  const coldMs = Math.round(performance.now() - coldBegan)
  const coldProcesses = first.ran.length
  assert.equal(cold.length, WORKTREES)
  assert.deepEqual(cold.filter((summary) => summary.landing.kind === "open").map((summary) => summary.path).sort(), open.map((worktree) => worktree.path).sort())
  assert.ok(cold.every((summary) => summary.behind?.commits === 0 && summary.changes === 0))
  assert.equal(named(first.ran, "status").length, WORKTREES, "a cold pass reads each worktree's status once")
  assert.equal(named(first.ran, "for-each-ref").length, 1, "and counts every branch against the main checkout in one process")
  assert.deepEqual([...named(first.ran, "symbolic-ref"), ...named(first.ran, "config")], [], "the start point, read when the first worktree was made, isn't read again")
  const coldCommands = [...new Set(first.ran.map((each) => each.command))].map((command) => `${command} x${named(first.ran, command).length}`)

  // --- The same pass again: nothing moved, so nothing is asked of Git.
  first.ran.length = 0
  assert.deepEqual(await before.summaries(), cold)
  assert.deepEqual(first.ran.map((each) => each.command), [], "a pass that finds everything as it was starts no Git process")

  // --- An ask answers at once with what's held, while the pass behind it is held open.
  let release!: () => void
  let entered!: () => void
  const inPass = new Promise<void>((resolve) => { entered = resolve })
  working = () => new Promise((resolve) => {
    entered()
    release = () => resolve([])
  })
  const answered = performance.now()
  const held = await before.heldNow(undefined, "changes")
  const answerMs = performance.now() - answered
  await inPass
  assert.deepEqual(held.summaries, cold, "every summary held is in the answer")
  assert.deepEqual(held.reading, [], "and none is marked as still being read: all were read by this host")
  assert.ok(answerMs < 200, `the answer took ${answerMs.toFixed(0)} ms while a pass was held open`)
  let passDone = false
  const passing = before.summaries().then(() => { passDone = true })
  await delay(50)
  assert.equal(passDone, false, "the pass is still open behind the answer")
  assert.deepEqual((await before.heldNow(undefined, "changes")).summaries, cold, "a second ask mid-pass answers at once too")
  release()
  working = async () => []
  await passing

  // --- A restart: a new host, with what the last one held read from its file.
  await before.closeSummaries()
  const file = join(worktreesRoot, "summaries.json")
  const stored = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(stored.version, 1, "the file says its format")
  assert.equal(Object.keys(stored.worktrees).length, WORKTREES)
  // A field a newer build added is written back as it was.
  const entryOf = Object.keys(stored.worktrees)[0]!
  writeFileSync(file, JSON.stringify({ ...stored, later: { kept: true }, worktrees: { ...stored.worktrees, [entryOf]: { ...stored.worktrees[entryOf], measured: 7 } } }))
  const second = counting()
  const after = service(second.git)
  const changes: WorktreeSummaryChanges[] = []
  const wholes: WorktreeSummary[][] = []
  after.followSummaryChanges((said) => changes.push(said))
  after.followSummaries((summaries) => wholes.push(summaries))
  const restarted = await after.heldNow(undefined, "changes")
  assert.deepEqual(restarted.summaries, cold, "a host that just started answers with what the last one held")
  assert.deepEqual([...restarted.reading].sort(), made.map((worktree) => worktree.path).sort(), "each marked as still being read until this host has looked")
  const warmBegan = performance.now()
  assert.deepEqual(await after.summaries(), cold)
  const warmMs = Math.round(performance.now() - warmBegan)
  assert.deepEqual(second.ran.map((each) => each.command), [], "the first pass after a restart with nothing moved starts no Git process")
  assert.deepEqual((await after.heldNow(undefined, "changes")).reading, [], "and after it nothing is marked as being read")
  assert.deepEqual(changes.flatMap((said) => said.changed.map((summary) => summary.path)).sort(), made.map((worktree) => worktree.path).sort(), "each summary is said once looked at, to whoever only listens")
  before = after

  // --- One worktree's commit: that worktree is read, and no other.
  const [busy, ...others] = made
  assert.ok(busy)
  second.ran.length = 0
  changes.length = 0
  commit(busy.path, "more.txt", "more\n", "more work")
  const committed = await before.summaries()
  const busySummary = committed.find((summary) => summary.path === busy.path)
  assert.deepEqual([busySummary?.ahead, busySummary?.landing], [2, { kind: "open", into: "main", commits: 2 }])
  assert.deepEqual(named(second.ran, "status").map((each) => each.cwd), [busy.path], "only the worktree that committed has its status read")
  assert.ok(second.ran.length <= 6, `one commit cost ${second.ran.length} Git processes, not at most 6: ${second.ran.map((each) => each.command).join(", ")}`)
  const busyTip = git(busy.path, "rev-parse", "HEAD")
  const aboutBusy = (each: Counted) => each.cwd === busy.path || each.args.some((word) => word.includes(busy.branch) || word.includes(busyTip))
  // Git's version, asked once by a host, and the main checkout's tree, read once per commit of it, are no worktree's.
  const shared = (each: Counted) => each.command === "version" || each.command.startsWith("rev-parse") && each.args.some((word) => word.endsWith("^{tree}"))
  assert.deepEqual(second.ran.filter((each) => !aboutBusy(each) && !shared(each)).map((each) => each.args.join(" ")), [], "and every process is about that worktree")
  const commitProcesses = second.ran.map((each) => each.command)
  await Promise.resolve()
  assert.deepEqual(changes.map((said) => said.changed.map((summary) => summary.path)), [[busy.path]], "the event carries the one summary that changed")
  assert.deepEqual(changes[0]?.removed, [])

  // --- A turn's end in one worktree: its own event reads it, nobody asking.
  second.ran.length = 0
  changes.length = 0
  writeFileSync(join(others[0]!.path, "edited.txt"), "edit\n")
  before.turnEnded(others[0]!.path)
  for (const deadline = performance.now() + 10_000; !changes.length; await delay(25)) if (performance.now() > deadline) throw new Error("the turn's end was never said")
  assert.deepEqual(changes.flatMap((said) => said.changed.map((summary) => [summary.path, summary.changes])), [[others[0]!.path, 1]])
  assert.deepEqual(second.ran.map((each) => [each.command, each.cwd]), [["status --porcelain", others[0]!.path]], "a turn's end costs one status of its worktree")
  rmSync(join(others[0]!.path, "edited.txt"))
  before.turnEnded(others[0]!.path)
  for (const deadline = performance.now() + 10_000; changes.length < 2; await delay(25)) if (performance.now() > deadline) throw new Error("the second turn's end was never said")

  // --- The main checkout moves: every branch is counted in one process, the landings a window shows are read first,
  // and the rest one at a time.
  const shownNow = [open[4]!.path, open[5]!.path]
  for (const path of shownNow) shown.add(path)
  // Shown for the first time since this host started: the count the last host left is read again, once.
  second.ran.length = 0
  await before.summaries()
  assert.deepEqual(named(second.ran, "status").map((each) => each.cwd).sort(), [...shownNow].sort(), "a worktree a window shows has the status the last host left read again")
  await before.summaries()
  assert.equal(named(second.ran, "status").length, shownNow.length, "once")
  second.ran.length = 0
  changes.length = 0
  const saidBehind = new Map<string, number>()
  after.followSummaryChanges((said) => {
    changes.push(said)
    for (const summary of said.changed) if (summary.behind?.commits === 1 && !saidBehind.has(summary.path)) saidBehind.set(summary.path, performance.now())
  })
  const target = commit(repo, "main-moved.txt", "moved\n", "main moves")
  const movedBegan = performance.now()
  const moved = await before.summaries()
  const movedMs = Math.round(performance.now() - movedBegan)
  assert.ok(moved.every((summary) => summary.behind?.commits === 1), "every worktree is a commit behind")
  assert.deepEqual(moved.filter((summary) => summary.landing.kind === "open").length, open.length, "and each open branch is still open against the new commit")
  assert.deepEqual(named(second.ran, "status"), [], "the main checkout moving reads no worktree's status")
  assert.equal(named(second.ran, "for-each-ref").length, 1, "every branch's ahead and behind are counted in one process")
  assert.deepEqual(named(second.ran, "rev-list"), [], "none is counted on its own")
  const merges = named(second.ran, "merge-tree")
  assert.equal(merges.length, open.length, "each open branch's landing is asked again, a merge in memory")
  assert.ok(merges.every((each) => each.args.includes(target)), "against the main checkout's new commit")
  const tipOf = new Map(open.map((worktree) => [git(worktree.path, "rev-parse", "HEAD"), worktree.path]))
  const order = merges.map((each) => tipOf.get(each.args.at(-1) ?? ""))
  assert.deepEqual(order.slice(0, shownNow.length).sort(), [...shownNow].sort(), "the worktrees a window shows are read first")
  const rest = merges.slice(shownNow.length)
  const gaps = rest.slice(1).map((each, index) => each.at - rest[index]!.at)
  assert.ok(gaps.every((gap) => gap >= 100), `the rest are read one at a time, apart: ${gaps.map((gap) => gap.toFixed(0)).join(", ")} ms`)
  assert.equal(saidBehind.size, WORKTREES)
  assert.ok(Math.max(...saidBehind.values()) < (rest[1]?.at ?? Infinity), "every worktree's count is said before the landings that wait are read")
  const movedProcesses = second.ran.length

  // --- The whole list, for a window that knows only that form: not said while windows take changes, and said again
  // once one asks the old way. (A host no window has asked says it too: `test-thread-worktrees.ts` hears it that way.)
  after.followSummaryChanges((said) => changes.push(said))
  const wholeBefore = wholes.length
  assert.equal(wholeBefore, 0, "the only window asked for changes, so through a restart, a commit and the main checkout moving the whole list was never said")
  changes.length = 0
  commit(busy.path, "third.txt", "3\n", "third")
  const third = await after.summaries()
  await Promise.resolve()
  assert.equal(wholes.length, wholeBefore, "once windows take changes, the whole list isn't said on every change")
  assert.deepEqual(changes.map((said) => said.changed.map((summary) => summary.path)), [[busy.path]])
  // A window that folds the changes into the answer it got holds what a whole list would say.
  const folded = new Map(moved.map((summary) => [summary.path, summary]))
  for (const said of changes) {
    for (const summary of said.changed) folded.set(summary.path, summary)
    for (const path of said.removed) folded.delete(path)
  }
  assert.deepEqual([...folded.values()], third)
  const oldForm = await after.heldNow(undefined, "whole")
  assert.deepEqual(oldForm.summaries, third, "a window of an earlier build is answered with the list")
  commit(busy.path, "fourth.txt", "4\n", "fourth")
  const fourth = await after.summaries()
  assert.deepEqual(wholes.at(-1), fourth, "and hears the whole list again on a change")
  assert.ok(wholes.length > wholeBefore)

  // --- A checkout's status: those who need it as of now share one read made after they asked; those who only show
  // it take the one held while nothing has signalled since; and a checkout a tab has open is read from its watcher.
  const statuses = checkoutStatuses(second.git)
  const statusReads = (path = busy.path) => second.ran.filter((each) => each.command === "status --porcelain" && each.cwd === path).length
  second.ran.length = 0
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => statuses.read(busy.path, { fresh: true }))), ["", "", "", "", ""])
  assert.equal(statusReads(), 1, "five who ask for it as of now at once cost one status")
  await Promise.all(Array.from({ length: 5 }, () => statuses.read(busy.path)))
  assert.equal(statusReads(), 1, "and those who only show it take that one: nothing has signalled since")
  assert.equal((await after.review(busy.path)).commits, 4)
  assert.equal(statusReads(), 2, "a review decides on its own read")
  writeFileSync(join(busy.path, "unsaved.txt"), "x\n")
  assert.match((await after.removal(busy.path)).held ?? "", /has changes that aren't committed/, "what a removal would meet is read after it's asked, never taken from before")
  assert.equal((await after.review(busy.path)).merge.ok, false, "and so is a review's")
  rmSync(join(busy.path, "unsaved.txt"))
  assert.equal((await after.removal(busy.path)).held, null)
  const beforeSignal = statusReads()
  statuses.touched(busy.path)
  await Promise.all(Array.from({ length: 3 }, () => statuses.read(busy.path)))
  assert.equal(statusReads(), beforeSignal + 1, "after a signal, those who show it share one read")
  // A tab has the worktree open: its watcher keeps the status, and showing it starts no process of its own.
  const tab = await second.git.openRepository(busy.path)
  assert.ok(tab)
  const closeTab = tab.watch()
  await tab.status()
  second.ran.length = 0
  statuses.touched(busy.path)
  assert.equal(await statuses.read(busy.path), "")
  writeFileSync(join(busy.path, "in-tab.txt"), "x\n")
  tab.changed(["in-tab.txt"])
  statuses.touched(busy.path)
  assert.equal(await statuses.read(busy.path), "?? in-tab.txt", "what the tab's watcher holds is what's shown")
  assert.equal(statusReads(), 0, "with no status process of the summaries' own")
  rmSync(join(busy.path, "in-tab.txt"))
  tab.changed(["in-tab.txt"])
  statuses.touched(busy.path)
  closeTab()

  // --- What reads a worktree's status between its Git events: a tool's write, a file event while a window shows
  // it, the window coming to focus. A worktree nobody shows and nothing writes in costs nothing.
  const said = (path: string) => changes.flatMap((each) => each.changed).filter((summary) => summary.path === path).at(-1)?.changes
  const until = async (what: string, done: () => boolean, ms = 20_000) => {
    for (const deadline = performance.now() + ms; !done(); await delay(50)) if (performance.now() > deadline) throw new Error(`never: ${what}`)
  }
  await after.summaries()
  second.ran.length = 0
  changes.length = 0
  // An agent's turn editing two hundred files through its tools, over a second and a half.
  const edited = others[1]!
  for (let n = 0; n < 200; n += 1) {
    writeFileSync(join(edited.path, `edit-${n}.txt`), "x\n")
    after.wrote([join(edited.path, `edit-${n}.txt`)])
    if (n % 20 === 19) await delay(150)
  }
  const lastEdit = performance.now()
  await until("the turn's edits counted", () => said(edited.path) === 200)
  const editsSeenMs = Math.round(performance.now() - lastEdit)
  const editReads = statusReads(edited.path)
  assert.ok(editReads <= 2, `two hundred edits cost ${editReads} status reads, not at most 2`)
  assert.ok(editsSeenMs < 8_000, `the count was right ${editsSeenMs} ms after the last edit`)
  // More writes straight after are waited out longer: the reads of one long turn stay a handful.
  for (let n = 200; n < 230; n += 1) {
    writeFileSync(join(edited.path, `edit-${n}.txt`), "x\n")
    after.wrote([join(edited.path, `edit-${n}.txt`)])
  }
  await until("the later edits counted", () => said(edited.path) === 230)
  assert.ok(statusReads(edited.path) <= editReads + 1)
  assert.deepEqual(named(second.ran, "status").filter((each) => each.cwd !== edited.path), [], "and no other worktree was read for them")

  // What a finished call says it wrote: the files it changed, and the folder of a command that may have written.
  assert.deepEqual(writtenPaths([
    { kind: "modify", path: "/w/a/src/x.ts" }, { kind: "read", path: "/w/a/README" }, { kind: "rename", from: "/w/a/old", to: "/w/a/new" },
    { kind: "command", command: "git status" }, { kind: "command", command: "npm test", cwd: "/w/a/web" }, { kind: "command", command: "make build" },
  ], "/w/a"), ["/w/a/src/x.ts", "/w/a/old", "/w/a/new", "/w/a/web", "/w/a"], "a read and a command that only reads name nothing")

  // An edit outside Mako, in a worktree a window shows that a tree watch the host already keeps covers.
  const [watchedShown, watchedUnshown, plainShown] = [open[4]!, others[4]!, open[5]!]
  trees.follow((watched, paths) => after.filesHeard(watched, paths))
  await treeBackend(watchedShown.path, [], quietListener)
  await treeBackend(watchedUnshown.path, [], quietListener)
  assert.equal(trees.covers(join(watchedShown.path, "src")), true)
  // A watch that just began heard nothing of what came before it: the shown one is read once.
  await until("the shown worktree read as its watch began", () => statusReads(watchedShown.path) === 1)
  second.ran.length = 0
  changes.length = 0
  writeFileSync(join(watchedShown.path, "outside.txt"), "x\n")
  delivering.get(watchedShown.path)?.events([{ path: join(watchedShown.path, "outside.txt"), type: "create" }])
  const outsideAt = performance.now()
  await until("the outside edit counted", () => said(watchedShown.path) === 1)
  const outsideSeenMs = Math.round(performance.now() - outsideAt)
  assert.ok(outsideSeenMs < 8_000, `an edit outside Mako in a shown worktree was on its row after ${outsideSeenMs} ms`)
  assert.equal(statusReads(watchedShown.path), 1)
  // The same in a worktree nobody shows: heard, and not read until a window shows it.
  writeFileSync(join(watchedUnshown.path, "outside.txt"), "x\n")
  delivering.get(watchedUnshown.path)?.events([{ path: join(watchedUnshown.path, "outside.txt"), type: "create" }])
  await delay(FILES_WAIT_MS)
  await after.summaries()
  assert.equal(statusReads(watchedUnshown.path), 0, "a worktree nobody shows isn't read for a file event")
  shown.add(watchedUnshown.path)
  await after.summaries()
  assert.equal(statusReads(watchedUnshown.path), 1, "and is once a window shows it")
  assert.equal(said(watchedUnshown.path), 1)
  shown.delete(watchedUnshown.path)

  // A shown worktree no tree watch covers: nothing says an editor changed a file in it, so the window coming to
  // focus reads it, at most once a minute.
  const realNow = Date.now
  let ahead = 0
  Date.now = () => realNow() + ahead
  try {
    writeFileSync(join(plainShown.path, "editor.txt"), "x\n")
    second.ran.length = 0
    await after.heldNow(undefined, "changes", true)
    await after.summaries()
    assert.equal(statusReads(plainShown.path), 0, "read within the last minute, a focus doesn't read it again")
    ahead += 61_000
    await after.heldNow(undefined, "changes")
    await after.summaries()
    assert.equal(statusReads(plainShown.path), 0, "an ask that isn't a focus reads nothing")
    await after.heldNow(undefined, "changes", true)
    await after.summaries()
    assert.equal(statusReads(plainShown.path), 1, "the window coming to focus reads the shown worktree nothing watches")
    assert.equal(said(plainShown.path), 1)
    assert.deepEqual(named(second.ran, "status").map((each) => each.cwd), [plainShown.path], "and no other: the watched one would have been heard, the rest aren't shown")
    // Past the hour: a worktree a tree watch covers, with nothing heard, isn't read; one nothing covers is.
    ahead += 2 * 60 * 60_000
    second.ran.length = 0
    await after.summaries()
    const backstopped = named(second.ran, "status").map((each) => each.cwd)
    assert.equal(backstopped.includes(watchedShown.path) || backstopped.includes(watchedUnshown.path), false, "a covered worktree has no hourly read")
    assert.equal(backstopped.length, WORKTREES - 2, "the hour's backstop reads those nothing would say changed")
    second.ran.length = 0
    await after.summaries()
    assert.equal(second.ran.length, 0, "and an idle worktree costs nothing between")
  } finally {
    Date.now = realNow
  }

  // --- An inventory is drawn from what's held: it asks Git nothing and measures no size before it answers.
  const children: unknown[] = []
  subscribe("child_process", (message) => {
    children.push(message)
  })
  const sized = () => children.filter((child) => SpawnedSchema.safeParse(child).data?.process.spawnargs.some((word) => word.endsWith("du"))).length
  let sizesSaid = 0
  after.followSizes(() => { sizesSaid += 1 })
  await after.summaries()
  second.ran.length = 0
  const inventoryBegan = performance.now()
  const inventory = await after.inventory()
  const inventoryMs = Math.round(performance.now() - inventoryBegan)
  assert.equal(inventory.worktrees.length, WORKTREES)
  assert.ok(inventory.worktrees.every((worktree) => worktree.bytes === null), "no size is in the first answer")
  assert.equal(sized(), 0, "and no checkout was walked for one before it")
  assert.deepEqual(second.ran.map((each) => each.command), [], "the list asks Git nothing: every count is one held")
  assert.ok(inventory.worktrees.every((worktree) => worktree.refreshing === undefined))
  assert.equal(inventory.worktrees.find((worktree) => worktree.path === edited.path)?.changes, 230)
  assert.equal(inventory.worktrees.find((worktree) => worktree.path === busy.path)?.landing.kind, "open")
  await after.settled()
  assert.equal(sizesSaid, 1, "the sizes are said once, when they're all in")
  const measuredOnce = sized()
  assert.equal(measuredOnce, WORKTREES)
  const sizedInventory = await after.inventory()
  assert.ok(sizedInventory.worktrees.every((worktree) => (worktree.bytes ?? 0) > 0), "the next list has them")
  await after.settled()
  assert.equal(sized(), measuredOnce, "and measures none again while no checkout changed")
  // One something signalled is listed with its last count, marked, and read behind the answer.
  const signalled = others[5]!
  writeFileSync(join(signalled.path, "listed.txt"), "x\n")
  after.wrote([join(signalled.path, "listed.txt")])
  second.ran.length = 0
  const marked = await after.inventory()
  assert.deepEqual(marked.worktrees.filter((worktree) => worktree.refreshing).map((worktree) => [worktree.path, worktree.changes]), [[signalled.path, 0]], "a worktree whose files changed is listed as being read again, alone")
  await after.settled()
  assert.deepEqual(named(second.ran, "status").map((each) => each.cwd), [signalled.path], "and it alone is read, behind the answer")
  const listedAgain = (await after.inventory()).worktrees.find((worktree) => worktree.path === signalled.path)
  assert.deepEqual([listedAgain?.changes, listedAgain?.refreshing, listedAgain?.held === null], [1, undefined, false])
  // What the list shows doesn't decide a removal: a file nothing signalled isn't in the list, and holds the removal.
  const unsignalled = others[6]!
  writeFileSync(join(unsignalled.path, "quiet.txt"), "x\n")
  assert.equal((await after.inventory()).worktrees.find((worktree) => worktree.path === unsignalled.path)?.held, null)
  assert.match((await after.removal(unsignalled.path)).held ?? "", /has changes that aren't committed/, "the removal reads the worktree as it is")
  await assert.rejects(after.remove(unsignalled.path), /has changes that aren't committed/)
  rmSync(join(unsignalled.path, "quiet.txt"))
  const sizedBefore = sized()
  commit(busy.path, "fifth.txt", "5\n", "fifth")
  await after.inventory()
  await after.settled()
  assert.equal(sized(), sizedBefore + 1, "a checkout that changed is measured again, alone")

  console.log(JSON.stringify({
    worktrees: WORKTREES,
    coldPass: { git: coldProcesses, ms: coldMs, commands: coldCommands },
    passAfterRestart: { git: 0, ms: warmMs },
    oneCommit: { git: commitProcesses.length, commands: commitProcesses },
    mainMoved: { git: movedProcesses, ms: movedMs, mergesShownFirst: shownNow.length, mergesSpread: rest.length },
    answerWhilePassOpenMs: Math.round(answerMs),
    turnOf200Edits: { statusReads: editReads, countRightAfterMs: editsSeenMs },
    outsideEditInShownWorktree: { statusReads: 1, seenAfterMs: outsideSeenMs },
    inventory: { git: 0, ms: inventoryMs, sizesBeforeAnswer: 0 },
  }))
  await after.closeSummaries()
  const kept = JSON.parse(readFileSync(file, "utf8"))
  assert.deepEqual(kept.later, { kept: true }, "a field this build doesn't know is written back")
  assert.equal(kept.worktrees[entryOf].measured, 7, "and one beside a worktree's summary, through every read of it since")
  // A file in a newer format is left alone, and nothing is read from it.
  writeFileSync(file, JSON.stringify({ ...kept, version: 99 }))
  const newer = service(counting().git)
  assert.equal((await newer.heldNow(undefined, "changes")).summaries.length, 0)
  await newer.summaries()
  await newer.closeSummaries()
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 99, "a newer build's file isn't rewritten")
  rmSync(file)

  // --- A landing read as an idle read says what the write did: a clean merge, a conflict, a merge, a squash, nothing committed.
  {
    const lands = repository("lands")
    const landing = counting()
    const landed = service(landing.git)
    const clean = await make(landed, lands, "Clean")
    const conflict = await make(landed, lands, "Conflict")
    const merged = await make(landed, lands, "Merged")
    const squashed = await make(landed, lands, "Squashed")
    const empty = await make(landed, lands, "Empty")
    commit(clean.path, "clean.txt", "clean\n", "clean")
    commit(conflict.path, "src/file-0.ts", "theirs\n", "theirs")
    commit(merged.path, "merged.txt", "merged\n", "merged")
    commit(squashed.path, "squashed.txt", "squashed\n", "squashed")
    commit(lands, "src/file-0.ts", "ours\n", "ours")
    git(lands, "merge", "-q", "--no-edit", merged.branch)
    git(lands, "merge", "-q", "--squash", squashed.branch)
    git(lands, "commit", "-q", "-m", "squash")
    const kinds = new Map((await landed.summaries()).map((summary) => [summary.path, summary.landing.kind]))
    assert.deepEqual([clean, conflict, merged, squashed, empty].map((worktree) => kinds.get(worktree.path)), ["open", "open", "merged", "merged", "empty"])
    assert.ok(named(landing.ran, "merge-tree").every((each) => each.args[0] === "merge-tree"), "each merge in memory ran as a read")
    // The same merges as a write, as they ran before, and as the idle read they run as now: the same word for each.
    const tip = (worktree: { path: string }) => git(worktree.path, "rev-parse", "HEAD")
    const mainTip = git(lands, "rev-parse", "HEAD")
    for (const worktree of [clean, conflict, merged, squashed]) {
      const args = ["merge-tree", "--write-tree", mainTip, tip(worktree)]
      const written = await landing.git.output(lands, args).catch(() => "")
      const read = await landing.git.run({ cwd: lands, args, read: true, idle: true }).then((result) => result.stdout.toString("utf8").trim(), () => "")
      assert.equal(read, written, "the idle read answers what the write answered")
    }
    assert.equal(await landing.git.output(lands, ["merge-tree", "--write-tree", mainTip, tip(conflict)]).catch(() => ""), "", "a conflict answers nothing either way")
    for (const worktree of [clean, conflict, merged, squashed, empty]) assert.equal((await landed.removal(worktree.path)).landing.kind, kinds.get(worktree.path), "a removal's own landing agrees")
    // Git before 2.41 has no `ahead-behind` for `for-each-ref`: each worktree is counted on its own, to the same numbers.
    const counts = (summaries: readonly WorktreeSummary[]) => summaries.map((summary) => [summary.path, summary.ahead, summary.behind?.commits, summary.landing])
    const withAheadBehind = counts(await landed.summaries())
    assert.ok(named(landing.ran, "for-each-ref").some((each) => each.args.some((word) => word.includes("ahead-behind"))))
    assert.ok(withAheadBehind.some(([, ahead, behind]) => ahead === 1 && Number(behind) > 1), "the fixture has branches both ahead and behind")
    // Nothing of the counts kept in the file: the older Git counts every one itself.
    rmSync(file, { force: true })
    const older = counting()
    const atLeast = older.git.atLeast.bind(older.git)
    const faked = mock.method(older.git, "atLeast", async (major: number, minor: number) => (major > 2 || (major === 2 && minor >= 41) ? false : atLeast(major, minor)))
    const olderService = service(older.git)
    assert.deepEqual(counts(await olderService.summaries()), withAheadBehind, "an older Git's counts and landings are the same")
    assert.equal(named(older.ran, "for-each-ref").filter((each) => each.args.some((word) => word.includes("ahead-behind"))).length, 0, "counted without the atom it lacks")
    assert.ok(named(older.ran, "rev-list").length >= 2 * 5, "by a count a worktree and side")
    faked.mock.restore()
    await olderService.closeSummaries()
    await older.git.close()
    await landed.closeSummaries()
    await landing.git.close()
  }

  // --- The file between builds: one a newer build wrote keeps every field this build doesn't know through this
  // build's rewrite, and one from a build that knew fewer fields is read for what it has, and loses none of it.
  {
    const formats = join(root, "formats.json")
    const summary = { path: "/w/a", into: "main", ahead: 1, changes: 2, landing: { kind: "open", into: "main", commits: 1, since: 5 }, pull: null, behind: { from: "main", commits: 0 }, review: "asked" }
    const newer = {
      version: 1,
      later: { kept: true },
      landings: { "landing-key": { kind: "merged", into: "main", by: "squash" } },
      counts: { "count-key": 3 },
      trees: { "tree-key": "abc" },
      worktrees: { "/w/a": { summary, at: 1, statusAt: 1, index: 1, refs: "r", measured: 7 } },
      pulls: { "/repo": [{ number: 1, title: "t", url: "u", branch: "b", state: "open", head: "h", checks: null, reviewers: 2 }] },
      points: { "/repo": { key: "k", point: { from: "main", commit: "c", branch: "main", upstream: null, standing: { kind: "alone" }, fetchedBy: "x" }, tracked: null, seen: 9 } },
    }
    writeFileSync(formats, JSON.stringify(newer))
    const cache = new WorktreeSummaryCache(formats)
    const memory = await cache.load()
    assert.deepEqual([memory.worktrees.get("/w/a")?.summary.changes, memory.counts.get("count-key"), memory.landings.get("landing-key")?.kind], [2, 3, "merged"], "this build reads what it knows of it")
    memory.counts.set("another", 4)
    cache.changed(() => memory)
    await cache.flush()
    assert.deepEqual(JSON.parse(readFileSync(formats, "utf8")), { ...newer, counts: { ...newer.counts, another: 4 } }, "and writes back every field, at every depth, with what it added")
    // From a build that knew fewer: no trees, no points, no pull requests, and a worktree's entry without its times.
    const fewer = { worktrees: { "/w/b": { summary: { path: "/w/b", into: null, ahead: 0, changes: 0, landing: { kind: "empty" }, pull: null, behind: null } } }, counts: { "count-key": 3 } }
    writeFileSync(formats, JSON.stringify(fewer))
    const upgraded = new WorktreeSummaryCache(formats)
    const read = await upgraded.load()
    assert.deepEqual(read.worktrees.get("/w/b"), { summary: fewer.worktrees["/w/b"].summary, at: 0, statusAt: 0, index: 0, refs: "" }, "an entry without the times this build keeps is read as never checked, so it's read again")
    read.trees.set("tree-key", "abc")
    upgraded.changed(() => read)
    await upgraded.flush()
    const rewritten = JSON.parse(readFileSync(formats, "utf8"))
    assert.deepEqual([rewritten.counts, rewritten.worktrees["/w/b"].summary, rewritten.trees, rewritten.version], [fewer.counts, fewer.worktrees["/w/b"].summary, { "tree-key": "abc" }, 1], "nothing it held is lost, and this build's fields join it")
  }

  // --- GitHub: a merged pull request gets no check read, an open one whose head a worktree has out gets one; the
  // repository's record outlives a forget; and `gh` is asked its version once.
  {
    const log = join(root, "gh-requests")
    const binary = join(root, "gh-fixture")
    const head = git(busy.path, "rev-parse", "HEAD")
    const otherHead = git(open[1]!.path, "rev-parse", "HEAD")
    const pulls = [
      { number: 7, title: "Open", state: "OPEN", isDraft: false, url: "https://github.com/fixture/project/pull/7", headRefName: busy.branch, headRefOid: head },
      { number: 8, title: "Merged", state: "MERGED", isDraft: false, url: "https://github.com/fixture/project/pull/8", headRefName: open[1]!.branch, headRefOid: otherHead },
    ]
    writeFileSync(log, "")
    writeFileSync(binary, `#!${process.execPath}
import { appendFileSync } from "node:fs"
const a = process.argv.slice(2), pulls = ${JSON.stringify(pulls)}
const n = Number((a.find((x) => x.startsWith("number=")) || "").slice(7))
const repo = a[0] === "api" && a[1] === "repos/{owner}/{repo}"
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind: a[0] === "--version" ? "version" : a[0] === "api" && a[1] === "user" ? "user" : repo ? "repo" : n ? "checks" : "list", number: n }) + "\\n")
if (a[0] === "--version") console.log("gh version 2.0.0")
else if (a[0] === "api" && a[1] === "user") console.log(JSON.stringify({ login: "fixture", id: 1 }))
else if (repo) console.log(JSON.stringify({ full_name: "fixture/project", html_url: "https://github.com/fixture/project", default_branch: "main" }))
else if (a[1] === "graphql") console.log("HTTP/2.0 200 OK\\n\\n" + JSON.stringify({ data: { repository: n ? { pullRequest: { ...pulls.find((p) => p.number === n), commits: { nodes: [] } } } : { pullRequests: { nodes: pulls } } } }))
else console.log(JSON.stringify(pulls))
`, { mode: 0o700 })
    const previous = process.env.GH_PATH
    process.env.GH_PATH = binary
    const requests = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line): { kind: string; number: number } => JSON.parse(line))
    const host = new HostStopping()
    try {
      const listed = await host.run(() => listBranchPulls(repo, [head, otherHead], new Map([[busy.branch, head], [open[1]!.branch, otherHead]])))
      assert.deepEqual(listed?.map((pull) => [pull.number, pull.state]), [[7, "open"], [8, "merged"]])
      assert.deepEqual(requests().filter((request) => request.kind === "checks").map((request) => request.number), [7], "the open pull request's checks are read; the merged one's, whose worktree is still kept, aren't")
      const reposBefore = requests().filter((request) => request.kind === "repo").length
      assert.equal(reposBefore, 1)
      await host.run(() => forgetGitHubReads(repo))
      await host.run(() => forgetGitHubReads())
      await host.run(() => listBranchPulls(repo, [head, otherHead]))
      assert.equal(requests().filter((request) => request.kind === "repo").length, reposBefore, "who the repository is on GitHub isn't asked again after a forget")
      assert.equal(requests().filter((request) => request.kind === "list").length, 2, "its pull requests are")
      assert.deepEqual(requests().filter((request) => request.kind === "checks").map((request) => request.number), [7, 7], "and again only the open one's checks")
      for (let ask = 0; ask < 3; ask += 1) assert.equal((await host.run(() => githubStatus(repo))).installed, true)
      assert.equal(requests().filter((request) => request.kind === "version").length, 1, "three asks of GitHub's status start gh for its version once")
    } finally {
      await host.stop()
      if (previous === undefined) delete process.env.GH_PATH
      else process.env.GH_PATH = previous
    }
  }

  console.log("worktree summaries: held answer at once, no Git after a restart with nothing moved, one commit reads one worktree, the main checkout moving reads shown landings first, changed-only events with the whole list for an older window, status fresh for what decides and held for what shows, a tab's watcher for an open worktree, tool writes and file events and focus reading what they touch and nothing else, an inventory from what's held, landing as an idle read, an older Git's counts, the file between builds, merged pull requests' checks left alone")
} finally {
  await before.closeSummaries().catch(() => undefined)
  threads.close()
  await first.git.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
}
