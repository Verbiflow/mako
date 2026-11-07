import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { FROM_AGENTS, fromAgent } from "../packages/host/src/contracts/children"
import type { LiveAction } from "../packages/host/src/contracts/live-actions"
import { actionNotice, describeActionRecovery } from "../packages/host/src/contracts/operation-recovery"
import { personPromptedAt } from "../packages/host/src/contracts/worked-at"

/*
 * The notice above the composer speaks for what the person did. A steer Mako sent by itself (a Fin's digest, an Apex's
 * message to its Fin) raises nothing, whatever became of it, and hides nothing of theirs; a steer of the person's that
 * failed keeps its notice; and what a notice says about their words is true.
 */

const steer = (text: string, kind: "steer" | "steer-queued"): LiveAction["input"] => {
  const common = { id: randomUUID(), requestId: randomUUID(), text, attachments: [] }
  return kind === "steer" ? { kind, ...common } : { kind, queuedRequestId: randomUUID(), ...common }
}
const action = (text: string, state: LiveAction["state"], kind: "steer" | "steer-queued" = "steer", at = 1, sender?: LiveAction["sender"]): LiveAction => ({
  input: steer(text, kind),
  digest: "digest",
  bindingId: randomUUID(),
  createdAt: at,
  ...(sender && { sender }),
  state,
})

const REFUSED = { kind: "not-accepted", reason: "The turn moved on" } as const
const DIGEST = `${FROM_AGENTS}\n1 finished:\n  • "lint" done: Lint is clean.`
const FROM_APEX = `${fromAgent("your Apex")}\nAdd #482 to the queue.`

for (const [who, text] of [["a Fin's digest", DIGEST], ["an Apex's message", FROM_APEX]] as const)
  for (const state of [REFUSED, { kind: "failed", reason: "no" }, { kind: "uncertain", reason: "no" }, { kind: "dispatching" }] as const) {
    assert.equal(actionNotice([action(text, state)], []), undefined, `${who} raises nothing when ${state.kind}`)
    assert.equal(actionNotice([action(text, state, "steer-queued")], []), undefined, `${who}, from the queue, raises nothing when ${state.kind}`)
  }

// The person's own keeps its notice, under one of Mako's too.
const mine = action("Use the other branch", REFUSED)
assert.equal(actionNotice([mine], []), mine, "a steer of the person's that failed keeps its notice")
assert.equal(actionNotice([mine, action(DIGEST, REFUSED)], []), mine, "and a digest after it hides nothing of theirs")
assert.equal(actionNotice([mine], [{ id: mine.input.id }]), undefined, "once its words went as a message of their own, it's over")
const words = action("Use the other branch", { kind: "uncertain", reason: "no" })
assert.equal(actionNotice([words], []), words, "an outcome unknown is still theirs to hear")

// Who sent it is the host's word, never the text's: a person pasting Mako's header is still the person.
const pasted = action(DIGEST, REFUSED, "steer", 9, "person")
assert.equal(actionNotice([pasted], []), pasted, "the person's failed steer keeps its notice, whatever its words look like")
assert.equal(personPromptedAt([], [pasted]), 9, "and it's their last message")
assert.equal(actionNotice([action("Use the other branch", REFUSED, "steer", 1, "native")], []), undefined, "one Mako sent raises nothing, whatever its words look like")
assert.equal(personPromptedAt([], [action("Use the other branch", { kind: "accepted" }, "steer", 5, "native")]), undefined, "and isn't the person writing")

// What a notice says about the person's words is true: a refused steer goes as the next message, and a compaction had none.
const refused = describeActionRecovery(mine)
assert.doesNotMatch(refused.guidance, /remains available/, "the words didn't stay anywhere to edit")
assert.match(refused.guidance, /next message/)
const compact: LiveAction = { input: { kind: "compact", id: randomUUID() }, digest: "digest", bindingId: randomUUID(), createdAt: 1, state: REFUSED }
assert.doesNotMatch(describeActionRecovery(compact).guidance, /input/i, "a compaction has no input to keep")

// A steer Mako sent isn't the person writing; a receipt kept before they said who sent it goes by its words.
assert.equal(personPromptedAt([], [action(DIGEST, { kind: "accepted" }, "steer", 5)]), undefined, "a digest isn't the person's last message")
assert.equal(personPromptedAt([], [action("Use the other branch", { kind: "accepted" }, "steer", 7)]), 7)

console.log("Steer notices: Mako's own raise nothing and hide nothing, the person's stay, and what they say is true")
