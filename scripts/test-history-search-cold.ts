import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import type { Thread } from "@mako/sessions"
import type { ColdRefused } from "@mako/host/conversations/thread-history"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"

/**
 * A search reads no journal in (`npm run test:agents-doors`): `agents_read`'s search, and `thread_history`'s, read a
 * conversation no host holds in memory cold (`ColdJournal`), at most `SEARCH_CHARS` of it, newest first, giving way to
 * the host between turns, and name the older turns they left as a range to search next.
 */
const TURNS = 420
const FILLER = "filler words that pad each turn ".repeat(340)
const LOOP_HOLD_MS = 250
/** What one search reads of what no host holds in memory (`thread-history.ts`). */
const SEARCH_CHARS = 4_000_000

const root = mkdtempSync(join(tmpdir(), "mako-history-search-cold-"))
const script: Script = (turn) => (turn.text.includes("You're fin:") ? "Started." : "ok")
// A host short of memory, whose harnesses hibernate as soon as they rest: a Fin at rest is let go of.
const world = new AgentsWorld({ root, script, conversationMemory: { bytes: 0, recent: 0, sweepMs: 20 }, providerIdleMs: 50 })
try {
  const apex = await world.apex("claude", "full")
  const started = await world.agents.start(apex.caller, { brief: { objective: "Keep notes." }, name: "notes", harness: "codex", cwd: world.root, clientKey: "notes" })
  assert.ok(!("refused" in started) && started.conversation)
  const fin = started.conversation!
  await world.settle(300, 20_000, "ignore")
  // A long history: each turn's words carry a marker and about 11,000 characters besides.
  for (let index = 1; index <= TURNS; index++) world.say(fin, `Note marker-${index}: ${FILLER}`)
  await world.settle(500, 300_000, "ignore")

  // At rest, the host lets go of it: it's read only when something acts on it.
  const deadline = Date.now() + 30_000
  while (world.live.loaded(fin)) {
    assert.ok(Date.now() < deadline, "the host lets go of the Fin at rest")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  // Its journal is read where it lies, while the host still lets go of it too.
  // The loop's holds while nothing searches, as a yardstick: a shared runner's speed varies by several times, and this
  // world sweeps its memory every 20 ms, so the search is held to a multiple of what the host holds the loop anyway.
  const idle = monitorEventLoopDelay({ resolution: 10 })
  idle.enable()
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  idle.disable()
  const delay = monitorEventLoopDelay({ resolution: 10 })
  delay.enable()
  const began = performance.now()
  const newest = await world.agents.read(apex.caller, { child: "notes", search: `marker-${TURNS}:` })
  const took = performance.now() - began
  delay.disable()
  assert.ok(!("refused" in newest), JSON.stringify(newest))
  assert.match(newest.text, /^1 hit for "marker-420:"/, newest.text.slice(0, 300))
  assert.equal(world.live.loaded(fin), false, "a search reads its journal cold: nothing of it is read in")
  const held = delay.max / 1e6
  const yardstick = idle.max / 1e6
  const bound = Math.max(LOOP_HOLD_MS, 3 * yardstick)
  assert.ok(held < bound, `the search held the loop ${held.toFixed(0)} ms at most, over ${bound.toFixed(0)} ms (idle: ${yardstick.toFixed(0)} ms)`)

  // Its oldest turns are past what one search reads: it says so, and names the turns that reach them.
  const oldest = await world.agents.read(apex.caller, { child: "notes", search: "marker-3:" })
  assert.ok(!("refused" in oldest), JSON.stringify(oldest))
  const cursor = /search again with turns: "(\d+:1-\d+)"/.exec(oldest.text)?.[1]
  assert.ok(oldest.text.startsWith('No match for "marker-3:"') && cursor, `older turns are named: ${oldest.text.slice(0, 400)}`)
  const conversations = world.live.summaries()
  const history = await import("@mako/host/conversations/thread-history")
  const tools = history.threadHistoryTools({
    conversations: () => conversations, snapshot: (id) => world.live.historySnapshot(id), resident: (id) => world.live.loaded(id), cold: (id) => world.live.coldSearch(id),
    store: () => world.store, catalog: { list: () => [], nativePath: () => undefined, ref: () => undefined, open: async () => null, entry: async () => null },
  })
  const reached = await tools.answer(apex.conversation, { action: "search", thread: started.child!, query: "marker-3:", turns: cursor! })
  assert.match(reached, /^1 hit for "marker-3:" in turns/, `the named turns reach it: ${reached.slice(0, 300)}`)
  assert.equal(world.live.loaded(fin), false, "and still nothing is read in")
  // One its journal can't give cold: searched in its session's own record when that holds it, within the same budget;
  // else named unsearchable, never "search again"; one only busy says to search again.
  const RECORD_TURNS = 2_000
  const recordPath = join(root, "record.jsonl")
  const record: Thread = {
    ref: { harness: "codex", nativeId: "record", path: recordPath, title: "Its record", cwd: world.root, bytes: 1 },
    entries: Array.from({ length: RECORD_TURNS }, (_, index) => ({ type: "user" as const, id: `r-${index + 1}`, text: `Record mark-${index + 1}: ${FILLER.slice(0, 3_000)}` })),
  }
  // The record is read a page at a time, as its viewer pages it: never opened whole. What each search parses is counted.
  let served = 0
  let opens = 0
  // Its view as its viewer names it: an append moves its revision and bytes on, a rewrite changes them otherwise.
  let revision = 1
  let bytes = 1_000
  const page = async (path: string, before?: number, limit = 100) => {
    if (path !== recordPath) return null
    const end = Math.min(record.entries.length, before ?? record.entries.length)
    const start = Math.max(0, end - Math.min(200, Math.max(1, limit)))
    const entries = record.entries.slice(start, end)
    served += entries.reduce((sum, entry) => sum + ("text" in entry ? entry.text.length : 0), 0)
    return { ref: { ...record.ref, revision: String(revision), bytes }, translator: "t1", entries, start, total: record.entries.length, hasEarlier: start > 0 }
  }
  const refusing = (refused: ColdRefused["refused"]) => history.threadHistoryTools({
    conversations: () => conversations, snapshot: (id) => world.live.historySnapshot(id), resident: () => false, cold: async () => ({ refused }),
    store: () => world.store,
    catalog: { list: () => [], nativePath: () => undefined, ref: () => undefined, open: async () => (opens++, null), entry: async () => null, page },
  })
  const asRecord = refusing({ kind: "structural", why: "its history is its session's own record", record: { path: recordPath, harness: "codex" } })
  const recordChars = record.entries.reduce((sum, entry) => sum + ("text" in entry ? entry.text.length : 0), 0)
  served = 0
  const newestInRecord = await asRecord.answer(apex.conversation, { action: "search", thread: started.child!, query: `mark-${RECORD_TURNS}:` })
  assert.match(newestInRecord, /^1 hit for "mark-2000:"/, newestInRecord.slice(0, 200))
  const firstServed = served
  // Once counted, a search parses the window it searches and no more: about SEARCH_CHARS, whatever the record's size.
  served = 0
  const again = await asRecord.answer(apex.conversation, { action: "search", thread: started.child!, query: `mark-${RECORD_TURNS - 1}:` })
  assert.match(again, /^1 hit for "mark-1999:"/, again.slice(0, 200))
  // At most its budget and two pages past it: one it trims, one it reads back to its first turn's opener.
  const PAGE_CHARS = 200 * 3_100
  assert.ok(served <= SEARCH_CHARS + 2 * PAGE_CHARS, `the second search parsed ${served} characters of a ${recordChars}-character record, past the ${SEARCH_CHARS} budget and two pages`)
  assert.equal(opens, 0, "and never opened the record whole")
  const oldestInRecord = await asRecord.answer(apex.conversation, { action: "search", thread: started.child!, query: "mark-2:" })
  const recordCursor = /search again with turns: "(\d+:1-\d+)"/.exec(oldestInRecord)?.[1]
  assert.ok(oldestInRecord.startsWith('No match for "mark-2:"') && recordCursor, `a long record is held to the budget too: ${oldestInRecord.slice(0, 300)}`)
  const recordReached = await asRecord.answer(apex.conversation, { action: "search", thread: started.child!, query: "mark-2:", turns: recordCursor! })
  assert.match(recordReached, /^1 hit for "mark-2:" in turns/, recordReached.slice(0, 200))
  assert.ok(/\[(?:\d+:)?2\.0[\]/]/.test(recordReached), `numbered as read numbers it: turn 2 is mark-2's: ${recordReached.slice(0, 300)}`)
  // A record that grew is counted only where it grew.
  for (let index = RECORD_TURNS + 1; index <= RECORD_TURNS + 10; index++) record.entries.push({ type: "user" as const, id: `r-${index}`, text: `Record mark-${index}: ${FILLER.slice(0, 3_000)}` })
  revision += 1
  bytes += 100
  served = 0
  const grown = await asRecord.answer(apex.conversation, { action: "search", thread: started.child!, query: `mark-${RECORD_TURNS + 10}:` })
  assert.match(grown, /^1 hit for "mark-2010:"/, grown.slice(0, 200))
  assert.ok(served <= SEARCH_CHARS + 4 * PAGE_CHARS, `a grown record counts where it grew, not all of it again: ${served}`)
  // Rewritten to as many entries (compacted, restored, decoded again): its first ten prompts now one message's chunks,
  // nine turns fewer. Its index is counted again, and its newest turn reads as the rewritten record numbers it.
  record.entries = record.entries.map((entry, index) => (index < 10 && entry.type === "user" ? { ...entry, messageId: "one-message" } : entry))
  revision += 1
  bytes = 900
  const rewritten = await asRecord.answer(apex.conversation, { action: "search", thread: started.child!, query: `mark-${RECORD_TURNS + 10}:` })
  assert.match(rewritten, /\[(?:\d+:)?2001\.0[\]/]/, `a rewrite is counted again: the newest turn is 2001 now: ${rewritten.slice(0, 300)}`)
  console.log(`paged record: ${recordChars} characters; the first search parsed ${firstServed} (its count, once), later ones at most ${SEARCH_CHARS + 2 * PAGE_CHARS}`)
  const unsearchable = await refusing({ kind: "structural", why: "its journal keeps its own copy of its history" }).answer(apex.conversation, { action: "search", thread: started.child!, query: "marker" })
  assert.ok(unsearchable.includes("can't be searched here") && unsearchable.includes("thread_history read") && !unsearchable.includes("search again in a moment"), unsearchable)
  const busy = await refusing({ kind: "busy" }).answer(apex.conversation, { action: "search", thread: started.child!, query: "marker" })
  assert.ok(busy.includes("search again in a moment"), busy)
  // The cache of records read whole keeps none past its cap: one bigger serves the search that opened it and goes.
  const huge = "y".repeat(1_000_000)
  const hugePath = join(root, "huge.jsonl")
  const hugeRecord: Thread = {
    ref: { harness: "codex", nativeId: "huge", path: hugePath, title: "Huge", cwd: world.root, bytes: 1 },
    entries: Array.from({ length: 70 }, (_, index) => ({ type: "user" as const, id: `h-${index}`, text: index === 69 ? `last-mark ${huge}` : huge })),
  }
  let hugeOpens = 0
  const whole = history.threadHistoryTools({
    conversations: () => conversations, snapshot: (id) => world.live.historySnapshot(id), resident: () => false,
    cold: async () => ({ refused: { kind: "structural", why: "its history is its session's own record", record: { path: hugePath, harness: "codex" } } }),
    store: () => world.store,
    catalog: { list: () => [], nativePath: () => undefined, ref: () => undefined, open: async (path) => (path === hugePath ? (hugeOpens++, hugeRecord) : null), entry: async () => null },
  })
  await whole.answer(apex.conversation, { action: "search", thread: started.child!, query: "last-mark" })
  await new Promise((resolve) => setImmediate(resolve))
  const firstOpens = hugeOpens
  await whole.answer(apex.conversation, { action: "search", thread: started.child!, query: "last-mark" })
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(firstOpens > 0 && hugeOpens === 2 * firstOpens, `a record past the cache's cap is opened again each time, never kept: ${firstOpens} then ${hugeOpens} opens`)
  console.log(`cold search: ${TURNS} turns, the newest found in ${took.toFixed(0)} ms holding the loop ${held.toFixed(0)} ms at most (idle ${yardstick.toFixed(0)} ms), nothing read in; older turns named (${cursor}) and reached`)
} finally {
  await world.close()
  rmSync(root, { recursive: true, force: true })
}
