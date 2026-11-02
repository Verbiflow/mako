import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { AgentsWorld, HARNESSES, type Script } from "./lib/agents-world.ts"

/**
 * An app update mid-tree (`npm run test:orch-update`): the host closes as an
 * update's install closes it and a new one opens on the same store and
 * journals. No turn is lost or taken twice: a child's turn the update cut
 * continues once, whatever the person chose for their own turns; reports in
 * but not yet heard wake the lead once from the new host; a wake the lead
 * already took isn't sent again. And the whole tree: a lead on each of the
 * six harnesses, three children each across three harnesses, one wake per
 * lead per burst, before an update and after it.
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
  const lead = await world.lead("codex")
  const children: string[] = []
  for (const harness of CHILDREN) {
    const started = await world.agents.start(lead.caller, { brief: { objective: `Review ${harness}'s part.` }, harness, name: `review-${harness}`, clientKey: harness, cwd: world.root })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    children.push(started.conversation)
  }
  return { world, lead, children }
}

function promptsOf(world: AgentsWorld, conversation: string) {
  return world.prompts.filter((prompt) => prompt.conversation === conversation)
}

function digests(world: AgentsWorld, lead: string) {
  return promptsOf(world, lead).filter((prompt) => prompt.text.startsWith(FROM_AGENTS))
}

/** The update cuts every child's turn: each continues once on the new host, and their reports wake the lead once. */
async function childrenMidTurn(): Promise<void> {
  let host = 1
  const { world, lead, children } = await tree("mid-turn", async (turn) => {
    if (!turn.text.includes("child:") && !children.includes(turn.conversation)) return "ok"
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
    const woken = digests(world, lead.conversation)
    assert.equal(woken.length, 1, "the three reports wake the lead once")
    assert.match(woken[0]!.text, /3 finished:/)
  } finally {
    await world.close()
  }
}

/** Reports in, the lead not yet woken: the new host wakes it once with all of them. */
async function reportsUnheard(): Promise<void> {
  const { world, lead } = await tree("unheard", (turn) => (turn.text.includes("child:") ? `Done: ${turn.harness} reviewed its part.` : "ok"))
  try {
    await until("the reports", () => world.store.undeliveredReports().length === CHILDREN.length)
    assert.equal(digests(world, lead.conversation).length, 0, "still coalescing when the update comes")
    await world.restart()
    await world.settle()
    const woken = digests(world, lead.conversation)
    assert.equal(woken.length, 1, "one wake, from the new host")
    for (const harness of CHILDREN) assert.equal(woken[0]!.text.split(`"review-${harness}"`).length - 1, 1, `${harness}'s report once`)
    assert.equal(world.store.undeliveredReports().length, 0)
  } finally {
    await world.close()
  }
}

/** The lead is mid-wake when the update comes: the reports it took aren't sent again. */
async function leadMidWake(): Promise<void> {
  let host = 1
  const { world, lead } = await tree("mid-wake", async (turn) => {
    if (turn.text.includes("child:")) return `Done: ${turn.harness} reviewed its part.`
    if (turn.text.startsWith(FROM_AGENTS) && host === 1) await turn.world.hold(turn.conversation)
    return "Noted."
  })
  try {
    await until("the wake", () => digests(world, lead.conversation).length === 1)
    host = 2
    await world.restart()
    await world.settle()
    assert.equal(digests(world, lead.conversation).length, 1, "the wake the lead took isn't sent again")
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
    script: (turn) => (turn.text.includes("child:") ? `Done: ${turn.harness} reviewed its part.` : "ok"),
    // Only a child's launch carries a brief from an agent; the lead's goes on. The child's goes on once the exit has begun.
    launching: (conversation) => {
      if (host !== 1 || world.live.snapshot(conversation)?.requests[0]?.actor?.kind !== "agent") return
      reached?.()
      return new Promise<void>((resolve) => { finish = resolve })
    },
  })
  try {
    const lead = await world.lead("codex")
    const started = await world.agents.start(world.caller(lead.conversation), { brief: { objective: "Review cursor's part." }, harness: "cursor", name: "review-cursor", clientKey: "cursor", cwd: world.root })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    const child = started.conversation
    await launched
    assert.equal(promptsOf(world, child).length, 0, "the brief wasn't sent before the update")
    host = 2
    const restarted = world.restart()
    finish?.()
    await restarted
    await world.settle()
    const briefs = promptsOf(world, child).filter((prompt) => prompt.text.includes("child:"))
    assert.equal(briefs.length, 1, "the new host sends the brief once")
    assert.equal(world.store.reportsOf(world.store.edges().all[0]!.child, 0).length, 1, "and the child reports once")
    assert.equal(digests(world, lead.conversation).length, 1, "which wakes the lead once")
  } finally {
    await world.close()
  }
}

/** Six leads, one per harness, each with three children on three others: each burst wakes each lead once, across an update mid-burst. */
async function sixLeads(): Promise<void> {
  let host = 1
  let burst = 1
  const world = new AgentsWorld({ root: join(root, "six"), script: async (turn) => {
    if (!turn.text.includes("child:") && !turn.text.includes("Continue")) return "Noted."
    if (burst === 2 && host === 1) await turn.world.hold(turn.conversation)
    return `Done: ${turn.harness} finished burst ${burst}.`
  } })
  try {
    const leads = await Promise.all(HARNESSES.map((harness) => world.lead(harness)))
    const spawn = async (round: number) => {
      for (const [index, lead] of leads.entries())
        for (let i = 1; i <= 3; i += 1) {
          const harness = HARNESSES[(index + i) % HARNESSES.length]!
          const started = await world.agents.start(lead.caller, { brief: { objective: `Burst ${round}: review ${harness}'s part.` }, harness, name: `b${round}-${harness}`, clientKey: `b${round}-${harness}`, cwd: world.root })
          assert.ok(!("refused" in started), JSON.stringify(started))
        }
    }
    await spawn(1)
    await world.settle()
    const woken = () => leads.map((lead) => digests(world, lead.conversation).length + world.steers.filter((steer) => steer.conversation === lead.conversation).length)
    assert.deepEqual(woken(), [1, 1, 1, 1, 1, 1], "the first burst wakes each lead once")
    burst = 2
    await spawn(2)
    await until("the second burst's turns", () => world.agents.diagnostics().running === leads.length * 3)
    host = 2
    await world.restart()
    await world.settle()
    assert.deepEqual(woken(), [2, 2, 2, 2, 2, 2], "and the second, cut by the update, once more each")
    const children = world.store.edges().all
    assert.equal(children.length, leads.length * 6)
    assert.ok(children.every((edge) => world.store.reportsOf(edge.child, 0).length === 1), "every child ended once, with one report")
    for (const edge of children) {
      const conversations = world.store.thread(edge.child)!.sessions.flatMap((session) => world.store.conversationsOf(session))
      const briefs = world.prompts.filter((prompt) => conversations.includes(prompt.conversation) && prompt.text.includes("child:"))
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
