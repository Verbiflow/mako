import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { OwnerAnswerSchema, OwnerAskSchema, ParkedTurnSchema, QuietAnswerSchema, QuietNoteSchema, autoContinueOp } from "../dist/handoff.js"
import { continueCloudThread } from "../dist/continues.js"
import { QUIET_OTHERS_LINK_VERSION, QUIET_PROJECT_FROM_LINK_VERSION, QUIET_PROJECT_LINK_VERSION } from "../dist/version.js"

const session = randomUUID()
const note = () => ({ note: randomUUID(), reason: "sleep", at: 1, threads: [{ thread: "t-device", sessions: [{ session, generation: 4 }], checkpoint: { version: 1, sha256: "a".repeat(64), bytes: 409, head: "b".repeat(40), branch: "mako/fix", index: "c".repeat(40), work: "d".repeat(40), standby: "t-standby" } }] })

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

test("a Thread of a note names its parked turns, each with the continuation it goes on under; a note without them still reads", () => {
  const turn = () => ({ conversation: randomUUID(), request: randomUUID(), continuation: randomUUID(), stopped: ["call-1"] })
  const parked = note()
  parked.threads[0].parked = [turn(), { ...turn(), stopped: undefined }]
  assert.equal(QuietNoteSchema.safeParse(parked).success, true)
  assert.equal(QuietNoteSchema.safeParse(note()).success, true, "a device before parked turns says none")
  const missing = turn()
  delete missing.continuation
  assert.equal(ParkedTurnSchema.safeParse(missing).success, false, "every parked turn names the continuation it goes on under")
  assert.equal(ParkedTurnSchema.safeParse({ ...turn(), extra: true }).success, false)
  const many = note()
  many.threads[0].parked = Array.from({ length: 17 }, turn)
  assert.equal(QuietNoteSchema.safeParse(many).success, false, "at most 16 a Thread")
})

test("the note's checkpoint is the whole checkpoint the arrival applies, with its standby", () => {
  const hashOnly = note()
  hashOnly.threads[0].checkpoint = { sha256: "a".repeat(64), standby: "t-standby" }
  assert.equal(QuietNoteSchema.safeParse(hashOnly).success, false, "a hash alone can't be applied")
  const detached = note()
  delete detached.threads[0].checkpoint.branch
  assert.equal(QuietNoteSchema.safeParse(detached).success, true, "a detached HEAD names no branch")
  const noStandby = note()
  delete noStandby.threads[0].checkpoint.standby
  assert.equal(QuietNoteSchema.safeParse(noStandby).success, false, "where it was sent is named")
})

test("a project folder's Thread names each other repository with its own checkpoint", () => {
  const other = (name) => ({ path: `/Users/someone/worktrees/fix/${name}`, url: `https://github.com/acme/${name}`, branch: "mako/fix", checkpoint: { version: 1, sha256: "e".repeat(64), bytes: 300, head: "f".repeat(40), branch: "mako/fix", index: "1".repeat(40), work: "2".repeat(40) } })
  const two = note()
  two.threads[0].others = [other("web")]
  assert.equal(QuietNoteSchema.safeParse(two).success, true)
  assert.equal(QuietNoteSchema.safeParse(note()).success, true, "a single repository names none")
  const relative = note()
  relative.threads[0].others = [{ ...other("web"), path: "web" }]
  assert.equal(QuietNoteSchema.safeParse(relative).success, false, "its path is where it sits, whole")
  const notGitHub = note()
  notGitHub.threads[0].others = [{ ...other("web"), url: "git@github.com:acme/web.git" }]
  assert.equal(QuietNoteSchema.safeParse(notGitHub).success, false, "a GitHub repository a machine clones over https")
  const hashOnly = note()
  hashOnly.threads[0].others = [{ ...other("web"), checkpoint: { sha256: "e".repeat(64) } }]
  assert.equal(QuietNoteSchema.safeParse(hashOnly).success, false, "the whole checkpoint, as the arrival applies it")
  const many = note()
  many.threads[0].others = Array.from({ length: 32 }, (_, i) => other(`r${i}`))
  assert.equal(QuietNoteSchema.safeParse(many).success, false, "at most 31")
  assert.equal(QUIET_OTHERS_LINK_VERSION, 26, "sent only to a gateway whose link agreed them")
})


test("a project folder's Thread names its project worktree, absolute and at most 4,096 characters; a note without it still reads", () => {
  const project = note()
  project.threads[0].project = "/Users/ada/.mako/worktrees/shop-1a2b/fix"
  assert.equal(QuietNoteSchema.safeParse(project).success, true)
  assert.equal(QUIET_PROJECT_LINK_VERSION, 25, "sent only to a gateway whose link agreed it")
  for (const bad of ["", "shop/fix", `/${"a".repeat(4_096)}`]) {
    const refused = note()
    refused.threads[0].project = bad
    assert.equal(QuietNoteSchema.safeParse(refused).success, false, `refused: ${bad.slice(0, 12)}`)
  }
  const longest = note()
  longest.threads[0].project = `/${"a".repeat(4_095)}`
  assert.equal(QuietNoteSchema.safeParse(longest).success, true)
  // The device folder it mirrors, by which each Session is placed: absolute too, and sent at 26.
  const from = note()
  Object.assign(from.threads[0], { project: "/Users/ada/.mako/worktrees/shop-1a2b/fix", projectFrom: "/Users/ada/shop" })
  assert.equal(QuietNoteSchema.safeParse(from).success, true)
  assert.equal(QuietNoteSchema.safeParse({ ...from, threads: [{ ...from.threads[0], projectFrom: "shop" }] }).success, false, "absolute")
  assert.equal(QUIET_PROJECT_FROM_LINK_VERSION, 26)
})
