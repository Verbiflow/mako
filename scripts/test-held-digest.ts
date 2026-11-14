import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { mock } from "node:test"
import { join } from "node:path"
import { holdForRetry, RESET_MARGIN_MS } from "@mako/host/contracts/delivery-retry"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import { holdDue, holdOf } from "@mako/host/contracts/request-hold"
import { LiveRequestSchema } from "@mako/host/conversations/live-journal"
import { FROM_AGENTS } from "@mako/host/contracts/children"
import { readFinReports } from "@mako/host/contracts/fin-reports"
import { AgentsWorld, HARNESSES, TESTED_HARNESSES, type Script } from "./lib/agents-world.ts"

/**
 * Reports that arrive while an Apex can't run wait as one digest and go once, in the first turn after it can
 * (`npm run test:held-digest`), on each of the six harnesses. The case of 2026-11-05: an Apex's plan ran out, its Fin
 * posted 25 reports, each woke the Apex and every turn failed the same way. Covered: a wake refused unsent, a wake its
 * harness accepted and failed with nothing done, a restart in the wait, a crash as the digest is written, a switch by hand, any number of failures in a row, a Stop
 * in the wait and a message of the person's in the wait.
 */

const root = mkdtempSync(join(tmpdir(), "mako-held-digest-"))
const LATER = 24 * 60 * 60_000
// No time in its words: with one, the wait counts from that reset (`nextRetry`), and these cases are about the budget.
const LIMIT = "You've hit your usage limit."

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
  /** Conversations whose turn says something before its limit: a model that heard what it was sent. */
  speaking: Set<string>
  /** The harness whose account ran out: any other takes what's sent. */
  on?: string
  knocks: string[]
}

function worldOf(name: string, words = LIMIT) {
  const limits: Limits = { refused: new Set(), failing: new Set(), speaking: new Set(), knocks: [] }
  const script: Script = async (turn) => {
    if (turn.text.includes("You're fin:")) return turn.world.hold(turn.conversation).then(() => "Labels finished.")
    if (!limits.failing.has(turn.conversation)) return "Done."
    limits.knocks.push(turn.conversation)
    if (limits.speaking.has(turn.conversation)) turn.world.live.observe({ type: "live-update", id: turn.conversation, update: { kind: "text", text: "Reading the reports." } })
    const session = turn.world.live.snapshot(turn.conversation)!.session
    turn.world.live.observe({ type: "live-session", session: { ...session, status: "failed", error: LIMIT } })
    return new Promise<string>(() => {})
  }
  const world = new AgentsWorld({
    root: join(root, name),
    script,
    refusePrompt: (conversation, harness) => {
      if (!limits.refused.has(conversation) || (limits.on && harness !== limits.on)) return undefined
      limits.knocks.push(conversation)
      return words
    },
  })
  return { world, limits }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const rows = (world: AgentsWorld, conversation: string): readonly LiveRequest[] => world.live.snapshot(conversation)?.requests ?? []
const digests = (world: AgentsWorld, conversation: string) => world.prompts.filter((prompt) => prompt.conversation === conversation && prompt.text.includes(FROM_AGENTS))

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
  // A start that fails past the budget, the third way a digest stops being retried: it rests, and what isn't one fails.
  {
    const since = Date.now() - 7 * 60 * 60_000
    const retry = { at: since, attempt: 9, since, cause: "rate-limited" as const, reason: LIMIT }
    const digest = LiveRequestSchema.parse({ id: randomUUID(), text: FROM_AGENTS, attachments: [], status: "queued", retry, digest: { notices: [] } })
    const message = LiveRequestSchema.parse({ id: randomUUID(), text: "Words", attachments: [], status: "queued", retry })
    assert.equal(holdForRetry([message], "rate-limited", LIMIT, Date.now()), undefined, "a message past the budget fails, as ever")
    const [rested] = holdForRetry([digest], "rate-limited", LIMIT, Date.now()) ?? []
    assert.equal(rested?.status, "held", "a digest past the budget stays")
    assert.equal(rested?.digest?.resting, true, "at rest")
    assert.ok(holdDue(holdOf(rested!)!)! > Date.now(), "and tries by itself, a limit's, on its hour")
    const [outage] = holdForRetry([{ ...digest, retry: { ...retry, cause: "network" as const } }], "network", "fetch failed", Date.now() + 2 * 60 * 60_000) ?? []
    assert.equal(outage?.digest?.resting, true, "another cause rests too")
    assert.equal(holdDue(holdOf(outage!)!), undefined, "with no time of its own: only a limit tries by itself")
    assert.equal(holdForRetry([{ ...digest, digest: { notices: [], heard: true as const } }], "rate-limited", LIMIT, Date.now()), undefined, "one a model answered has nothing to keep")
  }

  for (const harness of TESTED_HARNESSES) {
    const names = ["fin-a", "fin-b", "fin-c"]

    // Refused unsent: the first report knocks once, the rest join it, and nothing more is tried.
    {
      const { world, limits } = worldOf(`${harness}-refused`)
      const { conversation, fins } = await apexWithFins(world, harness, names)
      limits.refused.add(conversation)
      await report(world, conversation, fins, names)
      assert.ok(limits.knocks.length <= 1, `${harness} refused: at most one knock for three reports, not ${limits.knocks.length}`)
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
      assert.ok(limits.knocks.length <= 1, `${harness} failed: at most one knock for three reports, not ${limits.knocks.length}`)
      waitsAsOne(world, conversation, names, `${harness} failed`)
      const sent = digests(world, conversation).length
      limits.failing.clear()
      await goesAsOne(world, conversation, names, `${harness} failed`, sent)
      await world.close()
    }

    // A restart in the wait: the digest is in the journal, and what arrives after joins it.
    {
      const { world, limits } = worldOf(`${harness}-restart`)
      const { conversation, fins } = await apexWithFins(world, harness, names.slice(0, 2))
      limits.refused.add(conversation)
      await report(world, conversation, fins.slice(0, 2), names)
      await world.restart()
      await until(`${harness} restart: the Apex read in`, () => world.live.held(conversation) !== undefined || world.live.snapshot(conversation) !== undefined)
      assert.ok(limits.knocks.length <= 1, `${harness} restart: nothing knocked as the host came up`)
      waitsAsOne(world, conversation, names.slice(0, 2), `${harness} restart`)
      limits.refused.clear()
      await goesAsOne(world, conversation, names.slice(0, 2), `${harness} restart`)
      await world.close()
    }

    // A crash as the digest is written, with a report on its way into it: that report is never read as heard unsent.
    {
      const { world, limits } = worldOf(`${harness}-crash`)
      const { conversation, fins } = await apexWithFins(world, harness, names.slice(0, 2))
      limits.refused.add(conversation)
      await report(world, conversation, fins.slice(0, 1), names)
      let cut = false
      world.live.rewriteWaiting = () => {
        cut = true
        throw new Error("the host died here")
      }
      world.release(fins[1]!)
      await until(`${harness} crash: the write to be cut`, () => cut)
      await world.restart()
      limits.refused.clear()
      world.live.wakeDue(Date.now() + LATER)
      await until(`${harness} crash: fin-a heard`, () => digests(world, conversation).some((prompt) => prompt.text.includes(`"fin-a"`)))
      await until(`${harness} crash: fin-b heard too`, () => digests(world, conversation).some((prompt) => prompt.text.includes(`"fin-b"`)), 5_000)
      assert.equal(world.store.undeliveredReports().filter(({ report: kept }) => kept.status !== "progress").length, 0, `${harness} crash: nothing left unheard`)
      await world.close()
    }

    // What the person did on 2026-11-05, switching the Thread by hand: a hold about the old harness's account goes with
    // it, so the Thread goes at once, its digest first with the hand-over's context, then their message.
    {
      const { world, limits } = worldOf(`${harness}-switch`)
      const { conversation, fins } = await apexWithFins(world, harness, names)
      limits.refused.add(conversation)
      limits.on = harness
      await report(world, conversation, fins, names)
      await until(`${harness} switch: the limit to hold the digest`, () => rows(world, conversation).some((request) => request.text.startsWith(FROM_AGENTS) && request.retry !== undefined))
      const knocks = limits.knocks.length
      const next = HARNESSES[(HARNESSES.indexOf(harness) + 1) % HARNESSES.length]!
      world.live.transfer(conversation, { id: randomUUID(), provider: next, text: "Carry on here.", attachments: [] })
      await until(`${harness} switch: their message to be taken`, () => rows(world, conversation).some((request) => request.text === "Carry on here." && request.status === "completed"))
      assert.equal(limits.knocks.length, knocks, `${harness} switch: the spent harness wasn't tried again`)
      const there = world.prompts.filter((prompt) => prompt.conversation === conversation && prompt.harness === next)
      assert.equal(there.length, 2, `${harness} switch: its digest and their message, each once`)
      assert.ok(there[0]!.text.includes(FROM_AGENTS), `${harness} switch: the digest goes first`)
      for (const name of names) assert.equal(readFinReports(there[0]!.text).text.split(`"${name}"`).length - 1, 1, `${harness} switch: ${name} was heard once`)
      assert.ok(there[1]!.text.includes("Carry on here."), `${harness} switch: then their message`)
      const carrying = rows(world, conversation).filter((request) => request.context?.length)
      assert.equal(carrying.length, 1, `${harness} switch: one row carries the hand-over`)
      assert.ok(carrying[0]!.text.startsWith(FROM_AGENTS), `${harness} switch: the digest, the first thing the destination hears`)
      assert.ok(!rows(world, conversation).some((request) => request.status === "held"), `${harness} switch: nothing is left holding`)
      await world.close()
    }

    // A Stop outlasts a switch: what it paused stays paused on the destination.
    {
      const { world, limits } = worldOf(`${harness}-stop-switch`)
      const { conversation, fins } = await apexWithFins(world, harness, names)
      limits.refused.add(conversation)
      await report(world, conversation, fins.slice(0, 1), names)
      await world.live.cancel(conversation)
      const next = HARNESSES[(HARNESSES.indexOf(harness) + 1) % HARNESSES.length]!
      world.live.transfer(conversation, { id: randomUUID(), provider: next, text: "Carry on here.", attachments: [] })
      await until(`${harness} stop-switch: the switch to land`, () => rows(world, conversation).some((request) => request.text === "Carry on here."))
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(digests(world, conversation).filter((prompt) => prompt.harness === next).length, 0, `${harness} stop-switch: the digest stays the Stop's`)
      await world.close()
    }

    // 2026-11-05's shape: the account stays out, turn after turn. Each attempt that nothing heard proves nothing, so
    // the reports outlast any number of them, then the person's message, a restart among them or none.
    for (const failures of [2, 3, 28]) {
      const { world, limits } = worldOf(`${harness}-failures-${failures}`)
      const { conversation, fins } = await apexWithFins(world, harness, names.slice(0, 2))
      limits.failing.add(conversation)
      await report(world, conversation, fins, names)
      // A minute apart, as the budget for an Apex's digests has them (`WAKES_PER_MINUTE`).
      let passed = 0
      const clock = Date.now.bind(Date)
      const time = mock.method(Date, "now", () => clock() + passed)
      for (let attempt = 1; attempt <= failures; attempt += 1) {
        if (attempt > 1) {
          passed += 61_000
          world.live.wakeDue(Date.now() + LATER)
        }
        await until(`${harness} ${failures} failures: attempt ${attempt}`, () => limits.knocks.length === attempt && rows(world, conversation).some((request) => request.status === "held" && request.digest !== undefined))
        if (attempt === 2) await world.restart()
      }
      assert.equal(limits.knocks.length, failures, `${harness} ${failures} failures: one attempt each, none for the reports`)
      waitsAsOne(world, conversation, names.slice(0, 2), `${harness} ${failures} failures`)
      const sent = digests(world, conversation).length
      limits.failing.clear()
      passed += 61_000
      world.say(conversation, "Then this.")
      await until(`${harness} ${failures} failures: their message to be taken`, () => rows(world, conversation).some((request) => request.text === "Then this." && request.status === "completed"))
      const went = digests(world, conversation).slice(sent)
      assert.equal(went.length, 1, `${harness} ${failures} failures: the digest went, once`)
      for (const name of names.slice(0, 2)) assert.equal(readFinReports(went[0]!.text).text.split(`"${name}"`).length - 1, 1, `${harness} ${failures} failures: ${name} was heard once`)
      const order = world.prompts.filter((prompt) => prompt.conversation === conversation).map((prompt) => prompt.text)
      assert.ok(order.lastIndexOf(went[0]!.text) < order.findIndex((text) => text.includes("Then this.")), `${harness} ${failures} failures: the digest went first`)
      assert.equal(world.store.undeliveredReports().filter(({ report: kept }) => kept.status !== "progress").length, 0, `${harness} ${failures} failures: nothing left unheard`)
      await world.close()
      time.mock.restore()
    }

    // A limit that says when it lifts: the digest goes then, not before, whatever comes round, and once.
    {
      const { world, limits } = worldOf(`${harness}-reset`, "You've hit your usage limit. Try again in 3 hours.")
      const { conversation, fins } = await apexWithFins(world, harness, names)
      limits.refused.add(conversation)
      await report(world, conversation, fins, names)
      // Its gathering window over, it knocks, and the refusal names the reset.
      world.live.wakeDue(Date.now() + 60_000)
      await until(`${harness} reset: the refusal`, () => rows(world, conversation).some((request) => request.digest && request.retry))
      const held = rows(world, conversation).find((request) => request.digest && request.retry)!
      assert.equal(held.retry!.at, held.retry!.until! + RESET_MARGIN_MS, `${harness} reset: it goes just past the reset`)
      assert.ok(Math.abs(held.retry!.until! - (held.retry!.since + 3 * 60 * 60_000)) < 1_000, `${harness} reset: read from its words`)
      world.live.wakeDue(held.retry!.at - 1)
      await pause(60)
      assert.equal(limits.knocks.length, 1, `${harness} reset: nothing knocks before it, for however many reports`)
      waitsAsOne(world, conversation, names, `${harness} reset`)
      limits.refused.clear()
      world.live.wakeDue(held.retry!.at + 1)
      await goesAsOne(world, conversation, names, `${harness} reset`)
      await world.close()
    }

    // Giving up stops the retrying, never the reports: past the budget nothing knocks, and a digest no model heard rests,
    // through a restart, taking later news, until the next turn that can run, on any harness. A failed turn and a refused
    // send end the same way, and a limit outlasts the budget as a rule: Cursor's lasted three days.
    for (const [how, release] of [["failed", "message"], ["refused", "message"], ["failed", "switch"], ["failed", "hour"], ["refused", "hour"], ["failed", "stop"]] as const) {
      const { world, limits } = worldOf(`${harness}-rest-${how}-${release}`)
      const { conversation, fins } = await apexWithFins(world, harness, names)
      const out = how === "failed" ? limits.failing : limits.refused
      out.add(conversation)
      limits.on = harness
      await report(world, conversation, fins.slice(0, 2), names)
      await until(`${harness} rest: the limit to hold it`, () => limits.knocks.length === 1 && rows(world, conversation).some((request) => request.status === "held" && request.digest !== undefined && (request.retry !== undefined)))
      let passed = 0
      const clock = Date.now.bind(Date)
      const time = mock.method(Date, "now", () => clock() + passed)
      passed += 7 * 60 * 60_000
      world.live.wakeDue(Date.now() + LATER)
      await until(`${harness} rest: the attempt past the budget`, () => limits.knocks.length === 2)
      await until(`${harness} rest: it to rest`, () => rows(world, conversation).some((request) => request.status === "held" && request.digest?.resting === true))
      const nextTry = () => rows(world, conversation).find((request) => request.status === "held" && request.digest?.resting)?.digest?.nextTry
      const first = nextTry()!
      assert.ok(first > Date.now(), `${harness} rest: a limit's digest has a time of its own`)
      // Not before its hour, whatever else comes round.
      passed += 59 * 60_000
      world.live.wakeDue(Date.now())
      await pause(60)
      assert.equal(limits.knocks.length, 2, `${harness} rest: nothing before the hour`)
      await world.restart()
      await until(`${harness} rest: read in`, () => world.live.snapshot(conversation) !== undefined)
      assert.equal(nextTry(), first, `${harness} rest: its time survives a restart`)
      // The hour: one attempt, for the Thread, and it rests again without starting the budget over.
      passed += 2 * 60_000
      world.live.wakeDue(Date.now())
      await until(`${harness} rest: the hour's attempt`, () => limits.knocks.length === 3)
      await until(`${harness} rest: at rest again`, () => (nextTry() ?? 0) > first)
      const again = nextTry()!
      assert.ok(!rows(world, conversation).some((request) => request.status === "held" && request.retry !== undefined), `${harness} rest: no budget starts again`)
      await pause(60)
      assert.equal(limits.knocks.length, 3, `${harness} rest: one attempt an hour`)
      await report(world, conversation, fins.slice(2), names, 2)
      assert.equal(limits.knocks.length, 3, `${harness} rest: later news joins it and knocks at nothing`)
      assert.equal(nextTry(), again, `${harness} rest: and leaves its one time where it was`)
      waitsAsOne(world, conversation, names, `${harness} rest`)
      const sent = digests(world, conversation).length
      out.clear()
      passed += 61_000
      if (release === "stop") {
        // A Stop wins over the hour: nothing goes until a Resume, and a stopped Thread isn't woken by what it holds.
        await world.live.cancel(conversation)
        passed += 2 * 60 * 60_000
        world.live.wakeDue(Date.now())
        await pause(60)
        assert.equal(digests(world, conversation).length, sent, `${harness} rest: a Stop outlasts the hour`)
        const held = rows(world, conversation).find((request) => request.status === "held" && request.digest !== undefined)!
        assert.equal(held.pause, "stop", `${harness} rest: the digest is the Stop's`)
        world.live.editQueued(conversation, { requestId: held.id, expectedText: held.text, change: { kind: "resume" } })
        await until(`${harness} rest: the resumed digest`, () => digests(world, conversation).length === sent + 1)
        await world.close()
        time.mock.restore()
        continue
      }
      if (release === "hour") {
        // Nobody says anything: the limit clears, and within the hour the Apex hears its Fins.
        passed += 61 * 60_000
        world.live.wakeDue(Date.now())
        await until(`${harness} rest: the Apex to hear, unasked`, () => digests(world, conversation).length === sent + 1)
        await until(`${harness} rest: its turn to end`, () => !rows(world, conversation).some((request) => request.status === "dispatching"))
        const heard = digests(world, conversation).slice(sent)[0]!
        for (const name of names) assert.equal(readFinReports(heard.text).reports.filter((report) => report.name === name).length, 1, `${harness} rest: ${name} heard once`)
        assert.equal(world.store.undeliveredReports().filter(({ report: kept }) => kept.status !== "progress").length, 0, `${harness} rest: nothing left unheard`)
        await world.close()
        time.mock.restore()
        continue
      }
      if (release === "message") {
        world.say(conversation, "Then this.")
        await until(`${harness} rest: their message`, () => rows(world, conversation).some((request) => request.text === "Then this." && request.status === "completed"))
      } else {
        const next = HARNESSES[(HARNESSES.indexOf(harness) + 1) % HARNESSES.length]!
        await world.live.transfer(conversation, { id: randomUUID(), provider: next, text: "Then this.", attachments: [] })
        await until(`${harness} rest: the switch's message`, () => rows(world, conversation).some((request) => request.text === "Then this." && request.status === "completed"))
      }
      const went = digests(world, conversation).slice(sent)
      assert.equal(went.length, 1, `${harness} rest: the digest went, once`)
      for (const name of names) assert.equal(readFinReports(went[0]!.text).reports.filter((report) => report.name === name).length, 1, `${harness} rest: ${name} was heard once`)
      const order = world.prompts.filter((prompt) => prompt.conversation === conversation).map((prompt) => prompt.text)
      assert.ok(order.lastIndexOf(went[0]!.text) < order.findIndex((text) => text.includes("Then this.")), `${harness} rest: the digest went first`)
      assert.equal(world.store.undeliveredReports().filter(({ report: kept }) => kept.status !== "progress").length, 0, `${harness} rest: nothing left unheard`)
      await world.close()
      time.mock.restore()
    }

    // A turn that said something heard it: what follows is a plain continuation, which the person's message supersedes, and the digest isn't told twice.
    {
      const { world, limits } = worldOf(`${harness}-heard`)
      const { conversation, fins } = await apexWithFins(world, harness, names.slice(0, 2))
      limits.failing.add(conversation)
      limits.speaking.add(conversation)
      await report(world, conversation, fins, names)
      await until(`${harness} heard: the turn to fail`, () => limits.knocks.length === 1 && rows(world, conversation).some((request) => request.status === "held" && request.continues !== undefined))
      assert.ok(!rows(world, conversation).some((request) => request.status === "held" && request.text.startsWith(FROM_AGENTS)), `${harness} heard: nothing retells it`)
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
      await until(`${harness} person: the limit to hold the digest`, () => limits.knocks.length > 0)
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
    console.log(`${harness}: a wake refused or failed at a limit knocked once for three reports, which waited as one digest and went once, across a restart, a crash mid-write, a switch, 28 failures in a row, a Stop and the person's own message`)
  }
  console.log("held digest: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
