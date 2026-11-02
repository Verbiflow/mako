import assert from "node:assert/strict"
import { test } from "node:test"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { ASLEEP_AFTER_MS, byLastWorked, lastWorked, sessionStanding, staleTarget, type SessionFacts } from "@mako/host/contracts/session-choice"
import { foldThreads, newerThan, openingSession, sessionsByLastWorked } from "../src/web-client/threads"
import { forkedFrom, sendsToWords, sessionBrief, sessionCalled, sessionDetail, sessionName, staleSendWords, wokeWords } from "../src/lib/session-words"
import { wokeAfterRest } from "../src/lib/woke-after-rest"
import type { Exchange } from "../src/lib/exchanges"
import type { ChatMessage } from "../src/lib/types"

const day = 24 * 60 * 60_000
const NOW = Date.parse("2026-11-01T20:17:00Z")
const label = (harness: string) => ({ cursor: "Cursor", claude: "Claude Code", codex: "Codex" })[harness] ?? harness
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

function facts(id: string, fields: Partial<SessionFacts>): SessionFacts {
  return { id, harness: "claude", state: "idle", createdAt: NOW - 30 * day, ...fields }
}

function listed(n: number, fields: Partial<ListedSession>): ListedSession {
  return {
    session: uuid(n),
    thread: uuid(100),
    conversation: `c${n}`,
    harness: "claude",
    state: "idle",
    folder: "/work/api",
    createdAt: new Date(NOW - 30 * day).toISOString(),
    activityAt: new Date(NOW - 30 * day).toISOString(),
    generation: 1,
    runsOn: { kind: "cloud", threadId: "t-0123456789abcdef" },
    listedAt: new Date(NOW).toISOString(),
    ...fields,
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

/**
 * The Thread of 2026-11-01 as the account listed it: a Cursor fork made Oct 10 and last sent a message Oct 12, two
 * Claude Code Sessions, and the Cursor Session the person worked in that afternoon, idle between turns. The fork and
 * the first Claude Code Session were read on another device that evening, so their journals are the newest written.
 */
function incident(): ListedSession[] {
  return [
    listed(9, { harness: "cursor", forkOf: uuid(8), createdAt: iso(NOW - 22 * day), promptedAt: iso(NOW - 20 * day), activityAt: iso(NOW + 90 * 60_000), title: "Wire the review screen" }),
    listed(11, { createdAt: iso(NOW - 19 * day), promptedAt: iso(NOW - 19 * day), activityAt: iso(NOW + 3 * 60 * 60_000) }),
    listed(12, { createdAt: iso(NOW - 15 * day), promptedAt: iso(NOW - 15 * day), activityAt: iso(NOW - 15 * day) }),
    listed(14, { harness: "cursor", createdAt: iso(NOW - 7 * day), promptedAt: iso(NOW - 4 * 60 * 60_000), activityAt: iso(NOW - 4 * 60 * 60_000), title: "Ship the session picker" }),
  ]
}

function incidentThread() {
  return foldThreads({ rows: incident(), devices: new Map(), quiet: new Map(), waiting: new Map(), archived: [] }).threads[0]!
}

test("nothing picks a Session for the person by how recent it is: a Thread opens as it always did, on its first unless one waits or works", () => {
  const thread = incidentThread()
  // The tabs keep their places, oldest first, as a Mac's do.
  assert.deepEqual(thread.sessions.map((session) => session.row.conversation), ["c9", "c11", "c12", "c14"])
  assert.equal(openingSession(thread).row.conversation, "c9", "the Session worked in this afternoon isn't chosen for them")
  const rows = incident()
  rows[1]!.state = "working"
  rows[2]!.state = "waiting"
  const busy = foldThreads({ rows, devices: new Map(), quiet: new Map(), waiting: new Map(), archived: [] }).threads[0]!
  assert.equal(openingSession(busy).row.conversation, "c12", "one waiting on the person")
  rows[2]!.state = "idle"
  assert.equal(openingSession(foldThreads({ rows, devices: new Map(), quiet: new Map(), waiting: new Map(), archived: [] }).threads[0]!).row.conversation, "c11", "one at work")
  // The list of them, though, reads newest first, by the last message: the fork's evening read never makes it new.
  assert.deepEqual(sessionsByLastWorked(thread).map((session) => session.row.conversation), ["c14", "c12", "c11", "c9"])
  assert.equal(thread.sessions[0]!.facts.fork, true, "a listed fork says so")
  assert.equal(thread.sessions[0]!.facts.forkOf, uuid(8))
})

test("a send to the old fork the screen opened on asks first and offers the newest; one the person picked never asks", () => {
  const thread = incidentThread()
  const [fork, , , newest] = thread.sessions
  assert.equal(newerThan(thread, fork!, NOW, "screen")?.row.conversation, "c14")
  assert.equal(newerThan(thread, fork!, NOW, "person"), undefined, "picked, it's where the words are meant to go")
  assert.equal(newerThan(thread, newest!, NOW, "screen"), undefined, "the one worked in last never asks")
  const words = staleSendWords(fork!.facts, newest!.facts, label, NOW)
  assert.equal(words.title, "Send to Cursor fork, idle 20 days?")
  assert.equal(words.newest, "Newest: Cursor · Ship the session picker, last message 4 hours ago")
})

test("what asks first: opened by the screen, resting a day, and someone worked in another Session since", () => {
  const old = facts("old", { promptedAt: NOW - 2 * day })
  const fresh = facts("fresh", { promptedAt: NOW - 60_000 })
  assert.equal(staleTarget(old, [old, fresh], NOW, "screen")?.id, "fresh")
  assert.equal(staleTarget(old, [old, fresh], NOW, "person"), undefined)
  // A day to the minute isn't yet asleep.
  assert.equal(staleTarget(facts("edge", { promptedAt: NOW - ASLEEP_AFTER_MS }), [fresh], NOW, "screen"), undefined)
  // Alone in its Thread, or the newest of it: nothing newer to offer.
  assert.equal(staleTarget(old, [old], NOW, "screen"), undefined)
  assert.equal(staleTarget(old, [old, facts("older", { promptedAt: NOW - 3 * day })], NOW, "screen"), undefined)
  // At work, waiting on the person, or moving: it's in the middle of something, a message to it means it.
  for (const state of ["working", "waiting", "moving"] as const) assert.equal(staleTarget({ ...old, state }, [old, fresh], NOW, "screen"), undefined, state)
  // A last turn that failed rests as much as a ready one; so does a quiet device's.
  assert.equal(staleTarget({ ...old, state: "failed" }, [old, fresh], NOW, "screen")?.id, "fresh")
  assert.equal(staleTarget({ ...old, state: "working", quiet: true }, [old, fresh], NOW, "screen")?.id, "fresh")
})

test("when the person last worked in a Session: their last message, else its harness's own write, else its start", () => {
  const newest = facts("newest", { promptedAt: NOW - 60_000 })
  // A terminal's session holds no message Mako saw: its harness's own last write says when it was worked in.
  const terminal = facts("terminal", { harnessWroteAt: NOW - 30_000 })
  assert.equal(lastWorked(terminal), NOW - 30_000)
  assert.deepEqual(byLastWorked([newest, terminal]).map((each) => each.id), ["terminal", "newest"])
  // Never worked in: its start, and between equals the later start.
  assert.deepEqual(byLastWorked([facts("a", { createdAt: NOW - 2 }), facts("b", { createdAt: NOW - 1 })]).map((each) => each.id), ["b", "a"])
})

test("a Session's name, standing, age and parent, as every list says them", () => {
  const parent = facts("parent", { harness: "cursor", title: "Ship the session picker", promptedAt: NOW - 4 * 60 * 60_000 })
  const fork = facts("fork", { harness: "cursor", fork: true, forkOf: "parent", promptedAt: NOW - 20 * day, title: "Wire the review screen" })
  assert.equal(sessionStanding(fork, NOW), "asleep")
  assert.equal(sessionStanding({ ...fork, promptedAt: NOW - 60 * 60_000 }, NOW), "idle")
  assert.equal(sessionStanding({ ...fork, state: "working", quiet: true }, NOW), "asleep", "a quiet device's turn isn't running")
  assert.equal(sessionName(fork, "Cursor"), "Wire the review screen")
  assert.equal(sessionName({ title: "  " }, "Cursor"), "Cursor")
  const from = forkedFrom(fork, [parent, fork], label)
  assert.equal(from, "Ship the session picker")
  assert.equal(sessionDetail(fork, NOW, "Cursor", from), "Fork of Ship the session picker · Asleep · last message 20 days ago")
  assert.equal(sessionDetail(fork, NOW, "Cursor"), "Fork · Asleep · last message 20 days ago", "its parent archived or listed nowhere")
  assert.equal(forkedFrom(fork, [fork], label), undefined)
  // A fork keeping its parent's title says only that it's a fork: "Fork of" its own name tells nothing apart.
  assert.match(sessionBrief({ ...fork, title: "Ship the session picker" }, NOW, "Cursor", from), /^Fork · Asleep · /)
  assert.equal(sessionDetail(facts("new", { state: "working", createdAt: NOW - 5 * 60_000 }), NOW, "Claude Code"), "Working · started 5 minutes ago")
  assert.equal(sessionDetail(facts("terminal", { harnessWroteAt: NOW - 2 * 60 * 60_000 }), NOW, "Claude Code"), "Idle · active 2 hours ago")
})

test("the composer says where its words go: the harness and the Session's own name, never the Thread's", () => {
  assert.equal(sendsToWords({ title: "Ship the session picker" }, "Cursor"), "To Cursor · Ship the session picker")
  assert.equal(sendsToWords({ title: "Wire the review screen", fork: true }, "Cursor"), "To Cursor fork · Wire the review screen")
  assert.equal(sendsToWords({}, "Claude Code"), "To Claude Code", "no name of its own: its harness's, said once")
  assert.equal(sessionCalled({ title: "Cursor" }, "Cursor"), "Cursor")
})

test("a message that reaches a session after a day's rest says so above it, from the transcript's own times", () => {
  const message = (id: string, timestamp: number, provider?: string): ChatMessage => ({ id, role: provider ? "assistant" : "user", blocks: [{ type: "text", text: "Please continue" }], timestamp, ...(provider && { provider }) })
  const exchange = (id: string, prompt: number, answered?: number): Exchange => ({ id, prompt: message(`${id}-p`, prompt), response: answered === undefined ? [] : [message(`${id}-r`, answered, "cursor")], system: [] })
  const oct12 = Date.parse("2026-10-12T15:00:00Z")
  const woke = wokeAfterRest([exchange("a", oct12 - 60_000, oct12), exchange("b", oct12 + 60_000, oct12 + 2 * 60_000), exchange("c", NOW)])
  assert.deepEqual([...woke.keys()], ["c"], "a turn soon after the last doesn't say it")
  const said = woke.get("c")!
  assert.equal(said.harness, "cursor")
  assert.equal(said.lastAt, oct12 + 2 * 60_000)
  assert.match(wokeWords("Cursor session", said.restedMs, said.lastAt).title, /^Sent to this Cursor session, idle since Oct 12/)
  assert.equal(wokeWords("Cursor session", said.restedMs, said.lastAt).detail, "20 days without a message")
  // A live conversation's prompts carry no time of their own: their requests say when they were sent.
  const live = (id: string): Exchange => ({ id, prompt: { id: `${id}-p`, role: "user", requestId: `r-${id}`, blocks: [{ type: "text", text: "Go on" }] }, response: [], system: [] })
  const asked = new Map([["r-a", oct12], ["r-b", NOW]])
  assert.equal(wokeAfterRest([live("a"), live("b")], asked).get("b")?.restedMs, NOW - oct12)
  assert.equal(wokeAfterRest([live("a"), live("b")]).size, 0, "with no time at all, nothing is said")
  // What follows a released turn isn't judged: its times aren't held.
  assert.equal(wokeAfterRest([{ id: "x", unloaded: "Earlier", response: [], system: [] }, exchange("y", NOW)]).size, 0)
})
