import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { readFinReports } from "@mako/host/contracts/fin-reports"
import { AgentsWorld, HARNESSES, type Script } from "./lib/agents-world.ts"

/**
 * An app update mid-tree (`npm run test:orch-update`): the host closes as an
 * update's install closes it and a new one opens on the same store and
 * journals. No turn is lost or taken twice: a child's turn the update cut
 * continues once, whatever the person chose for their own turns; reports in
 * but not yet heard wake the Apex once from the new host; a wake the Apex
 * already took isn't sent again. And the whole tree: an Apex on each of the
 * six harnesses, three children each across three harnesses, one wake per
 * apex per burst, before an update and after it.
 */
const root = mkdtempSync(join(tmpdir(), "mako-orch-update-"))
const CHILDREN = ["claude", "cursor", "grok"]

async function until(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function tree(name: string, script: Script) {
  const world = new AgentsWorld({ root: join(root, name), script })
  const apex = await world.apex("codex")
  const children: string[] = []
  for (const harness of CHILDREN) {
    const started = await world.agents.start(apex.caller, { brief: { objective: `Review ${harness}'s part.` }, harness, name: `review-${harness}`, clientKey: harness, cwd: world.root })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    children.push(started.conversation)
  }
  return { world, apex, children }
}

function promptsOf(world: AgentsWorld, conversation: string) {
  return world.prompts.filter((prompt) => prompt.conversation === conversation)
}

function digests(world: AgentsWorld, apex: string) {
  return promptsOf(world, apex).filter((prompt) => prompt.text.startsWith(FROM_AGENTS))
}

/** The update cuts every child's turn: each continues once on the new host, and their reports wake the Apex once. */
async function childrenMidTurn(): Promise<void> {
  let host = 1
  const { world, apex, children } = await tree("mid-turn", async (turn) => {
    if (!turn.text.includes("You're fin:") && !children.includes(turn.conversation)) return "ok"
    if (host === 1) await turn.world.hold(turn.conversation)
    return `Done: ${turn.harness} reviewed its part.`
  })
  try {
    await until("the children's turns", () => children.every((child) => world.live.snapshot(child)?.session.status === "running"))
    host = 2
    await world.restart()
    await world.settle()
    for (const child of children) {
      const prompts = promptsOf(world, child)
      assert.equal(prompts.length, 2, `${child}: its brief, then one continuation`)
      const requests = world.live.snapshot(child)!.requests
      assert.equal(new Set(requests.map((request) => request.id)).size, requests.length, "no request twice")
      assert.ok(requests.at(-1)!.continues?.auto, "the second is Mako's continuation")
    }
    const woken = digests(world, apex.conversation)
    assert.equal(woken.length, 1, "the three reports wake the Apex once")
    assert.match(woken[0]!.text, /3 finished:/)
  } finally {
    await world.close()
  }
}

/** Reports in, the Apex not yet woken: the new host wakes it once with all of them. */
async function reportsUnheard(): Promise<void> {
  const { world, apex } = await tree("unheard", (turn) => (turn.text.includes("You're fin:") ? `Done: ${turn.harness} reviewed its part.` : "ok"))
  try {
    // Each report is in the Apex's queue, in the one digest still gathering its burst, when the update comes.
    const gathered = () => world.live.snapshot(apex.conversation)?.requests.find((request) => request.digest && request.status === "held")?.digest?.notices.length ?? 0
    await until("the reports", () => gathered() === CHILDREN.length)
    assert.equal(digests(world, apex.conversation).length, 0, "still coalescing when the update comes")
    assert.equal(world.store.undeliveredReports().length, 0, "heard once they're in the Apex's queue")
    await world.restart()
    await world.settle()
    const woken = digests(world, apex.conversation)
    assert.equal(woken.length, 1, "one wake, from the new host")
    // The words name each report once; the same report rides after them as data, for the person's card of it.
    const { text: words, reports } = readFinReports(woken[0]!.text)
    for (const harness of CHILDREN) {
      assert.equal(words.split(`"review-${harness}"`).length - 1, 1, `${harness}'s report once`)
      assert.equal(reports.filter((card) => card.name === `review-${harness}`).length, 1, `${harness}'s report once as data`)
    }
    assert.equal(world.store.undeliveredReports().length, 0)
  } finally {
    await world.close()
  }
}

/** The Apex is mid-wake when the update comes: the reports it took aren't sent again. */
async function leadMidWake(): Promise<void> {
  let host = 1
  const { world, apex } = await tree("mid-wake", async (turn) => {
    if (turn.text.includes("You're fin:")) return `Done: ${turn.harness} reviewed its part.`
    if (turn.text.startsWith(FROM_AGENTS) && host === 1) await turn.world.hold(turn.conversation)
    return "Noted."
  })
  try {
    await until("the wake", () => digests(world, apex.conversation).length === 1)
    host = 2
    await world.restart()
    await world.settle()
    assert.equal(digests(world, apex.conversation).length, 1, "the wake the Apex took isn't sent again")
    assert.equal(world.store.undeliveredReports().length, 0)
  } finally {
    await world.close()
  }
}

/** The update lands as a child's harness has started and its brief isn't sent yet: the new host sends the brief once. */
async function launchCut(): Promise<void> {
  let host = 1
  let reached: (() => void) | undefined
  let finish: (() => void) | undefined
  const launched = new Promise<void>((resolve) => { reached = resolve })
  const world = new AgentsWorld({
    root: join(root, "launch-cut"),
    script: (turn) => (turn.text.includes("You're fin:") ? `Done: ${turn.harness} reviewed its part.` : "ok"),
    // Only a child's launch carries a brief from an agent; the Apex's goes on. The child's goes on once the exit has begun.
    launching: (conversation) => {
      if (host !== 1 || world.live.snapshot(conversation)?.requests[0]?.actor?.kind !== "agent") return
      reached?.()
      return new Promise<void>((resolve) => { finish = resolve })
    },
  })
  try {
    const apex = await world.apex("codex")
    const started = await world.agents.start(world.caller(apex.conversation), { brief: { objective: "Review cursor's part." }, harness: "cursor", name: "review-cursor", clientKey: "cursor", cwd: world.root })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    const child = started.conversation
    await launched
    assert.equal(promptsOf(world, child).length, 0, "the brief wasn't sent before the update")
    host = 2
    const restarted = world.restart()
    finish?.()
    await restarted
    await world.settle()
    const briefs = promptsOf(world, child).filter((prompt) => prompt.text.includes("You're fin:"))
    assert.equal(briefs.length, 1, "the new host sends the brief once")
    assert.equal(world.store.reportsOf(world.store.edges().all[0]!.child, 0).length, 1, "and the child reports once")
    assert.equal(digests(world, apex.conversation).length, 1, "which wakes the Apex once")
  } finally {
    await world.close()
  }
}

/** Six apexes, one per harness, each with three children on three others: each burst wakes each apex once, across an update mid-burst. */
async function sixLeads(): Promise<void> {
  let host = 1
  let burst = 1
  // The second burst's 18 Fins are at work at once, past the default limit.
  const world = new AgentsWorld({ root: join(root, "six"), finLimit: () => HARNESSES.length * 3, script: async (turn) => {
    if (!turn.text.includes("You're fin:") && !turn.text.includes("Continue")) return "Noted."
    if (burst === 2 && host === 1) await turn.world.hold(turn.conversation)
    return `Done: ${turn.harness} finished burst ${burst}.`
  } })
  try {
    const apexes = await Promise.all(HARNESSES.map((harness) => world.apex(harness)))
    const spawn = async (round: number) => {
      for (const [index, apex] of apexes.entries())
        for (let i = 1; i <= 3; i += 1) {
          const harness = HARNESSES[(index + i) % HARNESSES.length]!
          const started = await world.agents.start(apex.caller, { brief: { objective: `Burst ${round}: review ${harness}'s part.` }, harness, name: `b${round}-${harness}`, clientKey: `b${round}-${harness}`, cwd: world.root })
          assert.ok(!("refused" in started), JSON.stringify(started))
        }
    }
    await spawn(1)
    await world.settle()
    const woken = () => apexes.map((apex) => digests(world, apex.conversation).length + world.steers.filter((steer) => steer.conversation === apex.conversation).length)
    assert.deepEqual(woken(), [1, 1, 1, 1, 1, 1], "the first burst wakes each apex once")
    burst = 2
    await spawn(2)
    await until("the second burst's turns", () => world.agents.diagnostics().running === apexes.length * 3)
    host = 2
    await world.restart()
    await world.settle()
    assert.deepEqual(woken(), [2, 2, 2, 2, 2, 2], "and the second, cut by the update, once more each")
    const children = world.store.edges().all
    assert.equal(children.length, apexes.length * 6)
    assert.ok(children.every((edge) => world.store.reportsOf(edge.child, 0).length === 1), "every child ended once, with one report")
    for (const edge of children) {
      const conversations = world.store.thread(edge.child)!.sessions.flatMap((session) => world.store.conversationsOf(session))
      const briefs = world.prompts.filter((prompt) => conversations.includes(prompt.conversation) && prompt.text.includes("You're fin:"))
      assert.equal(briefs.length, 1, `${edge.name}: its brief reached its harness once`)
    }
  } finally {
    await world.close()
  }
}

try {
  await sixLeads()
  await childrenMidTurn()
  await reportsUnheard()
  await leadMidWake()
  await launchCut()
  console.log("orch update: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
