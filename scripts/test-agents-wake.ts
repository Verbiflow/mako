import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { AFTER_START, AGENT_TOOLS, WAIT_LIMIT_MS, type AgentsStarted, type AgentsStartInput, type AgentsStartResult } from "@mako/host/contracts/agent-tools"
import { childState, ReportSchema, ReportStatusSchema, reportRoute, StartModeSchema, ThreadParentSchema, WakeOnSchema, type ReportStatus, type StartMode, type WakeOn } from "@mako/host/contracts/agents"
import { SessionIdSchema } from "@mako/host/contracts/thread-identity"
import { agentToolSchema } from "@mako/host/conversations/agent-tools"
import { FROM_AGENTS, WAKE_COALESCE_MS } from "@mako/host/conversations/agent-wakes"
import { AgentsWorld, HARNESSES, type Script } from "./lib/agents-world.ts"

/**
 * How a lead hears back from its children (`npm run test:agents-wake`): each
 * start's mode (`background`, `wait`) and wake setting (`decisions`,
 * `finish`, `never`), on the real store, `LiveConversations` and `Agents`
 * with every harness a scripted model. A burst is one wake; `finish` and
 * `never` send questions to the person and never drop them; a `wait` answers
 * its result or a question within its window, and past it the result starts
 * the lead's next turn, settled-only, on all six harnesses, across a restart,
 * and once only when the start is repeated.
 */
const root = mkdtempSync(join(tmpdir(), "mako-agents-wake-"))

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await delay(10)
  }
}

function world(name: string, script: Script): AgentsWorld {
  return new AgentsWorld({ root: join(root, name), script })
}

function wakesOf(w: AgentsWorld, conversation: string) {
  return w.prompts.filter((prompt) => prompt.conversation === conversation && prompt.text.startsWith(FROM_AGENTS))
}

function started(answer: AgentsStartResult | undefined): AgentsStarted {
  assert.ok(answer && !("refused" in answer), JSON.stringify(answer))
  return answer
}

const RESULT = "There are 12 files.\nsrc holds 9 and test holds 3.\nNothing else is tracked."

/** Where each report goes, for every mode and wake setting, and whose a question reads as. */
function routes(): void {
  const table = {
    "background decisions": { done: "lead", failed: "lead", blocked: "lead", "needs-input": "lead", progress: "none" },
    "background finish": { done: "lead", failed: "lead", blocked: "person", "needs-input": "person", progress: "none" },
    "background never": { done: "none", failed: "none", blocked: "person", "needs-input": "person", progress: "none" },
    "wait decisions": { done: "lead", failed: "lead", blocked: "lead", "needs-input": "lead", progress: "none" },
    "wait finish": { done: "lead", failed: "lead", blocked: "person", "needs-input": "person", progress: "none" },
    "wait never": { done: "lead", failed: "lead", blocked: "person", "needs-input": "person", progress: "none" },
  } satisfies Record<`${StartMode} ${WakeOn}`, Record<ReportStatus, ReturnType<typeof reportRoute>>>
  for (const mode of StartModeSchema.options)
    for (const wake of WakeOnSchema.options)
      for (const status of ReportStatusSchema.options) assert.equal(reportRoute({ mode, wake }, status), table[`${mode} ${wake}`][status], `${mode} ${wake} ${status}`)
  assert.equal(reportRoute({}, "needs-input"), "lead", "absent means background and decisions")
  const lead = SessionIdSchema.parse(randomUUID())
  const edge = (wake?: WakeOn) => ThreadParentSchema.parse({
    child: randomUUID(), parent: randomUUID(), parentSession: lead, name: "c", role: "worker", origin: "started",
    asked: { brief: { objective: "x" }, ...(wake && { wake }) }, op: "start:c", startedBy: { kind: "agent", session: lead }, createdAt: 1,
  })
  const asking = { latest: ReportSchema.parse({ id: "r", child: randomUUID(), status: "needs-input", summary: "Which?", question: "Main or next?", ownerGeneration: 1, at: 1 }) }
  assert.deepEqual(childState(edge(), { source: "live" }, asking), { kind: "blocked", question: "Main or next?", on: "lead" })
  assert.deepEqual(childState(edge("finish"), { source: "live" }, asking), { kind: "blocked", question: "Main or next?", on: "person" }, "a question its lead won't hear is the person's")
  assert.deepEqual(childState(edge("never"), { source: "live" }, asking), { kind: "blocked", question: "Main or next?", on: "person" })
}

/** The model sees both choices on every door, each said when to use. */
function described(): void {
  const start = AGENT_TOOLS.find((tool) => tool.verb === "start")!
  const { properties } = z.looseObject({
    properties: z.record(z.string(), z.looseObject({ anyOf: z.array(z.looseObject({ const: z.string() })).optional(), description: z.string().optional() })),
  }).parse(agentToolSchema(start).toJSONSchema())
  const values = (field: string) => properties[field]?.anyOf?.map((choice) => choice.const).sort()
  assert.deepEqual(values("mode"), ["background", "wait"])
  assert.deepEqual(values("wake"), ["decisions", "finish", "never"])
  for (const field of ["mode", "wake", "timeoutMs"]) assert.equal(properties[field]?.description, start.mcp.fields[field], `${field} is described to the model`)
  assert.match(start.mcp.description, /mode wait only when your next step can't go on without its result/)
  assert.match(start.mcp.fields.mode!, /Never wait on work that can run while you do other things/)
  assert.match(start.mcp.fields.wake!, /questions go to the person/)
  assert.match(start.mcp.description, new RegExp(`${WAIT_LIMIT_MS / 1000} seconds`))
}

/** Five children finishing within a second wake their idle lead once, with all five. */
async function burst(): Promise<void> {
  const w = world("burst", async (turn) => {
    if (!turn.text.includes("child:")) return "ok"
    await delay(Math.random() * 800)
    return `Done: ${turn.harness} checked its part.`
  })
  try {
    const lead = await w.lead("codex")
    for (const [i, harness] of HARNESSES.slice(1).entries())
      started(await w.agents.start(lead.caller, { brief: { objective: `Check part ${i}` }, harness, name: `part-${i}`, clientKey: `p${i}`, cwd: w.root }))
    await w.settle()
    const wakes = wakesOf(w, lead.conversation)
    assert.equal(wakes.length, 1, "one wake for the burst")
    assert.match(wakes[0]!.text, /5 finished:/)
    assert.equal(w.store.undeliveredReports().length, 0)
  } finally {
    await w.close()
  }
}

/** `finish`: a question goes to the person, never to the lead; once the person answers, the result wakes the lead. */
async function finishOnly(): Promise<void> {
  const children = new Set<string>()
  const w = world("finish", async (turn) => {
    if (turn.text.includes("child:")) {
      children.add(turn.conversation)
      const told = await turn.world.agents.report(turn.caller, { status: "needs-input", summary: "The branch isn't named.", question: "Main or next?", clientKey: "q" })
      assert.ok(!("refused" in told), JSON.stringify(told))
      return "I asked."
    }
    return children.has(turn.conversation) ? "Merged it into main." : "ok"
  })
  try {
    const lead = await w.lead("claude")
    const answer = started(await w.agents.start(lead.caller, { brief: { objective: "Merge the fix" }, harness: "codex", wake: "finish", clientKey: "m", cwd: w.root }))
    assert.match(answer.next, /its questions go to the person/)
    await w.settle()
    assert.equal(wakesOf(w, lead.conversation).length, 0, "the question didn't wake the lead")
    const listed = await w.agents.list(lead.caller, {})
    assert.ok("children" in listed)
    assert.deepEqual(listed.children[0]!.state, { kind: "blocked", question: "Main or next?", on: "person" }, "it's the person's to answer")
    assert.equal(w.store.edges().of(answer.child!)!.asked.wake, "finish", "the edge keeps what was asked")
    w.say(answer.conversation!, "Main.")
    await w.settle()
    const wakes = wakesOf(w, lead.conversation)
    assert.equal(wakes.length, 1, "its result wakes the lead")
    assert.match(wakes[0]!.text, /1 finished:\n {2}• "[^"]+" \(Codex\) done: Merged it into main\./)
    assert.doesNotMatch(wakes[0]!.text, /needs a decision/)
  } finally {
    await w.close()
  }
}

/** `never`: nothing wakes the lead, across a restart too; its report is there to read, and a question is the person's. */
async function never(): Promise<void> {
  const w = world("never", async (turn) => {
    if (!turn.text.includes("child:")) return "ok"
    if (turn.text.includes("Ask")) {
      await turn.world.agents.report(turn.caller, { status: "blocked", summary: "No key.", question: "Which signing key?", clientKey: "q" })
      return "Blocked."
    }
    return "Indexed 4,000 symbols."
  })
  try {
    const lead = await w.lead("opencode")
    const quiet = started(await w.agents.start(lead.caller, { brief: { objective: "Index the repo" }, harness: "grok", name: "index", wake: "never", clientKey: "i", cwd: w.root }))
    assert.match(quiet.next, /Nothing it reports wakes you/)
    started(await w.agents.start(lead.caller, { brief: { objective: "Ask about the key" }, harness: "devin", name: "sign", wake: "never", clientKey: "s", cwd: w.root }))
    await w.settle()
    assert.equal(wakesOf(w, lead.conversation).length, 0)
    assert.equal(w.store.undeliveredReports().length, 0, "nothing waits to wake it later")
    const read = await w.agents.read(lead.caller, { child: "index" })
    assert.ok("text" in read && /Indexed 4,000 symbols/.test(read.text), "the lead reads it when it wants")
    const listed = await w.agents.list(lead.caller, {})
    assert.ok("children" in listed)
    assert.deepEqual(listed.children.find((strip) => strip.name === "sign")!.state, { kind: "blocked", question: "Which signing key?", on: "person" }, "the question reaches the person")
    await w.restart()
    await w.settle()
    assert.equal(wakesOf(w, lead.conversation).length, 0, "a restart doesn't wake it either")
  } finally {
    await w.close()
  }
}

/** A lead whose turn starts a child with `mode: "wait"`: `go` starts it, and the script keeps the answer. */
function waitingLead(input: Omit<AgentsStartInput, "cwd" | "clientKey"> & { clientKey?: string }, child: Script, after?: (turn: Parameters<Script>[0]) => Promise<void>) {
  const answers: AgentsStartResult[] = []
  const script: Script = async (turn) => {
    if (turn.text === "go") {
      answers.push(await turn.world.agents.start(turn.caller, { clientKey: "w", ...input, cwd: turn.world.root }))
      await after?.(turn)
      return "Noted."
    }
    if (turn.text.startsWith(FROM_AGENTS)) return "Going on."
    return child(turn)
  }
  return { answers, script }
}

/** The result comes within the window: the start answers it in full, and no wake follows. */
async function waitSettles(): Promise<void> {
  const { answers, script } = waitingLead({ brief: { objective: "Count the files" }, harness: "codex", mode: "wait" }, async (turn) => {
    if (!turn.text.includes("child:")) return "ok"
    await delay(300)
    await turn.world.agents.report(turn.caller, { status: "done", summary: RESULT, artifacts: [{ kind: "file", ref: "counts.txt" }], clientKey: "r" })
    return "Reported."
  })
  const w = world("wait-settles", script)
  try {
    const lead = await w.lead("claude")
    const began = Date.now()
    w.say(lead.conversation, "go")
    await until("the answer", () => answers.length === 1)
    const answer = started(answers[0])
    assert.ok(Date.now() - began < 3_000, "it answered as the result came")
    assert.deepEqual(answer.waited, { outcome: "result", report: { status: "done", summary: RESULT, artifacts: [{ kind: "file", ref: "counts.txt" }] } }, "the whole report, not its first line")
    assert.match(answer.next, /its report is above/)
    await w.settle()
    assert.equal(wakesOf(w, lead.conversation).length, 0, "the lead heard it in the answer, so nothing wakes it")
    assert.equal(w.store.undeliveredReports().length, 0)
  } finally {
    await w.close()
  }
}

/** A question ends the wait at once, its words in the answer; once answered, the result is the lead's next turn. */
async function waitAsks(wake: "decisions" | "finish"): Promise<void> {
  const children = new Set<string>()
  let asked = 0
  const { answers, script } = waitingLead({ brief: { objective: "Merge the fix" }, harness: "cursor", mode: "wait", wake }, async (turn) => {
    if (turn.text.includes("child:")) {
      children.add(turn.conversation)
      await delay(150)
      asked = Date.now()
      await turn.world.agents.report(turn.caller, { status: "needs-input", summary: "The branch isn't named.", question: "Main or next?", clientKey: "q" })
      return "I asked."
    }
    return children.has(turn.conversation) ? "Merged into main. CI is green." : "ok"
  })
  const w = world(`wait-asks-${wake}`, script)
  try {
    const lead = await w.lead("codex")
    w.say(lead.conversation, "go")
    await until("the answer", () => answers.length === 1)
    const answer = started(answers[0])
    assert.ok(Date.now() - asked < 500, `the question ended the wait at once (${Date.now() - asked} ms)`)
    assert.equal(answer.waited?.outcome, "question")
    assert.ok(answer.waited?.outcome === "question")
    assert.equal(answer.waited.question, "Main or next?")
    assert.equal(answer.waited.answers, wake === "decisions" ? "you" : "the person")
    await w.settle()
    assert.equal(wakesOf(w, lead.conversation).length, 0, "the question was told in the answer, once")
    w.say(answer.conversation!, "Main.")
    await w.settle()
    const wakes = wakesOf(w, lead.conversation)
    assert.equal(wakes.length, 1)
    assert.match(wakes[0]!.text, /^\[mako · from your agents, not the person\]\nThe result you waited for:\n {2}• "[^"]+" \(Cursor\) done:\n {4}Merged into main\. CI is green\./)
  } finally {
    await w.close()
  }
}

/** The window ends first: the answer says the turn ends, and the result starts the lead's next turn, in full, soon after it comes. */
async function waitTimesOut(): Promise<void> {
  let reported = 0
  const { answers, script } = waitingLead({ brief: { objective: "Count the files" }, harness: "grok", mode: "wait", timeoutMs: 300 }, async (turn) => {
    if (!turn.text.includes("child:")) return "ok"
    await turn.world.hold(turn.conversation)
    reported = Date.now()
    await turn.world.agents.report(turn.caller, { status: "done", summary: RESULT, clientKey: "r" })
    return "Reported."
  })
  const w = world("wait-times-out", script)
  try {
    const lead = await w.lead("devin")
    const began = Date.now()
    w.say(lead.conversation, "go")
    await until("the answer", () => answers.length === 1)
    const answer = started(answers[0])
    assert.ok(Date.now() - began < 1_500, "the window held 300 ms, not the limit")
    assert.deepEqual(answer.waited, { outcome: "pending" })
    assert.match(answer.next, /End your turn now: its result starts your next turn/)
    assert.equal(w.live.session(answer.conversation!)?.status, "running", "a timeout never stops the child")
    await until("the lead's turn to end", () => w.live.session(lead.conversation)?.status === "ready")
    w.release(answer.conversation!)
    await until("the wake", () => wakesOf(w, lead.conversation).length === 1)
    const wake = wakesOf(w, lead.conversation)[0]!
    assert.ok(wake.at - reported < 1_000, `the result started the next turn ${wake.at - reported} ms after it came`)
    assert.match(wake.text, /The result you waited for:\n {2}• "[^"]+" \(Grok\) done:\n {4}There are 12 files\.\n {4}src holds 9 and test holds 3\.\n {4}Nothing else is tracked\./)
    await w.settle()
    assert.equal(wakesOf(w, lead.conversation).length, 1)
  } finally {
    await w.close()
  }
}

/** A lead still at work on a step-steer harness: the result it waited for is never steered in; a background child's report is. */
/** A busy lead whose harness refuses the steer: the report isn't lost, it starts the lead's next turn. */
async function refusedSteer(): Promise<void> {
  let child = ""
  const w = new AgentsWorld({ root: join(root, "refused-steer"), refuseSteers: true, script: async (turn) => {
    if (turn.text === "go") {
      started(await turn.world.agents.start(turn.caller, { brief: { objective: "Run lint" }, harness: "codex", name: "lint", clientKey: "l", cwd: turn.world.root }))
      await turn.world.hold(turn.conversation)
      return "Noted."
    }
    if (turn.text.startsWith(FROM_AGENTS)) return "Going on."
    child = turn.conversation
    return "Lint is clean."
  } })
  try {
    const lead = await w.lead("claude")
    w.say(lead.conversation, "go")
    await until("the child's report", () => child !== "" && w.store.reportsOf(w.store.edges().all[0]!.child, 0).length === 1)
    await delay(WAKE_COALESCE_MS + 500)
    assert.equal(wakesOf(w, lead.conversation).length, 0, "no turn starts while the lead's runs")
    assert.equal(w.agents.wakes.pending(), 1, "the refused digest still waits")
    w.release(lead.conversation)
    await until("the next turn", () => wakesOf(w, lead.conversation).length === 1)
    assert.match(wakesOf(w, lead.conversation)[0]!.text, /"lint" \(Codex\) done: Lint is clean\./)
    await w.settle()
    assert.equal(w.store.undeliveredReports().length, 0)
  } finally {
    await w.close()
  }
}

async function waitNeverSteers(): Promise<void> {
  const kids = new Map<string, string>()
  const { answers, script } = waitingLead({ brief: { objective: "Count the files" }, harness: "codex", name: "count", mode: "wait", timeoutMs: 200 }, async (turn) => {
    if (!turn.text.includes("child:")) return "ok"
    kids.set(turn.text.includes("child:count") ? "count" : "lint", turn.conversation)
    await turn.world.hold(turn.conversation)
    return turn.text.includes("child:count") ? RESULT : "Lint is clean."
  }, async (turn) => {
    started(await turn.world.agents.start(turn.caller, { brief: { objective: "Run lint" }, harness: "codex", name: "lint", clientKey: "l", cwd: turn.world.root }))
    await turn.world.hold(turn.conversation)
  })
  const w = world("wait-never-steers", script)
  try {
    const lead = await w.lead("claude")
    w.say(lead.conversation, "go")
    await until("both children", () => answers.length === 1 && kids.size === 2)
    w.release(kids.get("count")!)
    w.release(kids.get("lint")!)
    await until("the background report's steer", () => w.steers.length === 1, 6_000)
    assert.match(w.steers[0]!.text, /1 finished:\n {2}• "lint" \(Codex\) done: Lint is clean\./)
    assert.doesNotMatch(w.steers[0]!.text, /waited for/, "the waited-for result isn't steered into the running turn")
    await delay(500)
    assert.equal(wakesOf(w, lead.conversation).length, 0, "and doesn't start a turn while one runs")
    w.release(lead.conversation)
    await until("the next turn", () => wakesOf(w, lead.conversation).length === 1)
    assert.match(wakesOf(w, lead.conversation)[0]!.text, /The result you waited for:\n {2}• "count" \(Codex\) done:\n {4}There are 12 files\./)
    await w.settle()
    assert.equal(w.steers.length, 1)
    assert.equal(wakesOf(w, lead.conversation).length, 1)
  } finally {
    await w.close()
  }
}

/** An approval the person answers (the lead isn't on full access) ends the wait too, and says it's the person's. */
async function waitOnApproval(): Promise<void> {
  const { answers, script } = waitingLead({ brief: { objective: "Install the deps" }, harness: "codex", mode: "wait" }, async (turn) => {
    if (!turn.text.includes("child:")) return "ok"
    await delay(100)
    turn.world.live.observe({ type: "live-permission", request: { id: "npm-ci", observationId: "npm-ci-1", sessionId: turn.conversation, title: "Run npm ci", options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] } })
    await turn.world.hold(turn.conversation)
    return "Installed."
  })
  const w = world("wait-approval", script)
  try {
    const lead = await w.lead("opencode", "auto")
    const began = Date.now()
    w.say(lead.conversation, "go")
    await until("the answer", () => answers.length === 1)
    const answer = started(answers[0])
    assert.ok(Date.now() - began < 3_000)
    assert.ok(answer.waited?.outcome === "question", JSON.stringify(answer.waited))
    assert.equal(answer.waited.answers, "the person")
    assert.match(answer.waited.question, /npm ci/)
    assert.match(answer.next, /asks the person/)
    w.release(answer.conversation!)
  } finally {
    await w.close()
  }
}

/** Every harness as the lead: past the window, the result starts its next turn, and no steer carries it. */
async function sixHarnesses(): Promise<void> {
  for (const harness of HARNESSES) {
    const { answers, script } = waitingLead({ brief: { objective: "Count the files" }, harness: HARNESSES[(HARNESSES.indexOf(harness) + 1) % HARNESSES.length], mode: "wait", timeoutMs: 100 }, async (turn) => {
      if (!turn.text.includes("child:")) return "ok"
      await delay(400)
      return RESULT
    })
    const w = world(`six-${harness}`, script)
    try {
      const lead = await w.lead(harness)
      w.say(lead.conversation, "go")
      await until(`${harness}'s answer`, () => answers.length === 1)
      assert.deepEqual(started(answers[0]).waited, { outcome: "pending" })
      await until(`${harness}'s next turn`, () => wakesOf(w, lead.conversation).length === 1)
      assert.match(wakesOf(w, lead.conversation)[0]!.text, /The result you waited for:[\s\S]*There are 12 files\.\n {4}src holds 9/, harness)
      await w.settle()
      assert.equal(wakesOf(w, lead.conversation).length, 1, harness)
      assert.equal(w.steers.length, 0, harness)
    } finally {
      await w.close()
    }
  }
}

/** The host restarts while the lead's turn waits: the lead still hears the child's result, once. */
async function waitAcrossRestart(): Promise<void> {
  let host = 1
  let child = ""
  const { answers, script } = waitingLead({ brief: { objective: "Count the files" }, harness: "codex", mode: "wait" }, async (turn) => {
    if (turn.conversation !== child && !turn.text.includes("child:")) return "ok"
    child = turn.conversation
    if (host === 1) await turn.world.hold(turn.conversation)
    return RESULT
  })
  const w = world("wait-restart", script)
  try {
    const lead = await w.lead("claude")
    w.say(lead.conversation, "go")
    await until("the child's turn", () => child !== "" && w.live.session(child)?.status === "running")
    host = 2
    await w.restart()
    await w.settle(2_600, 30_000)
    const inline = answers.filter((answer) => !("refused" in answer) && answer.waited?.outcome === "result").length
    const woken = wakesOf(w, lead.conversation).filter((wake) => /There are 12 files/.test(wake.text)).length
    assert.equal(inline + woken, 1, `the lead heard the result once (inline ${inline}, woken ${woken})`)
    assert.equal(w.store.undeliveredReports().length, 0)
  } finally {
    await w.close()
  }
}

/** A start repeated with its key after the result came (a resumed run calls again): the result again, and no wake for it. */
async function repeatAnswersAgain(): Promise<void> {
  let child = ""
  const { answers, script } = waitingLead({ brief: { objective: "Count the files" }, harness: "codex", mode: "wait", timeoutMs: 100 }, async (turn) => {
    if (!turn.text.includes("child:")) return "ok"
    child = turn.conversation
    await turn.world.hold(turn.conversation)
    return RESULT
  }, async (turn) => {
    await until("the child", () => child !== "")
    turn.world.release(child)
    await until("its report", () => turn.world.store.reportsOf(turn.world.store.edges().all[0]!.child, 0).length === 1)
    answers.push(await turn.world.agents.start(turn.caller, { brief: { objective: "Count the files" }, harness: "codex", mode: "wait", clientKey: "w", cwd: turn.world.root }))
  })
  const w = world("wait-repeat", script)
  try {
    const lead = await w.lead("cursor")
    w.say(lead.conversation, "go")
    await w.settle()
    assert.equal(answers.length, 2)
    assert.deepEqual(started(answers[0]).waited, { outcome: "pending" })
    const again = started(answers[1])
    assert.ok(again.deduped)
    assert.equal(again.waited?.outcome, "result")
    assert.equal(wakesOf(w, lead.conversation).length, 0, "the repeat's answer carried it, so it doesn't wake the lead too")
  } finally {
    await w.close()
  }
}

/** A background start answers at once, as before. */
async function backgroundAnswersAtOnce(): Promise<void> {
  const w = world("background", (turn) => turn.text.includes("child:") ? turn.world.hold(turn.conversation).then(() => "ok") : "ok")
  try {
    const lead = await w.lead("codex")
    const began = Date.now()
    const answer = started(await w.agents.start(lead.caller, { brief: { objective: "Hold" }, harness: "claude", clientKey: "b", cwd: w.root }))
    assert.ok(Date.now() - began < 1_000)
    assert.equal(answer.waited, undefined)
    assert.equal(answer.next, AFTER_START)
    w.release(answer.conversation!)
  } finally {
    await w.close()
  }
}

try {
  routes()
  described()
  await backgroundAnswersAtOnce()
  await burst()
  await finishOnly()
  await never()
  await waitSettles()
  await waitAsks("decisions")
  await waitAsks("finish")
  await waitTimesOut()
  await waitNeverSteers()
  await refusedSteer()
  await waitOnApproval()
  await sixHarnesses()
  await waitAcrossRestart()
  await repeatAnswersAgain()
  console.log("agents wake: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
