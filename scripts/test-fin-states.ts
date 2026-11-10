import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentCaller, ChildState } from "@mako/host/contracts/agents"
import type { AgentsSendResult } from "@mako/host/contracts/agent-tools"
import { rollup } from "@mako/host/contracts/children"
import { NativeAgentSchema } from "@mako/host/contracts/native-agents"
import { SessionIdSchema } from "@mako/host/contracts/thread-identity"
import { FROM_AGENTS, WAKE_COALESCE_MS } from "@mako/host/conversations/agent-wakes"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { AgentsWorld, HARNESSES, type Script } from "./lib/agents-world.ts"
import { rosterWindow } from "./lib/roster-window.ts"

/**
 * A Fin reads working only while a turn of it runs or a message is on its way
 * there (`npm run test:fin-states`). Four Fins an Apex stopped while the host
 * stalled read working for a day, held a place against the Mac's room, and
 * took no message: the stop paused what was queued, and a paused message
 * first in line holds the ones behind it, so every message after (the
 * Apex's, and its own Fins' digests) waited behind it forever, for a Resume
 * nobody presses on a Fin, while the queue read as work. Covered, a Fin on
 * each of the six harnesses: a message after a stop goes, what the stop
 * paused follows it, and the room it held is free; a message behind one the
 * person paused to edit reads as no work, and nothing goes ahead of it, a
 * new message or a stop and a restart between; a stopped Fin that's an Apex
 * hears its own Fins only once resumed, after the message that resumed it, a
 * restart between; a stopped Fin never
 * reads working, and a stop ends a turn still running in it; a turn the
 * harness failed leaves no message stuck behind it.
 */
const root = mkdtempSync(join(tmpdir(), "mako-fin-states-"))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, done: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}

function sent(result: AgentsSendResult) {
  assert.ok(!("refused" in result), `refused: ${"refused" in result ? result.why : ""}`)
  return result
}

/** A world whose Apex runs on Cursor, with `script` answering its Fins' turns and "ok" for the Apex's. */
function worldOf(name: string, script: (turn: Parameters<Script>[0]) => Promise<string | undefined> | string | undefined, budget = { running: 1, started: 100 }): AgentsWorld {
  return new AgentsWorld({ root: join(root, name), budget, script: async (turn) => (await script(turn)) ?? "ok" })
}

function stateOf(world: AgentsWorld, apex: string, name: string): ChildState | undefined {
  return world.agents.roster(apex).find((entry) => entry.child?.name === name)?.child?.state
}

function promptsOf(world: AgentsWorld, conversation: string): string[] {
  // Classify the delivered user payload; Mako's note can repeat instructions that overtook it.
  return world.prompts.filter((prompt) => prompt.conversation === conversation).map((prompt) => prompt.text.replace(/^<mako-local-control>[\s\S]*?<\/mako-local-control>\n\n/, ""))
}

function requestOf(world: AgentsWorld, conversation: string, words: string) {
  return world.live.snapshot(conversation)?.requests.find((request) => request.text.includes(words))
}

async function startFin(world: AgentsWorld, caller: AgentCaller, name: string, harness: string): Promise<string> {
  const started = await world.agents.start(caller, { brief: { objective: `Work as ${name}` }, harness, name, clientKey: name, cwd: world.root })
  assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
  return started.conversation!
}

try {
  for (const harness of HARNESSES) {
    // A message after a stop goes; what the stop paused waits for its Resume without holding anything else back.
    {
      let first = true
      const world = worldOf(`after-stop-${harness}`, (turn) => {
        if (!turn.text.includes("fin:labels") && !turn.text.includes("Carry on.")) return turn.text.includes("fin:second") ? "Second done." : undefined
        if (!first) return "Labels finished."
        first = false
        return turn.world.hold(turn.conversation).then(() => "Cut short.")
      })
      const apex = await world.apex("cursor", "full")
      const fin = await startFin(world, apex.caller, "labels", harness)
      await until("the Fin to work", () => world.live.session(fin)?.status === "running")
      assert.equal(sent(await world.agents.send(apex.caller, { to: "labels", text: "Also do the README.", clientKey: "readme" })).delivery, "queued")
      const stopped = await world.agents.stop(apex.caller, { child: "labels", reason: "the host is stalling" })
      assert.deepEqual("stopped" in stopped && stopped.stopped, ["labels"])
      await until("the stop", () => stateOf(world, apex.conversation, "labels")?.kind === "ended")
      assert.equal(requestOf(world, fin, "Also do the README.")?.status, "held", "the stop paused what was queued")
      const resumed = sent(await world.agents.send(apex.caller, { to: "labels", text: "Carry on.", clientKey: "go" }))
      assert.equal(resumed.delivery, "turn", "a stopped Fin with a paused message takes a new one now")
      await until(`${harness}: the message after the stop, then the one the stop paused, to reach its harness`, () => promptsOf(world, fin).some((text) => text.includes("Also do the README.")))
      assert.deepEqual(promptsOf(world, fin).slice(1).map((text) => text.includes("Carry on.") ? "carry on" : text.includes("Also do the README.") ? "readme" : text.slice(0, 60)), ["carry on", "readme"], "the message that resumed it goes first")
      const deliveredReadme = world.prompts.find((prompt) => prompt.conversation === fin && prompt.text.endsWith("Also do the README."))?.text ?? ""
      assert.match(deliveredReadme, /queued before newer instructions/, "the old work still carries the newer resume instruction as provenance")
      await until("its turns to end", () => { const state = stateOf(world, apex.conversation, "labels"); return state?.kind === "ended" && state.outcome === "done" })
      const second = await world.agents.start(apex.caller, { brief: { objective: "Work as second" }, harness, name: "second", clientKey: "second", cwd: world.root })
      assert.ok(!("refused" in second) && second.state !== "queued", `${harness}: a Fin done with a paused message holds no room: ${JSON.stringify(second)}`)
      await world.close()
    }

    // A message behind one the person paused to edit keeps its place behind it, and reads as no work.
    {
      let fin = ""
      let turns = 0
      const world = worldOf(`edit-pause-${harness}`, (turn) => {
        if (turn.conversation !== fin && !turn.text.includes("fin:labels")) return undefined
        turns += 1
        return turns === 1 ? turn.world.hold(turn.conversation).then(() => "First half done.") : "Done."
      })
      const apex = await world.apex("cursor", "full")
      fin = await startFin(world, apex.caller, "labels", harness)
      await until("the Fin to work", () => world.live.session(fin)?.status === "running")
      sent(await world.agents.send(apex.caller, { to: "labels", text: "Then the README.", clientKey: "readme" }))
      sent(await world.agents.send(apex.caller, { to: "labels", text: "Then the CHANGELOG.", clientKey: "changelog" }))
      const readme = requestOf(world, fin, "Then the README.")!
      world.live.editQueued(fin, { requestId: readme.id, expectedText: readme.text, change: { kind: "pause" } })
      // The Apex sends again while the person edits: the message being edited stays theirs, paused, in its place.
      sent(await world.agents.send(apex.caller, { to: "labels", text: "And the LICENSE.", clientKey: "license" }))
      assert.equal(requestOf(world, fin, "Then the README.")?.status, "held", `${harness}: a new message doesn't resume one the person is editing`)
      const journal = new LiveJournal(join(world.root, "journals"), fin)
      assert.equal(journal.read()?.requests.find((request) => request.text.includes("Then the README."))?.editing, true, "the journal keeps that it's being edited")
      journal.close()
      world.release(fin)
      await until("its turn to end", () => world.live.session(fin)?.status === "ready")
      await pause(300)
      assert.equal(promptsOf(world, fin).length, 1, "nothing jumps ahead of a message being edited")
      assert.notEqual(stateOf(world, apex.conversation, "labels")?.kind, "working", `${harness}: a queue held by the person's edit is no work`)
      const notices = await Promise.all([0, 1].map(() => world.agents.send(apex.caller, { to: "labels", text: "And the NOTICE.", clientKey: "notice" })))
      const waiting = sent(notices[0]!)
      assert.equal(waiting.delivery, "queued", `${harness}: saving a message behind an edit is not starting its turn`)
      assert.match(waiting.hears, /paused for editing/, `${harness}: the receipt names the actual hold`)
      const waitingState = stateOf(world, apex.conversation, "labels")
      assert.ok(waitingState?.kind === "blocked" && waitingState.on === "person", `${harness}: pending work is visible instead of the old done report`)
      const repeated = sent(await world.agents.send(apex.caller, { to: "labels", text: "And the NOTICE.", clientKey: "notice" }))
      assert.equal(repeated.delivery, "queued")
      assert.equal(repeated.deduped, true)
      assert.equal(world.live.snapshot(fin)?.requests.filter(request => request.text.includes("And the NOTICE.")).length, 1, "concurrent and repeated messages are one durable request")
      const counted = await world.agents.list(apex.caller, {})
      assert.ok("tree" in counted)
      assert.equal(counted.tree.running, 0, "held work occupies no concurrent Fin slot")
      assert.equal(counted.tree.started, 1, "messaging reuses its one lifetime admission")
      assert.equal(rollup(world.agents.roster(apex.conversation)).needs, 1, "the shared UI count includes the held Fin")
      if (harness === "claude") {
        const window = rosterWindow()
        try {
          const snapshot = world.live.snapshot(apex.conversation)
          assert.ok(snapshot)
          const view = await window.ask({ kind: "init", snapshot, listed: true })
          const drawn = z.object({ children: z.array(NativeAgentSchema) }).parse(JSON.parse(view.drawn))
          const fin = drawn.children.find(child => child.child?.name === "labels")
          assert.equal(fin?.child?.state?.kind, "blocked", "the actual renderer selector preserves the held Fin and its state")
          assert.equal(rollup(drawn.children).needs, 1)
        } finally { window.close() }
      }
      await world.restart()
      const afterRestart = sent(await world.agents.send(apex.caller, { to: "labels", text: "And the NOTICE.", clientKey: "notice" }))
      assert.equal(afterRestart.delivery, "queued")
      assert.match(afterRestart.hears, /paused for editing/)
      assert.equal(afterRestart.deduped, true)
      world.live.editQueued(fin, { requestId: readme.id, expectedText: readme.text, change: { kind: "resume" } })
      await until("all four to go, in order", () => promptsOf(world, fin).length === 5)
      assert.deepEqual(promptsOf(world, fin).slice(1).map((text) => /Then the README\.|Then the CHANGELOG\.|And the LICENSE\.|And the NOTICE\./.exec(text)?.[0]), ["Then the README.", "Then the CHANGELOG.", "And the LICENSE.", "And the NOTICE."])
      await world.close()
    }

    // A stop beside the person's edit: the message that resumes the Fin waits behind the one being edited, across a restart.
    {
      let fin = ""
      let turns = 0
      const world = worldOf(`edit-and-stop-${harness}`, (turn) => {
        if (turn.conversation !== fin && !turn.text.includes("fin:labels")) return undefined
        turns += 1
        return turns === 1 ? turn.world.hold(turn.conversation).then(() => "Cut short.") : "Done."
      })
      const apex = await world.apex("cursor", "full")
      fin = await startFin(world, apex.caller, "labels", harness)
      await until("the Fin to work", () => world.live.session(fin)?.status === "running")
      sent(await world.agents.send(apex.caller, { to: "labels", text: "Then the README.", clientKey: "a" }))
      sent(await world.agents.send(apex.caller, { to: "labels", text: "Then the CHANGELOG.", clientKey: "b" }))
      const readme = requestOf(world, fin, "Then the README.")!
      world.live.editQueued(fin, { requestId: readme.id, expectedText: readme.text, change: { kind: "pause" } })
      await world.agents.stop(apex.caller, { child: "labels", reason: "pausing" })
      await until("the stop", () => world.live.session(fin)?.status !== "running")
      sent(await world.agents.send(apex.caller, { to: "labels", text: "Carry on.", clientKey: "c" }))
      await pause(300)
      assert.equal(promptsOf(world, fin).length, 1, `${harness}: nothing jumps ahead of the message the person is editing`)
      await world.restart()
      await pause(300)
      assert.equal(requestOf(world, fin, "Then the README.")?.status, "held", `${harness}: a restart keeps the person's edit hold`)
      assert.equal(requestOf(world, fin, "Then the README.")?.editing, true)
      assert.equal(promptsOf(world, fin).length, 1, `${harness}: nor does a restart send anything past it`)
      world.live.editQueued(fin, { requestId: readme.id, expectedText: readme.text, change: { kind: "resume" } })
      await until("all three to go", () => promptsOf(world, fin).length === 4)
      // The journal keeps the order the resume made (`request_order`), across the restart.
      assert.deepEqual(promptsOf(world, fin).slice(1).map((text) => /Then the README\.|Carry on\.|Then the CHANGELOG\./.exec(text)?.[0]), ["Then the README.", "Carry on.", "Then the CHANGELOG."],
        "the person's message, then the one that resumed the Fin, then what the stop paused")
      await world.close()
    }

    // A stopped Fin that's an Apex hears its own Fins once it's resumed, after the message that resumed it, a restart between.
    {
      let lead = ""
      let leadTurns = 0
      const world = worldOf(`stopped-apex-${harness}`, async (turn) => {
        if (turn.text.includes("fin:sub")) return turn.world.hold(turn.conversation).then(() => "Sub finished.")
        if (turn.conversation !== lead && !turn.text.includes("fin:lead")) return undefined
        leadTurns += 1
        if (leadTurns === 1) {
          await startFin(turn.world, turn.caller, "sub", harness)
          return turn.world.hold(turn.conversation).then(() => "Cut short.")
        }
        return "Lead carried on."
      }, { running: 5, started: 100 })
      const apex = await world.apex("cursor", "full")
      lead = await startFin(world, apex.caller, "lead", harness)
      await until("the lead's Fin to work", () => world.agents.roster(lead).some((entry) => entry.child?.name === "sub" && entry.child.state?.kind === "working"))
      const sub = world.agents.roster(lead).find((entry) => entry.child?.name === "sub")!.child!.conversation!
      assert.deepEqual("stopped" in (await world.agents.stop(apex.caller, { child: "lead", reason: "pausing" })) && true, true)
      await until("the lead to stop", () => stateOf(world, apex.conversation, "lead")?.kind === "ended")
      world.release(sub)
      await until("the sub's report", () => world.agents.roster(lead).find((entry) => entry.child?.name === "sub")?.child?.state?.kind === "ended")
      await pause(WAKE_COALESCE_MS + 600)
      await world.settle(600, 20_000, "ignore")
      assert.equal(promptsOf(world, lead).length, 1, `${harness}: a stopped Fin takes no turn for its own Fins' news`)
      assert.deepEqual(stateOf(world, apex.conversation, "lead"), { kind: "ended", outcome: "stopped", reason: "pausing" })
      await world.restart()
      await world.settle(600, 20_000, "ignore")
      assert.equal(promptsOf(world, lead).length, 1, `${harness}: nor after a restart`)
      assert.deepEqual(stateOf(world, apex.conversation, "lead"), { kind: "ended", outcome: "stopped", reason: "pausing" })
      sent(await world.agents.send(world.caller(apex.conversation), { to: "lead", text: "Carry on.", clientKey: "go" }))
      await until(`${harness}: the lead to hear its Fin after the message`, () => promptsOf(world, lead).some((text) => text.startsWith(FROM_AGENTS)))
      const after = promptsOf(world, lead).slice(1)
      assert.ok(after[0]!.includes("Carry on."), `the message that resumed it goes first: ${after[0]}`)
      assert.match(after.find((text) => text.startsWith(FROM_AGENTS))!, /"sub" \(\w+\) done: Sub finished\./)
      await world.close()
    }

    // A stopped Fin never reads working, and a stop ends a turn still running in it.
    {
      let fin = ""
      const world = worldOf(`stop-again-${harness}`, (turn) => {
        if (turn.conversation !== fin && !turn.text.includes("fin:labels")) return undefined
        return turn.world.hold(turn.conversation).then(() => "Cut short.")
      })
      const apex = await world.apex("cursor", "full")
      fin = await startFin(world, apex.caller, "labels", harness)
      await until("the Fin to work", () => world.live.session(fin)?.status === "running")
      await world.agents.stop(apex.caller, { child: "labels", reason: "first stop" })
      await until("the stop", () => world.live.session(fin)?.status !== "running")
      // A message an older build sent a stopped Fin as a turn of its own, as its Fins' digests went.
      world.live.submit(fin, randomUUID(), `${FROM_AGENTS}\n1 finished`, [], undefined, undefined, undefined, { kind: "agent", session: SessionIdSchema.parse(world.store.journalPlacement(apex.conversation)?.session) })
      await until("that turn to run", () => world.live.session(fin)?.status === "running")
      assert.deepEqual(stateOf(world, apex.conversation, "labels"), { kind: "ended", outcome: "stopped", reason: "first stop" }, `${harness}: a stopped Fin doesn't read working`)
      const again = await world.agents.stop(apex.caller, { child: "labels", reason: "stop it all" })
      assert.deepEqual("stopped" in again && again.stopped, ["labels"], `${harness}: a stop ends what still runs in a stopped Fin`)
      await until("its turn to end", () => world.live.session(fin)?.status !== "running")
      await world.close()
    }

    // A turn the harness failed for good leaves no message stuck behind it (one it fails for now continues by itself: test:delivery-retry).
    {
      let fin = ""
      let turns = 0
      const world = worldOf(`failed-${harness}`, async (turn) => {
        if (turn.conversation !== fin && !turn.text.includes("fin:labels")) return undefined
        turns += 1
        if (turns > 1) return "Labels finished."
        await turn.world.hold(turn.conversation)
        const session = turn.world.live.snapshot(turn.conversation)!.session
        turn.world.live.observe({ type: "live-session", session: { ...session, status: "failed", error: "The model API refused the request: encrypted_content could not be verified" } })
        return new Promise<string>(() => {})
      })
      const apex = await world.apex("cursor", "full")
      fin = await startFin(world, apex.caller, "labels", harness)
      await until("the Fin to work", () => world.live.session(fin)?.status === "running")
      sent(await world.agents.send(apex.caller, { to: "labels", text: "Also do the README.", clientKey: "readme" }))
      world.release(fin)
      // Failure sends nothing queued by itself: what waits behind it is no work, and the Fin reads failed.
      await until(`${harness}: the failed Fin to read failed`, () => stateOf(world, apex.conversation, "labels")?.kind === "ended")
      await pause(300)
      assert.deepEqual(stateOf(world, apex.conversation, "labels"), { kind: "ended", outcome: "failed", reason: "The model API refused the request: encrypted_content could not be verified" })
      assert.equal(requestOf(world, fin, "Also do the README.")?.status, "queued")
      // A new message goes, and what waited behind the failure follows it.
      assert.equal(sent(await world.agents.send(apex.caller, { to: "labels", text: "Retry the labels.", clientKey: "retry" })).delivery, "turn")
      await until(`${harness}: both to reach its harness`, () => promptsOf(world, fin).some((text) => text.includes("Also do the README.")))
      const after = promptsOf(world, fin).slice(1)
      assert.ok(after[0]!.includes("Retry the labels.") && after[1]!.includes("Also do the README."), JSON.stringify(after.map((text) => text.slice(0, 80))))
      await until("it to finish", () => { const state = stateOf(world, apex.conversation, "labels"); return state?.kind === "ended" && state.outcome === "done" })
      await world.close()
    }
    console.log(`${harness}: a message after a stop went and the room was free; a stopped Apex heard its Fins once resumed; a stopped Fin never read working and a stop ended its turn; a failed turn left nothing stuck; an edit-paused queue kept its order and read as no work`)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("fin states: ok")
