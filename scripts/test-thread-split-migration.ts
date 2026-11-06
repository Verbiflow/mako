import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { ThreadIdSchema, type Actor, type SessionId, type ThreadId } from "@mako/host/contracts/thread-identity"
import { MoveIdSchema, RuntimeIdSchema, type ExecutionOwner } from "@mako/host/contracts/thread-execution"
import { carryDrafts, type ThreadSplit } from "@mako/host/contracts/thread-splits"
import { ThreadStore, type JournalFacts } from "@mako/host/threads/store"
import { preSplitCopyPath, splitThreadId, undoThreadSplits } from "@mako/host/threads/thread-split"
import { ThreadArchives } from "@mako/host/threads/archives"
import { growth, subquadratic } from "./lib/growth.ts"

/**
 * A Thread is one conversation (`docs/one-conversation.md`): the split of every Thread that held several Sessions
 * into one Thread per Session. Built on stores shaped like the person's: a 14-Session Thread with a worktree, a
 * title, a purpose, a draft, an archived Session, forks, a harness's own fork and a hand-off between harnesses, an
 * Apex whose Fins hang off different Sessions, a Fin that holds two Sessions, and Threads that run elsewhere or are
 * moving. Checks nothing is lost, every Thread the split makes, that a second open changes nothing, that a process
 * killed mid-split leaves the store as it was, the copy kept before, the way back, and a generated store of the
 * person's size. `MAKO_SPLIT_REAL_COPY=<a copy of threads.sqlite>` runs the same checks on a copy of a real store,
 * copied again into a scratch folder first; never point it at a store a Mako uses.
 */

const realPath = (path: string) => path
const migration: Actor = { kind: "service", name: "migration" }
const cloud: ExecutionOwner = { kind: "cloud", runtime: RuntimeIdSchema.parse("6f0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d") }

// The child half of the crash check: split until the second Thread is done, then die without a word.
if (process.argv[2] === "--crash-child") {
  const path = process.argv[3]!
  new ThreadStore(path, { realPath, oneConversation: true, afterSplitThread: (done) => { if (done === 2) process.kill(process.pid, "SIGKILL") } })
  throw new Error("The split finished; the crash never came")
}

const root = mkdtempSync(join(tmpdir(), "mako-thread-split-"))
let clock = Date.parse("2026-10-01T09:00:00.000Z")
const now = () => clock++

function open(path: string, oneConversation: boolean, extra: Partial<ConstructorParameters<typeof ThreadStore>[1]> = {}): ThreadStore {
  return new ThreadStore(path, { now, realPath, oneConversation, ...extra })
}

function journal(input: Partial<JournalFacts> & Pick<JournalFacts, "harness">): JournalFacts {
  return { conversationId: randomUUID(), createdAt: clock++, bindings: [], ...input }
}

function binding(provider: string, id: string) {
  return { provider, nativeId: id, path: `/natives/${provider}/${id}.jsonl` }
}

interface Fixture {
  path: string
  apex: ThreadId
  sessions: SessionId[]
  conversations: string[]
  finByS9: ThreadId
  finByS0: ThreadId
  twoSessionFin: { thread: ThreadId; first: SessionId; run: SessionId }
  elsewhere: ThreadId
  moving: ThreadId
  single: ThreadId
  archived: string
}

/** The person's 14-Session Thread and its neighbours, made through the store's own calls the way builds before the split made them. */
function buildFixture(name: string): Fixture {
  const path = join(root, `${name}.sqlite`)
  const store = open(path, false)
  const person = store.person()
  const sessions: SessionId[] = []
  const conversations: string[] = []
  const add = (facts: JournalFacts) => {
    const placed = store.registerJournal(facts, person)
    sessions.push(placed.session)
    conversations.push(facts.conversationId)
    return placed
  }
  const tab = (thread: ThreadId, bindings: JournalFacts["bindings"], harness: string) => {
    const created = store.createSession({ operationId: randomUUID(), thread, actor: person })
    assert.equal(created.thread, thread, "builds before the split put a + tab's Session in its Thread")
    return add(journal({ harness, session: created.session, bindings }))
  }
  // s0: the conversation the Thread was captured from.
  const s0 = add(journal({ harness: "cursor", threadPath: "/natives/cursor/s0.jsonl", bindings: [binding("cursor", "s0")] }))
  const apex = s0.thread
  store.renameThread({ operationId: randomUUID(), thread: apex, title: "Thread Environments and Cloud", actor: person })
  store.attachWorktree({ path: "/worktrees/thread-environments", thread: apex, repoRoot: "/repo", project: "/repo", branch: "mako/thread-environments", base: "0a1b2c3" })
  store.markPurpose(apex, "setup", "/repo")
  // s1: a + tab handed off from Cursor to Codex: one Session, two harnesses.
  tab(apex, [binding("cursor", "s1"), binding("codex", "s1-codex")], "cursor")
  for (const index of [2, 3, 4, 5]) tab(apex, [binding(index === 4 ? "codex" : "cursor", `s${index}`)], index === 4 ? "codex" : "cursor")
  // s6: a fork of s0 that joined its parent's Thread as a tab.
  add(journal({ harness: "cursor", ancestry: { parentId: conversations[0]!, placement: "parent-thread" }, bindings: [binding("cursor", "s6")] }))
  tab(apex, [binding("cursor", "s7")], "cursor")
  // s8: a fork of the fork.
  add(journal({ harness: "cursor", ancestry: { parentId: conversations[6]!, placement: "parent-thread" }, bindings: [binding("cursor", "s8")] }))
  tab(apex, [binding("claude", "s9"), binding("cursor", "s9-cursor")], "claude")
  tab(apex, [binding("claude", "s10")], "claude")
  tab(apex, [binding("claude", "s11")], "claude")
  // s12: Codex's own fork of s1's Codex session, found by the catalog, which joins its parent's Thread.
  const imported = store.resolveRefs([{ harness: "codex", nativeId: "s12", path: "/natives/codex/s12.jsonl", parentNativeId: "s1-codex" }], migration)
  const s12 = imported.get("/natives/codex/s12.jsonl")!
  assert.equal(s12.thread, apex, "a harness's own fork joined its parent's Thread")
  sessions.push(s12.session)
  conversations.push("")
  // s13: a + tab whose Session was made for a send that never went out.
  const s13 = store.createSession({ operationId: randomUUID(), thread: apex, actor: person })
  sessions.push(s13.session)
  conversations.push("")
  assert.equal(store.thread(apex)?.sessions.length, 14)

  const fin = (title: string, parentSession: SessionId, op: string, run?: { harness: string; nativeId: string }) => {
    const placed = store.registerJournal(journal({ harness: run?.harness ?? "codex", bindings: [binding(run?.harness ?? "codex", `fin-${op}`)] }), person)
    store.keepEdge({
      child: placed.thread, parent: apex, parentSession, name: title, role: "worker", origin: "started",
      asked: { brief: { objective: title } }, op, startedBy: { kind: "agent", session: parentSession }, createdAt: clock++,
      ...(run && { run: { ...run, device: store.deviceId, startedAt: clock++ } }),
    })
    return placed
  }
  const finByS9 = fin("cloud-probe", sessions[9]!, "start:s9:1").thread
  const finByS0 = fin("store-audit", sessions[0]!, "start:s0:1").thread
  store.keepReport({ id: `report:${finByS9}:1`, child: finByS9, status: "done", summary: "Probed the cloud.", ownerGeneration: 1, at: clock++ })

  // A Fin of two Sessions, whose followed run is its second.
  const finFirst = fin("two-sessions", sessions[0]!, "start:s0:2", { harness: "codex", nativeId: "fin-run" })
  const finRun = tab(finFirst.thread, [binding("codex", "fin-run")], "codex")
  store.keepReport({ id: `report:${finFirst.thread}:1`, child: finFirst.thread, status: "needs-input", summary: "Which region?", ownerGeneration: 1, at: clock++ })

  // A Thread whose Sessions run on a cloud machine, and one that is leaving for it: both stay whole for now.
  const elsewhere = add(journal({ harness: "claude", bindings: [binding("claude", "away-0")] })).thread
  tab(elsewhere, [binding("claude", "away-1")], "claude")
  const moving = add(journal({ harness: "codex", bindings: [binding("codex", "moving-0")] })).thread
  tab(moving, [binding("codex", "moving-1")], "codex")
  store.beginMove({ move: MoveIdSchema.parse(randomUUID()), thread: moving, target: cloud, actor: person })
  const single = add(journal({ harness: "grok", bindings: [binding("grok", "alone")] })).thread
  store.close()

  const db = new DatabaseSync(path)
  const away = db.prepare("SELECT session_id FROM memberships WHERE thread_id = ?").all(elsewhere).map((row) => String(row.session_id))
  for (const session of away) db.prepare("UPDATE executions SET owner_kind = 'cloud', owner_id = ? WHERE session_id = ?").run(cloud.kind === "cloud" ? cloud.runtime : "", session)
  db.close()

  return {
    path, apex, sessions, conversations, finByS9, finByS0,
    twoSessionFin: { thread: finFirst.thread, first: finFirst.session, run: finRun.session },
    elsewhere, moving, single, archived: conversations[5]!,
  }
}

/** Every row a split must keep as it was, and the ones it may change, read straight from the file. */
interface Picture {
  members: Map<string, { thread: string; position: number }>
  threads: Map<string, { owner: string; title: string | null; source: string | null; merged: string | null }>
  edges: Map<string, { parent: string; parentSession: string; child: string; run: string | null }>
  reports: Map<string, string>
  kept: Record<string, string>
}

const EdgeRecordSchema = z.object({ parent: z.string(), child: z.string(), parentSession: z.string() })
const ReportRecordSchema = z.object({ child: z.string() })
const OwnerSchema = z.object({ kind: z.string(), device: z.string().optional(), runtime: z.string().optional() })

const KEPT_TABLES = {
  sessions: "SELECT id, origin, parent_session, created_at, merged_into FROM sessions ORDER BY id",
  journals: "SELECT conversation_id, session_id, created_at FROM journals ORDER BY conversation_id",
  sources: "SELECT device_id, harness, key, session_id FROM sources ORDER BY device_id, harness, key",
  locators: "SELECT device_id, path, harness, native_id, session_id, origin FROM locators ORDER BY device_id, path",
  native_claims: "SELECT device_id, harness, native_id, session_id FROM native_claims ORDER BY device_id, harness, native_id",
  executions: "SELECT session_id, owner_kind, owner_id, generation, move_id FROM executions ORDER BY session_id",
  thread_worktrees: "SELECT path, thread_id, device_id, repo_root, project, branch, base FROM thread_worktrees ORDER BY path",
  thread_purposes: "SELECT thread_id, purpose, project FROM thread_purposes ORDER BY thread_id",
  moves: "SELECT id, thread_id, phase FROM moves ORDER BY id",
  principals: "SELECT id FROM principals ORDER BY id",
} satisfies Record<string, string>

function picture(path: string): Picture {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const members = new Map(db.prepare("SELECT session_id, thread_id, position FROM memberships").all()
      .map((row) => [String(row.session_id), { thread: String(row.thread_id), position: Number(row.position) }]))
    const threads = new Map(db.prepare("SELECT id, owner_id, title, title_source, merged_into FROM threads").all()
      .map((row) => [String(row.id), { owner: String(row.owner_id), title: row.title === null ? null : String(row.title), source: row.title_source === null ? null : String(row.title_source), merged: row.merged_into === null ? null : String(row.merged_into) }]))
    const edges = new Map(db.prepare("SELECT child_thread, parent_thread, record, run_native_id FROM thread_parents").all().map((row) => {
      const record = EdgeRecordSchema.parse(JSON.parse(String(row.record)))
      assert.equal(record.parent, String(row.parent_thread), "an edge's record names the parent its row does")
      assert.equal(record.child, String(row.child_thread), "an edge's record names the child its row does")
      return [String(row.child_thread), { parent: String(row.parent_thread), parentSession: record.parentSession, child: String(row.child_thread), run: row.run_native_id === null ? null : String(row.run_native_id) }]
    }))
    const reports = new Map(db.prepare("SELECT id, child_thread, record FROM thread_reports").all().map((row) => {
      assert.equal(ReportRecordSchema.parse(JSON.parse(String(row.record))).child, String(row.child_thread), "a report's record names the child its row does")
      return [String(row.id), String(row.child_thread)]
    }))
    const kept = Object.fromEntries(Object.entries(KEPT_TABLES).map(([table, query]) => [table, JSON.stringify(db.prepare(query).all())]))
    return { members, threads, edges, reports, kept }
  } finally {
    db.close()
  }
}

function digest(path: string): string {
  const found = picture(path)
  const db = new DatabaseSync(path, { readOnly: true })
  const extra = JSON.stringify([
    db.prepare("SELECT thread_id, place_thread, why FROM thread_places ORDER BY thread_id").all(),
    db.prepare("SELECT thread_id, from_thread, session_id, position, from_title FROM thread_splits ORDER BY thread_id").all(),
  ])
  db.close()
  return createHash("sha256").update(JSON.stringify([found.kept, [...found.members].sort(), [...found.threads].sort(), [...found.edges].sort(), [...found.reports].sort(), extra])).digest("hex")
}

function groupsOf(members: Picture["members"]): Map<string, string[]> {
  const groups = new Map<string, { session: string; position: number }[]>()
  for (const [session, member] of members) groups.set(member.thread, [...groups.get(member.thread) ?? [], { session, position: member.position }])
  return new Map([...groups].map(([thread, list]) => [thread, list.sort((a, b) => a.position - b.position || (a.session < b.session ? -1 : 1)).map((entry) => entry.session)]))
}

/**
 * What any split must leave, read from before and after alone: every Session still in exactly one Thread; each Thread
 * that held several holds its first, and each other Session is in the Thread `splitThreadId` names, owned by the same
 * person, untitled, sharing the first's place; every Session's journals, native sessions and claims, every worktree,
 * purpose and move as they were; each parent edge under the Thread its parent Session is in now; each child edge (and
 * its reports) with its run. Threads in `deferred` are left whole. Returns the Threads the split made.
 */
function checkSplit(before: Picture, after: Picture, deferred: ReadonlySet<string>, store?: ThreadStore): Map<string, string> {
  assert.deepEqual(after.kept, before.kept, "Sessions, journals, native sessions, claims, executions, worktrees, purposes and moves are as they were")
  assert.deepEqual([...after.members.keys()].sort(), [...before.members.keys()].sort(), "every Session is still in a Thread, and no Session was added")
  const made = new Map<string, string>()
  for (const [thread, sessions] of groupsOf(before.members)) {
    if (sessions.length < 2 || deferred.has(thread)) {
      for (const session of sessions) assert.deepEqual(after.members.get(session), before.members.get(session), "a Thread left whole keeps its tabs")
      continue
    }
    const [first, ...rest] = sessions
    assert.equal(after.members.get(first!)?.thread, thread, "the first Session keeps its Thread")
    assert.deepEqual(after.threads.get(thread), before.threads.get(thread), "the Thread that stays keeps its title and owner")
    for (const session of rest) {
      const next = splitThreadId(thread, session)
      assert.equal(after.members.get(session)?.thread, next, "every other Session is in the Thread the split names")
      assert.equal(after.members.get(session)?.position, 0)
      const row = after.threads.get(next)
      assert.ok(row, "the split Thread exists")
      assert.equal(row.owner, before.threads.get(thread)?.owner, "owned by the same person")
      assert.equal(row.title, null, "untitled, so it reads as its own conversation")
      assert.equal(row.merged, null)
      if (store) assert.equal(store.placeOf(ThreadIdSchema.parse(next)), store.placeOf(ThreadIdSchema.parse(thread)), "it shares its source's place")
      made.set(session, next)
    }
  }
  const groups = groupsOf(after.members)
  for (const [thread, sessions] of groups) if (!deferred.has(thread)) assert.equal(sessions.length, 1, `Thread ${thread} is one conversation`)
  for (const [child, edge] of before.edges) {
    const now = after.edges.get(child) ?? [...after.edges.values()].find((candidate) => candidate.run !== null && candidate.run === edge.run && candidate.parentSession === edge.parentSession)
    assert.ok(now, "every parent edge is kept")
    assert.equal(now.parentSession, edge.parentSession, "and names the same parent Session")
    if (!deferred.has(edge.parent)) assert.equal(now.parent, after.members.get(edge.parentSession)?.thread ?? edge.parent, "under the Thread its parent Session is in now")
  }
  assert.equal(after.edges.size, before.edges.size, "no edge was added or lost")
  for (const [id, child] of before.reports) {
    const now = after.reports.get(id)
    assert.ok(now, "every report is kept")
    assert.ok(after.edges.has(now), "under a child that has its edge")
    if (now !== child) assert.ok(after.edges.get(now)?.run === before.edges.get(child)?.run, "a report moved only with its child's run")
  }
  return made
}

function fixtureChecks(): void {
  const fixture = buildFixture("fixture")
  const { path, apex, sessions } = fixture
  const before = picture(path)
  assert.equal(groupsOf(before.members).get(apex)?.length, 14)

  // What a window keeps, beside the store: an archived Session and a + tab's draft whose send named its Session.
  const archives = new ThreadArchives(join(root, "fixture-archives.sqlite"))
  archives.set({ id: randomUUID(), target: { kind: "live", id: fixture.archived }, archived: true }, [`live:${fixture.archived}`])
  const archivedBefore = archives.snapshot().keys
  const drafts: { id: string; thread: string; cwd: string; title: string; session?: string; key?: string }[] = [
    { id: randomUUID(), thread: apex, cwd: "/worktrees/thread-environments", title: "Thread Environments and Cloud", session: sessions[13]! },
    { id: randomUUID(), thread: fixture.single, cwd: "/repo", title: "alone" },
  ]

  const store = open(path, true)
  const after = picture(path)
  const deferred = new Set([fixture.elsewhere, fixture.moving])
  const made = checkSplit(before, after, deferred, store)
  assert.equal(made.size, 13 + 1, "thirteen Threads from the fourteen, and one from the Fin of two")

  // The 14-Session Thread, Session by Session.
  assert.deepEqual(store.thread(apex)?.sessions, [sessions[0]], "the Thread keeps its first conversation")
  assert.equal(store.thread(apex)?.title, "Thread Environments and Cloud")
  assert.deepEqual(store.purposes().map((purpose) => purpose.thread), [apex], "its purpose stays with it")
  assert.deepEqual(store.worktrees().map((worktree) => [worktree.thread, worktree.path]), [[apex, "/worktrees/thread-environments"]], "the worktree stays its own")
  for (const [index, session] of sessions.slice(0, 14).entries()) {
    const placed = store.sessionPlacement(session)
    assert.ok(placed)
    if (index === 0) continue
    assert.equal(placed.thread, splitThreadId(apex, session))
    assert.deepEqual(store.thread(placed.thread)?.sessions, [session])
    assert.equal(store.placeOf(placed.thread), apex, `Session ${index}'s Thread works in the 14-Session Thread's place`)
  }
  const handedOff = store.sessionPlacement(sessions[1]!)!
  const read = new DatabaseSync(path, { readOnly: true })
  const handoffHarnesses = read.prepare("SELECT DISTINCT harness FROM locators WHERE session_id = ? ORDER BY harness").all(handedOff.session).map((row) => String(row.harness))
  read.close()
  assert.equal(store.journalPlacement(fixture.conversations[1]!)?.thread, handedOff.thread, "the hand-off's conversation is in one Thread")
  assert.deepEqual(handoffHarnesses, ["codex", "cursor"], "both harnesses of the hand-off stay in that one Session")
  const forks = store.forksOf([sessions[6]!, sessions[8]!])
  assert.equal(forks.get(sessions[6]!), sessions[0], "a fork still says what it forked from")
  assert.equal(forks.get(sessions[8]!), sessions[6], "so does a fork of a fork")
  const parents = new DatabaseSync(path, { readOnly: true })
  assert.equal(String(parents.prepare("SELECT parent_session FROM sessions WHERE id = ?").get(sessions[12]!)?.parent_session), sessions[1], "and a harness's own fork keeps its parent")
  parents.close()
  const splits = store.threadSplits()
  assert.equal(splits.filter((split) => split.from === apex).length, 13)
  assert.ok(splits.filter((split) => split.from === apex).every((split) => split.fromTitle === "Thread Environments and Cloud"), "each split Thread says where it came from")
  // Newest first: each split Thread was created when its Session was.
  const created = new DatabaseSync(path, { readOnly: true })
  const order = created.prepare("SELECT m.session_id FROM threads t JOIN memberships m ON m.thread_id = t.id WHERE t.id IN (SELECT thread_id FROM thread_splits WHERE from_thread = ?) ORDER BY t.created_at DESC").all(apex).map((row) => String(row.session_id))
  created.close()
  assert.deepEqual(order, sessions.slice(1, 14).toReversed().filter((session) => order.includes(session)), "the split Threads sort newest first")
  assert.equal(order.length, 13)

  // The Apex's Fins follow the Session that started them; the Fin of two keeps its edge with its run.
  assert.equal(store.edges().of(fixture.finByS9)?.parent, splitThreadId(apex, sessions[9]!), "a Fin started from s9 hangs off s9's Thread")
  assert.equal(store.edges().of(fixture.finByS0)?.parent, apex, "a Fin started from s0 stays with the Thread")
  const runThread = splitThreadId(fixture.twoSessionFin.thread, fixture.twoSessionFin.run)
  assert.equal(store.edges().of(runThread)?.op, "start:s0:2", "the Fin's edge follows the Session its run is")
  assert.equal(store.edges().of(fixture.twoSessionFin.thread), undefined)
  assert.deepEqual(store.reportsOf(runThread).map((report) => report.summary), ["Which region?"], "and its reports with it")
  assert.deepEqual(store.reportsOf(fixture.finByS9).map((report) => report.summary), ["Probed the cloud."])
  assert.equal(store.edges().children(apex).length, 2)

  // Left whole for now: the cloud's Thread and the moving one.
  assert.equal(store.thread(fixture.elsewhere)?.sessions.length, 2)
  assert.equal(store.thread(fixture.moving)?.sessions.length, 2)
  assert.deepEqual(store.groups().map((group) => group.id).sort(), [fixture.elsewhere, fixture.moving].sort(), "only the deferred Threads still group")

  // Archived and drafted: an archive is the Session's own key, and a draft that named its Session follows it.
  assert.deepEqual(archives.snapshot().keys, archivedBefore, "archives are kept by Session, so nothing moves")
  assert.deepEqual(store.thread(store.journalPlacement(fixture.archived)!.thread)?.sessions, [sessions[5]], "the archived Session's Thread holds it alone")
  archives.close()
  const carried = carryDrafts(drafts, splits.map((split): ThreadSplit => ({ thread: split.thread, from: split.from, session: split.session, ...(split.fromTitle && { fromTitle: split.fromTitle }) })))
  assert.deepEqual(carried.map((draft) => [draft.thread, draft.key]).sort(), [
    [splitThreadId(apex, sessions[13]!), `thread-session:${apex}`],
    [fixture.single, undefined],
  ].sort(), "the draft goes with its Session and keeps the key its text is under")

  // The copy kept before, whole and as it was.
  const copy = preSplitCopyPath(path)
  assert.ok(existsSync(copy) && !existsSync(`${copy}.partial`), "the store was copied before it was split")
  assert.deepEqual(picture(copy).members, before.members, "the copy holds the Threads as they were")
  const copyHash = createHash("sha256").update(readFileSync(copy)).digest("hex")

  // Others hosts sharing the store forget each moved Session's placement.
  const log = new DatabaseSync(path, { readOnly: true })
  const logged = new Set(log.prepare("SELECT session_id FROM placement_changes").all().map((row) => String(row.session_id)))
  const stamp = log.prepare("SELECT value FROM store_meta WHERE key = 'one-conversation'").get()
  log.close()
  for (const session of made.keys()) assert.ok(logged.has(session), "a moved Session is in the placement log")
  assert.ok(stamp, "the store says it was split")
  store.close()

  // A second open changes nothing, and keeps the first copy.
  const once = digest(path)
  open(path, true).close()
  assert.equal(digest(path), once, "a second split changes nothing")
  assert.equal(createHash("sha256").update(readFileSync(copy)).digest("hex"), copyHash, "and the copy is the first one")

  // A build before the split reads it, and its + and forks group again; the next open splits those too.
  const older = open(path, false)
  assert.deepEqual(older.groups().map((group) => group.id).sort(), [fixture.elsewhere, fixture.moving].sort())
  const regrouped = older.createSession({ operationId: randomUUID(), thread: apex, actor: older.person() })
  assert.equal(regrouped.thread, apex)
  older.close()
  const resplit = open(path, true)
  assert.equal(resplit.sessionPlacement(regrouped.session)?.thread, splitThreadId(apex, regrouped.session))

  // While it's on, a + and a fork make Threads of their own in their source's place.
  const second = resplit.createSession({ operationId: randomUUID(), thread: ThreadIdSchema.parse(splitThreadId(apex, sessions[3]!)), actor: resplit.person() })
  assert.notEqual(second.thread, splitThreadId(apex, sessions[3]!))
  assert.deepEqual(resplit.thread(second.thread)?.sessions, [second.session])
  assert.equal(resplit.placeOf(second.thread), apex, "a + beside a split Thread works in the same place")
  const fork = resplit.registerJournal(journal({ harness: "cursor", ancestry: { parentId: fixture.conversations[2]!, placement: "parent-thread" }, bindings: [binding("cursor", "late-fork")] }), resplit.person())
  assert.notEqual(fork.thread, splitThreadId(apex, sessions[2]!), "a fork is a Thread of its own")
  assert.equal(resplit.forksOf([fork.session]).get(fork.session), sessions[2], "that says what it forked from")
  assert.equal(resplit.placeOf(fork.thread), apex)
  const harnessFork = resplit.resolveRefs([{ harness: "codex", nativeId: "late-codex-fork", path: "/natives/codex/late.jsonl", parentNativeId: "s1-codex" }], migration).get("/natives/codex/late.jsonl")!
  assert.notEqual(harnessFork.thread, handedOff.thread, "a harness's own fork is one too")
  assert.equal(resplit.placeOf(harnessFork.thread), apex)
  // Removing the place's worktree leaves no Thread pointing at the owner's next one.
  resplit.detachWorktree("/worktrees/thread-environments")
  assert.equal(resplit.placeOf(second.thread), second.thread, "a removed worktree's place is gone for every Thread in it")
  resplit.close()
  console.log("ok: the 14-Session Thread, its Fins, forks, hand-off, worktree, title, purpose, archive and draft")
}

function crashChecks(): void {
  // Thrown inside the split: the transaction rolls back and the store is as it was.
  const thrown = buildFixture("thrown")
  const before = digest(thrown.path)
  assert.throws(() => open(thrown.path, true, { afterSplitThread: (done) => { if (done === 2) throw new Error("cut off mid-split") } }), /cut off mid-split/)
  assert.equal(digest(thrown.path), before, "a split that fails part way leaves nothing changed")
  open(thrown.path, true).close()

  // Killed: a process stopped with SIGKILL after two Threads, mid-transaction, then a fresh open.
  const killed = buildFixture("killed")
  const killedBefore = picture(killed.path)
  const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--crash-child", killed.path], { encoding: "utf8" })
  assert.equal(child.signal, "SIGKILL", `the child died mid-split (${child.stderr})`)
  assert.deepEqual(picture(killed.path).members, killedBefore.members, "a process killed mid-split leaves every Session where it was")
  const store = open(killed.path, true)
  checkSplit(killedBefore, picture(killed.path), new Set([killed.elsewhere, killed.moving]), store)
  store.close()
  console.log("ok: a split thrown or killed part way changes nothing, and the next open finishes it")
}

function undoChecks(): void {
  const fixture = buildFixture("undo")
  const before = picture(fixture.path)
  open(fixture.path, true).close()
  const split = digest(fixture.path)
  const db = new DatabaseSync(fixture.path)
  db.exec("BEGIN IMMEDIATE")
  const undone = undoThreadSplits(db)
  db.exec("COMMIT")
  db.close()
  assert.deepEqual(undone, { rejoined: 14, kept: 0 })
  const back = picture(fixture.path)
  assert.deepEqual(back.members, before.members, "every Session is back in its Thread at its tab")
  assert.deepEqual([...back.edges.values()].map((edge) => [edge.child, edge.parent]).sort(), [...before.edges.values()].map((edge) => [edge.child, edge.parent]).sort(), "every edge is back")
  assert.deepEqual(back.reports, before.reports, "every report is back")
  assert.deepEqual(back.kept, before.kept)
  const older = open(fixture.path, false)
  assert.equal(older.thread(fixture.apex)?.sessions.length, 14, "a build before the split sees the Thread whole")
  older.close()
  open(fixture.path, true).close()
  assert.equal(digest(fixture.path), split, "splitting again makes the same Threads")
  console.log("ok: the way back rejoins every Session, edge and report, and a second split matches the first")
}

/** A store of the person's shape at `threads` Threads: one in 50 with 2 to 14 Sessions of every origin, and Fins under 16 of those. */
function generate(path: string, threads: number): { thread: string; sessions: string[] }[] {
  open(path, false).close()
  const db = new DatabaseSync(path)
  const principal = String(db.prepare("SELECT value FROM store_meta WHERE key = 'principal'").get()!.value)
  const device = String(db.prepare("SELECT value FROM store_meta WHERE key = 'device'").get()!.value)
  const actor = JSON.stringify(migration)
  const origins = ["imported", "imported", "imported", "new", "fork", "started", "captured"] as const
  let seed = 7
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
  const multi: { thread: string; sessions: string[] }[] = []
  db.exec("BEGIN")
  for (let index = 0; index < threads; index += 1) {
    const thread = randomUUID()
    const size = index % 50 === 7 ? 2 + Math.floor(random() * 13) : 1
    db.prepare("INSERT INTO threads (id, owner_id, title, title_source, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(thread, principal, index % 50 === 7 && random() < 0.2 ? `Named ${index}` : null, index % 50 === 7 && random() < 0.2 ? "user" : null, clock++, actor)
    const sessions: string[] = []
    for (let position = 0; position < size; position += 1) {
      const session = randomUUID()
      const origin = position === 0 ? "started" : origins[Math.floor(random() * origins.length)]!
      const parent = origin === "fork" || (origin === "imported" && random() < 0.5) ? sessions[Math.floor(random() * sessions.length)] ?? null : null
      db.prepare("INSERT INTO sessions (id, origin, parent_session, created_at, created_by) VALUES (?, ?, ?, ?, ?)").run(session, origin, parent, clock++, actor)
      db.prepare("INSERT INTO memberships (session_id, thread_id, position, added_at, added_by) VALUES (?, ?, ?, ?, ?)").run(session, thread, position, clock++, actor)
      db.prepare("INSERT INTO executions (session_id, owner_kind, owner_id, generation, move_id, updated_at, updated_by) VALUES (?, 'device', ?, 1, NULL, ?, ?)").run(session, device, clock++, actor)
      db.prepare("INSERT INTO sources (device_id, harness, key, session_id, first_seen_at) VALUES (?, 'codex', ?, ?, ?)").run(device, session, session, clock++)
      sessions.push(session)
    }
    if (size > 1) multi.push({ thread, sessions })
  }
  for (const [index, apex] of multi.slice(0, 16).entries()) {
    const child = randomUUID()
    const childSession = randomUUID()
    db.prepare("INSERT INTO threads (id, owner_id, created_at, created_by) VALUES (?, ?, ?, ?)").run(child, principal, clock++, actor)
    db.prepare("INSERT INTO sessions (id, origin, parent_session, created_at, created_by) VALUES (?, 'started', NULL, ?, ?)").run(childSession, clock++, actor)
    db.prepare("INSERT INTO memberships (session_id, thread_id, position, added_at, added_by) VALUES (?, ?, 0, ?, ?)").run(childSession, child, clock++, actor)
    db.prepare("INSERT INTO executions (session_id, owner_kind, owner_id, generation, move_id, updated_at, updated_by) VALUES (?, 'device', ?, 1, NULL, ?, ?)").run(childSession, device, clock++, actor)
    const parentSession = apex.sessions[index % apex.sessions.length]!
    const record = { child, parent: apex.thread, parentSession, name: `fin-${index}`, role: "worker", origin: "started", asked: { brief: { objective: "work" } }, op: `op-${index}`, startedBy: { kind: "agent", session: parentSession }, createdAt: clock++ }
    db.prepare("INSERT INTO thread_parents (child_thread, parent_thread, name, op, run_harness, run_native_id, record, created_at, closed_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL)")
      .run(child, apex.thread, record.name, record.op, JSON.stringify(record), record.createdAt)
  }
  db.exec("COMMIT")
  db.close()
  return multi
}

/** The person's store, about 5,000 Threads, 100 of them split; its split's work grows with the store, not its square. */
function generatedChecks(): void {
  const path = join(root, "generated.sqlite")
  const multi = generate(path, 5000)
  const before = picture(path)
  const store = open(path, true)
  const made = checkSplit(before, picture(path), new Set(), store)
  store.close()
  assert.equal(made.size, multi.reduce((sum, thread) => sum + thread.sessions.length - 1, 0))
  const once = digest(path)
  open(path, true).close()
  assert.equal(digest(path), once, "a second open changes nothing")
  let stores = 0
  const grew = growth((threads) => {
    const each = join(root, `generated-${stores++}.sqlite`)
    generate(each, threads)
    return () => open(each, true).close()
  }, 1_000, 10_000, 3)
  assert.ok(grew.ratio < subquadratic(1_000, 10_000), `splitting 10,000 Threads took ${grew.ratio.toFixed(1)} times 1,000`)
  console.log(`ok: a generated store of the person's shape (${multi.length} Threads into ${multi.length + made.size}, twice its size split in ${Math.round(grew.largeMs)} ms of CPU, ${grew.ratio.toFixed(1)} times a tenth of that)`)
}

/** A copy of a real store, copied again so the one named is never written. */
function realCopyChecks(source: string): void {
  const path = join(root, "real-copy.sqlite")
  for (const suffix of ["", "-wal"]) if (existsSync(source + suffix)) copyFileSync(source + suffix, path + suffix)
  // A store a newer build migrated first is opened by this one as it is.
  open(path, false).close()
  const before = picture(path)
  const db = new DatabaseSync(path, { readOnly: true })
  const self = String(db.prepare("SELECT value FROM store_meta WHERE key = 'self'").get()!.value)
  const owner = OwnerSchema.parse(JSON.parse(self))
  const deferred = new Set(db.prepare(`SELECT DISTINCT m.thread_id AS id FROM memberships m LEFT JOIN executions e ON e.session_id = m.session_id
    WHERE (e.session_id IS NOT NULL AND (e.owner_kind IS NOT ? OR e.owner_id IS NOT ?))
    OR m.thread_id IN (SELECT thread_id FROM moves WHERE phase IN ('leaving', 'released'))`).all(owner.kind, owner.device ?? owner.runtime ?? "").map((row) => String(row.id)))
  db.close()
  const store = open(path, true)
  const made = checkSplit(before, picture(path), deferred, store)
  store.close()
  const undo = new DatabaseSync(path)
  undo.exec("BEGIN IMMEDIATE")
  const undone = undoThreadSplits(undo)
  undo.exec("COMMIT")
  undo.close()
  assert.deepEqual(picture(path).members, before.members, "the way back restores the real store's Threads")
  console.log(`ok: a copy of a real store (${made.size} Threads made, ${deferred.size} left whole, ${undone.rejoined} rejoined by the way back)`)
}

try {
  fixtureChecks()
  crashChecks()
  undoChecks()
  generatedChecks()
  const real = process.env.MAKO_SPLIT_REAL_COPY
  if (real) realCopyChecks(real)
} finally {
  rmSync(root, { recursive: true, force: true })
}
