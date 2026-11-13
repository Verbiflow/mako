import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { ASK_EVERY_MS } from "@mako/host/contracts/children"
import { FROM_AGENTS, WAKES_PER_MINUTE } from "@mako/host/conversations/agent-wakes"
import { AgentsWorld, TESTED_HARNESSES } from "./lib/agents-world.ts"

/**
 * A digest holding a question doesn't wait for the minute's budget (`npm run test:wake-queue`), with each harness as
 * the Apex: an Apex's six digests of the minute are spent and its Fin asks. The Apex hears it within the burst's
 * window, before the person is asked, once. A question that joins a digest the budget holds takes that digest with it.
 * What carries no question still waits for its slot, and a storm of questions gathers rather than looping.
 */
const ASK = "Run the migration?"
const ANSWER_MS = 6_000
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, done: () => boolean, ms = 15_000): Promise<void> {
  const deadline = performance.now() + ms
  while (!done()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}

async function run(root: string, harness: string, held: boolean): Promise<void> {
  const fin = { conversation: "" }
  const world: AgentsWorld = new AgentsWorld({
    root,
    apexAnswerMs: ANSWER_MS,
    script: async (turn) => {
      if (turn.text.includes("You're fin:")) {
        fin.conversation = turn.conversation
        return turn.world.hold(turn.conversation).then(() => "Done.")
      }
      return "ok"
    },
  })
  const label = `${harness}${held ? ", joining a held digest" : ""}`
  try {
    const apex = await world.apex(harness, "full")
    const started = await world.agents.start(apex.caller, { brief: { objective: "Migrate" }, harness: "codex", name: "worker", clientKey: "worker", cwd: world.root })
    assert.ok(!("refused" in started), JSON.stringify(started))
    await until("the Fin's turn", () => world.live.session(fin.conversation)?.status === "running")
    const actor = { kind: "agent" as const, session: world.store.journalPlacement(apex.conversation)!.session }
    const report = { id: "", child: world.store.edges().all[0]!.child, status: "done" as const, summary: "Earlier.", ownerGeneration: 1, at: Date.now() }
    const digest = (index: number) => {
      const id = `report:${report.child}:earlier-${index}`
      world.live.submit(apex.conversation, randomUUID(), `${FROM_AGENTS}\nEarlier ${index}.`, [], undefined, undefined, undefined, actor, { digest: { notices: [{ id: `notice:${report.child}:${id}`, report: { ...report, id }, label: `"worker" (Codex)`, fin: { name: "worker" }, from: actor.session }] } })
    }
    const earlier = () => world.prompts.filter((prompt) => prompt.conversation === apex.conversation && prompt.text.includes("Earlier ")).length
    for (let index = 0; index < WAKES_PER_MINUTE; index += 1) {
      digest(index)
      await until(`digest ${index} to go`, () => earlier() === index + 1)
      await until(`its turn to end`, () => world.live.session(apex.conversation)?.status === "ready")
    }
    if (held) {
      digest(WAKES_PER_MINUTE)
      await until("the budget to hold the next", () => world.live.snapshot(apex.conversation)?.requests.some((request) => request.text.includes(`Earlier ${WAKES_PER_MINUTE}.`) && request.status === "held") === true)
    }

    const asked = performance.now()
    void world.ask(fin.conversation, ASK)
    const heard = () => world.prompts.filter((prompt) => prompt.conversation === apex.conversation && prompt.text.includes(ASK))
    await until(`${label}: its Apex to hear it`, () => heard().length > 0, ANSWER_MS - 500)
    assert.ok(performance.now() - asked < ANSWER_MS, `${label}: before the person would be asked`)
    await pause(300)
    assert.equal(heard().length, 1, `${label}: once`)
    if (held) assert.equal(heard()[0]!.text.includes(`worker`), true, label)
    if (!held) {
      // What carries no question still waits for the budget.
      digest(WAKES_PER_MINUTE)
      await pause(400)
      assert.equal(earlier(), WAKES_PER_MINUTE, `${label}: a digest with no question waits for its slot`)
    }
  } finally {
    for (const summary of world.live.summaries()) world.release(summary.session.id)
    await world.close()
  }
}

/**
 * A Fin that asks something new during each of its Apex's turns can't turn the budget's exception into a loop: past the
 * minute's digests, one that asks goes at most every `ASK_EVERY_MS`, and what's asked meanwhile joins it.
 */
async function storm(root: string, harness: string): Promise<void> {
  const fin = { conversation: "" }
  let holding = true
  const world: AgentsWorld = new AgentsWorld({
    root,
    script: async (turn) => {
      if (turn.text.includes("You're fin:")) {
        fin.conversation = turn.conversation
        return turn.world.hold(turn.conversation).then(() => "Done.")
      }
      return holding ? turn.world.hold(turn.conversation).then(() => "ok") : "ok"
    },
  })
  const realNow = Date.now
  try {
    const apex = await world.apex(harness, "full")
    const started = await world.agents.start(apex.caller, { brief: { objective: "Migrate" }, harness: "codex", name: "worker", clientKey: "worker", cwd: world.root })
    assert.ok(!("refused" in started), JSON.stringify(started))
    await until("the Fin's turn", () => fin.conversation !== "")
    world.say(apex.conversation, "Keep busy.")
    await until("the Apex's turn", () => world.prompts.some((prompt) => prompt.conversation === apex.conversation && prompt.text.includes("Keep busy.")))
    const words = (wave: number) => `Question ${wave} of the storm?`
    const heard = (wave: number) => world.prompts.some((prompt) => prompt.conversation === apex.conversation && prompt.text.includes(words(wave)))
    const ask = async (wave: number) => {
      const reported = await world.agents.report(world.caller(fin.conversation), { clientKey: `wave-${wave}`, status: "needs-input", summary: "A choice.", question: words(wave) })
      assert.ok(!("refused" in reported), JSON.stringify(reported))
    }
    // The minute's six go, each its own turn.
    for (let wave = 0; wave < WAKES_PER_MINUTE; wave += 1) {
      await ask(wave)
      world.release(apex.conversation)
      await until(`${harness}: question ${wave}`, () => heard(wave))
    }
    // Past them, the next ones gather: none starts a turn at once.
    await ask(WAKES_PER_MINUTE)
    world.release(apex.conversation)
    await pause(300)
    await ask(WAKES_PER_MINUTE + 1)
    await ask(WAKES_PER_MINUTE + 2)
    await pause(300)
    const waiting = () => world.live.snapshot(apex.conversation)?.requests.filter((request) => request.digest && (request.status === "held" || request.status === "queued")) ?? []
    assert.equal(heard(WAKES_PER_MINUTE), false, `${harness}: the seventh doesn't start a turn at once`)
    assert.equal(waiting().length, 1, `${harness}: what's asked meanwhile gathers in one digest`)
    const at = waiting()[0]!.wake?.at
    assert.ok(at !== undefined && at <= Date.now() + ASK_EVERY_MS, `${harness}: and has its time, inside the Apex's minute`)
    // Its time comes: one turn, all of them in it.
    holding = false
    const later = mock.method(Date, "now", () => realNow() + ASK_EVERY_MS + 1_000)
    try {
      world.live.wakeDue(Date.now())
      await until(`${harness}: the gathered questions`, () => heard(WAKES_PER_MINUTE) && heard(WAKES_PER_MINUTE + 1) && heard(WAKES_PER_MINUTE + 2))
    } finally {
      later.mock.restore()
    }
    const carrying = world.prompts.filter((prompt) => prompt.conversation === apex.conversation && prompt.text.includes(words(WAKES_PER_MINUTE)))
    assert.equal(carrying.length, 1, `${harness}: one turn`)
    assert.ok(carrying[0]!.text.includes(words(WAKES_PER_MINUTE + 2)), `${harness}: with all of them`)
  } finally {
    for (const summary of world.live.summaries()) world.release(summary.session.id)
    await world.close()
  }
}

const root = mkdtempSync(join(tmpdir(), "mako-question-budget-"))
try {
  for (const harness of TESTED_HARNESSES) await run(join(root, harness), harness, false)
  // The two that take a message at a step steer it into the running turn, so no digest waits for its end.
  for (const harness of TESTED_HARNESSES.filter((each) => each !== "claude" && each !== "opencode")) await storm(join(root, `storm-${harness}`), harness)
  await run(join(root, "held"), "claude", true)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("question skips the budget: with the minute's digests spent, a question reached its Apex within the burst's window, once, on all six harnesses, and took a held digest with it; what asks nothing kept its slot, and a storm of questions gathered into one turn")
