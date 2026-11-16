import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"

/**
 * A search reads no journal in (`npm run test:agents-doors`): `agents_read`'s search, and `thread_history`'s, read a
 * conversation no host holds in memory cold (`ColdJournal`), at most `SEARCH_CHARS` of it, newest first, giving way to
 * the host between turns, and name the older turns they left as a range to search next.
 */
const TURNS = 420
const FILLER = "filler words that pad each turn ".repeat(340)
const LOOP_HOLD_MS = 250

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
    conversations: () => conversations, snapshot: (id) => world.live.historySnapshot(id), resident: (id) => world.live.loaded(id), cold: (id) => world.live.coldView(id, true),
    store: () => world.store, catalog: { list: () => [], nativePath: () => undefined, ref: () => undefined, open: async () => null, entry: async () => null },
  })
  const reached = await tools.answer(apex.conversation, { action: "search", thread: started.child!, query: "marker-3:", turns: cursor! })
  assert.match(reached, /^1 hit for "marker-3:" in turns/, `the named turns reach it: ${reached.slice(0, 300)}`)
  assert.equal(world.live.loaded(fin), false, "and still nothing is read in")
  console.log(`cold search: ${TURNS} turns, the newest found in ${took.toFixed(0)} ms holding the loop ${held.toFixed(0)} ms at most (idle ${yardstick.toFixed(0)} ms), nothing read in; older turns named (${cursor}) and reached`)
} finally {
  await world.close()
  rmSync(root, { recursive: true, force: true })
}
