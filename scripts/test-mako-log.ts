import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { foldMakoLog, makoFacts, makoLogDifference } from "@mako/host/conversations/mako-log"
import type { ConversationControl } from "@mako/host/contracts/conversation-control"
import type { ConversationGoal } from "@mako/host/contracts/live-goals"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { auditSnapshot } from "./performance-audit-fixtures"

process.env.MAKO_LOG_CHECK = "1"
const root = await mkdtemp(join(tmpdir(), "mako-log-"))
let snapshot = auditSnapshot(1)
const id = snapshot.session.id
const file = join(root, `${id}.sqlite`)
let journal = new LiveJournal(root, id)
let seen = 0

/** Commits `next` and returns the kinds of the events it logged; the log must fold to its facts. */
function commit(next: LiveSnapshot): string[] {
  const previous = snapshot
  snapshot = { ...next, revision: previous.revision + 1 }
  journal.commit(snapshot, previous)
  const log = journal.makoLog()
  assert.equal(makoLogDifference(log, makoFacts(snapshot)), undefined)
  const added = log.slice(seen)
  seen = log.length
  return added.map((event) => event.kind)
}

const binding = (bindingId: string, nativeId?: string): ConversationControl["bindings"][number] => {
  const made: ConversationControl["bindings"][number] = { id: bindingId, provider: "fixture", coveredBlocks: 0, includesBase: false }
  if (nativeId) made.nativeId = nativeId
  return made
}

try {
  journal.commit(snapshot)
  seen = journal.makoLog().length
  assert.deepEqual(journal.makoLog().map((event) => event.kind), ["request"], "A new conversation logs its first request whole")
  assert.ok(journal.makoLog().every((event) => event.origin === "host" && event.schema === 1))

  const [request] = snapshot.requests
  assert.ok(request)
  assert.deepEqual(commit({ ...snapshot, requests: [{ ...request, status: "completed" }] }), ["request.completed"], "Each step of a request is named by the state it reached")
  const completed = journal.makoLog().at(-1)
  assert.deepEqual(completed?.value, { key: request.id, set: { status: "completed" } }, "A change holds only what changed")

  assert.deepEqual(commit({ ...snapshot, blocks: [...snapshot.blocks, { type: "text", id: "text-more", text: "more" }] }), [], "A flush that changed none of Mako's facts logs nothing")

  const first = randomUUID()
  const second = randomUUID()
  const control: ConversationControl = { merges: [], activeBindingId: first, bindings: [binding(first)], transfers: [] }
  assert.deepEqual(commit({ ...snapshot, control }), ["activeBinding", "control", "binding"])
  assert.deepEqual(commit({ ...snapshot, control: { ...control, bindings: [binding(first, "native-1")] } }), ["binding.changed"], "A binding the harness named changes in place")
  const named = snapshot.control!
  assert.deepEqual(commit({ ...snapshot, control: { ...named, activeBindingId: second, bindings: [...named.bindings, binding(second)] } }), ["activeBinding", "binding"], "A switch is its activation and its binding")
  const switched = snapshot.control!
  assert.deepEqual(commit({ ...snapshot, control: { ...switched, bindings: [...switched.bindings].reverse() } }), ["binding.order"])
  assert.deepEqual(commit({ ...snapshot, control: { ...switched, bindings: [binding(second)] } }), ["binding.removed"], "A removed binding is its own event")

  const fork = randomUUID()
  const asked = randomUUID()
  const second_request = { id: asked, text: "Go on.", attachments: [], status: "dispatching" as const }
  assert.deepEqual(commit({ ...snapshot, requests: [...snapshot.requests, second_request] }), ["request"])
  assert.deepEqual(
    commit({ ...snapshot, requests: [snapshot.requests[0]!, { ...second_request, status: "interrupted", interruption: { reason: "stopped", at: 5, closed: ["tool-0"] } }] }),
    ["request.interrupted"],
  )
  assert.deepEqual(
    commit({ ...snapshot, control: { ...snapshot.control!, ancestry: { kind: "fork", parentId: fork, sourceRevision: 3, point: "run" } } }),
    ["ancestry"],
  )
  assert.deepEqual(commit({ ...snapshot, control: { ...snapshot.control!, ancestry: undefined } }), ["ancestry"], "A field control loses is unset")

  const goal: ConversationGoal = { objective: "Ship it", status: "active", by: "mako", setAt: 1, updatedAt: 1 }
  assert.deepEqual(commit({ ...snapshot, goal }), ["goal"])
  assert.deepEqual(commit({ ...snapshot, goal: { ...goal, status: "paused", updatedAt: 2 } }), ["goal.changed"])
  assert.deepEqual(journal.makoLog().at(-1)?.value, { set: { status: "paused", updatedAt: 2 } })
  assert.deepEqual(commit({ ...snapshot, goal: undefined }), ["goal.removed"])
  assert.deepEqual(commit({ ...snapshot, requests: [snapshot.requests[1]!] }), ["request.removed"])
  assert.deepEqual(commit({ ...snapshot, control: undefined }), ["control.removed"])
  assert.deepEqual(commit({ ...snapshot, control }), ["activeBinding", "control", "binding"], "Control that comes back logs whole again")

  const writer = new DatabaseSync(file)
  try {
    writer.exec("CREATE TRIGGER refuse_log BEFORE INSERT ON log BEGIN SELECT RAISE(ABORT, 'fixture log refusal'); END")
    const before = snapshot
    const refused = { ...snapshot, revision: snapshot.revision + 1, requests: [{ ...snapshot.requests[0]!, status: "completed" as const }] }
    assert.throws(() => journal.commit(refused, before), /fixture log refusal/)
    assert.deepEqual(journal.read()?.requests, before.requests, "A refused log takes the rows down with it")
    writer.exec("DROP TRIGGER refuse_log")
    assert.deepEqual(commit(refused), ["request.completed"], "After a rollback the log starts from what it holds, not from what it failed to write")
  } finally {
    writer.close()
  }

  journal.close()
  journal = new LiveJournal(root, id)
  const reopened = journal.read()
  assert.deepEqual(reopened?.requests, snapshot.requests)
  assert.equal(journal.makoLog().length, seen, "Reopening a journal whose log matches its rows logs nothing")
  journal.close()

  const older = new DatabaseSync(file)
  try {
    const { value } = z.object({ value: z.string() }).parse(older.prepare("SELECT value FROM requests WHERE id = ?").get(asked))
    older.prepare("UPDATE requests SET value = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(value), status: "failed", error: "older build" }), asked)
  } finally {
    older.close()
  }
  journal = new LiveJournal(root, id)
  const healed = journal.read()
  const taken = journal.makoLog().slice(seen)
  assert.deepEqual(taken.map((event) => [event.kind, event.origin]), [["request.failed", "journal"]], "A row an older build changed is taken into the log, marked as the journal's")
  assert.equal(makoLogDifference(journal.makoLog(), makoFacts(healed!)), undefined)
  journal.close()

  const blank = new DatabaseSync(file)
  try {
    blank.exec("DELETE FROM log")
  } finally {
    blank.close()
  }
  journal = new LiveJournal(root, id)
  const imported = journal.read()!
  const log = journal.makoLog()
  assert.ok(log.length > 0 && log.every((event) => event.origin === "journal"), "A journal from before the log has its facts imported")
  assert.equal(makoLogDifference(log, makoFacts(imported)), undefined)
  assert.equal(foldMakoLog([{ kind: "someday.new", value: { x: 1 } }, ...log]).facts().requests.length, imported.requests.length, "A kind this build doesn't know changes nothing")
  journal.close()
  console.log(`Mako's log: ${seen} events through a conversation's life fold to its facts; a rollback, a reopen, an older build and a journal from before the log all agree`)
} finally {
  try {
    journal.close()
  } catch {}
  await rm(root, { recursive: true, force: true })
}
