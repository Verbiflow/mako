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
    // An idle Apex hears the first report at once and the other two as one digest after it.
    const woken = digests(world, apex.conversation)
    assert.ok(woken.length >= 1 && woken.length <= 2, `the three reports wake the Apex at most twice, not ${woken.length}`)
    assert.equal(woken.reduce((sum, wake) => sum + Number(/(\d+) finished:/.exec(wake.text)?.[1] ?? 0), 0), 3, "three finished, across them")
    assert.equal(world.store.undeliveredReports().length, 0, "every report was heard")
  } finally {
    await world.close()
  }
}

/** Reports in, the Apex not yet woken by all of them: the new host wakes it once with those still waiting. */
async function reportsUnheard(): Promise<void> {
  const { world, apex } = await tree("unheard", (turn) => (turn.text.includes("You're fin:") ? `Done: ${turn.harness} reviewed its part.` : "ok"))
  try {
    // An idle Apex hears the first report at once; the rest wait in the Apex's queue, in the digest gathering after it,
    // when the update comes.
    const carried = () => (world.live.snapshot(apex.conversation)?.requests ?? []).filter((request) => request.digest && request.status !== "canceled")
    const gathering = () => carried().find((request) => request.status === "held" || request.status === "queued")
    await until("the reports", () => carried().reduce((sum, request) => sum + request.digest!.notices.length, 0) === CHILDREN.length && gathering() !== undefined)
    const sent = digests(world, apex.conversation).length
    assert.ok(sent <= 1, "only the first went before the update")
    assert.equal(world.store.undeliveredReports().length, 0, "heard once they're in the Apex's queue")
    await world.restart()
    await world.settle()
    const woken = digests(world, apex.conversation)
    assert.equal(woken.length - sent, 1, "one wake, from the new host")
    // The words name each report once; the same report rides after them as data, for the person's card of it.
    for (const harness of CHILDREN) {
      assert.equal(woken.reduce((sum, wake) => sum + readFinReports(wake.text).text.split(`"review-${harness}"`).length - 1, 0), 1, `${harness}'s report once`)
      assert.equal(woken.reduce((sum, wake) => sum + readFinReports(wake.text).reports.filter((card) => card.name === `review-${harness}`).length, 0), 1, `${harness}'s report once as data`)
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
    // The first report woke the Apex at once; what came while it took it waited for that turn's end, and goes from the
    // new host. No report is in two of them: the wake the Apex took isn't sent again.
    const woken = digests(world, apex.conversation)
    assert.ok(woken.length >= 1 && woken.length <= 2, `at most the first wake and the rest's: ${woken.length}`)
    // Counted in every prompt the Apex took: what waited for a cut turn's end may ride its continuation.
    const cards = promptsOf(world, apex.conversation).flatMap((prompt) => readFinReports(prompt.text).reports.map((card) => card.report))
    assert.equal(new Set(cards).size, cards.length, "the wake the Apex took isn't sent again")
    assert.equal(cards.length, CHILDREN.length, "every report reached it")
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
    // An idle Apex hears a burst's first report at once and the rest as one digest after it: at most two wakes a burst.
    const first = woken()
    assert.ok(first.every((count) => count >= 1 && count <= 2), `the first burst wakes each apex at most twice: ${first.join(", ")}`)
    burst = 2
    await spawn(2)
    await until("the second burst's turns", () => world.agents.diagnostics().running === apexes.length * 3)
    host = 2
    await world.restart()
    await world.settle()
    const second = woken().map((count, index) => count - first[index]!)
    assert.ok(second.every((count) => count >= 1 && count <= 2), `and the second, cut by the update, at most twice more each: ${second.join(", ")}`)
    assert.equal(world.store.undeliveredReports().length, 0, "every report was heard")
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
