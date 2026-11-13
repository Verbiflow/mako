import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { mock } from "node:test"
import { join } from "node:path"
import { FROM_AGENTS } from "@mako/host/contracts/children"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import { AgentsWorld, HARNESSES, type Script, type WorldAccount, type WorldOptions } from "./lib/agents-world.ts"

/**
 * The outage of 2026-11-05, replayed on each of the six harnesses (`npm run test:limit-replay`): a plan runs out mid-turn
 * under a tree. Somewhere to go: the Fin at work moves with what was queued for it, the idle one and the Apex go with it,
 * the person's next message goes there, every report reaches the Apex once, nothing knocks at the harness that ran out,
 * and the person is told once. Nowhere to go: the reports wait as one digest with no failing try per report, and the first
 * turn after the limit clears carries each of them once. A Stop outlasts all of it.
 */

const root = mkdtempSync(join(tmpdir(), "mako-limit-replay-"))
const LIMIT = "You've hit your usage limit."
/** Cursor's and Claude's refusals as they read on the day, word for word. */
const REFUSALS = new Map([
  ["cursor", "Your team has reached its usage limit Please reach out to an admin to increase your limit, or return on 11/8/2026 when your usage resets."],
  ["claude", "You've hit your weekly limit · resets 1pm (America/Los_Angeles)"],
])
const CATALOGS = Object.fromEntries(["claude", "codex", "cursor", "grok", "opencode", "devin"].map((harness) => [harness, [{ id: `${harness}-model`, label: `${harness} model`, options: [] }]]))
const NAMES = ["working", "queued", "idle"] as const

async function until(what: string, ready: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** One account on each harness, with room until a case spends it. */
function everyAccount(): Record<string, WorldAccount[]> {
  return Object.fromEntries(HARNESSES.map((each) => [each, [{ name: "default" }]]))
}

const rows = (world: AgentsWorld, conversation: string): readonly LiveRequest[] => world.live.snapshot(conversation)?.requests ?? []
const heardBy = (world: AgentsWorld, conversation: string) => world.prompts.filter((prompt) => prompt.conversation === conversation)

/** A tree on `harness`: an Apex at rest over Fins, two at work and one that took its turn. */
async function tree(name: string, harness: string, accounts: Record<string, WorldAccount[]>, reset: number, refusal = LIMIT, moveOnLimit = true, readingAccounts?: WorldOptions["readingAccounts"]) {
  const knocks: string[] = []
  const state = { out: false, knocks, holdMoved: false }
  const script: Script = async (turn) => {
    if (turn.text.includes("Keep working.")) return turn.world.hold(turn.conversation).then(() => "Stopped.")
    if (state.holdMoved && turn.text.includes("[mako · moved after a usage limit]")) return turn.world.hold(turn.conversation).then(() => "Done.")
    const fin = NAMES.find((each) => turn.text.includes(`${each}: Report`))
    if (!fin || !turn.text.includes("You're fin:") || turn.harness !== harness) return `Done on ${turn.harness}.`
    // A Fin that said where it stands and rests, its work not finished: idle, not done.
    if (fin === "idle") {
      await turn.world.agents.report(turn.caller, { status: "progress", summary: "Waiting for the next part.", clientKey: "idle" })
      return "Standing by."
    }
    await turn.world.hold(turn.conversation)
    turn.world.endWith(turn.conversation, { limit: { resetsAt: reset }, fail: LIMIT })
    return "Partial work."
  }
  const order = [harness, ...HARNESSES.filter((each) => each !== harness)]
  const world = new AgentsWorld({
    root: join(root, name),
    script,
    accounts,
    selected: {},
    catalogs: CATALOGS,
    order,
    moveOnLimit: () => moveOnLimit,
    ...(readingAccounts && { readingAccounts }),
    refusePrompt: (conversation, on) => {
      if (!state.out || on !== harness) return undefined
      state.knocks.push(conversation)
      return refusal
    },
  })
  const apex = await world.apex(harness, "full")
  world.say(apex.conversation, "Start the Fins.")
  await until("the Apex's turn", () => rows(world, apex.conversation).at(-1)?.status === "completed")
  const fins: Record<string, string> = {}
  for (const each of NAMES) {
    const started = await world.agents.start(apex.caller, { brief: { objective: `${each}: Report when told.` }, harness, name: each, clientKey: each, cwd: world.root, wake: "finish" })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    fins[each] = started.conversation!
    await until(`${each} to work`, () => heardBy(world, started.conversation!).length > 0)
  }
  await until("the idle Fin to rest", () => world.live.session(fins.idle!)?.status === "ready")
  return { world, apex, fins, state }
}

/** How often a report reached the Apex, as a turn or a step of one. */
const reached = (world: AgentsWorld, conversation: string, name: string) => [...heardBy(world, conversation), ...world.steers.filter((steer) => steer.conversation === conversation)].filter((heard) => heard.text.includes(FROM_AGENTS) && heard.text.includes(`"${name}"`)).length

const said = (world: AgentsWorld, conversation: string, words: string) => heardBy(world, conversation).filter((prompt) => prompt.text.includes(words))

async function somewhereToGo(harness: string): Promise<void> {
  const next = HARNESSES.find((each) => each !== harness)!
  const accounts = everyAccount()
  const reset = Date.now() + 3 * 3_600_000
  const { world, apex, fins, state } = await tree(`${harness}-moves`, harness, accounts, reset, REFUSALS.get(harness))
  try {
    const [working, queued, idle] = [fins.working!, fins.queued!, fins.idle!]
    const actor = { kind: "agent" as const, session: world.store.journalPlacement(apex.conversation)!.session }
    world.live.submit(queued, randomUUID(), "row-one", [], undefined, undefined, undefined, actor)
    world.live.submit(queued, randomUUID(), "row-two", [], undefined, undefined, undefined, actor)
    accounts[harness]![0]!.spentUntil = reset
    state.out = true
    world.release(working)
    await until(`${harness}: the Fin at work on ${next}`, () => world.live.session(working)?.harness === next && heardBy(world, working).some((prompt) => prompt.harness === next))
    assert.ok(heardBy(world, working).at(-1)!.text.includes("[mako · moved after a usage limit]"), `${harness}: it's told it moved`)
    await until(`${harness}: the idle Fin gone with it`, () => world.live.session(idle)?.harness !== harness)
    await until(`${harness}: the Apex gone with it`, () => world.live.session(apex.conversation)?.harness !== harness)
    world.release(queued)
    await until(`${harness}: what was queued for it`, () => ["row-one", "row-two"].every((words) => said(world, queued, words).length > 0))
    await world.settle(40, 20_000, "ignore")
    assert.equal(said(world, queued, "row-one").length, 1, `${harness}: a queued message goes once`)
    assert.equal(said(world, queued, "row-two").length, 1, `${harness}: and so does the next`)
    assert.ok(said(world, queued, "row-one").every((prompt) => prompt.harness !== harness), `${harness}: not on the harness that ran out`)
    const person = world.say(apex.conversation, "Then this.")
    await until(`${harness}: the person's message`, () => rows(world, apex.conversation).find((request) => request.id === person)?.status === "completed")
    assert.notEqual(heardBy(world, apex.conversation).at(-1)!.harness, harness, `${harness}: their message went on`)
    assert.ok(rows(world, apex.conversation).every((request) => request.status !== "failed"), `${harness}: nothing of the Apex's failed`)
    // Its gathering window over, the digest goes.
    world.live.wakeDue(Date.now() + 60 * 60_000)
    await until(`${harness}: the digest`, () => !rows(world, apex.conversation).some((request) => request.digest && (request.status === "held" || request.status === "queued" || request.status === "dispatching")))
    await world.settle(40, 20_000, "ignore")
    assert.deepEqual(state.knocks.filter((conversation) => conversation === apex.conversation), [], `${harness}: nothing knocked for the Apex`)
    for (const name of ["working", "queued"]) assert.equal(reached(world, apex.conversation, name), 1, `${harness}: ${name}'s report reached the Apex once`)
    await until(`${harness}: the notice`, () => world.agents.personAsk(apex.conversation) !== undefined)
    const notices = world.agents.roster(apex.conversation).filter((agent) => agent.child?.limitNotice)
    assert.equal(notices.length, 1, `${harness}: the person is told once`)
    assert.match(notices[0]!.child!.limitNotice!.line, /ran out until .*This Thread and [23] Fins moved to /, `${harness}: and what happened: ${notices[0]!.child!.limitNotice!.line}`)
    assert.equal(world.store.finTurn(world.store.journalPlacement(apex.conversation)!.thread), undefined, `${harness}: a turn that finished leaves nowhere closed to the next one, so the harness that ran out can have it back`)
  } finally {
    await world.close()
  }
}

async function nowhereToGo(harness: string): Promise<void> {
  const reset = Date.now() + 3 * 3_600_000
  const accounts = everyAccount()
  for (const each of HARNESSES) if (each !== harness) accounts[each]![0]!.spentUntil = reset
  const { world, apex, fins, state } = await tree(`${harness}-out`, harness, accounts, reset)
  let passed = 0
  const clock = Date.now.bind(Date)
  const time = mock.method(Date, "now", () => clock() + passed)
  try {
    accounts[harness]![0]!.spentUntil = reset
    state.out = true
    world.release(fins.working!)
    world.release(fins.queued!)
    await until(`${harness}: the Fins out of accounts`, () => NAMES.slice(0, 2).every((name) => world.agents.roster(apex.conversation).find((agent) => agent.title === name || agent.child?.name === name)?.child?.state?.kind === "ended"))
    await until(`${harness}: their reports held as one`, () => rows(world, apex.conversation).filter((request) => request.status === "held" && request.digest).length === 1 && NAMES.slice(0, 2).every((name) => rows(world, apex.conversation).some((request) => request.digest && request.text.includes(`"${name}"`))))
    assert.equal(world.live.session(apex.conversation)?.harness, harness, `${harness}: the Apex has nowhere to go, and stays`)
    assert.ok(state.knocks.filter((conversation) => conversation === apex.conversation).length <= 1, `${harness}: no failing try per report: ${state.knocks.length}`)
    await until(`${harness}: the person told`, () => world.agents.personAsk(apex.conversation) !== undefined)
    assert.match(world.agents.personAsk(apex.conversation)!.line, /ran out until .*2 Fins have nowhere to go\. .*waiting for/, `${harness}: and what it means`)
    state.out = false
    accounts[harness]![0]!.spentUntil = undefined
    passed = reset - clock() + 60_000
    world.live.wakeDue(Date.now() + 60 * 60_000)
    await until(`${harness}: the first turn after`, () => heardBy(world, apex.conversation).some((prompt) => prompt.text.includes(FROM_AGENTS) && prompt.harness === harness))
    await world.settle(40, 20_000, "ignore")
    for (const name of ["working", "queued"]) assert.equal(reached(world, apex.conversation, name), 1, `${harness}: ${name} was heard once`)
  } finally {
    time.mock.restore()
    await world.close()
  }
}

/** The Apex's own digest fails at the limit with nothing done, its Fins elsewhere: it moves, and every report goes with it, word for word. */
async function digestFirst(harness: string): Promise<void> {
  const elsewhere = HARNESSES.find((each) => each !== harness)!
  const next = HARNESSES.find((each) => each !== harness && each !== elsewhere)!
  const accounts = everyAccount()
  const heard: string[] = []
  let failing = false
  const script: Script = async (turn) => {
    if (turn.text.includes(FROM_AGENTS) && turn.harness === harness && failing) {
      const session = turn.world.live.snapshot(turn.conversation)!.session
      turn.world.live.observe({ type: "live-session", session: { ...session, status: "failed", error: LIMIT } })
      return new Promise<string>(() => {})
    }
    if (turn.text.includes(FROM_AGENTS)) heard.push(turn.text)
    if (turn.text.includes("You're fin:")) return turn.world.hold(turn.conversation).then(() => "Report: all labelled.")
    return "Done."
  }
  const world = new AgentsWorld({ root: join(root, `${harness}-digest`), script, accounts, moveOnLimit: () => true, selected: {}, catalogs: CATALOGS, order: [harness, elsewhere, next] })
  try {
    const apex = await world.apex(harness, "full")
    world.say(apex.conversation, "Start the Fins.")
    await until("the Apex's turn", () => rows(world, apex.conversation).at(-1)?.status === "completed")
    const started = await world.agents.start(apex.caller, { brief: { objective: "Label it." }, harness: elsewhere, name: "labels", clientKey: "labels", cwd: world.root, wake: "finish" })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    await until(`${harness}: the Fin at work`, () => heardBy(world, started.conversation!).length > 0)
    accounts[harness]![0]!.spentUntil = Date.now() + 3 * 3_600_000
    failing = true
    world.release(started.conversation!)
    world.live.wakeDue(Date.now() + 60 * 60_000)
    await until(`${harness}: the Apex gone on`, () => world.live.session(apex.conversation)?.harness !== harness, 20_000)
    await until(`${harness}: the report heard`, () => heard.length > 0, 20_000)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(heard.length, 1, `${harness}: once`)
    assert.ok(heard[0]!.includes('"labels"') && heard[0]!.includes("all labelled"), `${harness}: its report whole, not the move's words in its place: ${heard[0]!.slice(-200)}`)
  } finally {
    await world.close()
  }
}

/** The person's own message meets the limit first, in an Apex over a Fin at rest, and in a Thread with no Fins. */
async function personFirst(harness: string): Promise<void> {
  const refusal = REFUSALS.get(harness)
  const accounts = everyAccount()
  const reset = Date.now() + 3 * 3_600_000
  const { world, apex, fins, state } = await tree(`${harness}-person`, harness, accounts, reset, refusal)
  try {
    state.out = true
    const said = world.say(apex.conversation, "The person's words.")
    await until(`${harness}: their message on the next place`, () => rows(world, apex.conversation).find((request) => request.id === said)?.status === "completed")
    assert.notEqual(world.live.session(apex.conversation)?.harness, harness, `${harness}: with Fins open the Apex moved by itself`)
    assert.equal(heardBy(world, apex.conversation).filter((prompt) => prompt.text.includes("The person's words.")).length, 1, `${harness}: their words, once and as they wrote them`)
    assert.equal(await world.agents.nextPlace(apex.conversation), undefined, `${harness}: no card: nothing is waiting`)
    const alone = await world.apex(harness, "full")
    const words = world.say(alone.conversation, "No Fins here.")
    await until(`${harness}: it to wait`, () => rows(world, alone.conversation).some((request) => request.id === words && request.retry?.cause === "rate-limited"))
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(world.live.session(alone.conversation)?.harness, harness, `${harness}: a Thread with no Fins is the person's to decide`)
    accounts[harness]![0]!.spentUntil = reset
    const next = await world.agents.nextPlace(alone.conversation)
    assert.ok(next, `${harness}: its card says where it would go`)
    assert.notEqual(next.harness, harness, `${harness}: and names the harness it would go on, for its mark`)
    assert.equal(await world.agents.continueNext(alone.conversation, randomUUID()), true, `${harness}: and one press takes it there`)
    await until(`${harness}: their message there`, () => rows(world, alone.conversation).find((request) => request.id === words)?.status === "completed")
    assert.notEqual(heardBy(world, alone.conversation).at(-1)!.harness, harness)
  } finally {
    world.release(fins.working!)
    world.release(fins.queued!)
    await world.close()
  }
}

/** Settings' switch off: nothing moves by itself, the Apex included, and the person has the card. */
async function switchOff(harness: string): Promise<void> {
  const accounts = everyAccount()
  const reset = Date.now() + 3 * 3_600_000
  const { world, apex, fins, state } = await tree(`${harness}-off`, harness, accounts, reset, LIMIT, false)
  try {
    accounts[harness]![0]!.spentUntil = reset
    state.out = true
    const said = world.say(apex.conversation, "The person's words.")
    await until(`${harness}: it to wait`, () => rows(world, apex.conversation).some((request) => request.id === said && request.retry?.cause === "rate-limited"))
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(world.live.session(apex.conversation)?.harness, harness, `${harness}: the switch off, it stays`)
    assert.ok(await world.agents.nextPlace(apex.conversation), `${harness}: and the card offers the next place`)
    assert.equal(await world.agents.continueNext(apex.conversation, randomUUID()), true)
    await until(`${harness}: their message there`, () => rows(world, apex.conversation).find((request) => request.id === said)?.status === "completed")
    assert.notEqual(heardBy(world, apex.conversation).at(-1)!.harness, harness)
  } finally {
    world.release(fins.working!)
    world.release(fins.queued!)
    await world.close()
  }
}

/** A Stop lands after a move has reworded what waits, while it reads its history: the move goes no further, and leaves no trace. */
async function stopDeclines(harness: string, edit: boolean): Promise<void> {
  const accounts = everyAccount()
  const reset = Date.now() + 3 * 3_600_000
  const { world, apex, fins, state } = await tree(`${harness}-declines${edit ? "-edit" : ""}`, harness, accounts, reset)
  const idle = fins.idle!
  let release!: () => void
  const history = new Promise<void>((resolve) => (release = resolve))
  const reading = mock.method(world.live, "historyReady", async () => { await history })
  try {
    accounts[harness]![0]!.spentUntil = reset
    state.out = true
    const row = randomUUID()
    world.live.submit(idle, row, "Also this.", [], undefined, undefined, undefined, { kind: "agent", session: world.store.journalPlacement(apex.conversation)!.session })
    await until(`${harness}: the move to say so on it`, () => rows(world, idle).find((request) => request.id === row)?.text.includes("[mako · moved after a usage limit]") === true)
    world.live.stopHolds(idle)
    await until(`${harness}: the Stop to hold it`, () => rows(world, idle).find((request) => request.id === row)?.pause === "stop")
    if (edit) {
      const words = rows(world, idle).find((request) => request.id === row)!.text
      world.live.editQueued(idle, { requestId: row, expectedText: words, change: { kind: "edit", text: "The person's own words." } })
      await until(`${harness}: their edit`, () => rows(world, idle).find((request) => request.id === row)?.text === "The person's own words.")
    }
    release()
    const words = edit ? "The person's own words." : "Also this."
    await until(`${harness}: the move retired`, () => world.store.finTurn(world.agents.roster(apex.conversation).find((agent) => agent.child?.name === "idle")!.child!.thread)?.moving === undefined)
    assert.equal(rows(world, idle).find((request) => request.id === row)?.text, words, `${harness}: the words it should have, an edit standing over the move's`)
    assert.equal(world.live.session(idle)?.harness, harness, `${harness}: it stayed`)
    assert.equal(world.store.edges().of(world.agents.roster(apex.conversation).find((agent) => agent.child?.name === "idle")!.child!.thread)?.tuned?.rerouted, undefined, `${harness}: and nothing says it moved`)
  } finally {
    release()
    reading.mock.restore()
    world.release(fins.working!)
    world.release(fins.queued!)
    await world.close()
  }
}

/** A Stop with no row to pause, while the move reads the accounts: an idle Apex, and the card, both yield to it. */
async function stopInTheRead(harness: string): Promise<void> {
  let reads = 0
  let reached = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const hold = async (_harness: string, all: boolean) => {
    if (!all || (reads += 1) === 1) return
    reached = true
    await gate
  }
  const accounts = everyAccount()
  const reset = Date.now() + 3 * 3_600_000
  const { world, apex, fins, state } = await tree(`${harness}-read`, harness, accounts, reset, LIMIT, true, hold)
  try {
    // What the idle Fin said goes first, so the Apex is at rest with an empty queue.
    world.live.wakeDue(Date.now() + 60 * 60_000)
    await until(`${harness}: an empty queue`, () => world.live.session(apex.conversation)?.status === "ready" && !rows(world, apex.conversation).some((request) => request.status === "queued" || request.status === "held" || request.status === "dispatching"))
    accounts[harness]![0]!.spentUntil = reset
    state.out = true
    // Its report would be a row for the Stop to pause, which would hide what this is here to show.
    state.holdMoved = true
    world.release(fins.working!)
    await until(`${harness}: the tree's move at the accounts`, () => reached)
    assert.deepEqual(rows(world, apex.conversation).filter((request) => request.status === "queued" || request.status === "held"), [], `${harness}: nothing for the Stop to pause`)
    world.live.stopHolds(apex.conversation)
    release()
    await until(`${harness}: the Fin at work moved`, () => world.live.session(fins.working!)?.harness !== harness)
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(world.live.session(apex.conversation)?.harness, harness, `${harness}: a Stop in the read holds an idle Apex where it is`)
  } finally {
    release()
    world.release(fins.working!)
    world.release(fins.queued!)
    await world.close()
  }
  let reachedCard = false
  let releaseCard!: () => void
  const gateCard = new Promise<void>((resolve) => (releaseCard = resolve))
  let gating = false
  const single = new AgentsWorld({
    root: join(root, `${harness}-card`),
    script: () => "Done.",
    accounts: everyAccount(),
    selected: {},
    catalogs: CATALOGS,
    order: [harness, ...HARNESSES.filter((each) => each !== harness)],
    refusePrompt: (_conversation, on) => (on === harness ? LIMIT : undefined),
    readingAccounts: async (_harness, all) => {
      if (!all || !gating) return
      reachedCard = true
      await gateCard
    },
  })
  try {
    const alone = await single.apex(harness, "full")
    const row = single.say(alone.conversation, "Keep this.")
    await until(`${harness}: it to wait`, () => rows(single, alone.conversation).some((request) => request.id === row && request.retry))
    gating = true
    const pressed = single.agents.continueNext(alone.conversation, randomUUID())
    await until(`${harness}: the card at the accounts`, () => reachedCard)
    single.live.stopHolds(alone.conversation)
    releaseCard()
    assert.equal(await pressed, false, `${harness}: a Stop in the card's read wins`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(single.live.session(alone.conversation)?.harness, harness, `${harness}: and it stays`)
  } finally {
    releaseCard()
    await single.close()
  }
}

async function stopWins(harness: string): Promise<void> {
  const accounts = everyAccount()
  const reset = Date.now() + 3 * 3_600_000
  const { world, apex, fins, state } = await tree(`${harness}-stop`, harness, accounts, reset)
  try {
    world.say(apex.conversation, "Keep working.")
    await until(`${harness}: the Apex at work`, () => world.live.session(apex.conversation)?.status === "running")
    const held = randomUUID()
    world.live.submit(apex.conversation, held, "Held by the Stop.", [])
    await world.live.cancel(apex.conversation)
    world.release(apex.conversation)
    await until(`${harness}: the Stop to hold it`, () => rows(world, apex.conversation).some((request) => request.id === held && request.pause === "stop"))
    accounts[harness]![0]!.spentUntil = reset
    state.out = true
    world.release(fins.working!)
    await until(`${harness}: the Fin moved`, () => world.live.session(fins.working!)?.harness !== harness)
    // Time for whatever would have moved it: the tree's move and its Fins' reports.
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(world.live.session(apex.conversation)?.harness, harness, `${harness}: a stopped Apex stays`)
    assert.equal(rows(world, apex.conversation).find((request) => request.id === held)?.pause, "stop", `${harness}: and what it holds waits for its Resume`)
    assert.equal(heardBy(world, apex.conversation).filter((prompt) => prompt.text.includes("Held by the Stop.")).length, 0, `${harness}: nothing went`)
  } finally {
    world.release(fins.queued!)
    await world.close()
  }
}

try {
  for (const harness of HARNESSES) {
    await somewhereToGo(harness)
    await nowhereToGo(harness)
    await digestFirst(harness)
    await personFirst(harness)
    await switchOff(harness)
    await stopDeclines(harness, false)
    await stopDeclines(harness, true)
    await stopInTheRead(harness)
    await stopWins(harness)
    console.log(`${harness}: the tree went on, every report heard once and nothing knocking; with nowhere to go one digest waited and went once; the person's message went on, or their card took it; a Stop held`)
  }
  console.log("limit replay: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
