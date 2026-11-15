import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AccessTier } from "@mako/host/contracts/access"
import type { AgentsAnswerInput, AgentsAnswerResult } from "@mako/host/contracts/agent-tools"
import type { AgentCaller, ChildState } from "@mako/host/contracts/agents"
import { YOUR_APEX } from "@mako/host/contracts/children"
import type { LivePermissionResponse } from "@mako/host/contracts/providers-acp"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { FROM_AGENTS, fromAgent } from "@mako/host/conversations/agent-wakes"
import { finAsking } from "@mako/host/conversations/session-report"
import { HostJobs } from "@mako/host/base/host-jobs"
import { Agents } from "@mako/host/conversations/agents"
import { ThreadStore } from "@mako/host/threads/store"
import { AgentsWorld, HARNESSES, noConversations, type Script, type ScriptedTurn } from "./lib/agents-world.ts"

/**
 * What a Fin asks, answered (`npm run test:orch-answer`). The person's access
 * mode is the grant: an Apex on full access answers its Fins' approvals with
 * `agents_answer` and the Fin goes on; the same Apex on Ask is refused, and
 * the approval is the person's, who answers it, and the Apex is told so. One
 * an Apex may answer but leaves past its window (an Apex mid-turn on a harness
 * that hears a digest only at its turn's end) goes to the person too, and the
 * Apex hears they were asked. A Fin stopped while it waits reads as stopped.
 * A question grants nothing,
 * so an Apex on any mode answers its harness's question, and a question a
 * Fin's report asks, with its options and the one it recommends, which
 * reaches the Fin as its Apex's words. An Apex can leave an ask to the
 * person instead, and a repeat of an answer answers once. A Fin that finished
 * with a decision (a merge) reads as done with it open: its Apex answers it,
 * or past its window (a fake clock here) the person does, and the answer is
 * the Fin's next message.
 */
const root = mkdtempSync(join(tmpdir(), "mako-orch-answer-"))
const DECISION = /needs? a decision/

async function until(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function answered(result: AgentsAnswerResult) {
  assert.ok(!("refused" in result), `refused: ${"refused" in result ? result.why : ""}`)
  return result
}

interface Fixture {
  world: AgentsWorld
  apex: { conversation: string; caller: AgentCaller }
  fin: string
  /** The Fin's Thread, as the person's answer names it. */
  thread(): string
  state(): ChildState | undefined
  /** What the Fin's harness heard back from each ask, in order. */
  heard: LivePermissionResponse[]
  /** Every digest the Apex was woken with, in order. */
  wakes: string[]
}

/**
 * An Apex on `harness` at `access` with one Fin on `finHarness`, whose first
 * turn runs `asks`. The Apex's script answers each decision it's woken with
 * through `onDecision`, when given, and `apexTurn` takes the person's own
 * messages to it. `apexAnswerMs` is how long an ask waits on the Apex alone.
 */
async function fixture(name: string, options: {
  harness?: string
  access: AccessTier
  finHarness: string
  asks: (world: AgentsWorld, fin: string, heard: LivePermissionResponse[]) => Promise<void>
  onDecision?: (world: AgentsWorld, caller: AgentCaller, text: string) => Promise<void>
  apexTurn?: (turn: ScriptedTurn) => Promise<string>
  /** The Fin's turns after its first: an answer it takes, say. */
  finTurn?: (turn: ScriptedTurn) => Promise<string>
  apexAnswerMs?: number
  later?: FakeClock["later"]
  heldPulls?: AgentsWorld["options"]["heldPulls"]
}): Promise<Fixture> {
  const heard: LivePermissionResponse[] = []
  const wakes: string[] = []
  let finConversation = ""
  let firstTurn = true
  const script: Script = async (turn) => {
    if (turn.conversation === finConversation) {
      if (!firstTurn) return options.finTurn?.(turn) ?? "Done with the answer."
      firstTurn = false
      await options.asks(turn.world, turn.conversation, heard)
      return "Done."
    }
    const spoken = turn.text.replace(/^<mako-local-control>[\s\S]*?<\/mako-local-control>\n\n/, "")
    if (!spoken.startsWith(FROM_AGENTS)) return options.apexTurn?.(turn) ?? "ok"
    wakes.push(spoken)
    if (DECISION.test(spoken)) await options.onDecision?.(turn.world, turn.caller, spoken)
    return "ok"
  }
  const world = new AgentsWorld({ root: join(root, name), script, ...(options.apexAnswerMs !== undefined && { apexAnswerMs: options.apexAnswerMs }), ...(options.later && { later: options.later }), ...(options.heldPulls && { heldPulls: options.heldPulls }) })
  const apex = await world.apex(options.harness ?? "claude", options.access)
  const started = await world.agents.start(apex.caller, { brief: { objective: "Run the tests" }, harness: options.finHarness, name: "tests", clientKey: "tests", cwd: world.root })
  assert.ok(!("refused" in started) && started.conversation)
  finConversation = started.conversation!
  const entry = () => world.agents.roster(apex.conversation).find((each) => each.child?.name === "tests")?.child
  return { world, apex, fin: finConversation, thread: () => entry()!.thread, state: () => entry()?.state, heard, wakes }
}

/** The engine's waits on a clock the test moves: nothing fires until `fire`, so no case waits on the wall clock. */
class FakeClock {
  private pending: { ms: number; run: () => void }[] = []
  readonly later = (ms: number, run: () => void) => {
    const timer = { ms, run }
    this.pending.push(timer)
    return () => void (this.pending = this.pending.filter((each) => each !== timer))
  }
  /** Runs every wait of at least `ms` that is still set, as if that long passed. */
  fire(ms: number): number {
    const due = this.pending.filter((timer) => timer.ms <= ms)
    this.pending = this.pending.filter((timer) => timer.ms > ms)
    for (const timer of due) timer.run()
    return due.length
  }
  get waiting(): number {
    return this.pending.length
  }
}

/** An engine on `store` alone, with no conversation loaded: how a host that just started reads its Fins. */
function coldView(store: ThreadStore): Agents {
  return new Agents({
    store: () => store,
    catalog: { nativePath: () => undefined, ref: () => undefined, page: async () => null, activity: () => ({}), subscribe: () => () => {}, announce: () => {} },
    jobs: new HostJobs(),
    live: noConversations(() => {}),
    continueOn: () => Promise.reject(new Error("This test moves no conversation")),
    startLive: async () => {
      throw new Error("a cold view starts nothing")
    },
    harnesses: () => HARNESSES,
    runs: () => false,
    harnessLabel: (harness) => harness,
    modes: () => undefined,
  })
}

/** A Fin that finished with a merge to decide, as `agents_report` takes it. */
const MERGE = { status: "done" as const, summary: "PR #371 is green: every check passed.", artifacts: [{ kind: "pull-request" as const, ref: "https://git.example.com/acme/app/pull/371" }], question: "Merge #371?", options: [{ label: "Merge", detail: "Squash it into main" }, { label: "Leave open" }], recommended: 0, clientKey: "merge" }

const approve = (world: AgentsWorld, fin: string, heard: LivePermissionResponse[]) => world.ask(fin, "npm test").then((response) => void heard.push(response))

/** A Fin's agent asks, through a Mako tool, to move its Thread: the ask its tools raise below full access. */
const agentAsk = (answers: Array<{ ask: string; allow: boolean }>) => async (world: AgentsWorld, fin: string) => {
  world.live.asks.answering = async (conversation, ask, allow) => {
    answers.push({ ask, allow })
    world.live.asks.settle(conversation, ask)
  }
  world.live.asks.raise(fin, { id: "11111111-1111-4111-8111-111111111111", at: Date.now(), want: { kind: "move", move: "22222222-2222-4222-8222-222222222222", handsOff: true } })
  await until("the agent's ask to be answered", () => answers.length > 0, 20_000)
}

try {
  // A Fin's ask through Mako's tools is an approval on the one path a Fin's asks take: its Apex on full access answers
  // it with agents_answer, inside its window.
  {
    const answered: Array<{ ask: string; allow: boolean }> = []
    const replies: AgentsAnswerResult[] = []
    const { world, state, wakes } = await fixture("agent-ask-apex", {
      access: "full", finHarness: "opencode", asks: agentAsk(answered),
      onDecision: async (world, caller) => void replies.push(await world.agents.answer(caller, { to: "tests", allow: true, clientKey: "move" })),
    })
    await until("the Apex to be asked", () => replies.length === 1)
    assert.match(wakes[0]!, /Wants to move this Thread to the cloud/, "the Apex hears what the Fin's agent asked")
    if (!answered.length) await until("the ask to be answered", () => answered.length === 1)
    assert.deepEqual(answered, [{ ask: "11111111-1111-4111-8111-111111111111", allow: true }], "the Apex's allow is the ask's")
    await until("the Fin to go on", () => state()?.kind === "ended")
    await world.close()
  }
  console.log("an agent's ask from a Fin: its full-access Apex answered it with agents_answer")

  // Below full access it's the person's, on the Apex's row, as a harness's approval is.
  {
    const answered: Array<{ ask: string; allow: boolean }> = []
    const { world, apex, thread, state } = await fixture("agent-ask-person", { access: "ask", finHarness: "opencode", asks: agentAsk(answered) })
    await until("the ask to be the person's", () => { const now = state(); return now?.kind === "blocked" && now.on === "approval" })
    const blocked = state()
    assert.ok(blocked?.kind === "blocked" && blocked.ask?.kind === "approval")
    assert.deepEqual(blocked.ask.options?.map((option) => option.label), ["Move to the cloud", "Keep here"])
    assert.equal(blocked.ask.named, true, "answered in its own words, not a command's Allow once")
    const asking = world.agents.personAsk(apex.conversation)
    assert.equal(asking?.fin, thread(), "the Apex's row carries it, so the Inbox and phone do")
    await world.agents.respond(apex.conversation, { fin: thread(), ask: blocked.ask.id, allow: false, request: "r-keep" })
    await until("the person's answer to reach the ask", () => answered.length === 1)
    assert.deepEqual(answered, [{ ask: "11111111-1111-4111-8111-111111111111", allow: false }])
    await world.close()
  }
  console.log("an agent's ask from a Fin under an Apex on ask: the person's, from the Apex's row")

  // A full-access Apex answers each harness's approval, and its Fin goes on.
  for (const finHarness of HARNESSES) {
    const answers: AgentsAnswerResult[] = []
    const { world, apex, fin, state, heard } = await fixture(`full-${finHarness}`, {
      access: "full", finHarness, asks: approve,
      onDecision: async (world, caller, text) => {
        assert.match(text, /agents_answer allow: true/, "the wake says how to answer")
        answers.push(await world.agents.answer(caller, { to: "tests", allow: true, clientKey: "allow" }))
      },
    })
    await until(`${finHarness}'s approval to wake its Apex`, () => answers.length === 1)
    const first = answered(answers[0]!)
    assert.deepEqual({ name: first.name, answered: first.answered }, { name: "tests", answered: "approval" })
    await until(`${finHarness}'s Fin to go on`, () => heard.length === 1 && state()?.kind === "ended")
    assert.deepEqual(heard[0], { kind: "choice", optionId: "allow" }, "allowed once, as the person's Allow once")
    assert.equal(world.answers.filter((each) => each.conversation === fin).length, 1)
    const again = answered(await world.agents.answer(apex.caller, { to: "tests", allow: true, clientKey: "allow" }))
    assert.equal(again.deduped, true, "a repeat answers the first")
    assert.equal(world.answers.length, 1, "and its harness hears it once")
    assert.deepEqual(world.agents.diagnostics().answers, { apex: 1, passed: 0, refused: 0, person: 0 })
    await world.close()
  }
  console.log(`full access: the Apex answered an approval on each of ${HARNESSES.length} harnesses, each Fin went on, a repeat answered once`)

  // The same Apex on Ask: the approval is the person's at once. The Apex is told it can't answer, is refused if it tries, and the person answers.
  {
    let woken = 0
    const { world, apex, thread, state, heard, wakes } = await fixture("ask", { access: "ask", finHarness: "codex", asks: approve, onDecision: async () => void (woken += 1) })
    await until("the approval", () => state()?.kind === "blocked")
    await until("the Apex to be told", () => wakes.length === 1)
    assert.match(wakes[0]!, /1 waits on the person:\n  • "tests" \(Codex\): Approve: npm test\. Only the person can answer this approval: you're on ask, and only an Apex on full access answers its Fins' approvals\. Mako asked them in their Inbox and on their devices\./)
    assert.doesNotMatch(wakes[0]!, DECISION, "told, not asked to decide")
    const blocked = state()
    assert.ok(blocked?.kind === "blocked")
    assert.equal(blocked.on, "approval", "the person's approval")
    assert.match(blocked.question, /^Approve: npm test \(yours to answer: its Apex isn't on full access\)$/)
    assert.equal(blocked.ask?.kind, "approval")
    assert.deepEqual(blocked.ask?.options?.map((option) => option.label), ["Allow once", "Always allow", "Reject"], "the ask carries what answers it")
    const refused = await world.agents.answer(apex.caller, { to: "tests", allow: true, clientKey: "try" })
    assert.ok("refused" in refused && refused.refused === "access")
    assert.match(refused.why, /this Thread is on ask, and only an Apex on full access answers its Fins' approvals/)
    assert.equal(world.answers.length, 0, "nothing reached the harness")
    const asking = world.agents.personAsk(apex.conversation)
    assert.deepEqual(asking && { fin: asking.fin, kind: asking.ask.kind, line: asking.line, more: asking.more }, { fin: thread(), kind: "approval", line: "Approve: npm test", more: 0 }, "the Apex's row says the Fin's ask in its harness's words")
    // The person answers from the Apex's Thread, on any device: an ask already answered is refused, a repeat answers once.
    const stale = await world.agents.respond(apex.conversation, { fin: thread(), ask: "an-earlier-ask", allow: true, request: "r-stale" })
    assert.ok("refused" in stale && stale.refused === "conflict")
    const request = { fin: thread(), ask: blocked.ask!.id, allow: true, request: "r-allow" }
    assert.equal(answered(await world.agents.respond(apex.conversation, request)).answered, "approval")
    await until("the Fin to go on", () => heard.length === 1 && state()?.kind === "ended")
    assert.deepEqual(heard[0], { kind: "choice", optionId: "allow" }, "the person's Allow once")
    assert.equal(answered(await world.agents.respond(apex.conversation, request)).deduped, true, "a repeat answers the first")
    assert.equal(world.answers.length, 1, "and its harness hears it once")
    assert.equal(world.agents.personAsk(apex.conversation), undefined, "and the row no longer waits on it")
    assert.equal(woken, 0, "the Apex was never asked to decide the person's approval")
    assert.equal(wakes.length, 1, "and was told of it once")
    assert.deepEqual(world.agents.diagnostics().answers, { apex: 0, passed: 0, refused: 1, person: 1 })
    await world.close()
  }
  console.log("ask: the Apex was told the approval was the person's, refused it, and the person's answer from its Thread let the Fin go on, once")

  // A progress report before an approval suppresses the inferred end report. The stored notice that the Apex
  // couldn't answer must still stop blocking the Fin once the person answers, even before it reports anything else.
  {
    const { world, apex, fin, thread, state, heard } = await fixture("answered-after-progress", {
      access: "ask", finHarness: "codex",
      asks: async (world, conversation, heard) => {
        await world.agents.report(world.caller(conversation), { status: "progress", summary: "Checking the change.", clientKey: "checking" })
        await approve(world, conversation, heard)
      },
    })
    await until("the approval", () => state()?.kind === "blocked")
    const blocked = state()
    assert.ok(blocked?.kind === "blocked" && blocked.ask)
    assert.equal(answered(await world.agents.respond(apex.conversation, { fin: thread(), ask: blocked.ask.id, allow: true, request: "r-progress-allow" })).answered, "approval")
    await until("the answered turn to end", () => heard.length === 1 && world.live.session(fin)?.status === "ready")
    assert.equal(state()?.kind, "idle", "the stored approval notice no longer blocks the Fin after the person's answer")
    assert.equal(world.agents.personAsk(apex.conversation), undefined)
    const read = await world.agents.read(apex.caller, { child: "tests" })
    assert.ok("text" in read)
    assert.doesNotMatch(read.text, /asked them in their Inbox|^blocked/, "agents_read cannot repeat the stale notice as its current report")
    const listed = await world.agents.list(apex.caller, {})
    assert.ok("children" in listed)
    assert.equal(listed.children[0]?.report, undefined, "the strip cannot keep it as a blocked report either")
    await world.restart()
    assert.equal(state()?.kind, "idle", "a restart cannot revive that notice from the journal")
    await world.close()
  }
  console.log("an answered approval's stored notice no longer blocks its idle Fin, including after restart")

  // What stalled two Fins for 45 minutes: an Apex on full access, mid-turn on a harness that hears a digest only at its
  // turn's end, leaves an approval it may answer. Past the window the person is asked; their answer lets the Fin go on,
  // and the Apex, its turn over, isn't woken for an ask already answered.
  {
    let busy!: () => void
    const apexBusy = new Promise<void>((resolve) => { busy = resolve })
    const { world, apex, thread, state, heard, wakes } = await fixture("late-busy", {
      harness: "cursor", access: "full", finHarness: "claude", apexAnswerMs: 300,
      asks: async (world, fin, heard) => {
        await apexBusy
        await approve(world, fin, heard)
      },
      apexTurn: (turn) => turn.world.hold(turn.conversation).then(() => "Benchmarks done."),
    })
    world.say(apex.conversation, "Run the benchmarks")
    await until("the Apex's long turn", () => world.live.session(apex.conversation)?.status === "running")
    busy()
    await until("the approval to wait on the Apex", () => { const now = state(); return now?.kind === "blocked" && now.on === "lead" })
    const lead = state()
    assert.ok(lead?.kind === "blocked")
    assert.equal(world.agents.personAsk(apex.conversation), undefined, "inside the window it's the Apex's")
    await until("the person to be asked", () => { const now = state(); return now?.kind === "blocked" && now.on === "approval" })
    const blocked = state()
    assert.ok(blocked?.kind === "blocked")
    assert.equal(blocked.question, "Approve: npm test (yours to answer: its Apex is mid-turn and didn't answer within a second)")
    const asking = world.agents.personAsk(apex.conversation)
    assert.deepEqual(asking && { fin: asking.fin, kind: asking.ask.kind, line: asking.line }, { fin: thread(), kind: "approval", line: "Approve: npm test" }, "the Apex's row carries it, so the Inbox, a notification and the phone say it")
    assert.deepEqual(finAsking(asking)?.waiting, { for: "approval", line: "tests: Approve: npm test" })
    assert.equal(wakes.length, 0, "the Apex, mid-turn, heard nothing yet")
    assert.equal(answered(await world.agents.respond(apex.conversation, { fin: thread(), ask: blocked.ask!.id, allow: true, request: "r-late" })).answered, "approval")
    await until("the Fin to go on", () => heard.length === 1 && state()?.kind === "ended")
    assert.deepEqual(heard[0], { kind: "choice", optionId: "allow" })
    world.release(apex.conversation)
    await world.settle(600)
    assert.equal(wakes.length, 1, "its turn over, the Apex hears its Fin's result")
    assert.match(wakes[0]!, /1 finished:\n  • "tests" \(Claude\) done/)
    assert.doesNotMatch(wakes[0]!, /Approve: npm test/, "and not the ask the person already answered")
    await world.close()
  }
  console.log("late, busy: the person was asked once the busy Apex left the approval past its window, and their answer let the Fin go on")

  // An idle Apex woken with an approval that doesn't answer it: the person is asked too, the Apex hears they were and
  // that it may still answer, and its answer is the one the Fin hears.
  {
    const { world, apex, state, heard, wakes } = await fixture("late-idle", {
      // Past the 2 s an idle Apex's wake waits for the rest of its burst, so the first wake goes before the window ends.
      access: "full", finHarness: "codex", apexAnswerMs: 3_000, asks: approve,
      onDecision: async (world, caller, text) => {
        if (/Mako asked the person too/.test(text)) answered(await world.agents.answer(caller, { to: "tests", allow: true, clientKey: "late" }))
      },
    })
    await until("the Apex to hear twice", () => wakes.length === 2)
    assert.match(wakes[0]!, /Approve: npm test\. Allow it with agents_answer allow: true/)
    assert.match(wakes[1]!, /Approve: npm test\. Mako asked the person too, since you didn't answer within 3 seconds: they can answer it from their Inbox\. You may still allow it with agents_answer allow: true, refuse it with allow: false, or stop it with agents_stop; the first answer is the one it hears\./)
    await until("the Fin to go on", () => heard.length === 1 && state()?.kind === "ended")
    assert.deepEqual(heard[0], { kind: "choice", optionId: "allow" })
    assert.equal(world.agents.personAsk(apex.conversation), undefined, "and the person's row no longer waits on it")
    assert.deepEqual(world.agents.diagnostics().answers, { apex: 1, passed: 0, refused: 0, person: 0 })
    await world.close()
  }
  console.log("late, idle: the person was asked too, the Apex heard so, and its own answer still let the Fin go on")

  // An Apex that answers inside the window never troubles the person.
  {
    const { world, apex, state, heard, wakes } = await fixture("in-time", {
      access: "full", finHarness: "grok", apexAnswerMs: 3_000, asks: approve,
      onDecision: async (world, caller) => void answered(await world.agents.answer(caller, { to: "tests", allow: true, clientKey: "now" })),
    })
    await until("the Fin to go on", () => heard.length === 1 && state()?.kind === "ended")
    await world.settle(3_200)
    assert.equal(wakes.length, 2, "woken for the ask and for the result, never a second time for the ask")
    assert.doesNotMatch(wakes[1]!, /Approve: npm test/)
    assert.equal(world.agents.personAsk(apex.conversation), undefined)
    await world.close()
  }
  console.log("in time: an Apex that answered inside the window was woken once for the ask and the person never asked")

  // A Fin its Apex stops while it waits on an approval ends as stopped, in the Apex's words: not failed, and nobody woken.
  {
    const { world, apex, fin, state, heard, wakes } = await fixture("stopped-blocked", {
      harness: "cursor", access: "full", finHarness: "claude", asks: approve,
      onDecision: async (world, caller) => void await world.agents.stop(caller, { child: "tests", reason: "its labels are in already" }),
    })
    await until("the stop", () => state()?.kind === "ended")
    await world.settle(600)
    assert.deepEqual(state(), { kind: "ended", outcome: "stopped", reason: "its labels are in already" })
    assert.deepEqual(heard, [{ kind: "choice", optionId: null }], "its approval ended unanswered with its turn")
    const child = world.agents.roster(apex.conversation).find((each) => each.child?.name === "tests")!
    assert.equal(child.state.kind, "canceled", "every surface draws it as stopped")
    const thread = ThreadIdSchema.parse(child.child!.thread)
    assert.deepEqual(world.store.reportsOf(thread, 0).map((report) => report.status), ["blocked"], "no failure was written for the turn the stop cut")
    assert.equal(wakes.length, 1, "the Apex that stopped it isn't woken again")
    assert.equal(world.prompts.filter((prompt) => prompt.conversation === fin).length, 1)
    await world.close()
  }
  console.log("stopped while blocked: the Fin read as stopped with its Apex's reason, wrote no failure and woke no one")

  // The person answers a Fin harness's question left to them by one of its options, picked by its place.
  {
    const asked = { options: [{ optionId: "answer", name: "Answer" }], questions: [{ id: "q1", header: "Branch", question: "Which branch?", isSecret: false, allowOther: false, options: [{ label: "main", description: "The default branch", value: "main" }, { label: "release-6", description: "The release branch", value: "release-6" }] }] }
    const { world, apex, thread, state, heard } = await fixture("person-question", {
      access: "ask", finHarness: "cursor",
      asks: (world, fin, heard) => world.ask(fin, "Which branch?", asked).then((response) => void heard.push(response)),
      onDecision: async (world, caller) => void answered(await world.agents.answer(caller, { to: "tests", person: true, clientKey: "pass" })),
    })
    await until("the question to reach the person", () => { const now = state(); return now?.kind === "blocked" && now.on === "person" })
    const blocked = state()
    assert.ok(blocked?.kind === "blocked" && blocked.ask?.kind === "question")
    assert.equal(answered(await world.agents.respond(apex.conversation, { fin: thread(), ask: blocked.ask.id, option: 1, request: "r-q" })).answered, "question")
    await until("the Fin to go on", () => heard.length === 1 && state()?.kind === "ended")
    assert.deepEqual(heard[0], { kind: "answers", answers: { q1: ["release-6"] } }, "the option the person tapped")
    await world.close()
  }
  console.log("person question: the person answered a Fin harness's question by tapping its option")

  // A question grants nothing: an Apex on Ask answers its Fin harness's own question by an option's label.
  {
    const asked = { options: [{ optionId: "answer", name: "Answer" }], questions: [{ id: "q1", header: "Branch", question: "Which branch?", isSecret: false, allowOther: false, options: [{ label: "main", description: "The default branch", value: "main" }, { label: "release-6", description: "The release branch", value: "release-6" }] }] }
    const answers: AgentsAnswerResult[] = []
    const { world, state, heard } = await fixture("question", {
      access: "ask", finHarness: "claude",
      asks: (world, fin, heard) => world.ask(fin, "Which branch?", asked).then((response) => void heard.push(response)),
      onDecision: async (world, caller) => void answers.push(await world.agents.answer(caller, { to: "tests", answer: "Release-6", clientKey: "q" })),
    })
    await until("the question to wake its Apex", () => answers.length === 1)
    assert.equal(answered(answers[0]!).answered, "question")
    await until("the Fin to go on", () => heard.length === 1 && state()?.kind === "ended")
    assert.deepEqual(heard[0], { kind: "answers", answers: { q1: ["release-6"] } }, "its option's value, picked by its label")
    await world.close()
  }
  console.log("question: an Apex on Ask answered its Fin's harness question by an option's label")

  // A question in the Fin's report, typed: its options, its recommendation, what to do. The answer reaches the Fin as its Apex's words.
  {
    let report: Promise<unknown> | undefined
    const answers: AgentsAnswerResult[] = []
    const { world, fin, state } = await fixture("report", {
      access: "auto", finHarness: "grok",
      asks: async (world, conversation) => {
        report = world.agents.report(world.caller(conversation), {
          status: "needs-input", summary: "The release branch is ambiguous.", question: "Which branch does the release go from?",
          options: [{ label: "main", detail: "Ship what's merged today" }, { label: "release-6" }], recommended: 1, action: "Pick the branch the release goes from.", clientKey: "branch",
        })
        await report
      },
      onDecision: async (world, caller, text) => {
        assert.match(text, /options: main · release-6 \(recommended\)/, "the digest lists the options and the recommendation")
        answers.push(await world.agents.answer(caller, { to: "tests", answer: "release-6", clientKey: "branch" }))
      },
    })
    await until("the report's question to wake its Apex", () => answers.length === 1)
    const reported = answered(answers[0]!)
    assert.equal(reported.answered, "report")
    assert.ok(reported.delivery === "turn" || reported.delivery === "queued")
    await until("the answer to reach the Fin", () => world.prompts.some((prompt) => prompt.conversation === fin && prompt.text.includes("Answer: release-6")))
    const prompt = world.prompts.find((each) => each.conversation === fin && each.text.includes("Answer: release-6"))!
    assert.ok(prompt.text.startsWith(`${fromAgent(YOUR_APEX)}\nYour question: Which branch does the release go from?\nAnswer: release-6`), "as its Apex's words, beneath the question it answers")
    await until("the Fin to go on", () => state()?.kind === "ended")
    await world.close()
  }
  console.log("report: a typed question woke its Apex with its options, and the answer reached the Fin as its Apex's")

  // A Fin that asks and works on is still asking: the answer isn't refused, it reaches it, and the question is closed.
  {
    const answers: AgentsAnswerResult[] = []
    const { world, fin, state } = await fixture("asks-and-works", {
      access: "auto", finHarness: "claude",
      asks: async (world, conversation) => {
        await world.agents.report(world.caller(conversation), { status: "needs-input", summary: "Which base?", question: "Which base does it go on?", options: [{ label: "main" }], clientKey: "base" })
        await world.hold(conversation)
      },
      onDecision: async (world, caller) => {
        answers.push(await world.agents.answer(caller, { to: "tests", answer: "main", clientKey: "base" }))
      },
    })
    await until("its Apex to answer", () => answers.length === 1)
    assert.equal(answered(answers[0]!).answered, "report", "an answer isn't refused while the question stands")
    await until("the answer to reach it as it works", () => world.steers.some((steer) => steer.conversation === fin && steer.text.includes("Answer: main")))
    world.release(fin)
    await world.settle(300)
    assert.notEqual(state()?.kind, "blocked", "a question answered isn't listed as open once its turn ends")
    await world.close()
  }
  console.log("report: an answer reached a Fin that asked and worked on, and its question closed")

  // The Apex leaves it to the person: the ask is the person's, with its options, and the Apex isn't woken again.
  {
    let wakes = 0
    const { world, apex, thread, fin, state } = await fixture("person", {
      access: "full", finHarness: "opencode",
      asks: async (world, conversation) => {
        await world.agents.report(world.caller(conversation), { status: "blocked", summary: "Needs the signing key.", question: "Use the old signing key?", options: [{ label: "Yes" }, { label: "No" }], recommended: 1, clientKey: "key" })
      },
      onDecision: async (world, caller) => {
        wakes += 1
        answered(await world.agents.answer(caller, { to: "tests", person: true, clientKey: "pass" }))
      },
    })
    await until("the ask to reach the person", () => { const now = state(); return now?.kind === "blocked" && now.on === "person" })
    const blocked = state()
    assert.ok(blocked?.kind === "blocked")
    assert.equal(blocked.question, "Use the old signing key?")
    assert.deepEqual(blocked.ask && { options: blocked.ask.options, recommended: blocked.ask.recommended, kind: blocked.ask.kind }, { options: [{ label: "Yes" }, { label: "No" }], recommended: 1, kind: "report" })
    await world.settle(600)
    assert.equal(wakes, 1, "the person's ask wakes no Apex")
    assert.deepEqual(world.agents.diagnostics().answers, { apex: 0, passed: 1, refused: 0, person: 0 })
    const asking = world.agents.personAsk(apex.conversation)
    assert.deepEqual(asking && { fin: asking.fin, name: asking.name, line: asking.line, kind: asking.ask.kind }, { fin: thread(), name: "tests", line: "Use the old signing key?", kind: "report" })
    const shown = finAsking(asking)
    assert.deepEqual(shown?.asking, { fin: thread(), name: "tests", ask: asking!.ask.id, options: ["Yes", "No"], recommended: 1 }, "the row's ask, as every device reads it")
    assert.deepEqual(shown?.waiting, { for: "question", line: "tests: Use the old signing key?" })
    const notYours = await world.agents.respond(apex.conversation, { fin: thread(), ask: asking!.ask.id, option: 5, request: "r-bad" })
    assert.ok("refused" in notYours && notYours.refused === "conflict", "an option it doesn't have")
    assert.equal(answered(await world.agents.respond(apex.conversation, { fin: thread(), ask: asking!.ask.id, option: 1, request: "r-no" })).answered, "report")
    await until("the person's answer to reach the Fin", () => world.prompts.some((prompt) => prompt.conversation === fin && prompt.text.includes("Answer: No")))
    const prompt = world.prompts.find((each) => each.conversation === fin && each.text.includes("Answer: No"))!
    assert.ok(!prompt.text.startsWith(fromAgent(YOUR_APEX)), "as the person's words, not its Apex's")
    await until("the Fin to go on", () => state()?.kind === "ended")
    assert.equal(world.agents.personAsk(apex.conversation), undefined)
    assert.deepEqual(world.agents.diagnostics().answers, { apex: 0, passed: 1, refused: 0, person: 1 })
    const notWaiting = await world.agents.answer((await world.apex("codex")).caller, { to: "tests", answer: "Yes", clientKey: "x" } satisfies AgentsAnswerInput)
    assert.ok("refused" in notWaiting && notWaiting.refused === "unknown-child", "another Thread can't answer it")
    await world.close()
  }
  console.log("person: the Apex left the ask to the person, with its options, and wasn't woken again; the person's tap reached the Fin as their own words")

  // Done, needs a decision its Apex makes: the report, the digest that wakes the Apex, its answer, and the Fin's next message.
  {
    const clock = new FakeClock()
    let finish!: () => void
    const answering = new Promise<void>((resolve) => { finish = resolve })
    const answers: AgentsAnswerResult[] = []
    const { world, apex, fin, state, wakes } = await fixture("decision-apex", {
      access: "edits", finHarness: "codex", later: clock.later,
      asks: async (world, conversation) => void await world.agents.report(world.caller(conversation), MERGE),
      onDecision: async (world, caller, text) => {
        const decided = state()
        assert.ok(decided?.kind === "ended" && decided.outcome === "done", "it reads as done, not blocked")
        assert.deepEqual(decided.decision && { question: decided.decision.question, on: decided.decision.on, options: decided.decision.ask!.options?.map((option) => option.label) }, { question: "Merge #371?", on: "lead", options: ["Merge", "Leave open"] })
        assert.match(text, /1 needs a decision:\n {2}• "tests" \(Codex\) done; decide: Merge #371\? \(Merge · Leave open, recommends Merge\) \(\+37 chars: agents_read\)\n {4}pull-request: https:\/\/git\.example\.com\/acme\/app\/pull\/371/)
        assert.doesNotMatch(text, /finished:/)
        assert.equal(world.agents.personAsk(apex.conversation), undefined, "the Apex's to decide, not the person's")
        assert.equal(clock.waiting, 1, "the person is asked too only past the Apex's window")
        answers.push(await world.agents.answer(caller, { to: "tests", answer: "merge", clientKey: "merge" }))
      },
      finTurn: async (turn) => {
        await answering
        return turn.text.includes("Answer: Merge") ? "Merged #371." : "Hm."
      },
    })
    await until("the Apex to answer the decision", () => answers.length === 1)
    assert.equal(answered(answers[0]!).answered, "report")
    await until("the answer to reach the Fin as its next message", () => world.prompts.some((prompt) => prompt.conversation === fin && prompt.text.includes("Answer: Merge")))
    const prompt = world.prompts.find((each) => each.conversation === fin && each.text.includes("Answer: Merge"))!
    assert.ok(prompt.text.startsWith(`${fromAgent(YOUR_APEX)}\nYour question: Merge #371?\nAnswer: Merge`), "as its Apex's words, beneath the question")
    await until("the Fin at work on it", () => state()?.kind === "working")
    const going = state()
    assert.ok(going?.kind === "working")
    assert.deepEqual(going.answered, { by: "lead", answer: "Merge" }, "its row says who answered, while it works on it")
    assert.equal(clock.waiting, 0, "an answered decision waits on nobody")
    finish()
    await until("its next result", () => { const now = state(); return now?.kind === "ended" && !now.decision })
    await world.settle(600)
    assert.match(wakes.at(-1)!, /1 finished:\n {2}• "tests" \(Codex\) done: Merged #371\./, "the Apex hears the result of its answer")
    assert.equal(clock.fire(Number.MAX_SAFE_INTEGER), 0, "and nothing escalates later")
    await world.close()
  }
  console.log("decision, Apex: done with a merge to decide woke its Apex in one line, its answer was the Fin's next message, and the row said who answered")

  // One its Apex leaves past the window goes to the person too; the person's tap is the Fin's next message, as their own words.
  {
    const clock = new FakeClock()
    let finish!: () => void
    const answering = new Promise<void>((resolve) => { finish = resolve })
    const { world, apex, fin, thread, state, wakes } = await fixture("decision-late", {
      access: "full", finHarness: "claude", later: clock.later,
      asks: async (world, conversation) => void await world.agents.report(world.caller(conversation), MERGE),
      finTurn: async () => {
        await answering
        return "Merged #371."
      },
    })
    await until("the Apex to hear the decision", () => wakes.length === 1)
    const first = state()
    assert.ok(first?.kind === "ended" && first.decision?.on === "lead")
    assert.equal(clock.fire(60_000), 1, "a minute on, the person is asked")
    await until("the person to be asked", () => { const now = state(); return now?.kind === "ended" && now.decision?.on === "person" })
    const asking = world.agents.personAsk(apex.conversation)
    assert.deepEqual(asking && { fin: asking.fin, line: asking.line, kind: asking.ask.kind, options: asking.ask.options?.map((option) => option.label) }, { fin: thread(), line: "Done · needs you: Merge #371?", kind: "report", options: ["Merge", "Leave open"] })
    assert.deepEqual(finAsking(asking)?.waiting, { for: "question", line: "tests: Done · needs you: Merge #371?" }, "the Apex's row, the Inbox, a notification and the phone say it")
    await until("the Apex to hear it was asked", () => wakes.length === 2)
    assert.match(wakes[1]!, /1 waits on the person:\n {2}• "tests" \(Claude\) done; the person decides: Merge #371\? \(Merge · Leave open, recommends Merge\) \(\+37 chars: agents_read\)\. Mako asked the person too/)
    const decided = state()
    assert.ok(decided?.kind === "ended" && decided.decision)
    assert.equal(answered(await world.agents.respond(apex.conversation, { fin: thread(), ask: decided.decision.ask!.id, option: 0, request: "r-merge" })).answered, "report")
    await until("the person's answer to reach the Fin", () => world.prompts.some((prompt) => prompt.conversation === fin && prompt.text.includes("Answer: Merge")))
    assert.ok(!world.prompts.find((prompt) => prompt.conversation === fin && prompt.text.includes("Answer: Merge"))!.text.startsWith(fromAgent(YOUR_APEX)), "as the person's words")
    await until("the Fin at work on it", () => state()?.kind === "working")
    const going = state()
    assert.ok(going?.kind === "working")
    assert.deepEqual(going.answered, { by: "person", answer: "Merge" })
    const late = await world.agents.answer(apex.caller, { to: "tests", answer: "Leave open", clientKey: "late" })
    assert.ok("refused" in late && late.refused === "conflict", "the first answer is the one it hears")
    finish()
    await until("its next result", () => { const now = state(); return now?.kind === "ended" && !now.decision })
    assert.equal(world.agents.personAsk(apex.conversation), undefined)
    await world.close()
  }
  console.log("decision, late: left past its window it went to the person too, the Apex heard so, and the person's tap was the Fin's next message")

  // The person's from the start: the Apex is told and can't answer it, and leaving one to the person keeps it done.
  {
    const clock = new FakeClock()
    const { world, apex, state, wakes } = await fixture("decision-person", {
      access: "full", finHarness: "grok", later: clock.later,
      asks: async (world, conversation) => void await world.agents.report(world.caller(conversation), { ...MERGE, decides: "person" }),
    })
    await until("the Apex to be told", () => wakes.length === 1)
    assert.match(wakes[0]!, /1 waits on the person:\n {2}• "tests" \(Grok\) done; the person decides: Merge #371\?.*It's the person's: they answer it from their Inbox\. Don't answer it\./)
    assert.doesNotMatch(wakes[0]!, DECISION)
    const decided = state()
    assert.ok(decided?.kind === "ended" && decided.decision?.on === "person")
    assert.equal(clock.waiting, 0, "nothing escalates: it's the person's already")
    const refused = await world.agents.answer(apex.caller, { to: "tests", answer: "Merge", clientKey: "try" })
    assert.ok("refused" in refused && /left that decision to the person/.test(refused.why))
    assert.equal(world.agents.personAsk(apex.conversation)?.line, "Done · needs you: Merge #371?")
    await world.close()
  }
  {
    const { world, apex, state } = await fixture("decision-passed", {
      access: "full", finHarness: "opencode", later: new FakeClock().later,
      asks: async (world, conversation) => void await world.agents.report(world.caller(conversation), MERGE),
      onDecision: async (world, caller) => void answered(await world.agents.answer(caller, { to: "tests", person: true, clientKey: "pass" })),
    })
    await until("the decision left to the person", () => { const now = state(); return now?.kind === "ended" && now.decision?.on === "person" })
    assert.equal(world.agents.personAsk(apex.conversation)?.line, "Done · needs you: Merge #371?", "still done, now the person's")
    await world.close()
  }
  console.log("decision, person: theirs from the start the Apex was told and refused; one the Apex left to them stayed done")

  // Two answers at once, its Apex's and the person's: one takes it, the other is refused, and the Fin hears one. A
  // delivery that fails lets go of the decision, so the next answer takes it.
  {
    let results: AgentsAnswerResult[] = []
    const { world, apex, fin, thread, state } = await fixture("decision-race", {
      access: "full", finHarness: "codex", later: new FakeClock().later,
      asks: async (world, conversation) => void await world.agents.report(world.caller(conversation), MERGE),
      onDecision: async (world, caller) => {
        const decided = state()
        assert.ok(decided?.kind === "ended" && decided.decision)
        const id = decided.decision.ask!.id
        // A delivery that fails: the Fin's Thread archived, which takes no message.
        world.archived.add(fin)
        const failed = await world.agents.answer(caller, { to: "tests", answer: "Merge", clientKey: "archived" })
        assert.ok("refused" in failed, "an archived Fin takes no answer")
        const again = state()
        assert.ok(again?.kind === "ended" && again.decision?.ask?.id === id, "and the decision is open again, for the next answer")
        world.archived.delete(fin)
        results = await Promise.all([
          world.agents.answer(caller, { to: "tests", answer: "Merge", clientKey: "apex-merge" }),
          world.agents.respond(apex.conversation, { fin: thread(), ask: id, option: 1, request: "person-leave" }),
        ])
      },
    })
    await until("both answers", () => results.length === 2)
    const won = results.filter((result) => !("refused" in result))
    const lost = results.filter((result) => "refused" in result)
    assert.equal(won.length, 1, `one answer takes it: ${JSON.stringify(results)}`)
    assert.ok(lost.length === 1 && "refused" in lost[0]! && lost[0].refused === "conflict" && /it was answered/.test(lost[0].why), "the other is refused as answered")
    await until("the answer to reach the Fin", () => world.prompts.some((prompt) => prompt.conversation === fin && /Answer: /.test(prompt.text)))
    await until("its next result", () => { const now = state(); return now?.kind === "ended" && !now.decision })
    await world.settle(600)
    const heard = world.prompts.filter((prompt) => prompt.conversation === fin && /Answer: /.test(prompt.text))
    assert.equal(heard.length, 1, "and the Fin hears one answer, never both")
    assert.ok(heard[0]!.text.includes("Answer: Merge"), "the Apex's, which came first")
    await world.close()
  }
  console.log("decision, at once: of the Apex's and the person's answers one took it and the Fin heard it alone; a failed delivery let go first")

  // An answer taken stays taken across a restart: the host that starts on the same store refuses a contradictory one,
  // and the Fin hears one answer.
  {
    let answered: AgentsAnswerResult | undefined
    let held = 0
    let id: string | undefined
    const { world, apex, fin, thread, state } = await fixture("decision-restart", {
      access: "full", finHarness: "codex", later: new FakeClock().later,
      asks: async (world, conversation) => void await world.agents.report(world.caller(conversation), MERGE),
      onDecision: async (world, caller) => {
        const decided = state()
        if (decided?.kind === "ended") id = decided.decision?.ask?.id
        answered = await world.agents.answer(caller, { to: "tests", answer: "Merge", clientKey: "merge" })
      },
      // The answer's turn holds, as the review's run did: the host restarts while the Fin works on it.
      finTurn: async (turn) => {
        if (held++) return "Merged #371."
        await turn.world.hold(turn.conversation)
        return "Merged #371."
      },
    })
    await until("the Apex's answer", () => answered !== undefined)
    assert.ok(answered && !("refused" in answered) && id, "the Apex's answer took the decision")
    await until("the answer to reach the Fin", () => world.prompts.some((prompt) => prompt.conversation === fin && prompt.text.includes("Answer: Merge")))
    await world.restart()
    const after = state()
    assert.ok(!(after?.kind === "ended" && after.decision), `the restarted host holds the decision answered: ${JSON.stringify(after)}`)
    const person = await world.agents.respond(apex.conversation, { fin: thread(), ask: id, option: 1, request: "person-leave" })
    assert.ok("refused" in person && person.refused === "conflict", "the person's contradictory answer is refused")
    const lead = await world.agents.answer(apex.caller, { to: "tests", answer: "Leave open", clientKey: "leave" })
    assert.ok("refused" in lead, "so is the Apex's")
    const again = await world.agents.answer(apex.caller, { to: "tests", answer: "Merge", clientKey: "merge" })
    assert.ok(!("refused" in again) && again.deduped, "and a repeat of the answer is the answer it gave")
    world.release(fin)
    await world.settle(600)
    const heard = world.prompts.filter((prompt) => prompt.conversation === fin && /Answer: /.test(prompt.text))
    assert.equal(heard.length, 1, `the Fin heard one answer: ${heard.map((prompt) => prompt.text.split("\n").at(-1)).join(" | ")}`)
    await world.close()
  }
  console.log("decision, restart: an answer taken stayed taken on the restarted host, a contradictory one was refused, and the Fin heard one")

  // A host that stops between keeping an answer and delivering it: the next sends it once, and the one after sends nothing.
  {
    const { world, apex, fin, thread, state } = await fixture("decision-crash", {
      access: "full", finHarness: "claude", later: new FakeClock().later,
      asks: async (world, conversation) => void await world.agents.report(world.caller(conversation), MERGE),
    })
    await until("the decision", () => { const now = state(); return now?.kind === "ended" && now.decision !== undefined })
    const decided = state()
    assert.ok(decided?.kind === "ended" && decided.decision)
    // What answering keeps before any delivery, as a host that stopped right then left it.
    const session = apex.caller.kind === "agent" ? apex.caller.session : ""
    world.store.claimAnswer({
      ask: decided.decision.ask!.id, child: ThreadIdSchema.parse(thread()), op: `answer:${session}:merge`, by: "lead", answer: "Merge",
      request: "0c1a1ec7-0000-4000-8000-00000000c1a1", text: `${fromAgent(YOUR_APEX)}\nYour question: Merge #371?\nAnswer: Merge`,
      actor: { kind: "agent", session: SessionIdSchema.parse(session) }, at: Date.now(),
    })
    await world.restart()
    await until("the kept answer to reach the Fin", () => world.prompts.some((prompt) => prompt.conversation === fin && prompt.text.includes("Answer: Merge")))
    const ask = decided.decision.ask!.id
    await until("its delivery kept", () => world.store.answerOf(ask)?.delivered !== undefined)
    await world.settle(600)
    await world.restart()
    await world.settle(600)
    assert.equal(world.prompts.filter((prompt) => prompt.conversation === fin && /Answer: /.test(prompt.text)).length, 1, "sent once, never again by the next start")
    const late = await world.agents.respond(apex.conversation, { fin: thread(), ask, option: 1, request: "person-late" })
    assert.ok("refused" in late, "and it stays answered")
    await world.close()
  }
  console.log("decision, crash: an answer kept before its delivery was sent once by the next host and never by the one after")

  // A repeat of the same answer while the first is still on its way gets that answer, and the Fin hears it once.
  {
    let results: AgentsAnswerResult[] = []
    const { world, fin } = await fixture("decision-repeat", {
      access: "full", finHarness: "grok", later: new FakeClock().later,
      asks: async (world, conversation) => void await world.agents.report(world.caller(conversation), MERGE),
      onDecision: async (world, caller) => {
        results = await Promise.all([
          world.agents.answer(caller, { to: "tests", answer: "Merge", clientKey: "same" }),
          world.agents.answer(caller, { to: "tests", answer: "Merge", clientKey: "same" }),
        ])
      },
    })
    await until("both answers", () => results.length === 2)
    assert.ok(results.every((result) => !("refused" in result) && result.answered === "report"), `both are the one answer: ${JSON.stringify(results)}`)
    assert.equal(results.filter((result) => !("refused" in result) && result.deduped).length, 1, "the second says it's a repeat")
    await world.settle(600)
    assert.equal(world.prompts.filter((prompt) => prompt.conversation === fin && /Answer: /.test(prompt.text)).length, 1, "and the Fin heard it once")
    assert.deepEqual(world.agents.diagnostics().answers.apex, 1, "counted once")
    await world.close()
  }
  console.log("decision, repeat: the same answer twice at once was the one answer, heard once")

  // The review's probe: a new question in the very millisecond of the last answer is open, read from the store alone
  // (no conversation loaded, as a host that just started reads it), before and after a restart on the same store.
  // The engine's clock is held still at that millisecond, so nothing here races the wall.
  {
    let frozen: number | undefined
    const world = new AgentsWorld({
      root: join(root, "decision-same-ms"), now: () => frozen ?? Date.now(), later: new FakeClock().later,
      script: async (turn) => {
        if (turn.text.includes("Answer: ")) await turn.world.hold(turn.conversation)
        return "ok"
      },
    })
    const apex = await world.apex("claude", "full")
    const started = await world.agents.start(apex.caller, { brief: { objective: "Review" }, harness: "codex", name: "worker", clientKey: "worker", cwd: world.root })
    assert.ok(!("refused" in started) && started.conversation && started.child)
    const fin = started.conversation!
    const child = started.child!
    await until("the Fin's first turn", () => world.agents.roster(apex.conversation).some((each) => each.child?.state?.kind === "ended"))
    await world.agents.report(world.caller(fin), { ...MERGE, question: "Merge first?", clientKey: "first" })
    assert.ok(!("refused" in await world.agents.answer(apex.caller, { to: "worker", answer: "Merge", clientKey: "merge" })))
    await until("the answer to reach the Fin", () => world.prompts.some((prompt) => prompt.conversation === fin && prompt.text.includes("Answer: Merge")))
    const kept = world.store.latestAnswers().get(child)
    assert.ok(kept?.delivered)
    frozen = kept.at
    assert.ok(!("refused" in await world.agents.report(world.caller(fin), { ...MERGE, question: "Merge second?", clientKey: "second" })))
    assert.equal(world.store.latestReports().get(child)?.at, kept.at, "the new question and the last answer share their millisecond")
    const read = async (store: ThreadStore) => {
      const cold = coldView(store)
      try {
        const listed = await cold.list(apex.caller, {})
        assert.ok("children" in listed)
        return listed.children.find((strip) => strip.name === "worker")?.state
      } finally {
        cold.dispose()
      }
    }
    const before = await read(world.store)
    assert.equal(before?.kind === "ended" && before.decision?.question, "Merge second?", `the new question is open: ${JSON.stringify(before)}`)
    await world.close()
    const reopened = new ThreadStore(join(world.root, "threads.sqlite"), { now: () => Date.now() })
    try {
      const after = await read(reopened)
      assert.equal(after?.kind === "ended" && after.decision?.question, "Merge second?", `and on the store a host starts on: ${JSON.stringify(after)}`)
      assert.equal(reopened.latestAnswers().get(child)?.ask, kept.ask, "while the first answer stays the first ask's")
    } finally {
      reopened.close()
    }
  }
  console.log("decision, same millisecond: a new question as old as the last answer was open on its host and on the store a restart reads")

  // Keeping an answer's delivery fails (a store gone read-only): the answer still reached the Fin, nothing rejects
  // unhandled, the claim stays pending, and the next start finds the delivery under its request and keeps it, sending nothing.
  {
    const unhandled: Error[] = []
    const onUnhandled = (error: Error) => void unhandled.push(error)
    process.on("unhandledRejection", onUnhandled)
    try {
      let answers: AgentsAnswerResult[] = []
      const { world, fin, state } = await fixture("decision-stamp", {
        access: "full", finHarness: "codex", later: new FakeClock().later,
        asks: async (world, conversation) => void await world.agents.report(world.caller(conversation), MERGE),
        onDecision: async (world, caller) => {
          world.store.markAnswerDelivered = () => {
            throw new Error("attempt to write a readonly database")
          }
          answers = [await world.agents.answer(caller, { to: "tests", answer: "Merge", clientKey: "merge" })]
        },
      })
      await until("the answer", () => answers.length === 1)
      assert.ok(!("refused" in answers[0]!), `it reached the Fin, so it's answered: ${JSON.stringify(answers[0])}`)
      await until("the Fin to go on", () => { const now = state(); return now?.kind === "ended" && !now.decision })
      await world.settle(600)
      assert.deepEqual(unhandled.map((error) => error.message), [], "nothing rejects unhandled")
      assert.equal(world.store.undeliveredAnswers().length, 1, "the claim stays pending, for the next start")
      await world.restart()
      await until("the next start to keep its delivery", () => world.store.undeliveredAnswers().length === 0)
      await world.settle(600)
      assert.equal(world.prompts.filter((prompt) => prompt.conversation === fin && /Answer: /.test(prompt.text)).length, 1, "and the Fin heard it once")
      await world.close()
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  }
  console.log("decision, stamp fails: the answer still reached the Fin, nothing rejected unhandled, and the next start kept its delivery without sending it again")

  // What it waits on, how long it's idle and its open pull requests: on its strip, its crew mates' view and the front door.
  {
    const held = [{ number: 371, url: "https://git.example.com/acme/app/pull/371", state: "open" as const }, { number: 360, url: "https://git.example.com/acme/app/pull/360", state: "merged" as const }]
    const asked: { repoRoot: string; branch: string }[] = []
    const { world, apex, thread, state } = await fixture("facts", {
      access: "full", finHarness: "codex", later: new FakeClock().later,
      heldPulls: (repoRoot, branch) => (asked.push({ repoRoot, branch }), branch === "fix/swipe" ? held : []),
      asks: async (world, conversation) => void await world.agents.report(world.caller(conversation), {
        ...MERGE, decides: "person",
        artifacts: [...MERGE.artifacts, { kind: "pull-request", ref: "https://git.example.com/acme/app/pull/365" }],
        waitingOn: [{ kind: "pull-request", ref: "#412", until: "checks" }, { kind: "person", what: "merge" }],
      }),
    })
    await until("the decision", () => { const now = state(); return now?.kind === "ended" && now.decision !== undefined })
    world.store.attachWorktree({ path: join(world.root, "wt"), thread: ThreadIdSchema.parse(thread()), repoRoot: "/repo", project: "/repo", branch: "fix/swipe", base: "abc" })
    const listed = await world.agents.list(apex.caller, {})
    assert.ok("children" in listed)
    const strip = listed.children.find((child) => child.name === "tests")!
    assert.equal(strip.waiting, "waiting on #412 checks, the person to merge", "the strip says what it waits on")
    assert.deepEqual(strip.state.kind === "ended" && strip.state.waitingOn, [{ kind: "pull-request", ref: "#412", number: 412, until: "checks" }, { kind: "person", what: "merge" }], "its state carries them typed, the number read from the ref")
    assert.ok(Number.isInteger(strip.idleFor) && strip.idleFor! >= 0, "a finished Fin says how long it's been idle")
    assert.deepEqual(strip.openPRs, [{ repository: "acme/app", number: 371, url: "https://git.example.com/acme/app/pull/371", state: "open" }, { repository: "acme/app", number: 365, url: "https://git.example.com/acme/app/pull/365", state: "reported" }], "its branch's open one as last read, and the one only its report names")
    assert.deepEqual(asked.at(-1), { repoRoot: "/repo", branch: "fix/swipe" }, "read from its own worktree's branch")
    const sibling = await world.agents.start(apex.caller, { brief: { objective: "Write the docs" }, harness: "claude", name: "docs", clientKey: "docs", cwd: world.root })
    assert.ok(!("refused" in sibling) && sibling.conversation)
    const crew = await world.agents.list(world.caller(sibling.conversation!), { scope: "crew" })
    assert.ok("crew" in crew)
    const mate = crew.crew.find((each) => each.name === "tests")!
    assert.ok(Number.isInteger(mate.idleFor))
    assert.equal(mate.openPRs?.length, 2, "its crew mates read them too")
    const note = world.agents.frontDoor(apex.conversation, {}).join("\n")
    assert.match(note, /- fin:tests · Codex · done; the person decides: Merge #371\? \(Merge · Leave open, recommends Merge\) · waiting on #412 checks, the person to merge · asked:/)
    assert.doesNotMatch(note, /idleFor|openPRs/, "the front door stays short")
    await world.close()
  }
  console.log("facts: waitingOn on the strip and the front door, idleFor and openPRs on the strip and the crew, from held facts only")
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("orch answer: ok")
