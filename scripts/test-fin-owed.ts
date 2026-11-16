import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FROM_AGENTS } from "@mako/host/contracts/children"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"

/**
 * A reply owed (`docs/delivery-queue.md`, rule 17; `npm run test:orch-comms`): a question its Apex sent with
 * `expects: "answer"` that the Fin's harness took is owed an answer. A result settles it, and so does progress that
 * hands work on, waits on someone else or names it in `answers`; progress on a wait Mako watches doesn't. A turn that
 * ends owing one hears one reminder on its next turn; a second that ends owing it tells its Apex once. A task, a
 * `reply: none` message and a brief owe nothing beyond their result.
 */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, done: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(20)
  }
}

const REMINDER = "You haven't answered your Apex's message"
const ASK = "What's the status of #12?"
const waiting = { kind: "pull-request" as const, ref: "acme/app#12", until: "checks" as const }

// Progress on a watched wait isn't an answer: one reminder, then its Apex hears it once. A reply: none message owes nothing.
{
  const root = mkdtempSync(join(tmpdir(), "mako-fin-owed-"))
  let n = 0
  const script: Script = async (turn) => {
    if (turn.text.includes("You're fin:")) return "Started."
    if (turn.text.includes(FROM_AGENTS) || !turn.text.includes("fin:")) {
      // A Fin's own turns: progress on the PR's checks every time, which its Apex's question isn't answered by.
      n += 1
      if (turn.text.includes(ASK) || turn.text.includes("Also:") || turn.text.includes("FYI:")) {
        await turn.world.agents.report(turn.caller, { status: "progress", summary: `Pushed again; waiting on #12's checks (${n}).`, waitingOn: [waiting], clientKey: `progress-${n}` })
      }
      return "ok"
    }
    return "ok"
  }
  const world = new AgentsWorld({ root, script, readPull: async () => null })
  try {
    const apex = await world.apex("claude", "full")
    const started = await world.agents.start(apex.caller, { brief: { objective: "Land #12." }, harness: "codex", name: "lander", clientKey: "lander", cwd: world.root })
    assert.ok(!("refused" in started) && started.conversation)
    const fin = started.conversation!
    await world.settle(300, 20_000, "ignore")
    const finPrompts = () => world.prompts.filter((prompt) => prompt.conversation === fin).map((prompt) => prompt.text)
    const apexHeard = () => world.prompts.filter((prompt) => prompt.conversation === apex.conversation).map((prompt) => prompt.text)

    const fyi = await world.agents.send(apex.caller, { to: "lander", text: "FYI: main moved.", reply: "none", clientKey: "fyi" })
    assert.ok(!("refused" in fyi))
    await world.settle(300, 20_000, "ignore")
    const ask = await world.agents.send(apex.caller, { to: "lander", text: ASK, expects: "answer", clientKey: "ask" })
    assert.ok(!("refused" in ask) && "request" in ask, JSON.stringify(ask))
    await world.settle(300, 20_000, "ignore")
    assert.ok(!finPrompts().some((text) => text.includes(REMINDER)), "no reminder before a turn ended owing it")
    const also = await world.agents.send(apex.caller, { to: "lander", text: "Also: rebase on main.", clientKey: "also" })
    assert.ok(!("refused" in also))
    await until("the next turn", () => finPrompts().some((text) => text.includes("Also: rebase")))
    const next = finPrompts().find((text) => text.includes("Also: rebase"))!
    assert.ok(next.includes(REMINDER) && next.includes(ASK.slice(0, 20)), `the turn after a miss carries the reminder: ${next.slice(0, 600)}`)
    assert.ok(!next.includes("FYI: main moved"), "a reply: none message owes nothing")
    const reminders = () => finPrompts().flatMap((text) => text.split("\n").filter((line) => line.startsWith(REMINDER)))
    assert.ok(!reminders().some((line) => line.includes("Also: rebase")), `nor a task: its answer is its result: ${reminders().join(" | ")}`)
    await world.settle(400, 20_000, "ignore")
    await until("its Apex to hear it went unanswered", () => apexHeard().some((text) => text.includes("hasn't answered your message")))
    const told = apexHeard().filter((text) => text.includes("hasn't answered your message"))
    assert.equal(told.length, 1, "once")
    assert.ok(told[0]!.includes(ASK.slice(0, 20)), told[0])
    assert.equal(finPrompts().filter((text) => text.includes(REMINDER) && text.includes(ASK.slice(0, 20))).length, 1, "the reminder went once")
    console.log("owed: progress on a watched wait left the question open; one reminder, then its Apex heard it once; a reply: none message owed nothing")
  } finally {
    await world.close()
    rmSync(root, { recursive: true, force: true })
  }
}

// Progress naming it in `answers` settles it and wakes the Apex; a result settles it with nothing more said.
{
  const root = mkdtempSync(join(tmpdir(), "mako-fin-owed-answers-"))
  const script: Script = async (turn) => {
    if (turn.text.includes("You're fin:")) return "Started."
    // The reminder quotes the question, so it's read first.
    const reminded = /\(request ([0-9a-f-]{36})\)/.exec(turn.text)?.[1]
    if (!reminded && turn.text.includes(ASK)) {
      await turn.world.agents.report(turn.caller, { status: "progress", summary: "Waiting on #12's checks.", waitingOn: [waiting], clientKey: "first" })
      return "ok"
    }
    if (reminded) {
      await turn.world.agents.report(turn.caller, { status: "progress", summary: "#12: two checks pass, e2e still running; I'll land it once it passes.", waitingOn: [waiting], answers: [reminded], clientKey: "answer" })
      return "ok"
    }
    if (turn.text.includes("Then: tidy the docs.")) return "Docs tidied."
    return "ok"
  }
  const world = new AgentsWorld({ root, script, readPull: async () => null })
  try {
    const apex = await world.apex("claude", "full")
    const started = await world.agents.start(apex.caller, { brief: { objective: "Land #12." }, harness: "codex", name: "lander", clientKey: "lander", cwd: world.root })
    assert.ok(!("refused" in started) && started.conversation)
    const fin = started.conversation!
    await world.settle(300, 20_000, "ignore")
    assert.ok(!("refused" in await world.agents.send(apex.caller, { to: "lander", text: ASK, expects: "answer", clientKey: "ask" })))
    await world.settle(300, 20_000, "ignore")
    assert.ok(!("refused" in await world.agents.send(apex.caller, { to: "lander", text: "And: keep going.", clientKey: "go" })))
    await world.settle(400, 20_000, "ignore")
    const apexHeard = () => world.prompts.filter((prompt) => prompt.conversation === apex.conversation).map((prompt) => prompt.text)
    await until("its Apex to hear the answer", () => apexHeard().some((text) => text.includes("answers your message")))
    assert.ok(apexHeard().some((text) => text.includes("two checks pass")), "progress that answers wakes its Apex with it")
    // A result settles a message without naming it: no reminder on the turn after.
    assert.ok(!("refused" in await world.agents.send(apex.caller, { to: "lander", text: "Then: tidy the docs.", expects: "answer", clientKey: "docs" })))
    await world.settle(400, 20_000, "ignore")
    assert.ok(!("refused" in await world.agents.send(apex.caller, { to: "lander", text: "Thanks.", clientKey: "thanks" })))
    await world.settle(400, 20_000, "ignore")
    const last = world.prompts.filter((prompt) => prompt.conversation === fin).at(-1)!.text
    assert.ok(!last.includes(REMINDER), `nothing owed once answered: ${last.slice(0, 400)}`)
    assert.ok(!apexHeard().some((text) => text.includes("hasn't answered your message")), "and its Apex is never told it wasn't")
    console.log("owed: progress naming it in answers settled it and woke its Apex; a result settled the next with nothing said")
  } finally {
    await world.close()
    rmSync(root, { recursive: true, force: true })
  }
}

console.log("reply owed: opened when the harness takes it, settled by an answer, reminded once, then said to the Apex once")
