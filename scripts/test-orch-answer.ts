import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AccessTier } from "@mako/host/contracts/access"
import type { AgentsAnswerInput, AgentsAnswerResult } from "@mako/host/contracts/agent-tools"
import type { AgentCaller, ChildState } from "@mako/host/contracts/agents"
import { YOUR_APEX } from "@mako/host/contracts/children"
import type { LivePermissionResponse } from "@mako/host/contracts/providers-acp"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { FROM_AGENTS, fromAgent } from "@mako/host/conversations/agent-wakes"
import { finAsking } from "@mako/host/conversations/session-report"
import { AgentsWorld, HARNESSES, type Script, type ScriptedTurn } from "./lib/agents-world.ts"

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
 * person instead, and a repeat of an answer answers once.
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
  apexAnswerMs?: number
}): Promise<Fixture> {
  const heard: LivePermissionResponse[] = []
  const wakes: string[] = []
  let finConversation = ""
  let firstTurn = true
  const script: Script = async (turn) => {
    if (turn.conversation === finConversation) {
      if (!firstTurn) return "Done with the answer."
      firstTurn = false
      await options.asks(turn.world, turn.conversation, heard)
      return "Done."
    }
    if (!turn.text.startsWith(FROM_AGENTS)) return options.apexTurn?.(turn) ?? "ok"
    wakes.push(turn.text)
    if (DECISION.test(turn.text)) await options.onDecision?.(turn.world, turn.caller, turn.text)
    return "ok"
  }
  const world = new AgentsWorld({ root: join(root, name), script, ...(options.apexAnswerMs !== undefined && { apexAnswerMs: options.apexAnswerMs }) })
  const apex = await world.apex(options.harness ?? "claude", options.access)
  const started = await world.agents.start(apex.caller, { brief: { objective: "Run the tests" }, harness: options.finHarness, name: "tests", clientKey: "tests", cwd: world.root })
  assert.ok(!("refused" in started) && started.conversation)
  finConversation = started.conversation!
  const entry = () => world.agents.roster(apex.conversation).find((each) => each.child?.name === "tests")?.child
  return { world, apex, fin: finConversation, thread: () => entry()!.thread, state: () => entry()?.state, heard, wakes }
}

const approve = (world: AgentsWorld, fin: string, heard: LivePermissionResponse[]) => world.ask(fin, "npm test").then((response) => void heard.push(response))

try {
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
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("orch answer: ok")
