import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PullReading } from "@mako/host/contracts/pull-waits"
import type { TurnWaitResult } from "@mako/host/contracts/thread-tools"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"

/*
 * `wait` through the agents engine (`npm run test:turn-waits`): an Apex waits on its Fin and is woken by Mako's note
 * when the Fin's result lands; a Thread waits on a time; a pull request is read by PullWatch until its outcome; waits
 * that could never end are refused; Stop and archive end the wait; and an armed wait survives a restart. GitHub is a
 * stub and time is moved by hand.
 */

const URL = "https://git.example.com/acme/app/pull/371"

function armed(result: TurnWaitResult): Extract<TurnWaitResult, { outcome: "armed" }> {
  assert.ok("outcome" in result && result.outcome === "armed", JSON.stringify(result))
  return result
}

const root = mkdtempSync(join(tmpdir(), "mako-turn-waits-"))
try {
  let offset = 0
  const now = () => Date.now() + offset
  let pull: PullReading | null = { state: "open", url: URL, author: "fin-bot", checks: [{ name: "lint", state: "running" }], reviews: [] }
  const apexTexts: string[] = []
  const fins = new Map<string, string>()
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => { release = resolve })
  let releaseSlow: (() => void) | undefined
  const slowHeld = new Promise<void>((resolve) => { releaseSlow = resolve })
  let readGate: Promise<void> | undefined
  const script: Script = async (turn) => {
    const name = fins.get(turn.conversation)
    if (!name) {
      apexTexts.push(turn.text)
      return "ok"
    }
    if (name === "slow" && turn.text.includes("You're fin:")) {
      await slowHeld
      return "Stopped before it finished."
    }
    if (name === "docs" && turn.text.includes("You're fin:")) {
      await held
      return "Wrote the docs page; nothing left open."
    }
    return "ok"
  }
  const world = new AgentsWorld({ root, script, now, readPull: async (target) => {
    if (target.number === 372) {
      await readGate
      return { state: "open", url: "https://git.example.com/acme/app/pull/372", author: "fin-bot", checks: [], reviews: [] }
    }
    return target.number === 371 ? pull : null
  } })
  const apex = await world.apex("claude", "full")
  const started = await world.agents.start(apex.caller, { brief: { objective: "Write the docs page" }, harness: "codex", name: "docs", clientKey: "docs", cwd: world.root })
  assert.ok(!("refused" in started) && started.conversation)
  fins.set(started.conversation!, "docs")
  // The Fin's turn is held open on purpose: let it start, without waiting for it to end.
  await new Promise((resolve) => setTimeout(resolve, 300))

  // Refusals: a Fin that doesn't exist, a time and both, nothing to wait on.
  const unknown = await world.agents.turnWait(apex.caller, { description: "Waiting for nobody", on: [{ fin: "ghost" }], clientKey: "ghost" })
  assert.ok("refused" in unknown && unknown.refused === "unknown-fin")
  const nothing = await world.agents.turnWait(apex.caller, { description: "Waiting", clientKey: "nothing" })
  assert.ok("refused" in nothing && nothing.refused === "never")
  const badTime = await world.agents.turnWait(apex.caller, { description: "Waiting", at: "tomorrow at nine", clientKey: "bad" })
  assert.ok("refused" in badTime && badTime.refused === "invalid")

  // An Apex waits on its Fin: the Fin's result meets the wait and Mako's note wakes the Apex, once.
  const onFin = armed(await world.agents.turnWait(apex.caller, { description: "Waiting for the docs Fin", on: [{ fin: "docs" }], clientKey: "docs" }))
  assert.deepEqual(onFin.waitsOn, ["fin:docs"])
  const listed = await world.agents.turnWait(apex.caller, { action: "list", clientKey: "list" })
  assert.ok("outcome" in listed && listed.outcome === "listed" && listed.wait?.description === "Waiting for the docs Fin")
  release!()
  await world.settle(400)
  const note = apexTexts.find((text) => text.startsWith("Mako: the wait \"Waiting for the docs Fin\" is over."))
  assert.ok(note, `the Apex hears the note: ${JSON.stringify(apexTexts)}`)
  assert.match(note!, /- fin:docs: done: Wrote the docs page; nothing left open\./)
  const request = world.live.held(apex.conversation)?.requests.find((each) => each.text === note)
  assert.deepEqual(request?.actor, { kind: "service", name: "turn-wait" }, "Mako's words, never the person's")
  await world.agents.turnWaits.settled()
  assert.equal(world.store.undeliveredTurnWaits().length, 0)

  // A Fin that has finished has no result coming: waiting on it is refused.
  const finished = await world.agents.turnWait(apex.caller, { description: "Waiting for docs again", on: [{ fin: "docs" }], clientKey: "again" })
  assert.ok("refused" in finished && finished.refused === "never", JSON.stringify(finished))

  // A time: the Thread is woken when it comes.
  armed(await world.agents.turnWait(apex.caller, { description: "Checking the deploy in a minute", seconds: 60, clientKey: "minute" }))
  offset += 61_000
  world.agents.turnWaits.check()
  await world.settle(300)
  assert.ok(apexTexts.some((text) => text.startsWith("Mako: the time you waited for has come: \"Checking the deploy in a minute\"")), JSON.stringify(apexTexts.slice(-2)))

  // A pull request: merged already is never for checks, done already for a merge; open is read until its outcome.
  pull = { ...pull!, state: "merged" }
  const mergedChecks = await world.agents.turnWait(apex.caller, { description: "Waiting for CI on #371", on: [{ pull: "acme/app#371", until: "checks" }], clientKey: "merged-checks" })
  assert.ok("refused" in mergedChecks && mergedChecks.refused === "never")
  const mergedMerge = await world.agents.turnWait(apex.caller, { description: "Waiting for #371 to merge", on: [{ pull: "acme/app#371", until: "merge" }], clientKey: "merged-merge" })
  assert.ok("outcome" in mergedMerge && mergedMerge.outcome === "already-done")
  pull = { state: "open", url: URL, author: "fin-bot", checks: [{ name: "lint", state: "running" }], reviews: [] }
  armed(await world.agents.turnWait(apex.caller, { description: "Waiting for CI on #371", on: [{ pull: URL, until: "checks" }], seconds: 3600, clientKey: "ci" }))
  assert.ok(world.agents.pulls.keys().some((key) => key.includes("371")), `PullWatch reads it: ${world.agents.pulls.keys().join()}`)
  await world.agents.pulls.tick()
  assert.ok(!apexTexts.some((text) => text.includes("CI on #371\" is over")), "running checks wake no one")

  // An armed wait survives a restart, and is met after it.
  await world.restart()
  assert.equal(world.store.armedTurnWaitOf(apex.conversation)?.description, "Waiting for CI on #371")
  pull = { ...pull, checks: [{ name: "lint", state: "passed", at: now() - 1000 }] }
  offset += 8 * 60_000
  await world.agents.pulls.tick()
  await world.settle(300)
  const ci = apexTexts.find((text) => text.startsWith("Mako: the wait \"Waiting for CI on #371\" is over."))
  assert.ok(ci, JSON.stringify(apexTexts.slice(-2)))
  assert.equal(ci, `Mako: the wait "Waiting for CI on #371" is over.\n- acme/app#371 checks: checks settled: 1 passed. ${URL}`)
  assert.equal(apexTexts.filter((text) => text === ci).length, 1, "once")

  // The host wakes from a sleep the timer slept through: the wait fires once, saying it's late.
  armed(await world.agents.turnWait(apex.caller, { description: "Checking in after lunch", seconds: 60, clientKey: "lunch" }))
  offset += 2 * 3600_000
  world.agents.woke()
  world.agents.woke()
  await world.settle(300)
  const late = apexTexts.filter((text) => text.startsWith("Mako: the time you waited for has come: \"Checking in after lunch\""))
  assert.equal(late.length, 1, "once")
  assert.match(late[0]!, /this host was asleep or off until .*, so this comes late\.$/)

  // A Fin that ends while the pull request read is pending: its check comes after the read, so the wait is refused.
  const slow = await world.agents.start(apex.caller, { brief: { objective: "Something slow" }, harness: "codex", name: "slow", clientKey: "slow", cwd: world.root })
  assert.ok(!("refused" in slow) && slow.conversation)
  fins.set(slow.conversation!, "slow")
  await new Promise((resolve) => setTimeout(resolve, 300))
  let openRead: (() => void) | undefined
  readGate = new Promise<void>((resolve) => { openRead = resolve })
  const racing = world.agents.turnWait(apex.caller, { description: "Waiting for #372 and slow", on: [{ fin: "slow" }, { pull: "acme/app#372", until: "checks" }], returnWhen: "all", clientKey: "race" })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const stopped = await world.agents.stop(apex.caller, { child: "slow" })
  assert.ok(!("refused" in stopped))
  openRead!()
  const raced = await racing
  assert.ok("refused" in raced && raced.refused === "never", `a Fin that ended during the read is refused: ${JSON.stringify(raced)}`)
  assert.equal(world.store.armedTurnWaitOf(apex.conversation), undefined, "nothing armed that could never end")
  releaseSlow!()
  readGate = undefined

  // Stop and archive end the wait without waking anyone.
  armed(await world.agents.turnWait(apex.caller, { description: "Waiting an hour", seconds: 3600, clientKey: "stop" }))
  world.agents.threadStopped(apex.conversation, "stop")
  assert.equal(world.store.armedTurnWaitOf(apex.conversation), undefined)
  armed(await world.agents.turnWait(apex.caller, { description: "Waiting an hour", seconds: 3600, clientKey: "archive" }))
  await world.agents.archived(apex.conversation)
  assert.equal(world.store.armedTurnWaitOf(apex.conversation), undefined)
  offset += 2 * 3600_000
  world.agents.turnWaits.check()
  await world.settle(300)
  assert.ok(!apexTexts.some((text) => text.includes("\"Waiting an hour\"")), "a cancelled wait never fires")
  process.stdout.write("ok wait through the engine: a Fin, a time, a pull request, refusals, Stop, archive and a restart\n")
  await world.close()
} finally {
  rmSync(root, { recursive: true, force: true })
}
