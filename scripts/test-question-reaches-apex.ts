import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentsWorld, HARNESSES } from "./lib/agents-world.ts"

/**
 * A Fin's question is never lost to a message that crossed it (`npm run test:wake-queue`), with each harness as the
 * Apex: the Fin asks while its Apex's turn runs, so the question waits in an unsent digest, and the Apex, not having
 * heard it, sends the Fin something else. That message reaches the Fin and answers nothing: when the Apex's turn ends
 * the digest goes, with the question in it. The person's message into the Fin's own Thread does close it, as
 * `docs/delivery-queue.md` rule 13 says.
 */
const QUESTION = "Rerun once more, or hold?"
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, done: () => boolean): Promise<void> {
  const deadline = performance.now() + 15_000
  while (!done()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}

async function run(root: string, harness: string, crossing: "apex" | "person"): Promise<void> {
  const fin = { conversation: "" }
  let asked!: () => void
  const asking = new Promise<void>((resolve) => { asked = resolve })
  const world: AgentsWorld = new AgentsWorld({
    root,
    // A step can't take the digest, as in the case that found this: the notice waits for the Apex's turn to end.
    refuseSteers: true,
    script: async (turn) => {
      if (turn.text.includes("Keep busy.")) return turn.world.hold(turn.conversation).then(() => "Done.")
      if (turn.text.includes("You're fin:")) {
        fin.conversation = turn.conversation
        await asking
        const reported = await turn.world.agents.report(turn.caller, { status: "blocked", summary: "Main is red.", question: QUESTION, options: [{ label: "Rerun" }, { label: "Hold" }], clientKey: "question" })
        assert.ok(!("refused" in reported), JSON.stringify(reported))
      }
      return "ok"
    },
  })
  const label = `${harness}, ${crossing}'s message crossing`
  try {
    const apex = await world.apex(harness, "full")
    const started = await world.agents.start(apex.caller, { brief: { objective: "Land it" }, harness: "codex", name: "worker", clientKey: "worker", cwd: world.root })
    assert.ok(!("refused" in started), JSON.stringify(started))
    await until("the Fin's turn", () => fin.conversation !== "")
    world.say(apex.conversation, "Keep busy.")
    await until("the Apex's turn", () => world.prompts.some((prompt) => prompt.conversation === apex.conversation && prompt.text.includes("Keep busy.")))
    asked()
    const digest = () => world.live.snapshot(apex.conversation)?.requests.find((request) => request.digest && request.text.includes(QUESTION))
    await until("the question to wait unsent", () => digest()?.status === "queued")
    await until("the Fin's turn to end", () => world.live.session(fin.conversation)?.status === "ready")

    if (crossing === "apex") {
      const sent = await world.agents.send(apex.caller, { to: "worker", text: "Also add #462 to the order.", clientKey: "crossing" })
      assert.ok(!("refused" in sent), JSON.stringify(sent))
    } else world.say(fin.conversation, "Hold it, I'll look.")
    const words = crossing === "apex" ? "Also add #462" : "Hold it, I'll look."
    await until("the message to reach the Fin", () => world.prompts.some((prompt) => prompt.conversation === fin.conversation && prompt.text.includes(words)))
    await until("its turn to end", () => world.live.session(fin.conversation)?.status === "ready")
    await pause(100)
    world.release(apex.conversation)
    await until("the Apex's turn to end", () => world.live.session(apex.conversation)?.status === "ready")
    await world.settle(300, 15_000, "ignore")

    const heard = world.prompts.filter((prompt) => prompt.conversation === apex.conversation && prompt.text.includes(QUESTION))
    if (crossing === "person") {
      assert.equal(heard.length, 0, `${label}: the person answered it, so its Apex isn't asked`)
      return
    }
    assert.equal(heard.length, 1, `${label}: the Apex hears the question, once`)
  } finally {
    for (const summary of world.live.summaries()) world.release(summary.session.id)
    await world.close()
  }
}

/**
 * The digest is being sent, prepared and not yet handed to the Apex's harness, as a message crosses the question. Being
 * sent isn't being heard: only a handoff is, so the question stays open and its answer still goes.
 */
async function prepared(root: string, harness: string): Promise<void> {
  const fin = { conversation: "" }
  const apexTurn = { conversation: "", gated: false, waiting: false }
  const finTurn = { gated: false, waiting: false }
  let letApex!: () => void
  let letFin!: () => void
  let asked!: () => void
  const apexGate = new Promise<void>((resolve) => { letApex = resolve })
  const finGate = new Promise<void>((resolve) => { letFin = resolve })
  const asking = new Promise<void>((resolve) => { asked = resolve })
  const world: AgentsWorld = new AgentsWorld({
    root,
    refuseSteers: true,
    refusePrompt: async (id) => {
      if (id === fin.conversation && finTurn.gated) {
        finTurn.waiting = true
        await finGate
      }
      if (id === apexTurn.conversation && apexTurn.gated) {
        apexTurn.waiting = true
        await apexGate
      }
      return undefined
    },
    script: async (turn) => {
      if (turn.text.includes("Keep busy.")) return turn.world.hold(turn.conversation).then(() => "Done.")
      if (turn.text.includes("You're fin:")) {
        fin.conversation = turn.conversation
        await asking
        await turn.world.agents.report(turn.caller, { status: "blocked", summary: "Main is red.", question: QUESTION, options: [{ label: "Hold" }], clientKey: "question" })
      }
      // Still at it: its question stands as its latest word.
      if (turn.text.includes("Crossing words.")) return turn.world.hold(turn.conversation).then(() => "Done.")
      return "ok"
    },
  })
  const label = `${harness}, prepared`
  try {
    const apex = await world.apex(harness, "full")
    apexTurn.conversation = apex.conversation
    const started = await world.agents.start(apex.caller, { brief: { objective: "Land it" }, harness: "codex", name: "worker", clientKey: "worker", cwd: world.root })
    assert.ok(!("refused" in started), JSON.stringify(started))
    await until("the Fin's turn", () => fin.conversation !== "")
    world.say(apex.conversation, "Keep busy.")
    await until("the Apex's turn", () => world.prompts.some((prompt) => prompt.conversation === apex.conversation && prompt.text.includes("Keep busy.")))
    asked()
    const digest = () => world.live.snapshot(apex.conversation)?.requests.find((request) => request.digest && request.text.includes(QUESTION))
    await until("the question to wait", () => digest()?.status === "queued")
    await until("the Fin's turn to end", () => world.live.session(fin.conversation)?.status === "ready")
    finTurn.gated = true
    const sent = await world.agents.send(apex.caller, { to: "worker", text: "Crossing words.", clientKey: "crossing" })
    assert.ok(!("refused" in sent), JSON.stringify(sent))
    await until("the message to be on its way", () => finTurn.waiting)
    apexTurn.gated = true
    world.release(apex.conversation)
    await until("the digest to be prepared", () => apexTurn.waiting && digest()?.status === "dispatching")
    assert.equal(digest()?.nativeDelivery?.evidence.kind, "prepared", label)
    letFin()
    await until("the message to reach the Fin", () => world.prompts.some((prompt) => prompt.conversation === fin.conversation && prompt.text.includes("Crossing words.")))
    assert.equal(world.prompts.filter((prompt) => prompt.conversation === apex.conversation && prompt.text.includes(QUESTION)).length, 0, `${label}: its Apex hasn't heard it`)
    const answered = await world.agents.answer(apex.caller, { to: "worker", answer: "Hold", clientKey: "answer" })
    assert.ok(!("refused" in answered), `${label}: it's still open: ${JSON.stringify(answered)}`)
  } finally {
    letApex()
    letFin()
    for (const summary of world.live.summaries()) world.release(summary.session.id)
    await world.close()
  }
}

const root = mkdtempSync(join(tmpdir(), "mako-question-reaches-"))
try {
  for (const harness of HARNESSES) {
    await run(join(root, `apex-${harness}`), harness, "apex")
    await prepared(join(root, `prepared-${harness}`), harness)
  }
  await run(join(root, "person"), "claude", "person")
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("question reaches its Apex: a message that crossed it answered nothing, sent or being sent, and the Apex heard it once, on all six harnesses; the person's own message still closed it")
