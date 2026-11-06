import assert from "node:assert/strict"
import { backgroundWork, backgroundWorkText } from "../packages/host/src/contracts/background-work"
import { childGroup, childLine, readableStep, rollup, rollupChip, rollupLabel, rollupLine } from "../packages/host/src/contracts/children"
import type { ChildState } from "../packages/host/src/contracts/agents"
import type { NativeAgent } from "../packages/host/src/contracts/native-agents"

/*
 * One vocabulary and one count for an Apex's Fins (`rollup`, `rollupLine`, `rollupChip`, `rollupLabel`), steps as
 * phrases (`readableStep`), and background work that counts a Fin only while it's at work. The case it was written
 * for: three Fins working and one idle read "Waiting on 4 agents" beside "3 Fins working".
 */

function fin(index: number, state: ChildState, roster: NativeAgent["state"]): NativeAgent {
  // SAFETY: a roster entry as `childEntry` would make one, with only the fields `rollup`, `childLine` and
  // `backgroundWork` read; the rest of `NativeAgent` is optional or unread here.
  return {
    bindingId: "apex",
    nativeId: `mako-child:${index}`,
    provider: "cursor",
    title: `Fin ${index}`,
    state: roster,
    observedAt: 1,
    child: { thread: `thread-${index}`, name: `fin-${index}`, state },
  } as NativeAgent
}

const working = (step: string) => fin(0, { kind: "working", step }, { kind: "working", activity: step })
const crew = [
  working("Shell cd /Users/someone/.mako/worktrees/makomono-0a1b2c3d/dogfood && npm run typecheck"),
  { ...working("Shell gh pr checks 340 -R Verbiflow/mako 2>&1 | awk '{print $1, $2}'"), nativeId: "mako-child:1" },
  { ...working("Read /Users/someone/makomono/mako/src/web-client/desk.tsx"), nativeId: "mako-child:2" },
  fin(3, { kind: "idle" }, { kind: "waiting" }),
]

// An idle Fin is its own group, neither working nor done.
assert.equal(childGroup({ kind: "idle" }), "idle")
const counts = rollup(crew)
assert.deepEqual(counts, { total: 4, needs: 0, working: 3, queued: 0, idle: 1, failed: 0, done: 0 })
assert.equal(rollupLine(counts), "3 working · 1 idle")
assert.equal(rollupChip(counts), "4 Fins · 3 working")
assert.equal(rollupLabel(counts), "4 Fins: 3 working · 1 idle")
const busy = { total: 12, needs: 2, working: 5, queued: 2, idle: 0, failed: 0, done: 3 }
assert.equal(rollupLine(busy), "2 need you · 5 working · 2 queued · 3 done")
assert.equal(rollupChip(busy), "12 Fins · 2 need you · 5 working")
assert.equal(rollupChip({ total: 2, needs: 0, working: 0, queued: 0, idle: 0, failed: 0, done: 2 }), "2 Fins · 2 done")
for (const words of [rollupLine(busy), rollupChip(busy), rollupLabel(busy), rollupLabel(counts)])
  assert.doesNotMatch(words, /agent/i, `one word for them: ${words}`)

// The session waits on the three at work, never on the idle one, and calls them Fins.
const work = backgroundWork({ status: "ready", connection: "connected" }, { agents: crew, limited: false })
assert.equal(work?.count, 3, "an idle Fin is open, not running")
assert.equal(backgroundWorkText(work!), "3 Fins")

// Steps read as phrases, without home folders or the shell's plumbing; old recorded steps read the same.
assert.equal(readableStep("Shell cd /Users/someone/.mako/worktrees/makomono-0a1b2c3d/dogfood && npm run typecheck"), "Running npm run typecheck")
assert.equal(readableStep("Shell gh pr checks 340 -R Verbiflow/mako 2>&1 | awk '{print $1, $2}'"), "Running gh pr checks 340")
assert.equal(readableStep("Shell cd /Users/someone/.mako/worktrees/makomono-0a1b…"), "Running a command")
assert.equal(readableStep("Shell zsh -lc 'npm run lint'"), "Running npm run lint")
assert.equal(readableStep("Shell node /Users/someone/mako/scripts/test-inbox-ui.mjs --url http://x"), "Running node test-inbox-ui.mjs")
assert.equal(readableStep("Read /Users/someone/makomono/mako/src/web-client/desk.tsx"), "Reading desk.tsx")
assert.equal(readableStep("Edit src/components/rail/fin-pips.tsx"), "Editing fin-pips.tsx")
assert.equal(readableStep("Search live-mark in /Users/someone/makomono"), "Searching live-mark in ~/makomono")
assert.equal(readableStep("Writing the report"), "Writing the report")
assert.equal(readableStep(readableStep("Read /Users/a/b/c.ts")), "Reading c.ts", "a phrase read twice stays the phrase")
for (const agent of crew.slice(0, 3)) {
  const line = childLine(agent.child!.state!)!
  assert.doesNotMatch(line, /\/Users\/|2>&1|&&/, `a Fin's line is a phrase: ${line}`)
}

assert.equal(childLine({ kind: "queued", reason: "place-full", ahead: 2 }), "Queued: 2 ahead")
assert.equal(childLine({ kind: "queued", reason: "tree-running", ahead: 0, after: ["build", "lint"] }), "Starts after build, lint", "a Fin started after others says which")
assert.equal(childLine({ kind: "queued", reason: "tree-running", ahead: 0, after: ["build"], held: "lint" }), "Not started: lint didn't finish")

console.log("Fin words: one count and one vocabulary for every surface, an idle Fin never counted as work, steps as phrases")
