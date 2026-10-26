import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { Git } from "@mako/git"
import type { ActivityMark, ReportedEffect } from "@mako/protocol"
import { FakeClock, FakeEventSource } from "@mako/protocol/attribution-conformance"
import { gitRepository, nodeFileSystem } from "@mako/host/attribution/ports"
import { turnChanges, type JournalView } from "@mako/host/attribution/queries"
import { LaptopTracker } from "@mako/host/attribution/tracker"
import { runningIn, turnOnlyPair, turnWriters, undoPlan } from "@mako/host/attribution/turn-lines"
import type { LiveRequest, LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { TurnChanges } from "@mako/host/contracts/turn-changes"
import type { WriterRun } from "@mako/host/contracts/turn-review"
import { LiveJournal, storedRequest } from "@mako/host/conversations/live-journal"
import { LiveTurnReview, undoneTurns, type TurnReviewLedger } from "@mako/host/conversations/live-turn-review"
import { rewriteInPlace, type InPlaceFile } from "@mako/host/workspaces/worktree-move"

/*
 * Reviewing and undoing one turn, on a real repository: three turns of one
 * Thread, another Thread and the person in the same files. Turn 2's review
 * in a conversation nobody has open (its request read from the journal on
 * disk); who wrote each changed line, with the person's and the other
 * Thread's edits inside the turn's span; the diff with only the turn's
 * lines; an undo that keeps the person's and the other Thread's lines; a
 * stretch it leaves whole; the refusal while a run is on; and the writer's
 * backup ref, after a failure it rolls back and after a process killed
 * mid-write that the next start finishes.
 */

const here = fileURLToPath(import.meta.url)
const runner = new Git()
const lines = (count: number, edit: Record<number, string | null> = {}, prefix = "line") =>
  Array.from({ length: count }, (_, i) => (edit[i + 1] === null ? "" : `${edit[i + 1] ?? `${prefix} ${i + 1}`}\n`)).join("")

/** A child process: an in-place rewrite that kills itself at the step it names, as a host dying mid-undo. */
if (process.argv[2] === "child") {
  // SAFETY: the parent wrote this file from a ChildConfig just before it started this process.
  const config = JSON.parse(readFileSync(process.argv[3]!, "utf8")) as { repoRoot: string; head: string; plans: string; crashAt: string; files: { path: string; before: string | null; after: string | null }[] }
  const bytes = (text: string | null) => (text === null ? null : Buffer.from(text, "base64"))
  await rewriteInPlace({
    git: runner,
    ledger: undefined,
    id: randomUUID(),
    thread: "T1",
    project: config.repoRoot,
    repositories: [{ repoRoot: config.repoRoot, head: config.head, files: config.files.map((file): InPlaceFile => ({ path: file.path, before: bytes(file.before), after: bytes(file.after) })) }],
    message: "Mako: before an undo",
    save: async (plan) => {
      if (plan && plan.step !== "done") writeFileSync(join(config.plans, `${plan.id}.json`), JSON.stringify(plan))
    },
    log: () => {},
    stepped: (step) => {
      if (step === config.crashAt) process.kill(process.pid, "SIGKILL")
    },
  })
  process.exit(0)
}

const R1 = "0d1c2b3a-1111-4aaa-8bbb-000000000001"
const R2 = "0d1c2b3a-2222-4aaa-8bbb-000000000002"
const R3 = "0d1c2b3a-3333-4aaa-8bbb-000000000003"

async function fixture(name: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `mako-turn-review-${name}-`)))
  const repo = join(base, "repo")
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
  git("init", "-q", "-b", "main")
  git("config", "user.email", "test@example.invalid")
  git("config", "user.name", "Test")
  writeFileSync(join(repo, "app.ts"), lines(20))
  writeFileSync(join(repo, "util.ts"), lines(10, {}, "util"))
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  const clock = new FakeClock(Date.now())
  const events = new FakeEventSource()
  const tracker = await LaptopTracker.open(
    { fs: nodeFileSystem(), events, clock, storage: join(base, "journal"), device: "turn-review" },
    { repository: async (path) => gitRepository(runner, path) },
  )
  await tracker.track({ id: "repo", path: repo, kind: "workspace" })
  const view: JournalView = { store: tracker.store, roots: () => tracker.rootStates().values(), author: (seq) => tracker.authorOf(seq) }
  const abs = (path: string) => join(repo, path)
  const write = (path: string, content: string) => {
    writeFileSync(abs(path), content)
    utimesSync(abs(path), clock.now() / 1000, clock.now() / 1000)
    events.changed(abs(path))
  }
  const mark = (kind: ActivityMark["kind"], thread: string, id: string, edge: "start" | "end", turn?: string) =>
    tracker.activity({ kind, id, edge, at: clock.now(), thread, session: `${thread}-session`, checkout: repo, turn })
  const call = async (thread: string, turn: string, id: string, effects: ReportedEffect[], act: () => void) => {
    mark("call", thread, id, "start", turn)
    clock.advance(50)
    act()
    clock.advance(50)
    tracker.reported({ thread, session: `${thread}-session`, turn, call: id, status: "completed", endedAt: clock.now(), effects })
    mark("call", thread, id, "end", turn)
    await tracker.settled()
  }
  /** The person, with nothing running. */
  const person = async (path: string, content: string) => {
    clock.advance(5_000)
    write(path, content)
    await tracker.settled()
    clock.advance(5_000)
  }
  const ledger: TurnReviewLedger = {
    placement: () => ({ thread: "T1", session: "T1-session" }),
    settled: () => tracker.settled(),
    blob: (ref) => tracker.store.blob(ref),
    turnWriters: (thread, turn, file, shown) => turnWriters(view, thread, turn, file, shown),
    turnOnly: (thread, turn, file) => turnOnlyPair(view, thread, turn, file),
    undoPlan: (thread, scope, checkout) => undoPlan(view, thread, scope, checkout),
    running: (checkout) => runningIn(view, checkout),
    mako: (made) => tracker.mako(made),
  }
  const read = (path: string) => (existsSync(abs(path)) ? readFileSync(abs(path), "utf8") : null)
  return { base, repo, git, clock, events, tracker, view, abs, write, mark, call, person, ledger, read }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

const app = {
  r1: lines(20, { 2: "line 2 by turn 1" }),
  /** Turn 2's first call: line 5 rewritten, two lines after line 10, lines 15 and 16 gone. */
  r2: lines(20, { 2: "line 2 by turn 1", 5: "line 5 by turn 2", 10: "line 10\nadded A by turn 2\nadded B by turn 2", 15: null, 16: null }),
}
/** What app.ts holds after the person's line 8 and the other Thread's line 12, inside turn 2's span. */
const mixed = lines(20, { 2: "line 2 by turn 1", 5: "line 5 by turn 2", 8: "line 8 by you", 10: "line 10\nadded A by turn 2\nadded B by turn 2", 12: "line 12 by T2", 15: null, 16: null })
const final = mixed.replace("line 20\n", "line 20\nline 21 by turn 2\n")

/** Three turns of T1; inside turn 2's span on app.ts, the person's edit and T2's. */
async function turns(f: Fixture) {
  const { clock, mark, call, abs, write } = f
  clock.advance(1_000)
  mark("turn", "T1", R1, "start")
  await call("T1", R1, "c1", [{ kind: "modify", path: abs("app.ts"), edits: [{ old: "line 2\n", new: "line 2 by turn 1\n" }] }], () => write("app.ts", app.r1))
  mark("turn", "T1", R1, "end")
  clock.advance(5_000)
  mark("turn", "T1", R2, "start")
  await call("T1", R2, "c2", [{ kind: "modify", path: abs("app.ts"), edits: [{ old: "line 5\n", new: "line 5 by turn 2\n" }] }], () => write("app.ts", app.r2))
  mark("turn", "T1", R2, "end")
  // The person, with nothing running, then T2 in a call that names the file.
  await f.person("app.ts", app.r2.replace("line 8\n", "line 8 by you\n"))
  mark("turn", "T2", "x1", "start")
  await call("T2", "x1", "c3", [{ kind: "modify", path: abs("app.ts"), edits: [{ old: "line 12\n", new: "line 12 by T2\n" }] }], () => write("app.ts", mixed))
  mark("turn", "T2", "x1", "end")
  clock.advance(5_000)
  // Turn 2's background work writes once more, after both.
  await call("T1", R2, "c4", [{ kind: "modify", path: abs("app.ts"), edits: [{ old: "line 20\n", new: "line 20\nline 21 by turn 2\n" }] }], () => write("app.ts", final))
  clock.advance(5_000)
  mark("turn", "T1", R3, "start")
  await call("T1", R3, "c5", [{ kind: "modify", path: abs("util.ts"), edits: [{ old: "util 3\n", new: "util 3\nutil A by turn 3\nutil B by turn 3\n" }] }], () =>
    write("util.ts", lines(10, { 3: "util 3\nutil A by turn 3\nutil B by turn 3", 7: null }, "util")))
  mark("turn", "T1", R3, "end")
  clock.advance(15_000)
  f.tracker.sweep()
}

const appRecord = (record: TurnChanges) => record.files.find((file) => file.relative === "app.ts")!
const runsOf = (runs: readonly WriterRun[] | undefined) => (runs ?? []).map((run) => `${run.side === "additions" ? "+" : "-"}${run.start}${run.length > 1 ? `..${run.start + run.length - 1}` : ""} ${run.writer}${run.thread ? `:${run.thread}` : ""}`)

test("turn 2 of 3: the record, who wrote each changed line, and only its own lines", async () => {
  const f = await fixture("writers")
  await turns(f)
  const record = turnChanges(f.view, "T1", R2)
  // Only its own lines count: line 5, the two it added, 15 and 16 it removed, and line 21 from its background work.
  assert.deepEqual(record.own, { files: 1, added: 4, removed: 3 })
  const file = appRecord(record)
  assert.equal(file.kind, "modify")

  // On the journal's diff, from before its first entry on app.ts to after its last: the person's and T2's lines are named theirs.
  assert.deepEqual(runsOf(turnWriters(f.view, "T1", R2, file)), [
    "-5 turn", "+5 turn",
    "-8 person", "+8 person",
    "+11..12 turn",
    "-12 other:T2", "+14 other:T2",
    "-15..16 turn",
    "+21 turn",
  ])

  // On the checkpoints' diff, which saw a line added at the top after the turn: each shown line takes its journal line's writer.
  const shownAfter = ["header by you\n", ...final.split(/(?<=\n)/)]
  const shifted = runsOf(turnWriters(f.view, "T1", R2, file, { before: app.r1.split(/(?<=\n)/), after: shownAfter }))
  assert.ok(shifted.includes("+6 turn") && shifted.includes("+9 person") && shifted.includes("+22 turn"), `writers follow the shown lines: ${shifted.join(", ")}`)
  // A line outside the journal's span takes its neighbour's writer, or nobody's.
  assert.ok(shifted.some((run) => run.startsWith("+1 ")), "the header line is marked")

  // Only the turn's own lines change: the person's and T2's are on both sides.
  const only = turnOnlyPair(f.view, "T1", R2, file)!
  assert.equal(only.after, final)
  assert.equal(only.before, lines(20, { 2: "line 2 by turn 1", 8: "line 8 by you", 12: "line 12 by T2" }))
  await f.tracker.close()
  rmSync(f.base, { recursive: true, force: true })
})

test("Changes › Turn reads turn 2 of 3 from a conversation nobody has open", async () => {
  const f = await fixture("reopened")
  await turns(f)
  const conversations = join(f.base, "conversations")
  const id = randomUUID()
  const records = [R1, R2, R3].map((turn) => turnChanges(f.view, "T1", turn))
  const requests: LiveRequest[] = records.map((record, index) => ({ id: record.turn, text: `Turn ${index + 1}`, attachments: [], status: "completed", changes: record }))
  const snapshot: LiveSnapshot = {
    session: { connection: "connected", id, harness: "claude", cwd: f.repo, status: "ready", modes: [], currentMode: null, configOptions: [] },
    revision: 1,
    createdAt: 1_790_000_000_000,
    blocks: [],
    base: null,
    permissions: [],
    requests,
  }
  const journal = new LiveJournal(conversations, id)
  journal.commit(snapshot)
  journal.close()
  // Closed: the review reads its requests from the journal on disk, without loading it.
  const review = new LiveTurnReview({
    git: runner,
    ledger: () => f.ledger,
    request: (conversation, requestId) => storedRequest(conversations, conversation, requestId),
    cwd: () => f.repo,
    checkpoints: () => undefined,
    busy: () => false,
    plans: join(f.base, "undos"),
    undone: () => {},
  })
  const files = await review.files(id, R2, f.repo)
  assert.equal(files.root, f.repo)
  assert.deepEqual(files.files, [{ path: "app.ts", status: "modified", staged: false, insertions: 4, deletions: 3, binary: false }], "the list is the request's record")
  const diff = await review.diff(id, R2, "app.ts")
  assert.equal(diff.oldFile?.contents, app.r1, "before turn 2's first entry on the file")
  assert.equal(diff.newFile?.contents, final, "after its last")
  const writers = await review.writers(id, R2, "app.ts")
  assert.equal(writers?.body, "journal")
  assert.deepEqual(runsOf(writers?.runs), runsOf(turnWriters(f.view, "T1", R2, appRecord(records[1]!))))
  const only = await review.diff(id, R2, "app.ts", { only: true })
  assert.equal(only.oldFile?.contents, lines(20, { 2: "line 2 by turn 1", 8: "line 8 by you", 12: "line 12 by T2" }))
  // Turn 3 is a different file; turn 1's diff is its own line.
  assert.deepEqual((await review.files(id, R3, f.repo)).files.map((file) => file.path), ["util.ts"])
  assert.equal((await review.diff(id, R1, "app.ts")).newFile?.contents, app.r1)
  await f.tracker.close()
  rmSync(f.base, { recursive: true, force: true })
})

test("undo turn 2 keeps the person's line, the other Thread's and turn 1's", async () => {
  const f = await fixture("undo")
  await turns(f)
  // The conversation's requests, each with its record, as a resident one holds them.
  let requests: LiveRequest[] = [R1, R2, R3].map((turn, index) => ({ id: turn, text: `Turn ${index + 1}`, attachments: [], status: "completed", changes: turnChanges(f.view, "T1", turn) }))
  const review = new LiveTurnReview({
    git: runner, ledger: () => f.ledger, request: (_, requestId) => requests.find((request) => request.id === requestId), cwd: () => f.repo, checkpoints: () => undefined, busy: () => false, plans: join(f.base, "undos"),
    undone: (_, pick, undone) => {
      const marked = pick(requests)
      requests = requests.map((request) => (marked.has(request.id) ? { ...request, undone } : request))
    },
  })
  const preview = await review.undoPreview("c", { kind: "turn", requestId: R2 })
  assert.equal(preview.refused, undefined)
  // Kept counts what others wrote inside the turn's span; turn 1's line was there before it, so it's context, and stays.
  assert.deepEqual(preview.undo, [{ path: "app.ts", kind: "lines", removes: 4, restores: 3, kept: { person: 1, other: 1, thread: 0, maybe: 0, unknown: 0 } }])
  assert.deepEqual(preview.kept, [{ path: "app.ts", kept: { person: 1, other: 1, thread: 0, maybe: 0, unknown: 0 } }])
  assert.deepEqual(preview.left, [])
  const before = f.read("app.ts")
  const result = await review.undo("c", { kind: "turn", requestId: R2 }, preview.token)
  assert.equal(result.files, 1)
  assert.equal(f.read("app.ts"), lines(20, { 2: "line 2 by turn 1", 8: "line 8 by you", 12: "line 12 by T2" }), "turn 2's lines out, its removed lines back, everyone else's kept")
  assert.equal(f.read("util.ts"), lines(10, { 3: "util 3\nutil A by turn 3\nutil B by turn 3", 7: null }, "util"), "turn 3 untouched")
  // The checkout before the undo is kept, and can be read back.
  assert.match(result.backup, /^refs\/mako\/moves\//)
  assert.equal(`${f.git("show", `${result.backup}:app.ts`)}\n`, before)
  assert.deepEqual(readdirSync(join(f.base, "undos")).filter((name) => name.endsWith(".json")), [], "no plan left once it's done")
  // The undo is kept on turn 2's request, beside its record, and on no other turn's.
  const undone = requests.find((request) => request.id === R2)?.undone
  assert.ok(undone && undone.scope === "turn" && undone.files === 1 && undone.left === 0 && undone.backup === result.backup, JSON.stringify(undone))
  assert.deepEqual(requests.filter((request) => request.undone).map((request) => request.id), [R2])
  // Undoing it again is refused, and says why, rather than finding stretches it "can't split".
  const again = await review.undoPreview("c", { kind: "turn", requestId: R2 })
  assert.match(again.refused ?? "", /^This turn was undone already: its lines came out of 1 file, and the checkout from before is kept as refs\/mako\/moves\//)
  await assert.rejects(review.undo("c", { kind: "turn", requestId: R2 }, again.token), /undone already/)
  // Every change of the Thread marks the turns whose lines it took out; one undone already keeps its first undo.
  assert.deepEqual([...undoneTurns(requests, { kind: "thread" }, f.repo)].sort(), [R1, R3].sort())
  assert.deepEqual([...undoneTurns(requests, { kind: "thread" }, join(f.base, "elsewhere"))], [], "nothing of theirs is in another checkout")
  await f.tracker.close()
  rmSync(f.base, { recursive: true, force: true })
})

test("undo leaves a stretch someone edited since, and one where a removed line came back, and names them", async () => {
  const f = await fixture("whole")
  await turns(f)
  // The person rewrites one of turn 3's lines; T2 puts back the line turn 3 removed.
  await f.person("util.ts", lines(10, { 3: "util 3\nutil A by turn 3\nutil B, edited by you", 7: null }, "util"))
  f.mark("turn", "T2", "x2", "start")
  await f.call("T2", "x2", "c6", [{ kind: "modify", path: f.abs("util.ts"), edits: [{ old: "util 6\n", new: "util 6\nutil 7\n" }] }], () => f.write("util.ts", lines(10, { 3: "util 3\nutil A by turn 3\nutil B, edited by you" }, "util")))
  f.mark("turn", "T2", "x2", "end")
  f.clock.advance(15_000)
  f.tracker.sweep()
  const plan = undoPlan(f.view, "T1", { kind: "turn", requestId: R3 }, f.repo)
  assert.deepEqual(plan.writes, [], "nothing of util.ts is written")
  assert.deepEqual(plan.left.map((left) => [left.path, left.reason, left.lines, left.by]), [
    ["util.ts", "edited-since", { start: 4, length: 2 }, ["person"]],
    ["util.ts", "line-restored-by-another-writer", { start: 9, length: 1 }, ["other"]],
  ])
  await f.tracker.close()
  rmSync(f.base, { recursive: true, force: true })
})

test("what Git wrote is nobody's: the writer runs don't name it and an undo keeps it", async () => {
  const f = await fixture("git")
  await turns(f)
  // Turn 3's command pulled: the line Git wrote into util.ts is journaled under the turn's call, then marked as Git's.
  await f.call("T1", R3, "c7", [{ kind: "command", command: "git pull", cwd: f.repo }], () => f.write("util.ts", `${f.read("util.ts")}util 11 from the pull\n`))
  f.tracker.store.markGit(f.tracker.store.lastSeq(), true)
  f.clock.advance(15_000)
  f.tracker.sweep()
  const record = turnChanges(f.view, "T1", R3)
  assert.deepEqual(record.own, { files: 1, added: 2, removed: 1 }, "the pull's line isn't the turn's")
  const util = record.files.find((file) => file.relative === "util.ts")!
  assert.ok(!runsOf(turnWriters(f.view, "T1", R3, util)).some((run) => run.startsWith("+11")), "the pulled line is no change of the turn's diff")
  const plan = undoPlan(f.view, "T1", { kind: "thread" }, f.repo)
  const next = plan.writes.find((write) => write.path === "util.ts")?.next
  assert.equal(next?.kind === "text" ? next.text : null, `${lines(10, {}, "util")}util 11 from the pull\n`, "the thread's lines out, Git's kept")
  await f.tracker.close()
  rmSync(f.base, { recursive: true, force: true })
})

test("undo puts a line the turn replaced back where it stood, when the person since changed the line above it", async () => {
  const f = await fixture("adjacent")
  f.clock.advance(1_000)
  f.mark("turn", "T1", R1, "start")
  await f.call("T1", R1, "c1", [{ kind: "modify", path: f.abs("util.ts"), edits: [{ old: "util 5\n", new: "util 5 by turn 1\n" }] }], () => f.write("util.ts", lines(10, { 5: "util 5 by turn 1" }, "util")))
  f.mark("turn", "T1", R1, "end")
  // Right after the turn, the person rewrites the line just above the turn's.
  await f.person("util.ts", lines(10, { 4: "util 4 by you", 5: "util 5 by turn 1" }, "util"))
  f.clock.advance(15_000)
  f.tracker.sweep()
  const plan = undoPlan(f.view, "T1", { kind: "turn", requestId: R1 }, f.repo)
  assert.deepEqual(plan.left, [])
  const next = plan.writes.find((write) => write.path === "util.ts")?.next
  assert.equal(next?.kind === "text" ? next.text : null, lines(10, { 4: "util 4 by you" }, "util"), "util 5 back on line 5, below the person's line 4")
  await f.tracker.close()
  rmSync(f.base, { recursive: true, force: true })
})

test("undo is refused while a run is on in the checkout", async () => {
  const f = await fixture("busy")
  await turns(f)
  const review = new LiveTurnReview({ git: runner, ledger: () => f.ledger, request: () => undefined, cwd: () => f.repo, checkpoints: () => undefined, busy: () => false, plans: join(f.base, "undos"), undone: () => {} })
  f.mark("turn", "T2", "x9", "start")
  const preview = await review.undoPreview("c", { kind: "turn", requestId: R2 })
  assert.match(preview.refused ?? "", /An agent is working in this checkout/)
  await assert.rejects(review.undo("c", { kind: "turn", requestId: R2 }, preview.token), /An agent is working in this checkout/)
  assert.equal(f.read("app.ts"), final, "nothing written")
  f.mark("turn", "T2", "x9", "end")
  // A run of this host's own (the journal hasn't heard it yet) refuses as well.
  const local = new LiveTurnReview({ git: runner, ledger: () => f.ledger, request: () => undefined, cwd: () => f.repo, checkpoints: () => undefined, busy: (folder) => folder === f.repo, plans: join(f.base, "undos"), undone: () => {} })
  await assert.rejects(local.undo("c", { kind: "turn", requestId: R2 }, preview.token), /An agent is working/)
  // A preview read before the files changed doesn't undo what's there now.
  await f.person("app.ts", `${final}tail by you\n`)
  const free = new LiveTurnReview({ git: runner, ledger: () => f.ledger, request: () => undefined, cwd: () => f.repo, checkpoints: () => undefined, busy: () => false, plans: join(f.base, "undos"), undone: () => {} })
  await assert.rejects(free.undo("c", { kind: "turn", requestId: R2 }, preview.token), /changed since this preview/)
  await f.tracker.close()
  rmSync(f.base, { recursive: true, force: true })
})

test("the writer rolls back a failure and keeps the backup ref; a process killed mid-write is finished on the next start", async () => {
  const f = await fixture("writer")
  await turns(f)
  const head = f.git("rev-parse", "HEAD")
  const plan = undoPlan(f.view, "T1", { kind: "thread" }, f.repo)
  // Every line of T1's: turn 1's too.
  const files = plan.writes.map((write): InPlaceFile => ({ path: write.path, before: Buffer.from(f.read(write.path)!), after: write.next.kind === "text" ? Buffer.from(write.next.text) : null }))
  assert.deepEqual(files.map((file) => file.path).sort(), ["app.ts", "util.ts"])
  const was = Object.fromEntries(files.map((file) => [file.path, f.read(file.path)]))
  // A failure after the first file is written: every file back as it was, and the state before kept.
  const id = randomUUID()
  await assert.rejects(
    rewriteInPlace({ git: runner, ledger: undefined, id, thread: "T1", project: f.repo, repositories: [{ repoRoot: f.repo, head, files }], message: "before", save: async () => {}, log: () => {}, stepped: (step) => {
      if (step === "wrote") throw new Error("forced")
    } }),
    (error: Error) => error.message.includes(`refs/mako/moves/${id}`) && error.message.includes("forced"),
  )
  for (const [path, text] of Object.entries(was)) assert.equal(f.read(path), text, `${path} put back`)
  for (const [path, text] of Object.entries(was)) assert.equal(`${f.git("show", `refs/mako/moves/${id}:${path}`)}\n`, text, `${path} kept in the backup`)
  // The backup restores what was there, whatever happened since.
  writeFileSync(f.abs("app.ts"), "scribbled\n")
  f.git("checkout", `refs/mako/moves/${id}`, "--", "app.ts")
  assert.equal(f.read("app.ts"), was["app.ts"])
  f.git("reset", "-q")

  // A host killed after its first write: the next start finishes it from the saved plan.
  const plans = join(f.base, "undos")
  mkdirSync(plans, { recursive: true })
  const config = join(f.base, "child.json")
  writeFileSync(config, JSON.stringify({ repoRoot: f.repo, head, plans, crashAt: "wrote", files: files.map((file) => ({ path: file.path, before: file.before?.toString("base64") ?? null, after: file.after?.toString("base64") ?? null })) }))
  const child = spawnSync(process.execPath, [...process.execArgv, here, "child", config], { encoding: "utf8" })
  assert.equal(child.signal, "SIGKILL", child.stderr)
  assert.equal(readdirSync(plans).filter((name) => name.endsWith(".json")).length, 1, "its plan is saved")
  const review = new LiveTurnReview({ git: runner, ledger: () => f.ledger, request: () => undefined, cwd: () => f.repo, checkpoints: () => undefined, busy: () => false, plans, undone: () => {} })
  await review.resume()
  assert.equal(f.read("app.ts"), lines(20, { 8: "line 8 by you", 12: "line 12 by T2" }), "finished: every line of T1's out")
  assert.equal(f.read("util.ts"), lines(10, {}, "util"))
  assert.deepEqual(readdirSync(plans).filter((name) => name.endsWith(".json")), [])
  await f.tracker.close()
  rmSync(f.base, { recursive: true, force: true })
})

test("a save after the turn began, before it first wrote the file, is named on the checkpoints' diff as the journal has it, not nobody's", async () => {
  const f = await fixture("before-first")
  const { clock, mark, call, abs, write } = f
  clock.advance(1_000)
  mark("turn", "T1", R1, "start")
  // While the model thinks, the person changes line 1: only the turn was running, so the journal can't say whose.
  clock.advance(1_500)
  const saved = lines(20, { 1: "line 1 by you" })
  write("app.ts", saved)
  await f.tracker.settled()
  clock.advance(1_000)
  const after = lines(20, { 1: "line 1 by you", 4: "line 4 by turn 1" })
  await call("T1", R1, "c1", [{ kind: "modify", path: abs("app.ts"), edits: [{ old: "line 4\n", new: "line 4 by turn 1\n" }] }], () => write("app.ts", after))
  mark("turn", "T1", R1, "end")
  clock.advance(15_000)
  f.tracker.sweep()
  const record = turnChanges(f.view, "T1", R1)
  assert.deepEqual(record.own, { files: 1, added: 1, removed: 1 })
  const file = appRecord(record)
  // The checkpoints saw both: the one before the turn holds neither line.
  const shown = { before: lines(20).split(/(?<=\n)/), after: after.split(/(?<=\n)/) }
  assert.deepEqual(runsOf(turnWriters(f.view, "T1", R1, file, shown)), ["-1 maybe", "+1 maybe", "-4 turn", "+4 turn"])
  await f.tracker.close()
  rmSync(f.base, { recursive: true, force: true })
})
