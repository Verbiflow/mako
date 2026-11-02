import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FinAsk, NativeAgent } from "@mako/host/contracts/native-agents"
import { conversationShown, finAsking } from "@mako/host/conversations/session-report"
import { AgentsWorld, HARNESSES } from "./lib/agents-world.ts"

/*
 * What a Fin's ask to the person costs on the host (`npm run bench:orch-ask`), on each of the six scripted harnesses.
 * Approvals of an Apex on Ask are the person's the moment the harness asks; a question in a Fin's report is the
 * person's once its Apex leaves it to them (`agents_answer person: true`), called here as the Apex would, its wake's
 * pacing and its model's turn left out. Each is timed
 * from that moment to the Apex's batch carrying the ask (what every window draws it from) and its row saying it
 * (what the account's lists and the push read: the row goes on the next turn of the event loop after the batch,
 * `SessionPublisher.showsChanged`); the person's answer (`mako:agents-respond`) to the Fin's harness being handed it;
 * and the answer to the last batch with nothing left to answer, which must be under CLEARED_MS.
 */
const SAMPLES = 30
const CLEARED_MS = 2_000
const BUDGET = { askToBatchP95Ms: 300, askToRowP95Ms: 300, answerToHarnessP95Ms: 300 }

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}
const summary = (values: number[]) => ({ p50: percentile(values, 50), p95: percentile(values, 95), max: Math.max(...values) })

async function until<T>(what: string, found: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = found()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

/** The first batch of `conversation` from `from` on whose roster `holds` is true, and when it went out. */
function batchAfter(world: AgentsWorld, conversation: string, from: number, holds: (agents: readonly NativeAgent[]) => boolean): number | undefined {
  for (let index = from; index < world.events.length; index += 1) {
    const event = world.events[index]!
    if (event.type !== "live-batch" || event.batch.id !== conversation || !event.batch.nativeAgents) continue
    if (holds(event.batch.nativeAgents.agents)) return world.eventAt[index]!
  }
  return undefined
}

/** The ask of this Fin that's the person's, if it has one. */
function personsAsk(agent: NativeAgent): FinAsk | undefined {
  const state = agent.child?.state
  return state?.kind === "blocked" && state.on !== "lead" ? state.ask : undefined
}
const personAsked = (agents: readonly NativeAgent[], thread: string) => agents.some((agent) => agent.child?.thread === thread && personsAsk(agent) !== undefined)
const nothingAsked = (agents: readonly NativeAgent[]) => !agents.some((agent) => personsAsk(agent) !== undefined)

const root = mkdtempSync(join(tmpdir(), "mako-orch-ask-"))
interface Times {
  batch: number[]
  row: number[]
  answer: number[]
  cleared: number[]
}
const times = (): Times => ({ batch: [], row: [], answer: [], cleared: [] })
const timing = { approval: times(), question: times() }
const askedAt = new Map<string, number>()
const fins = new Map<string, string>()

async function run(kind: "approval" | "question"): Promise<void> {
  const world = new AgentsWorld({
    root: join(root, kind),
    script: async (turn) => {
      const sample = /^ask (\d+)$/.exec(turn.text)?.[1]
      if (fins.has(turn.conversation) && sample) {
        if (kind === "approval") {
          askedAt.set(sample, Date.now())
          await turn.world.ask(turn.conversation, `npm test --shard ${sample}`)
        } else {
          await turn.world.agents.report(turn.world.caller(turn.conversation), { status: "needs-input", summary: `Shard ${sample} is ambiguous.`, question: `Which suite runs shard ${sample}?`, options: [{ label: "unit" }, { label: "e2e" }], recommended: 0, clientKey: `q-${sample}` })
        }
        return "Done."
      }
      return "ok"
    },
  })
  try {
    const apex = await world.apex("claude", kind === "approval" ? "ask" : "full")
    const threads: string[] = []
    const conversations: string[] = []
    for (const [index, harness] of HARNESSES.entries()) {
      const name = `fin-${index}`
      const started = await world.agents.start(apex.caller, { brief: { objective: `Run shard ${index}.` }, harness, name, clientKey: name, cwd: world.root })
      assert.ok(!("refused" in started) && started.conversation && started.child, JSON.stringify(started))
      fins.set(started.conversation!, name)
      conversations.push(started.conversation!)
      threads.push(started.child!)
    }
    await world.settle(600, 60_000)
    for (let i = 0; i < SAMPLES; i += 1) {
      const index = i % HARNESSES.length
      const fin = conversations[index]!
      const thread = threads[index]!
      const sample = String(i)
      const from = world.events.length
      world.say(fin, `ask ${sample}`)
      if (kind === "question") {
        // As its Apex leaves it to the person, past the wake's pacing and the model's turn.
        await until(`sample ${i}'s question to its Apex`, () => { const state = world.agents.roster(apex.conversation).find((agent) => agent.child?.thread === thread)?.child?.state; return state?.kind === "blocked" && state.ask?.id.endsWith(`q-${sample}`) ? true : undefined })
        askedAt.set(sample, Date.now())
        const passed = await world.agents.answer(apex.caller, { to: thread, person: true, clientKey: randomUUID() })
        assert.ok(!("refused" in passed), JSON.stringify(passed))
      }
      const asked = await until(`sample ${i}'s ask`, () => askedAt.get(sample))
      const batched = await until(`sample ${i}'s ask on the Apex's batch`, () => batchAfter(world, apex.conversation, from, (agents) => personAsked(agents, thread)))
      const shown = conversationShown({ session: { id: apex.conversation, status: "ready" }, working: undefined, waitingOn: () => undefined, asking: (id) => finAsking(world.agents.personAsk(id)) })
      const rowAt = Date.now()
      assert.equal(shown.asking?.fin, thread, "the Apex's row says its Fin's ask")
      timing[kind].batch.push(batched - asked)
      timing[kind].row.push(Math.max(batched, rowAt) - asked)
      const ask = world.agents.personAsk(apex.conversation)!.ask
      const handedBefore = kind === "approval" ? world.answers.length : world.prompts.length
      const answerFrom = world.events.length
      const answeredAt = Date.now()
      const answered = await world.agents.respond(apex.conversation, { fin: thread, ask: ask.id, request: randomUUID(), ...(kind === "approval" ? { allow: true } : { option: 1 }) })
      assert.ok(!("refused" in answered), JSON.stringify(answered))
      const handed = await until(`sample ${i}'s answer at its harness`, () => kind === "approval" ? world.answers.slice(handedBefore).find((each) => each.conversation === fin)?.at : world.prompts.slice(handedBefore).find((each) => each.conversation === fin && each.text.includes("Answer: e2e"))?.at)
      timing[kind].answer.push(handed - answeredAt)
      const cleared = await until(`sample ${i}'s ask leaving the Apex's batch`, () => batchAfter(world, apex.conversation, answerFrom, nothingAsked), CLEARED_MS)
      timing[kind].cleared.push(cleared - answeredAt)
      assert.equal(world.agents.personAsk(apex.conversation), undefined, "nothing left on the Apex's row")
      await world.settle(200, 30_000, "ignore")
    }
  } finally {
    await world.close()
  }
}

try {
  await run("approval")
  await run("question")
  const result = {
    samples: SAMPLES,
    harnesses: HARNESSES,
    approval: { askToBatchMs: summary(timing.approval.batch), askToRowMs: summary(timing.approval.row), answerToHarnessMs: summary(timing.approval.answer), answerToClearedMs: summary(timing.approval.cleared) },
    question: { passedToBatchMs: summary(timing.question.batch), passedToRowMs: summary(timing.question.row), answerToHarnessMs: summary(timing.question.answer), answerToClearedMs: summary(timing.question.cleared) },
    budget: { ...BUDGET, clearedMs: CLEARED_MS },
  }
  console.log(JSON.stringify(result, null, 2))
  for (const kind of ["approval", "question"] as const) {
    const each = timing[kind]
    assert.ok(percentile(each.batch, 95) <= BUDGET.askToBatchP95Ms, `${kind}: to the Apex's batch p95 ${percentile(each.batch, 95)} ms`)
    assert.ok(percentile(each.row, 95) <= BUDGET.askToRowP95Ms, `${kind}: to the Apex's row p95 ${percentile(each.row, 95)} ms`)
    assert.ok(percentile(each.answer, 95) <= BUDGET.answerToHarnessP95Ms, `${kind}: answer to harness p95 ${percentile(each.answer, 95)} ms`)
  }
  console.log("bench orch-ask: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
