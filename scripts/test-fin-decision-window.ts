import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import type { AgentCaller, AgentRefused, ChildState } from "@mako/host/contracts/agents"
import { AGENT_TOOLS, type AgentsReportInput } from "@mako/host/contracts/agent-tools"
import { FOCUS_MS } from "@mako/host/contracts/children"
import { ThreadIdSchema, type ThreadId } from "@mako/host/contracts/thread-identity"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { APEX_ANSWER_MS, DECISION_HEARD_BY_MS } from "@mako/host/conversations/agents"
import { AgentsWorld, type ScriptedTurn } from "./lib/agents-world.ts"

/**
 * A decision goes to the person only once its Apex could have answered it (`npm run test:orch-answer`).
 *
 * A Fin that finished with a decision its Apex makes was escalated to the person a minute after it REPORTED, whether
 * or not its Apex had heard: on 2026-11-16 two of three escalations fired while the Apex was mid-turn on a harness
 * that hears a digest only at its turn's end. Now the Apex's minute (`APEX_ANSWER_MS`) starts when its harness takes
 * the digest or the steer that carries the decision, and one it hasn't heard `DECISION_HEARD_BY_MS` after the report
 * goes to the person as before, so none waits behind a long turn.
 *
 * Held here, on a clock the test moves: an idle Apex's minute starts as it takes the digest; an Apex mid-turn on a
 * harness that hears only at its turn's end isn't escalated past a minute after the report, hears at its turn's end,
 * and has its minute then; one whose turn never ends is escalated at three minutes; a steering harness hears at once;
 * both times survive a restart; an Apex that acts with a plain `agents_send` leaves the decision open, and it
 * escalates; and the digest and `agents_answer`'s own description say the rule where the Apex reads it.
 */
const root = mkdtempSync(join(tmpdir(), "mako-decision-window-"))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const MERGE: AgentsReportInput = { status: "done", summary: "PR #371 is green: every check passed.", question: "Merge #371?", options: [{ label: "Merge" }, { label: "Leave open" }], recommended: 0, clientKey: "merge" }
/** A timer's start may lag the moment it's measured from by this much: a digest's window and a loaded machine. */
const SLACK_MS = 5_000

async function until(what: string, done: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}

function kept<T extends object>(value: T | AgentRefused): T {
  assert.ok(!("refused" in value), JSON.stringify(value))
  return value
}

/** The engine's waits on a clock the test moves: nothing fires until it's run, and a cancelled wait is gone. */
class Timers {
  private pending: { ms: number; run: () => void }[] = []
  readonly later = (ms: number, run: () => void) => {
    const timer = { ms, run }
    this.pending.push(timer)
    return () => void (this.pending = this.pending.filter((each) => each !== timer))
  }
  /** The waits a decision arms: nothing of the hours-long ceilings a harness's held work gets. */
  get waits(): number[] {
    return this.pending.filter((timer) => timer.ms <= DECISION_HEARD_BY_MS).map((timer) => timer.ms)
  }
  /** Runs the one wait there is, as if its time passed. */
  fire(): void {
    const due = this.pending.filter((timer) => timer.ms <= DECISION_HEARD_BY_MS)
    assert.equal(due.length, 1, `one wait to fire: ${JSON.stringify(this.waits)}`)
    this.pending = this.pending.filter((timer) => timer !== due[0])
    due[0]!.run()
  }
}

interface Fixture {
  world: AgentsWorld
  apex: { conversation: string; caller: AgentCaller }
  fin: string
  child: ThreadId
  timers: Timers
  /** The digests the Apex's harness was sent, and what was steered into its turn. */
  heard: string[]
  state(): ChildState | undefined
  /** The Fin reports its decision, as its turn would. */
  decide(): Promise<string>
  holdApex(): Promise<void>
}

/** An Apex on `harness` with one Fin, "tests", that finished and is idle; `onDecision` is the Apex's turn on a digest. */
async function fixture(name: string, harness: string, onDecision?: (turn: ScriptedTurn) => Promise<void> | void): Promise<Fixture> {
  const timers = new Timers()
  const heard: string[] = []
  let fin = ""
  let holding = false
  const world = new AgentsWorld({
    root: join(root, name),
    later: timers.later,
    heard: (input) => {
      if (input.conversation !== fin && input.text.includes(FROM_AGENTS) && input.text.includes("decision")) heard.push(input.text)
    },
    script: async (turn) => {
      if (turn.text.includes("You're fin:") || turn.conversation === fin) return "Tests ran."
      if (turn.text.includes("Hold")) {
        holding = true
        await turn.world.hold(turn.conversation)
        return "Long turn over."
      }
      // The digest follows the note of what's pending, so it isn't the prompt's first words.
      if (turn.text.includes(FROM_AGENTS) && turn.text.includes("needs a decision")) await onDecision?.(turn)
      return "ok"
    },
  })
  const apex = await world.apex(harness, "full")
  const started = kept(await world.agents.start(apex.caller, { brief: { objective: "Get the PR green" }, harness: "codex", name: "tests", clientKey: "tests", cwd: world.root }))
  fin = started.conversation!
  const child = ThreadIdSchema.parse(started.child)
  await world.settle(400)
  return {
    world, apex, fin, child, timers, heard,
    state: () => world.agents.roster(apex.conversation).find((each) => each.child?.name === "tests")?.child?.state,
    decide: async () => kept(await world.agents.report(world.caller(fin), MERGE)).id,
    holdApex: async () => {
      world.say(apex.conversation, "Hold")
      await until("the Apex's long turn", () => holding)
    },
  }
}

const on = (f: Fixture) => { const state = f.state(); return state?.kind === "ended" ? state.decision?.on : undefined }

try {
  // The rule is said where the Apex reads it.
  // The digest's decision block (below) and the tool that answers: the server's instructions have no room left under
  // the shortest cut a harness makes of them (`test:mako-instructions`).
  assert.match(AGENT_TOOLS.find((tool) => tool.mcp.name === "agents_answer")?.mcp.description ?? "", /One you leave unanswered for a minute goes to the person too, even if you acted on it another way: a message to the Fin isn't an answer\./)
  assert.equal(DECISION_HEARD_BY_MS, FOCUS_MS + APEX_ANSWER_MS, "three minutes: the focus stretch and the minute to answer")

  // An idle Apex: its minute starts as its harness takes the digest, not as the Fin reports.
  {
    const f = await fixture("idle", "codex")
    await f.decide()
    assert.equal(f.heard.length, 0, "the digest waits out its window: the Apex hasn't heard")
    const [unheard, ...rest] = f.timers.waits
    assert.deepEqual(rest, [], "one wait a decision")
    assert.ok(unheard !== undefined && unheard > APEX_ANSWER_MS && unheard <= DECISION_HEARD_BY_MS, `before its Apex hears, it waits to be heard, at most three minutes: ${unheard}`)
    await until("the Apex to take the digest", () => f.heard.length === 1)
    assert.match(f.heard[0]!, /1 needs a decision:\n {2}• "tests" \(Codex\) done; decide: Merge #371\?[^\n]*\n {2}agents_answer answers each, or leaves it to the person with person: true\.\n {2}Answer with agents_answer even if you already acted on it: left unanswered, it goes to the person\./, "the digest says the rule")
    await until("its minute to start", () => f.timers.waits.length === 1 && f.timers.waits[0]! <= APEX_ANSWER_MS)
    assert.ok(f.timers.waits[0]! > APEX_ANSWER_MS - SLACK_MS, `a whole minute from the handoff: ${f.timers.waits[0]}`)
    assert.equal(on(f), "lead")
    f.timers.fire()
    await until("the person to be asked", () => on(f) === "person")
    assert.deepEqual(f.timers.waits, [], "the person's isn't escalated again")
    await f.world.settle(600)
    await f.world.close()
  }
  console.log("idle Apex: the wait to be heard became a minute to answer as its harness took the digest")

  // An Apex mid-turn on a harness that hears a digest only at its turn's end: nothing escalates while it can't answer.
  {
    const answers: string[] = []
    const f = await fixture("mid-turn", "codex", async (turn) => {
      answers.push(kept(await turn.world.agents.answer(turn.caller, { to: "tests", answer: "Merge", clientKey: "merge" })).answered)
    })
    await f.holdApex()
    await f.decide()
    await pause(2_500)
    assert.equal(f.heard.length, 0, "its harness takes nothing mid-turn")
    assert.equal(f.world.steers.length, 0)
    assert.equal(f.timers.waits.length, 1)
    assert.ok(f.timers.waits[0]! > APEX_ANSWER_MS, `a minute after the report nothing is due: it waits to be heard: ${f.timers.waits[0]}`)
    assert.equal(on(f), "lead", "still its Apex's")
    assert.equal(f.world.agents.personAsk(f.apex.conversation), undefined, "the person isn't asked")
    // Its turn ends: it hears, and answers in the turn the digest starts.
    f.world.release(f.apex.conversation)
    await until("the Apex to hear and answer", () => answers.length === 1)
    assert.deepEqual(answers, ["report"])
    await until("the Fin's answer", () => f.world.prompts.some((prompt) => prompt.conversation === f.fin && prompt.text.includes("Answer: Merge")))
    assert.deepEqual(f.timers.waits, [], "answered, nothing is left to escalate")
    await f.world.settle(600)
    assert.ok(!f.world.store.reportsOf(f.child, 0).some((report) => report.for === "person"), "and the person was never asked")
    await f.world.close()
  }
  console.log("Apex mid-turn: not escalated while it couldn't answer; it heard at its turn's end and answered")

  // An Apex whose turn never ends: three minutes after the report the person is asked, as before.
  {
    const f = await fixture("long-turn", "codex")
    await f.holdApex()
    const report = await f.decide()
    await pause(300)
    assert.equal(f.timers.waits.length, 1)
    assert.ok(f.timers.waits[0]! <= DECISION_HEARD_BY_MS && f.timers.waits[0]! > DECISION_HEARD_BY_MS - SLACK_MS, `three minutes from its report: ${f.timers.waits[0]}`)
    f.timers.fire()
    await until("the person to be asked", () => on(f) === "person")
    const asked = f.world.agents.personAsk(f.apex.conversation)
    assert.equal(asked?.line, "Done · needs you: Merge #371?")
    assert.deepEqual(f.world.store.openReportAsks(f.child).map((open) => open.supersedes), [[report]], "handed to the person, by its ID")
    f.world.release(f.apex.conversation)
    await f.world.settle(600)
    await f.world.close()
  }
  console.log("Apex on a turn that never ends: the person was asked three minutes after the report")

  // A harness that takes a message at its next step hears a decision at once, mid-turn: its minute starts then.
  {
    const f = await fixture("steered", "claude")
    await f.holdApex()
    await f.decide()
    await until("the decision to be steered in", () => f.world.steers.some((steer) => steer.text.includes("Merge #371?")))
    await until("its minute to start", () => f.timers.waits.length === 1 && f.timers.waits[0]! <= APEX_ANSWER_MS)
    assert.ok(f.timers.waits[0]! > APEX_ANSWER_MS - SLACK_MS)
    f.world.release(f.apex.conversation)
    await f.world.settle(600)
    await f.world.close()
  }
  console.log("steering harness: heard mid-turn, its minute started at the steer")

  // Both times survive a restart: the next host reads them from what was kept.
  {
    const wallNow = Date.now.bind(Date)
    let offset = 0
    const clock = mock.method(Date, "now", () => wallNow() + offset)
    try {
      // Heard: twenty seconds on, forty are left of its minute.
      const f = await fixture("restart-heard", "codex")
      await f.decide()
      await until("its minute to start", () => f.timers.waits.length === 1 && f.timers.waits[0]! <= APEX_ANSWER_MS)
      await f.world.settle(600)
      offset += 20_000
      await f.world.restart()
      assert.equal(f.timers.waits.length, 1, `watched again, once: ${JSON.stringify(f.timers.waits)}`)
      assert.ok(f.timers.waits[0]! <= APEX_ANSWER_MS - 20_000 && f.timers.waits[0]! > APEX_ANSWER_MS - 20_000 - SLACK_MS, `its minute goes on from where it was: ${f.timers.waits[0]}`)
      await f.world.close()
      // Not heard: a minute on, two are left to be heard in.
      const g = await fixture("restart-unheard", "codex")
      await g.holdApex()
      await g.decide()
      await pause(300)
      offset += 60_000
      g.world.release(g.apex.conversation)
      // The host goes as its Apex's turn is cut, with the digest still unsent in its queue.
      await g.world.crashed()
      const waits = g.timers.waits
      assert.ok(waits.length === 1, `watched again, once: ${JSON.stringify(waits)}`)
      assert.ok(waits[0]! <= DECISION_HEARD_BY_MS - 60_000 && waits[0]! > DECISION_HEARD_BY_MS - 60_000 - SLACK_MS, `two of its three minutes are left to be heard in: ${waits[0]}`)
      // The next host sends the digest on: heard, it has its minute.
      await until("the Apex to hear it from the next host", () => g.timers.waits.length === 1 && g.timers.waits[0]! <= APEX_ANSWER_MS)
      await g.world.settle(600)
      await g.world.close()
    } finally {
      clock.mock.restore()
    }
  }
  console.log("restart: a minute under way goes on from where it was")

  // An Apex that acts on a decision with a plain agents_send leaves it open: Mako doesn't guess that it answers it.
  {
    const f = await fixture("sent-not-answered", "codex", async (turn) => {
      kept(await turn.world.agents.send(turn.caller, { to: "tests", text: "Merge it.", clientKey: "act" }))
    })
    await f.decide()
    await until("the Apex to act with a message", () => f.world.prompts.some((prompt) => prompt.conversation === f.fin && prompt.text.includes("Merge it.")))
    await f.world.settle(600)
    assert.equal(f.world.store.openReportAsks(f.child).length, 1, "the decision is still open: a message isn't an answer")
    assert.equal(f.world.store.answerOf(f.world.store.openReportAsks(f.child)[0]!.id), undefined)
    assert.equal(f.timers.waits.length, 1, "and still goes to the person at its time")
    assert.ok(f.timers.waits[0]! <= APEX_ANSWER_MS)
    f.timers.fire()
    await until("the person to be asked", () => f.world.store.openReportAsks(f.child).some((open) => open.for === "person"))
    await f.world.settle(600)
    await f.world.close()
  }
  console.log("plain agents_send: the decision stayed open and went to the person")
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("fin decision window: ok")
