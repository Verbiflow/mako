import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentsSendResult, AgentsSent } from "@mako/host/contracts/agent-tools"
import { agentWords } from "@mako/host/contracts/children"
import { AgentsWorld, type WorldOptions } from "./lib/agents-world.ts"

/**
 * How `agents_send` reaches a working Fin (`npm run test:orch-deliver`), by
 * the choice its sender makes: `queue` (the default) after its turn, `steer`
 * into the running turn, `interrupt` by stopping it first. Each Fin runs on a
 * scripted harness whose steering is its real driver's: Claude's at the next
 * step, Cursor's at once with a steer it holds while its subagent runs and
 * answers when its turn ends, Codex's none here. What each answer says
 * (`hears`) names the Fin's harness, whatever harness its Apex runs on, and
 * is what happened: a steer the harness refuses goes as the next message, a
 * steer it holds answers before it's taken, and nothing goes twice.
 */
const root = mkdtempSync(join(tmpdir(), "mako-orch-deliver-"))
const CLAUDE = "at its next step, once the command or subagent it's running returns"
const CURSOR = "at once, cutting a running command short; a running subagent finishes first"

async function until(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** `call`, which must answer without the held steer's answer: a hang guard thirty times the 5 s it waits for one. */
async function beforeAnswered<T>(call: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const never = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("the call still waited after 150 s, so it waited for Cursor to answer the steer it holds")), 150_000)
  })
  try {
    return await Promise.race([call, never])
  } finally {
    clearTimeout(timer)
  }
}

function sent(result: AgentsSendResult): AgentsSent {
  assert.ok(!("refused" in result), JSON.stringify(result))
  return result
}

/** The words a prompt or steer carried past Mako's note and the Apex's header. */
function body(text: string): string {
  const spoken = text.replace(/^<mako-local-control>[\s\S]*?<\/mako-local-control>\n\n/, "")
  return agentWords(spoken)?.body ?? spoken
}

/** An Apex on `apexHarness` with one Fin on each of `fins`, every Fin's turn held while `busy`. */
async function team(name: string, apexHarness: string, fins: string[], options: Partial<WorldOptions> = {}) {
  const working: string[] = []
  const state = { busy: false, fins: working }
  const world = new AgentsWorld({
    root: join(root, name),
    steering: {
      claude: { lands: "step", hears: CLAUDE },
      cursor: { lands: "interrupt", answersOnEnd: true, hears: CURSOR, ...options.steering?.cursor },
    },
    ...options,
    script: async (turn) => {
      if (state.fins.includes(turn.conversation) && state.busy) await turn.world.hold(turn.conversation)
      return "Done."
    },
  })
  const apex = await world.apex(apexHarness)
  const conversations: Record<string, string> = {}
  for (const harness of fins) {
    const started = await world.agents.start(apex.caller, { brief: { objective: `Work on the ${harness} side.` }, harness, name: harness, clientKey: harness, cwd: world.root })
    assert.ok(!("refused" in started) && started.conversation)
    conversations[harness] = started.conversation
  }
  state.fins = Object.values(conversations)
  await world.settle()
  /** Sets each Fin to work on a turn that runs until `release`. */
  const work = async () => {
    state.busy = true
    for (const conversation of state.fins) world.live.submit(conversation, randomUUID(), "Next: the release build.", [])
    await until("every Fin at work", () => state.fins.every((conversation) => world.live.snapshot(conversation)?.session.status === "running"))
  }
  const release = async () => {
    state.busy = false
    for (const conversation of state.fins) world.release(conversation)
    await world.settle()
  }
  const prompts = (conversation: string) => world.prompts.filter((prompt) => prompt.conversation === conversation).map((prompt) => body(prompt.text))
  const steers = (conversation: string) => world.steers.filter((steer) => steer.conversation === conversation).map((steer) => body(steer.text))
  return { world, apex, fin: conversations, work, release, prompts, steers }
}

/** An idle Fin takes any choice as its next turn. */
async function idleTakesATurn(): Promise<void> {
  const { world, apex, fin, prompts } = await team("idle", "codex", ["claude"])
  try {
    for (const deliver of ["queue", "steer", "interrupt"] as const) {
      const answer = sent(await world.agents.send(apex.caller, { to: "claude", text: `Then ${deliver}.`, deliver, clientKey: `idle-${deliver}` }))
      assert.equal(answer.delivery, "turn", deliver)
      assert.equal(answer.hears, "claude takes it now, as its next turn.")
      await world.settle()
      assert.equal(prompts(fin.claude!).at(-1), `Then ${deliver}.`)
    }
  } finally {
    await world.close()
  }
}

/** Queued by default: the Fin hears it once its turn ends, and not before. */
async function queueByDefault(): Promise<void> {
  const { world, apex, fin, work, release, prompts, steers } = await team("queue", "cursor", ["claude"])
  try {
    await work()
    const answer = sent(await world.agents.send(apex.caller, { to: "claude", text: "Also cover the tablet layout.", clientKey: "q" }))
    assert.equal(answer.delivery, "queued")
    assert.equal(answer.hears, "claude hears it when its current turn ends, as its next message.")
    assert.equal(steers(fin.claude!).length, 0, "nothing went into the running turn")
    assert.ok(!prompts(fin.claude!).includes("Also cover the tablet layout."), "nor started a turn")
    await release()
    assert.equal(prompts(fin.claude!).at(-1), "Also cover the tablet layout.", "its next turn")
  } finally {
    await world.close()
  }
}

/** Steered into a step harness's turn, from an Apex on another harness: the answer is the Fin's harness's, not the Apex's. */
async function steerAcrossHarnesses(): Promise<void> {
  const { world, apex, fin, work, release, prompts, steers } = await team("steer", "cursor", ["claude", "codex"])
  try {
    await work()
    const claude = sent(await world.agents.send(apex.caller, { to: "claude", text: "Stop: use the v2 endpoint.", deliver: "steer", clientKey: "s1" }))
    assert.equal(claude.delivery, "steer")
    assert.equal(claude.hears, `claude hears it ${CLAUDE} (Claude).`, "Claude's step, though the Apex runs on Cursor")
    assert.deepEqual(steers(fin.claude!), ["Stop: use the v2 endpoint."])
    const codex = sent(await world.agents.send(apex.caller, { to: "codex", text: "Stop: use the v2 endpoint.", deliver: "steer", clientKey: "s2" }))
    assert.equal(codex.delivery, "queued", "a harness that takes no steer queues it")
    assert.equal(codex.hears, "codex hears it when its current turn ends, as its next message: Codex takes no message into a running turn.")
    const again = sent(await world.agents.send(apex.caller, { to: "claude", text: "Stop: use the v2 endpoint.", deliver: "steer", clientKey: "s1" }))
    assert.equal(again.deduped, true)
    await release()
    assert.deepEqual(steers(fin.claude!), ["Stop: use the v2 endpoint."], "once")
    assert.ok(!prompts(fin.claude!).includes("Stop: use the v2 endpoint."), "a steer it took isn't sent again as a message")
    assert.equal(prompts(fin.codex!).at(-1), "Stop: use the v2 endpoint.")
  } finally {
    await world.close()
  }
}

/** A steer the harness refuses goes as the next message, once, and says so. */
async function refusedSteerQueues(): Promise<void> {
  const { world, apex, fin, work, release, prompts } = await team("refused", "claude", ["claude"], { refuseSteers: true })
  try {
    await work()
    const answer = sent(await world.agents.send(apex.caller, { to: "claude", text: "Use the staging bucket.", deliver: "steer", clientKey: "r" }))
    assert.equal(answer.delivery, "queued")
    assert.equal(answer.hears, "Claude didn't take it into claude's running turn, so claude hears it when that turn ends, as its next message.")
    await release()
    assert.equal(prompts(fin.claude!).filter((text) => text === "Use the staging bucket.").length, 1)
  } finally {
    await world.close()
  }
}

/**
 * Cursor takes a steer at once, unless a subagent runs: then it holds it, the answer comes before it's taken, and a
 * turn that ends first sends it as the next message, once.
 */
async function cursorHoldsASteer(): Promise<void> {
  const { world, apex, fin, work, release, prompts, steers } = await team("cursor", "claude", ["cursor"], { steering: { cursor: { lands: "interrupt", answersOnEnd: true, hears: CURSOR, holds: true } } })
  try {
    await work()
    // The call gives up on the harness's answer after 5 s at most; Cursor here answers only when the test says.
    const held = sent(await beforeAnswered(world.agents.send(apex.caller, { to: "cursor", text: "Drop the retry loop.", deliver: "steer", clientKey: "c1" })))
    assert.equal(held.delivery, "steer")
    assert.equal(held.hears, "Cursor holds it until what cursor is running now returns, then cursor hears it; if its turn ends first, it goes as its next message.")
    const second = sent(await world.agents.send(apex.caller, { to: "cursor", text: "And the second retry.", deliver: "steer", clientKey: "c2" }))
    assert.equal(second.delivery, "queued", "one steer at a time: the next waits for the turn's end")
    assert.match(second.hears, /^cursor hears it when its current turn ends, as its next message: it couldn't go into its running turn/)
    assert.ok(world.answerSteer(fin.cursor!, { kind: "not-accepted", reason: "The run ended before taking it." }), "Cursor answers the steer it held as its run ends")
    await release()
    assert.deepEqual(prompts(fin.cursor!).slice(-2), ["Drop the retry loop.", "And the second retry."], "each as a message of its own, in order")
    assert.equal(steers(fin.cursor!).length, 0)
    await work()
    const taken = sent(await world.agents.send(apex.caller, { to: "cursor", text: "Skip the flaky test.", deliver: "steer", clientKey: "c3" }))
    assert.equal(taken.delivery, "steer")
    assert.ok(world.answerSteer(fin.cursor!, { kind: "accepted" }))
    await until("Cursor takes it", () => steers(fin.cursor!).includes("Skip the flaky test."))
    await release()
    assert.ok(!prompts(fin.cursor!).includes("Skip the flaky test."), "a steer it took never goes again")
  } finally {
    await world.close()
  }
}

/** Interrupted, the Fin's turn stops and the message starts its next one, ahead of what was already queued for it. */
async function interruptGoesFirst(): Promise<void> {
  const { world, apex, fin, work, release, prompts } = await team("interrupt", "codex", ["claude"])
  try {
    await work()
    sent(await world.agents.send(apex.caller, { to: "claude", text: "Later: the changelog.", clientKey: "i1" }))
    const answer = sent(await world.agents.send(apex.caller, { to: "claude", text: "Stop. The migration is wrong; revert it first.", deliver: "interrupt", clientKey: "i2" }))
    assert.equal(answer.delivery, "interrupt")
    assert.equal(answer.hears, "Mako stopped claude's turn; this message starts its next one, ahead of anything queued for it.")
    await until("the interrupt's turn", () => prompts(fin.claude!).includes("Stop. The migration is wrong; revert it first."))
    await release()
    assert.deepEqual(prompts(fin.claude!).slice(-2), ["Stop. The migration is wrong; revert it first.", "Later: the changelog."], "the interrupt first, then what was queued, which a Stop alone would hold")
    assert.ok(world.live.snapshot(fin.claude!)!.requests.every((request) => request.status !== "held" && request.status !== "queued"), "nothing left waiting")
  } finally {
    await world.close()
  }
}

/** The person's message, forwarded, takes the same choice. */
async function forwardTakesTheChoice(): Promise<void> {
  const { world, apex, fin, work, release, steers } = await team("forward", "codex", ["claude"])
  try {
    await work()
    world.say(apex.conversation, "No, not that branch: work on release/2.4.")
    await until("the Apex's turn", () => world.prompts.some((prompt) => prompt.conversation === apex.conversation && prompt.text.endsWith("release/2.4.")))
    const answer = sent(await world.agents.send(apex.caller, { to: "claude", forward: true, deliver: "steer", clientKey: "f" }))
    assert.equal(answer.delivery, "steer")
    assert.deepEqual(steers(fin.claude!), ["No, not that branch: work on release/2.4."])
    await release()
  } finally {
    await world.close()
  }
}

try {
  for (const test of [idleTakesATurn, queueByDefault, steerAcrossHarnesses, refusedSteerQueues, cursorHoldsASteer, interruptGoesFirst, forwardTakesTheChoice]) {
    await test()
    console.log(`ok ${test.name}`)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
