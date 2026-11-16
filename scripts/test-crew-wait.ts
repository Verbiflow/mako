import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CREW_WAIT, CREW_WAIT_S } from "@mako/host/contracts/turn-waits"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"

/*
 * The crew check-in (`npm run test:turn-waits`): an Apex whose turn ends with a Fin at work and no wait of its own
 * armed waits an hour for the crew (Mako's own wait, `armedBy: mako`); at the hour it hears how each Fin stands, as
 * Mako's words. A wait its agent armed is never replaced by it; one due while the Apex is at work, or with no Fin at
 * work, passes quietly; with no Fin at work none is armed. Time is moved by hand.
 */

const root = mkdtempSync(join(tmpdir(), "mako-crew-wait-"))
try {
  let offset = 0
  const now = () => Date.now() + offset
  const apexTexts: string[] = []
  const fins = new Set<string>()
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => { release = resolve })
  let longTurn: (() => void) | undefined
  const script: Script = async (turn) => {
    if (!fins.has(turn.conversation)) {
      apexTexts.push(turn.text)
      if (turn.text.endsWith("A long turn")) await new Promise<void>((resolve) => { longTurn = resolve })
      return "ok"
    }
    if (turn.text.includes("You're fin:")) {
      await held
      return "Wrote the docs page; nothing left open."
    }
    return "ok"
  }
  const world = new AgentsWorld({ root, script, now })
  const apex = await world.apex("claude", "full")
  /** The Apex's turn has ended: the Fin's turn is held on purpose, so the world never settles while it works. */
  const apexDone = async (what: string) => {
    const deadline = Date.now() + 10_000
    await new Promise((resolve) => setTimeout(resolve, 100))
    while (world.live.atWork(apex.conversation)) {
      if (Date.now() > deadline) throw new Error(`the Apex still at work: ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const crewOf = () => {
    const armed = world.store.armedTurnWaitOf(apex.conversation)
    return armed?.armedBy === "mako" ? armed : undefined
  }

  // No Fin yet: the Apex's turn ends with nothing armed.
  world.say(apex.conversation, "Plan the docs work")
  await world.settle(200)
  assert.equal(world.store.armedTurnWaitOf(apex.conversation), undefined, "no Fin at work, no check-in")

  const started = await world.agents.start(apex.caller, { brief: { objective: "Write the docs page" }, harness: "codex", name: "docs", clientKey: "docs", cwd: world.root })
  assert.ok(!("refused" in started) && started.conversation)
  fins.add(started.conversation!)
  await new Promise((resolve) => setTimeout(resolve, 300))

  // Its turn ends with the Fin at work: Mako waits an hour for the crew, as Mako's own wait.
  world.say(apex.conversation, "Start the docs Fin and wait")
  await apexDone("its turn")
  const crew = crewOf()
  assert.ok(crew, "a check-in is armed")
  assert.equal(crew.description, CREW_WAIT)
  assert.deepEqual(crew.items, [], "on time alone: each Fin's report wakes the Apex as ever")
  assert.ok(crew.endsBy! - now() > (CREW_WAIT_S - 5) * 1000 && crew.endsBy! - now() <= CREW_WAIT_S * 1000, "an hour on")
  assert.deepEqual(world.live.snapshot(apex.conversation)?.turnWait?.description, CREW_WAIT, "the person's line says so")

  // At the hour, the Apex hears how the crew stands, as Mako's words.
  const before = apexTexts.length
  offset += CREW_WAIT_S * 1000 + 1000
  world.agents.turnWaits.check()
  await apexDone("the check-in's turn")
  const note = apexTexts.slice(before).find((text) => text.startsWith("Mako: an hour passed with one of your Fins at work"))
  assert.ok(note, `the check-in's note: ${JSON.stringify(apexTexts.slice(before))}`)
  assert.match(note, /^- fin:docs: .+/m, "each Fin and how it stands")
  assert.match(note, /agents_read/)
  const request = world.live.held(apex.conversation)?.requests.find((each) => each.text === note)
  assert.deepEqual(request?.actor, { kind: "service", name: "turn-wait" }, "Mako's words, never the person's")
  // That turn's end arms the next hour.
  const next = crewOf()
  assert.ok(next && next.id !== crew.id, "the turn the check-in started arms the next one as it ends")

  // A wait the agent armed itself is never replaced by the check-in.
  const own = await world.agents.turnWait(apex.caller, { description: "Waiting for the docs Fin", on: [{ fin: "docs" }], clientKey: "own" })
  assert.ok("outcome" in own && own.outcome === "armed", JSON.stringify(own))
  world.say(apex.conversation, "Anything new?")
  await apexDone("anything new")
  assert.equal(world.store.armedTurnWaitOf(apex.conversation)?.description, "Waiting for the docs Fin", "the agent's own wait stands")
  await world.agents.turnWait(apex.caller, { action: "cancel", clientKey: "own-cancel" })

  // One due while the Apex is at work passes quietly: its turn's end arms the next.
  world.say(apex.conversation, "Check in again")
  await apexDone("check in again")
  const quiet = crewOf()
  assert.ok(quiet)
  world.say(apex.conversation, "A long turn")
  const longBy = Date.now() + 10_000
  while (!longTurn) {
    if (Date.now() > longBy) throw new Error(`the long turn never started: ${JSON.stringify(apexTexts.slice(-2))}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(world.live.atWork(apex.conversation))
  const duringTurn = apexTexts.length
  offset += CREW_WAIT_S * 1000 + 1000
  world.agents.turnWaits.check()
  await new Promise((resolve) => setTimeout(resolve, 200))
  longTurn()
  await apexDone("the long turn")
  assert.ok(!apexTexts.slice(duringTurn).some((text) => text.startsWith("Mako: an hour passed")), "due mid-turn, it says nothing")
  assert.equal(world.store.turnWaitsOf(apex.conversation).find((wait) => wait.id === quiet.id)?.state, "fired")

  // It backs off: a Fin working through check-ins wakes the Apex once per step, at 1 h, 2 h, 4 h, then 8 h and 8 h on.
  const notes = () => apexTexts.filter((text) => /^Mako: (an hour|\d+ hours) passed with /.test(text))
  const check = async () => {
    world.agents.turnWaits.check()
    await apexDone("a check-in")
  }
  for (const [step, hours] of [[0, 1], [1, 2], [2, 4], [3, 8], [3, 8]] as const) {
    const wait = crewOf()
    assert.ok(wait, `a check-in at step ${step}`)
    assert.equal(wait.crewStep ?? 0, step, `step ${step}`)
    assert.equal(Math.round((wait.endsBy! - wait.createdAt) / 3600_000), hours, `${hours} h at step ${step}`)
    const heard = notes().length
    offset += (hours * 3600_000) / 2
    await check()
    assert.equal(notes().length, heard, `nothing halfway through ${hours} h`)
    offset += (hours * 3600_000) / 2 + 1000
    await check()
    assert.equal(notes().length, heard + 1, `one wake at ${hours} h`)
    if (hours > 1) assert.match(notes().at(-1)!, new RegExp(`^Mako: ${hours} hours passed with one of your Fins at work`))
  }
  // A turn the person starts brings it back to an hour.
  world.say(apex.conversation, "How's the build?")
  await apexDone("the person's turn")
  assert.equal(crewOf()?.crewStep ?? 0, 0, "reset by the person's turn")
  // A Fin that reports, or shows work, isn't quiet: the check-in passes quietly and is armed again, an hour on after
  // the report.
  world.say(apex.conversation, "Back off again")
  await apexDone("a turn")
  offset += 3600_000 + 1000
  await check()
  const stepped = crewOf()
  assert.equal(stepped?.crewStep, 1, "backed off once more")
  const finCaller = world.caller(started.conversation!)
  const reported = await world.agents.report(finCaller, { status: "progress", summary: "Still building: 60% through.", clientKey: "still" })
  assert.ok(!("refused" in reported), JSON.stringify(reported))
  const heardBefore = notes().length
  offset += 2 * 3600_000 + 1000
  await check()
  assert.equal(notes().length, heardBefore, "a Fin that reported isn't quiet: no wake")
  const afterReport = crewOf()
  assert.ok(afterReport && afterReport.id !== stepped!.id, "armed again")
  assert.equal(afterReport.crewStep ?? 0, 0, "an hour on, after a report")
  offset += 55 * 60_000
  world.agents.active(started.conversation!)
  offset += 5 * 60_000 + 1000
  await check()
  assert.equal(notes().length, heardBefore, "a Fin that showed work within QUIET_MS isn't quiet: no wake")
  assert.equal(crewOf()?.crewStep ?? 0, 0, "armed again at its step")

  // The Fin finishes: its report wakes the Apex as ever, and that turn ends with no check-in; one still armed then
  // passes quietly at its hour.
  const left = crewOf()
  release!()
  await world.settle(400, undefined, "ignore")
  const after = crewOf()
  assert.ok(!after || after.id === left?.id, "no new check-in once no Fin is at work")
  const finished = apexTexts.length
  offset += CREW_WAIT_S * 1000 + 1000
  world.agents.turnWaits.check()
  await world.settle(300, undefined, "ignore")
  assert.ok(!apexTexts.slice(finished).some((text) => text.startsWith("Mako: an hour passed")), "with no Fin at work, it says nothing")
  assert.equal(crewOf(), undefined)

  process.stdout.write("ok crew check-in: armed when an Apex's turn ends with Fins at work, its hour's note, never over the agent's own wait, quiet mid-turn or with no Fin at work\n")
  await world.close()
} finally {
  rmSync(root, { recursive: true, force: true })
}
