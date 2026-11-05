import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import { FROM_AGENTS } from "@mako/host/contracts/children"
import { readFinReports } from "@mako/host/contracts/fin-reports"
import { AgentsWorld, HARNESSES, type Script } from "./lib/agents-world.ts"

/**
 * Reports that arrive while an Apex can't run wait as one digest and go once, in the first turn after it can
 * (`npm run test:held-digest`), on each of the six harnesses. The case of 2026-11-05: an Apex's plan ran out, its Fin
 * posted 25 reports, each woke the Apex and every turn failed the same way. Covered: a wake refused unsent, a wake its
 * harness accepted and failed with nothing done, a restart in the wait, a Stop in the wait and a message of the
 * person's in the wait.
 */

const root = mkdtempSync(join(tmpdir(), "mako-held-digest-"))
const LATER = 24 * 60 * 60_000
const LIMIT = "You've hit your usage limit. Try again in 3 hours."

async function until(what: string, ready: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Who's out, how, and every attempt on them: a limit's knock shows here whether it was refused or failed. */
interface Limits {
  refused: Set<string>
  failing: Set<string>
  knocks: string[]
}

function worldOf(name: string) {
  const limits: Limits = { refused: new Set(), failing: new Set(), knocks: [] }
  const script: Script = async (turn) => {
    if (turn.text.includes("You're fin:")) return turn.world.hold(turn.conversation).then(() => "Labels finished.")
    if (!limits.failing.has(turn.conversation)) return "Done."
    limits.knocks.push(turn.conversation)
    const session = turn.world.live.snapshot(turn.conversation)!.session
    turn.world.live.observe({ type: "live-session", session: { ...session, status: "failed", error: LIMIT } })
    return new Promise<string>(() => {})
  }
  const world = new AgentsWorld({
    root: join(root, name),
    script,
    refusePrompt: (conversation) => {
      if (!limits.refused.has(conversation)) return undefined
      limits.knocks.push(conversation)
      return LIMIT
    },
  })
  return { world, limits }
}

const rows = (world: AgentsWorld, conversation: string): readonly LiveRequest[] => world.live.snapshot(conversation)?.requests ?? []
const digests = (world: AgentsWorld, conversation: string) => world.prompts.filter((prompt) => prompt.conversation === conversation && prompt.text.startsWith(FROM_AGENTS))

/** An Apex that took a turn, with Fins at work that report when released. */
async function apexWithFins(world: AgentsWorld, harness: string, names: readonly string[]): Promise<{ conversation: string; fins: string[] }> {
  const apex = await world.apex(harness, "full")
  world.say(apex.conversation, "Start the Fins.")
  await until("the Apex's turn", () => rows(world, apex.conversation).at(-1)?.status === "completed")
  const fins: string[] = []
  for (const name of names) {
    const started = await world.agents.start(apex.caller, { brief: { objective: `${name}: Report when told.` }, harness, name, clientKey: name, cwd: world.root, wake: "finish" })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    fins.push(started.conversation!)
    await until(`${name} to work`, () => world.live.session(started.conversation!)?.status === "running")
  }
  return { conversation: apex.conversation, fins }
}

/** The one digest waiting: one row, holding, with every report named in it so far. */
function waitsAsOne(world: AgentsWorld, conversation: string, names: readonly string[], label: string): void {
  const held = rows(world, conversation).filter((request) => request.status === "held" && request.text.startsWith(FROM_AGENTS))
  assert.equal(held.length, 1, `${label}: one digest waits, not ${held.length}`)
  const { text, reports } = readFinReports(held[0]!.text)
  for (const name of names) assert.equal(text.split(`"${name}"`).length - 1, 1, `${label}: ${name} is in it once`)
  assert.deepEqual(reports.map((report) => report.name).sort(), [...names].sort(), `${label}: its reports as cards`)
}

/** The Fins report while the Apex can't run, one at a time, each only once the last is in the digest. */
async function report(world: AgentsWorld, conversation: string, fins: readonly string[], names: readonly string[], from = 0): Promise<void> {
  for (const [at, fin] of fins.entries()) {
    world.release(fin)
    const heard = names.slice(0, from + at + 1)
    await until(`${names[from + at]} in the digest`, () => {
      const held = rows(world, conversation).find((request) => request.status === "held" && request.text.startsWith(FROM_AGENTS))
      return held !== undefined && heard.every((name) => held.text.includes(`"${name}"`))
    })
  }
}

/** It can run again: its time comes, and exactly one more digest goes, carrying every report once. */
async function goesAsOne(world: AgentsWorld, conversation: string, names: readonly string[], label: string, sent = 0): Promise<void> {
  world.live.wakeDue(Date.now() + LATER)
  await until(`${label}: the digest's turn`, () => digests(world, conversation).length > sent && !rows(world, conversation).some((request) => request.text.startsWith(FROM_AGENTS) && (request.status === "dispatching" || request.status === "queued" || request.status === "held")))
  const went = digests(world, conversation).slice(sent)
  assert.equal(went.length, 1, `${label}: one turn carried them, not ${went.length}`)
  const { text } = readFinReports(went[0]!.text)
  for (const name of names) assert.equal(text.split(`"${name}"`).length - 1, 1, `${label}: ${name} was heard once`)
}

try {
  for (const harness of HARNESSES) {
    const names = ["fin-a", "fin-b", "fin-c"]

    // Refused unsent: the first report knocks once, the rest join it, and nothing more is tried.
    {
      const { world, limits } = worldOf(`${harness}-refused`)
      const { conversation, fins } = await apexWithFins(world, harness, names)
      limits.refused.add(conversation)
      await report(world, conversation, fins, names)
      assert.equal(limits.knocks.length, 1, `${harness} refused: one knock for three reports, not ${limits.knocks.length}`)
      waitsAsOne(world, conversation, names, `${harness} refused`)
      assert.equal(digests(world, conversation).length, 0, `${harness} refused: no digest reached the harness`)
      limits.refused.clear()
      await goesAsOne(world, conversation, names, `${harness} refused`)
      await world.close()
    }

    // Taken, then failed with nothing done: the wake's turn was never heard, so its digest is what goes again, with what came since.
    {
      const { world, limits } = worldOf(`${harness}-failed`)
      const { conversation, fins } = await apexWithFins(world, harness, names)
      limits.failing.add(conversation)
      await report(world, conversation, fins, names)
      assert.equal(limits.knocks.length, 1, `${harness} failed: one knock for three reports, not ${limits.knocks.length}`)
      waitsAsOne(world, conversation, names, `${harness} failed`)
      const sent = digests(world, conversation).length
      limits.failing.clear()
      await goesAsOne(world, conversation, names, `${harness} failed`, sent)
      await world.close()
    }

    // A restart in the wait: the digest is in the journal, and what arrives after joins it.
    {
      const { world, limits } = worldOf(`${harness}-restart`)
      const { conversation, fins } = await apexWithFins(world, harness, names)
      limits.refused.add(conversation)
      await report(world, conversation, fins.slice(0, 2), names)
      await world.restart()
      await until(`${harness} restart: the Apex read in`, () => world.live.held(conversation) !== undefined || world.live.snapshot(conversation) !== undefined)
      assert.equal(limits.knocks.length, 1, `${harness} restart: nothing knocked as the host came up`)
      waitsAsOne(world, conversation, names.slice(0, 2), `${harness} restart`)
      limits.refused.clear()
      await goesAsOne(world, conversation, names.slice(0, 2), `${harness} restart`)
      await world.close()
    }

    // A Stop in the wait: the digest stays, Stop's, and goes on a Resume alone.
    {
      const { world, limits } = worldOf(`${harness}-stop`)
      const { conversation, fins } = await apexWithFins(world, harness, names)
      limits.refused.add(conversation)
      await report(world, conversation, fins.slice(0, 2), names)
      await world.live.cancel(conversation)
      limits.refused.clear()
      world.live.wakeDue(Date.now() + LATER)
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(digests(world, conversation).length, 0, `${harness} stop: a Stop outlasts the digest's time`)
      const held = rows(world, conversation).find((request) => request.text.startsWith(FROM_AGENTS))!
      assert.equal(held.pause, "stop", `${harness} stop: the digest is the Stop's`)
      world.live.editQueued(conversation, { requestId: held.id, expectedText: held.text, change: { kind: "resume" } })
      await until(`${harness} stop: the resumed digest`, () => digests(world, conversation).length === 1)
      await world.close()
    }

    // A message of the person's in the wait is the try the wait was for: the digest goes now, whole and once, then their message.
    {
      const { world, limits } = worldOf(`${harness}-person`)
      const { conversation, fins } = await apexWithFins(world, harness, names)
      limits.failing.add(conversation)
      await report(world, conversation, fins.slice(0, 2), names)
      const sent = digests(world, conversation).length
      limits.failing.clear()
      world.say(conversation, "Then this.")
      await until(`${harness} person: their message to be taken`, () => rows(world, conversation).some((request) => request.text === "Then this." && request.status === "completed"))
      const went = digests(world, conversation).slice(sent)
      assert.equal(went.length, 1, `${harness} person: their message took nothing from the digest`)
      for (const name of names.slice(0, 2)) assert.ok(went[0]!.text.includes(`"${name}"`), `${harness} person: ${name} was heard`)
      const order = world.prompts.filter((prompt) => prompt.conversation === conversation).map((prompt) => prompt.text)
      assert.ok(order.indexOf(went[0]!.text) < order.findIndex((text) => text.includes("Then this.")), `${harness} person: the digest went first`)
      await world.close()
    }
    console.log(`${harness}: a wake refused or failed at a limit knocked once for three reports, which waited as one digest and went once, across a restart, a Stop and the person's own message`)
  }
  console.log("held digest: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
