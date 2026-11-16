import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"
import { FROM_AGENTS, QUIET_MS } from "@mako/host/contracts/children"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { digest, type Notice } from "@mako/host/conversations/agent-wakes"
import { QuietWatch } from "@mako/host/conversations/fin-quiet"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"
import { testScratch } from "./lib/test-scratch.mjs"

/*
 * A Fin that reads as working and does nothing is named to its Apex once (`npm run test:fin-quiet`): a turn that hangs
 * read as working until the person asked the Apex to check (capy-captain.md, change 3). On a clock the test moves:
 * quiet past `QUIET_MS` tells the Apex once, activity starts the quiet again, a Fin that stopped working is told
 * nothing, and a tree waits on one deadline however many Fins it has.
 */

const root = testScratch("mako-fin-quiet-")
const MINUTE = 60_000

/** Time and timers the test moves: `advance` runs every timer due by then, in order, as they'd have fired. */
class FakeClock {
  at = 1_800_000_000_000
  private timers: { due: number; run: () => void }[] = []
  readonly now = () => this.at
  readonly later = (ms: number, run: () => void) => {
    const timer = { due: this.at + ms, run }
    this.timers.push(timer)
    return () => void (this.timers = this.timers.filter((each) => each !== timer))
  }
  advance(ms: number): void {
    const until = this.at + ms
    for (;;) {
      const next = this.timers.filter((timer) => timer.due <= until).sort((a, b) => a.due - b.due)[0]
      if (!next) break
      this.timers = this.timers.filter((timer) => timer !== next)
      this.at = Math.max(this.at, next.due)
      next.run()
    }
    this.at = until
  }
}

function watch(working: (child: string) => boolean, tree: (child: string) => string = () => "apex") {
  const clock = new FakeClock()
  const told: { child: string; since: number; at: number }[] = []
  const quiet = new QuietWatch({ now: clock.now, later: clock.later, working, tree, quiet: (child, since) => told.push({ child, since, at: clock.now() }) })
  return { clock, told, quiet }
}

test("a working Fin quiet past the window is told once, and not again while it stays quiet", () => {
  const { clock, told, quiet } = watch(() => true)
  quiet.activity("fin")
  const began = clock.now()
  clock.advance(QUIET_MS - 1)
  assert.equal(told.length, 0, "not before the window")
  clock.advance(1)
  assert.deepEqual(told, [{ child: "fin", since: began, at: began + QUIET_MS }])
  clock.advance(10 * QUIET_MS)
  assert.equal(told.length, 1, "once a quiet stretch")
  assert.equal(quiet.waiting, 0, "and nothing waits once it's told")
})

test("activity starts the quiet again: the window counts from the last of it", () => {
  const { clock, told, quiet } = watch(() => true)
  quiet.activity("fin")
  clock.advance(10 * MINUTE)
  quiet.activity("fin")
  const last = clock.now()
  clock.advance(10 * MINUTE)
  assert.equal(told.length, 0, "20 minutes in, 10 of them quiet")
  clock.advance(5 * MINUTE)
  assert.deepEqual(told.map((each) => each.since), [last])
  // A Fin told, then active again and quiet again, is told of the new stretch.
  quiet.activity("fin")
  const again = clock.now()
  clock.advance(QUIET_MS)
  assert.deepEqual(told.map((each) => each.since), [last, again])
  assert.ok(quiet.stillQuiet("fin", again))
  quiet.activity("fin")
  assert.ok(!quiet.stillQuiet("fin", again), "activity after the notice makes it stale")
})

test("an idle or ended Fin is never told, and leaves the watch", () => {
  const working = new Set(["busy", "ends"])
  const { clock, told, quiet } = watch((child) => working.has(child))
  quiet.activity("busy")
  quiet.activity("ends")
  quiet.activity("idle")
  working.delete("ends")
  clock.advance(QUIET_MS)
  assert.deepEqual(told.map((each) => each.child), ["busy"])
  clock.advance(10 * QUIET_MS)
  assert.equal(quiet.waiting, 0)
  // Forgotten at its turn's end, a Fin's deadline goes with it.
  const { clock: other, told: none, quiet: forgetting } = watch(() => true)
  forgetting.activity("fin")
  forgetting.forget("fin")
  assert.equal(forgetting.waiting, 0)
  other.advance(10 * QUIET_MS)
  assert.equal(none.length, 0)
})

test("a tree waits on one deadline however many Fins it has; each tree on its own", () => {
  const { clock, told, quiet } = watch(() => true, (child) => (child.startsWith("a") ? "apex-a" : "apex-b"))
  quiet.activity("a1")
  clock.advance(MINUTE)
  quiet.activity("a2")
  quiet.activity("a3")
  quiet.activity("b1")
  assert.equal(quiet.waiting, 2, "one timer a tree, not one a Fin")
  clock.advance(QUIET_MS - MINUTE)
  assert.deepEqual(told.map((each) => each.child), ["a1"])
  assert.equal(quiet.waiting, 2, "the tree waits again, for its next Fin's moment")
  clock.advance(MINUTE)
  assert.deepEqual(told.map((each) => each.child).sort(), ["a1", "a2", "a3", "b1"])
})

test("the digest names a quiet Fin, its last step, and what the Apex can do", () => {
  const notice: Notice = {
    id: "notice:quiet:fin:1",
    report: { id: "quiet:fin:1", child: ThreadIdSchema.parse("11111111-1111-4111-8111-111111111111"), status: "progress", summary: "", implicit: true, ownerGeneration: 1, at: 1 },
    label: `"docs" (Claude)`,
    fin: { name: "docs", harness: "claude" },
    from: "s",
    quiet: { since: 0, forMs: 22 * MINUTE, step: "Running npm test", running: true },
  }
  const text = digest([notice], "1 working.")
  assert.match(text, /1 has gone quiet while working:/)
  assert.match(text, /"docs" \(Claude\) has shown no activity for 22m, its last step still running: Running npm test\./)
  assert.match(text, /agents_read shows what each is doing/)
})

test("through the engine: a Fin whose turn hangs is named to its Apex once; its turn's end ends the watch", async () => {
  // The engine's own timers and queue, on a quiet window short enough to wait out: the clock above holds the timing.
  const QUIET = 1_500
  const wakes: string[] = []
  let fin = ""
  const script: Script = async (turn) => {
    if (turn.conversation === fin) {
      await turn.world.hold(turn.conversation)
      return "Done."
    }
    const spoken = turn.text.replace(/^<mako-local-control>[\s\S]*?<\/mako-local-control>\n\n/, "")
    if (spoken.startsWith(FROM_AGENTS)) wakes.push(spoken)
    return "ok"
  }
  const quietWakes = () => wakes.filter((text) => text.includes("gone quiet"))
  const world = new AgentsWorld({ root: join(root, "engine"), script, quietMs: QUIET })
  try {
    const apex = await world.apex("claude", "full")
    const started = await world.agents.start(apex.caller, { brief: { objective: "Run the tests" }, harness: "codex", name: "tests", clientKey: "tests", cwd: world.root })
    assert.ok(!("refused" in started) && started.conversation)
    fin = started.conversation!
    await until(() => world.agents.quiet.waiting === 1, "the Fin's turn began, and its tree waits on one deadline")
    await until(() => quietWakes().length === 1, "the Apex is woken with the quiet Fin")
    assert.match(quietWakes()[0]!, /"tests" \(Codex\) has shown no activity for \d+s/)
    assert.match(quietWakes()[0]!, /It still reads as working\./)
    // Once: more quiet, no more notices.
    await pause(4 * QUIET)
    assert.equal(quietWakes().length, 1, "once a quiet stretch")
    // Activity starts a new stretch, which is told again.
    world.agents.active(fin)
    await until(() => quietWakes().length === 2, "a new quiet stretch is told again")
    // Its turn ends: it no longer works, and nothing more is said of it however long it's idle.
    world.release(fin)
    await until(() => world.agents.quiet.waiting === 0, "the ended Fin leaves the watch")
    await pause(4 * QUIET)
    assert.equal(quietWakes().length, 2, "an idle Fin is never named quiet")
  } finally {
    await world.close()
  }
})

test("through the engine: a Fin at work across a crash, with nothing new from it, is named once", async () => {
  // A hung turn is the case a restart hides: the new host must watch the Fins it finds at work, not wait for news of them.
  const QUIET = 1_500
  const wakes: string[] = []
  let fin = ""
  const script: Script = async (turn) => {
    if (turn.conversation === fin) {
      await turn.world.hold(turn.conversation)
      return "Done."
    }
    const spoken = turn.text.replace(/^<mako-local-control>[\s\S]*?<\/mako-local-control>\n\n/, "")
    if (spoken.startsWith(FROM_AGENTS)) wakes.push(spoken)
    return "ok"
  }
  const quietWakes = () => wakes.filter((text) => text.includes("gone quiet"))
  const world = new AgentsWorld({ root: join(root, "restart"), script, quietMs: QUIET })
  try {
    const apex = await world.apex("claude", "full")
    const started = await world.agents.start(apex.caller, { brief: { objective: "Run the tests" }, harness: "codex", name: "tests", clientKey: "tests", cwd: world.root })
    assert.ok(!("refused" in started) && started.conversation)
    fin = started.conversation!
    await until(() => world.agents.quiet.waiting === 1, "the Fin's turn began")
    // The host goes before the window, its turn left at work.
    await world.crashed()
    await until(() => world.agents.quiet.waiting === 1, "the new host watches the Fin it found at work")
    await until(() => quietWakes().length === 1, "the Apex is told of the Fin quiet across the crash")
    assert.match(quietWakes()[0]!, /"tests" \(Codex\) has shown no activity/)
    await pause(4 * QUIET)
    assert.equal(quietWakes().length, 1, "once")
    world.release(fin)
  } finally {
    await world.close()
  }
})

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`)
    await pause(50)
  }
}
