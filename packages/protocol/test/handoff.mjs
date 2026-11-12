import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { OwnerAnswerSchema, OwnerAskSchema, QuietAnswerSchema, QuietNoteSchema, autoContinueOp } from "../dist/handoff.js"
import { continueCloudThread } from "../dist/continues.js"

const session = randomUUID()
const note = () => ({ note: randomUUID(), reason: "sleep", at: 1, threads: [{ thread: "t-device", sessions: [{ session, generation: 4 }], checkpoint: { sha256: "a".repeat(64), standby: "t-standby" } }] })

test("a quiet note names each parked Thread, its Sessions at their generations and its acknowledged checkpoint, and nothing else", () => {
  assert.equal(QuietNoteSchema.safeParse(note()).success, true)
  assert.equal(QuietNoteSchema.safeParse({ ...note(), threads: [] }).success, true, "a device with nothing parked says so")
  const withoutCheckpoint = note()
  delete withoutCheckpoint.threads[0].checkpoint
  assert.equal(QuietNoteSchema.safeParse(withoutCheckpoint).success, true)
  for (const extra of [{ release: true }, { owner: "cloud" }]) assert.equal(QuietNoteSchema.safeParse({ ...note(), ...extra }).success, false, "a note releases nothing")
  assert.equal(QuietNoteSchema.safeParse({ ...note(), reason: "lost" }).success, false)
  const badSha = note()
  badSha.threads[0].checkpoint.sha256 = "A".repeat(64)
  assert.equal(QuietNoteSchema.safeParse(badSha).success, false)
  assert.equal(QuietNoteSchema.safeParse({ ...note(), threads: Array.from({ length: 33 }, () => note().threads[0]) }).success, false)
  assert.equal(QuietAnswerSchema.safeParse({ note: randomUUID(), threads: [{ thread: "t-a", accepted: true }, { thread: "t-b", accepted: false, why: "not-yours" }] }).success, true)
  assert.equal(QuietAnswerSchema.safeParse({ note: randomUUID(), threads: [{ thread: "t-b", accepted: false }] }).success, false, "a refusal says why")
})

test("an owner ask names every Session at its generation; each answer is yours, departed with its continue, or unknown", () => {
  assert.equal(OwnerAskSchema.safeParse({ sessions: [{ session, generation: 4 }] }).success, true)
  assert.equal(OwnerAskSchema.safeParse({ sessions: [{ session, generation: -1 }] }).success, false)
  const op = randomUUID()
  assert.equal(OwnerAnswerSchema.safeParse({ sessions: [
    { session, answer: "yours", generation: 6 },
    { session: randomUUID(), answer: "departed", generation: 5, cloudThread: "t-cloud", op, phase: "arriving" },
    { session: randomUUID(), answer: "unknown" },
  ] }).success, true)
  assert.equal(OwnerAnswerSchema.safeParse({ sessions: [{ session, answer: "departed", generation: 5 }] }).success, false, "departed names the continue to join")
  assert.equal(OwnerAnswerSchema.safeParse({ sessions: [{ session, answer: "yours" }] }).success, false, "yours says at which generation")
})

test("the account's continue of a quiet Thread is the same op, and cloud Thread, however often it's made", async () => {
  const sessions = [{ session, generation: 4 }, { session: randomUUID(), generation: 7 }]
  const first = await autoContinueOp("t-device", sessions, "0d4b7c2e-4c38-4b8a-9a6f-1f1e0a3b2c4d")
  assert.equal(await autoContinueOp("t-device", [...sessions].reverse(), "0d4b7c2e-4c38-4b8a-9a6f-1f1e0a3b2c4d"), first, "named by the highest generation, whatever the order")
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(await autoContinueOp("t-device", sessions, randomUUID()), first, "another note is another continue")
  assert.notEqual(await autoContinueOp("t-device", [{ session, generation: 8 }], "0d4b7c2e-4c38-4b8a-9a6f-1f1e0a3b2c4d"), first, "and another generation")
  assert.equal(await continueCloudThread(first), await continueCloudThread(await autoContinueOp("t-device", sessions, "0d4b7c2e-4c38-4b8a-9a6f-1f1e0a3b2c4d")))
})
