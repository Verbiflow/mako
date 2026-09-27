import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Actor, SessionId } from "../electron/contracts/thread-identity.js"
import {
  MoveIdSchema,
  RuntimeIdSchema,
  executionRefusal,
  type ExecutionOwner,
  type MoveId,
  type SessionExecution,
} from "../electron/contracts/thread-execution.js"
import {
  THREAD_STORE_MIGRATION,
  ThreadMoveConflictError,
  ThreadOperationConflictError,
  ThreadStore,
  type JournalFacts,
  type ThreadStoreOptions,
} from "../electron/thread-store.js"

const root = mkdtempSync(join(tmpdir(), "mako-thread-execution-"))
const handoffActor: Actor = { kind: "service", name: "handoff" }
const catalog: Actor = { kind: "service", name: "catalog" }
const cloud: ExecutionOwner = { kind: "cloud", runtime: RuntimeIdSchema.parse(randomUUID()) }
let clock = 1_000
const now = () => clock++

function store(name: string, self?: ExecutionOwner): ThreadStore {
  const options: ThreadStoreOptions = { now, realPath: (path) => path }
  if (self) options.self = self
  return new ThreadStore(join(root, `${name}.sqlite`), options)
}

function journal(input: Partial<JournalFacts> = {}): JournalFacts {
  return { conversationId: randomUUID(), createdAt: clock++, harness: "codex", bindings: [], ...input }
}

function moveId(): MoveId {
  return MoveIdSchema.parse(randomUUID())
}

function state(threads: ThreadStore, session: SessionId): Pick<SessionExecution, "state" | "generation"> {
  const execution = threads.execution(session)
  assert.ok(execution, "the store knows the Session")
  return { state: execution.state, generation: execution.generation }
}

function count(path: string, sql: string): number {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return Number(Object.values(db.prepare(sql).get() ?? {})[0])
  } finally {
    db.close()
  }
}

/** A store written by the A1 build: no execution tables, no `self`. */
function migrationFromA1(): void {
  const path = join(root, "a1.sqlite")
  const a1 = new ThreadStore(path, { now, realPath: (value) => value })
  const placed = a1.registerJournal(journal({ bindings: [{ provider: "codex", nativeId: "n-a1", path: "/fixture/a1.jsonl" }] }), a1.person())
  a1.close()
  const db = new DatabaseSync(path)
  db.exec("DROP TABLE executions; DROP TABLE moves; DROP TABLE store_migrations; DELETE FROM store_meta WHERE key = 'self'")
  db.close()

  const migrated = new ThreadStore(path, { now, realPath: (value) => value })
  assert.deepEqual(migrated.self, { kind: "device", device: migrated.deviceId }, "a Mac's store executes for its own device")
  assert.deepEqual(state(migrated, placed.session), { state: "here", generation: 1 }, "every existing Session runs here at generation 1")
  assert.equal(count(path, `SELECT count(*) FROM store_migrations WHERE version = ${THREAD_STORE_MIGRATION}`), 1)
  assert.equal(count(path, "SELECT count(*) FROM executions"), 1)
  migrated.close()

  // An A1 host on the same Mac mints a Session after the migration.
  const late = randomUUID()
  const writer = new DatabaseSync(path)
  writer.prepare("INSERT INTO sessions (id, origin, parent_session, created_at, created_by) VALUES (?, 'imported', NULL, 1, '{}')").run(late)
  writer.close()
  const reopened = new ThreadStore(path, { now, realPath: (value) => value })
  assert.equal(count(path, "SELECT count(*) FROM executions"), 2, "the next open writes a row for it")
  assert.deepEqual(state(reopened, placed.session), { state: "here", generation: 1 }, "reopening does not change a generation")
  reopened.close()

  assert.throws(() => new ThreadStore(path, { now, self: cloud }), /another environment/, "a store's environment is fixed")
}

/** Mac to cloud and back: same IDs, generation 1 to 5, one owner at a time. */
function roundTrip(): void {
  const mac = store("round-mac")
  const runtime = store("round-cloud", cloud)
  const first = mac.registerJournal(journal({ bindings: [{ provider: "codex", nativeId: "n-round", path: "/fixture/round.jsonl" }] }), mac.person())
  const tab = mac.createSession({ operationId: randomUUID(), thread: first.thread, actor: mac.person() })
  const tabJournal = journal({ session: tab.session })
  mac.registerJournal(tabJournal, mac.person())
  mac.renameThread({ operationId: randomUUID(), thread: first.thread, title: "Checkout flow", actor: mac.person() })

  const out = moveId()
  const began = mac.beginMove({ move: out, thread: first.thread, target: cloud, actor: mac.person() })
  assert.deepEqual(began.sessions, [first.session, tab.session])
  assert.deepEqual(state(mac, first.session), { state: "leaving", generation: 1 }, "leaving changes no generation")
  assert.equal(executionRefusal(mac.journalExecution(tabJournal)), undefined, "a leaving Session still admits prompts")
  assert.deepEqual(mac.moveJournals(out).find((entry) => entry.session === tab.session)?.journals, [tabJournal.conversationId])

  const releaseOp = randomUUID()
  const handoff = mac.release({ operationId: releaseOp, move: out, actor: mac.person() })
  assert.deepEqual(mac.release({ operationId: releaseOp, move: out, actor: mac.person() }), handoff, "replaying a release returns the same handoff")
  assert.deepEqual(state(mac, first.session), { state: "in-transit", generation: 2 })
  assert.match(executionRefusal(mac.journalExecution(tabJournal)) ?? "", /moving to a cloud runtime/)
  assert.throws(() => mac.createSession({ operationId: randomUUID(), thread: first.thread, actor: mac.person() }), /moving/)
  assert.equal(handoff.thread.title, "Checkout flow")
  assert.deepEqual(handoff.sessions.map((session) => [session.id, session.generation]), [[first.session, 2], [tab.session, 2]])

  const receipt = runtime.claim({ operationId: randomUUID(), handoff, actor: handoffActor })
  assert.deepEqual(runtime.claim({ operationId: randomUUID(), handoff, actor: handoffActor }), receipt, "a move is claimed once")
  assert.deepEqual(state(runtime, first.session), { state: "here", generation: 3 })
  assert.deepEqual(runtime.thread(first.thread)?.sessions, [first.session, tab.session], "the cloud keeps the Thread's IDs and order")
  assert.equal(runtime.thread(first.thread)?.title, "Checkout flow")
  assert.deepEqual(runtime.journalPlacement(tabJournal.conversationId), tab, "journals arrive under their Session")
  assert.throws(() => runtime.refuse({ operationId: randomUUID(), handoff, reason: "full", actor: handoffActor }), /already arrived/)

  mac.confirm({ operationId: randomUUID(), receipt, actor: handoffActor })
  assert.deepEqual(state(mac, first.session), { state: "elsewhere", generation: 3 })
  assert.match(executionRefusal(mac.journalExecution(tabJournal)) ?? "", /runs on a cloud runtime/)
  const capture = journal({ threadPath: "/fixture/round.jsonl", bindings: [{ provider: "codex", nativeId: "n-round", path: "/fixture/round.jsonl" }] })
  assert.equal(mac.journalExecution(capture).state, "elsewhere", "reopening the native session here is refused too")
  assert.equal(mac.journalExecution(journal({ bindings: [{ provider: "codex", nativeId: "n-round" }] })).state, "elsewhere", "so is a resume by native ID alone")
  assert.equal(mac.journalExecution(journal()).state, "here", "a new conversation runs here")
  assert.throws(() => mac.beginMove({ move: moveId(), thread: first.thread, target: cloud, actor: mac.person() }), /runs on a cloud runtime/)
  const replayed = { ...handoff, move: moveId(), source: cloud, target: mac.self }
  assert.throws(() => mac.claim({ operationId: randomUUID(), handoff: replayed, actor: handoffActor }), /older than/, "an old handoff never takes a Session back")

  const back = moveId()
  runtime.beginMove({ move: back, thread: first.thread, target: mac.self, actor: handoffActor })
  const returned = runtime.release({ operationId: randomUUID(), move: back, actor: handoffActor })
  const home = mac.claim({ operationId: randomUUID(), handoff: returned, actor: handoffActor })
  runtime.confirm({ operationId: randomUUID(), receipt: home, actor: handoffActor })
  assert.deepEqual(state(mac, first.session), { state: "here", generation: 5 }, "home again two owner changes later")
  assert.deepEqual(state(runtime, first.session), { state: "elsewhere", generation: 5 })
  assert.deepEqual(mac.journalPlacement(tabJournal.conversationId), tab, "the same Thread and Session IDs throughout")
  assert.equal(mac.journalExecution(tabJournal).state, "here")
  mac.createSession({ operationId: randomUUID(), thread: first.thread, actor: mac.person() })
  mac.close()
  runtime.close()
}

function cancelAndConflicts(): void {
  const mac = store("cancel-mac")
  const placed = mac.registerJournal(journal(), mac.person())
  assert.throws(() => mac.beginMove({ move: moveId(), thread: placed.thread, target: mac.self, actor: mac.person() }), /already runs here/)
  const move = moveId()
  mac.beginMove({ move, thread: placed.thread, target: cloud, actor: mac.person() })
  mac.beginMove({ move, thread: placed.thread, target: cloud, actor: mac.person() })
  assert.throws(() => mac.beginMove({ move: moveId(), thread: placed.thread, target: cloud, actor: mac.person() }), ThreadMoveConflictError)
  const other = mac.registerJournal(journal(), mac.person())
  assert.throws(() => mac.beginMove({ move, thread: other.thread, target: cloud, actor: mac.person() }), ThreadOperationConflictError)
  mac.cancelMove({ operationId: randomUUID(), move, actor: mac.person() })
  assert.deepEqual(state(mac, placed.session), { state: "here", generation: 1 }, "a cancelled move leaves no trace on the Session")
  assert.throws(() => mac.release({ operationId: randomUUID(), move, actor: mac.person() }), /already cancelled/)
  mac.beginMove({ move: moveId(), thread: placed.thread, target: cloud, actor: mac.person() })
  mac.close()
}

function refuseAndReclaim(): void {
  const mac = store("refuse-mac")
  const runtime = store("refuse-cloud", cloud)
  const elsewhere = store("refuse-other", { kind: "cloud", runtime: RuntimeIdSchema.parse(randomUUID()) })
  const placed = mac.registerJournal(journal(), mac.person())
  const move = moveId()
  mac.beginMove({ move, thread: placed.thread, target: cloud, actor: mac.person() })
  const handoff = mac.release({ operationId: randomUUID(), move, actor: mac.person() })
  assert.throws(() => elsewhere.claim({ operationId: randomUUID(), handoff, actor: handoffActor }), /another environment/)
  const refusal = runtime.refuse({ operationId: randomUUID(), handoff, reason: "no workspace", actor: handoffActor })
  assert.deepEqual(runtime.refuse({ operationId: randomUUID(), handoff, reason: "again", actor: handoffActor }), refusal, "a refusal is answered once")
  assert.throws(() => runtime.claim({ operationId: randomUUID(), handoff, actor: handoffActor }), /already refused/, "a refused move is never claimed")
  assert.equal(runtime.execution(placed.session), undefined, "a refusal writes no Session")
  mac.reclaim({ operationId: randomUUID(), refusal, actor: mac.person() })
  assert.deepEqual(state(mac, placed.session), { state: "here", generation: 3 })
  const forged = { move, owner: cloud, sessions: [{ id: placed.session, generation: 3 }] }
  assert.throws(() => mac.confirm({ operationId: randomUUID(), receipt: forged, actor: handoffActor }), /taken back/)
  mac.close()
  runtime.close()
  elsewhere.close()
}

/** The Thread comes back before the cloud's first receipt reaches the Mac. */
function returnBeforeReceipt(): void {
  const mac = store("early-mac")
  const runtime = store("early-cloud", cloud)
  const placed = mac.registerJournal(journal(), mac.person())
  const out = moveId()
  mac.beginMove({ move: out, thread: placed.thread, target: cloud, actor: mac.person() })
  const handoff = mac.release({ operationId: randomUUID(), move: out, actor: mac.person() })
  const receipt = runtime.claim({ operationId: randomUUID(), handoff, actor: handoffActor })
  assert.throws(() => mac.claim({ operationId: randomUUID(), handoff, actor: handoffActor }), /another environment/)

  const back = moveId()
  runtime.beginMove({ move: back, thread: placed.thread, target: mac.self, actor: handoffActor })
  const returned = runtime.release({ operationId: randomUUID(), move: back, actor: handoffActor })
  mac.claim({ operationId: randomUUID(), handoff: returned, actor: handoffActor })
  assert.deepEqual(state(mac, placed.session), { state: "here", generation: 5 })
  mac.confirm({ operationId: randomUUID(), receipt, actor: handoffActor })
  assert.deepEqual(state(mac, placed.session), { state: "here", generation: 5 }, "a late receipt does not take the Thread away again")
  mac.beginMove({ move: moveId(), thread: placed.thread, target: cloud, actor: mac.person() })
  mac.close()
  runtime.close()
}

/** A Session that has moved keeps its identity when a catalog alias turns up. */
function mergeExclusion(): void {
  const mac = store("merge-mac")
  const runtime = store("merge-cloud", cloud)
  const older = mac.resolveRefs([{ harness: "codex", nativeId: "n-older", path: "/fixture/older.jsonl", identity: "k-older" }], catalog)
    .get("/fixture/older.jsonl")
  const moved = mac.resolveRefs([{ harness: "codex", nativeId: "n-moved", path: "/fixture/moved.jsonl", identity: "k-moved" }], catalog)
    .get("/fixture/moved.jsonl")
  assert.ok(older && moved)
  const out = moveId()
  mac.beginMove({ move: out, thread: moved.thread, target: cloud, actor: mac.person() })
  const receipt = runtime.claim({ operationId: randomUUID(), handoff: mac.release({ operationId: randomUUID(), move: out, actor: mac.person() }), actor: handoffActor })
  mac.confirm({ operationId: randomUUID(), receipt, actor: handoffActor })
  const back = moveId()
  runtime.beginMove({ move: back, thread: moved.thread, target: mac.self, actor: handoffActor })
  mac.claim({ operationId: randomUUID(), handoff: runtime.release({ operationId: randomUUID(), move: back, actor: handoffActor }), actor: handoffActor })

  const both = mac.registerJournal(journal({
    bindings: [
      { provider: "codex", nativeId: "n-older", path: "/fixture/older.jsonl" },
      { provider: "codex", path: "/fixture/moved.jsonl" },
    ],
  }), mac.person())
  assert.equal(both.session, moved.session, "the older, unmoved Session joins the moved one")
  assert.deepEqual(mac.sessionPlacement(older.session), moved)
  mac.close()
  runtime.close()
}

/** Two hosts on one Mac share the store file; each sees the other's moves. */
function twoHosts(): void {
  const first = store("hosts")
  const second = store("hosts")
  const placed = first.registerJournal(journal(), first.person())
  const tracked = journal({ session: placed.session })
  first.registerJournal(tracked, first.person())
  assert.equal(second.journalExecution(tracked).state, "here")
  assert.equal(first.journalExecution(tracked).state, "here")

  const move = moveId()
  second.beginMove({ move, thread: placed.thread, target: cloud, actor: second.person() })
  assert.equal(first.journalExecution(tracked).state, "leaving", "another host's commit clears the remembered answer")
  assert.throws(() => first.beginMove({ move: moveId(), thread: placed.thread, target: cloud, actor: first.person() }), ThreadMoveConflictError)
  first.release({ operationId: randomUUID(), move, actor: first.person() })
  assert.equal(second.journalExecution(tracked).state, "in-transit")
  first.close()
  second.close()
}

try {
  migrationFromA1()
  roundTrip()
  cancelAndConflicts()
  refuseAndReclaim()
  returnBeforeReceipt()
  mergeExclusion()
  twoHosts()
  console.log("thread execution: migration, round trip, cancel, refuse and reclaim, early return, merge exclusion, two hosts")
} finally {
  rmSync(root, { recursive: true, force: true })
}
