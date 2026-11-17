import assert from "node:assert/strict"
import { test } from "node:test"
import { CLOUD_FIN_START_PATH, CloudFinPlaceSchema, CloudFinPlacedSchema, cloudFinInputSha256, cloudFinThread } from "../dist/cloud-fins.js"

const launch = () => ({ version: 1, op: "start:00000000-0000-4000-8000-000000000001:fix", parentThread: "11111111-1111-4111-8111-111111111111", brief: { objective: "Fix the parser", doneWhen: ["tests pass"] }, harness: "codex", access: "edits", source: "a".repeat(64) })

test("a cloud Fin's start is asked at its own path, with the repository and harness beside the start, nothing else", () => {
  assert.equal(CLOUD_FIN_START_PATH, "/v1/cloud/fins/start")
  const place = { op: "start:a:b", inputSha256: "b".repeat(64), thread: "t-0123456789abcdef", repository: { url: "https://github.com/octocat/Hello-World" }, harness: "codex" }
  assert.equal(CloudFinPlaceSchema.safeParse(place).success, true)
  assert.equal(CloudFinPlaceSchema.safeParse({ ...place, machine: "m-0123456789abcdef" }).success, false, "a device never names the machine")
  assert.equal(CloudFinPlaceSchema.safeParse({ ...place, repository: { url: "https://example.com/a/b" } }).success, false)
  assert.equal(CloudFinPlaceSchema.safeParse({ ...place, harness: "" }).success, false)
})

test("a start made answers its Thread and machine with the reservation; one not made, why, from a fixed list", () => {
  const reservation = { op: "start:a:b", inputSha256: "b".repeat(64), thread: "t-0123456789abcdef", by: "00000000-0000-4000-8000-000000000001", at: 1, phase: "running", cancel: false, generation: 1, planRevision: 1, leaseUntil: 2, retireUntil: 3, reservedCents: 4 }
  assert.equal(CloudFinPlacedSchema.safeParse({ ok: true, thread: "t-0123456789abcdef", machine: "m-0123456789abcdef", folder: "/home/user/Hello-World", reservation }).success, true)
  assert.equal(CloudFinPlacedSchema.safeParse({ ok: true, thread: "t-0123456789abcdef", machine: "m-0123456789abcdef", folder: "Hello-World", reservation }).success, false, "the machine's folder is absolute")
  assert.equal(CloudFinPlacedSchema.safeParse({ ok: false, reason: "closed", detail: "Cloud Fin starts aren't open" }).success, true)
  assert.equal(CloudFinPlacedSchema.safeParse({ ok: false, reason: "busy", detail: "" }).success, false)
})

test("a cloud Fin's Thread is fixed by its start's op: the same op the same Thread, another op another", async () => {
  const op = "start:00000000-0000-4000-8000-000000000001:fix"
  assert.match(await cloudFinThread(op), /^t-[0-9a-f]{16}$/)
  assert.equal(await cloudFinThread(op), await cloudFinThread(op))
  assert.notEqual(await cloudFinThread(op), await cloudFinThread(`${op}2`))
})

test("a start's launch digest is the same whatever order its fields come in, and changes with anything it launches", async () => {
  const digest = await cloudFinInputSha256(launch())
  assert.match(digest, /^[0-9a-f]{64}$/)
  const reordered = Object.fromEntries(Object.entries(launch()).reverse())
  assert.equal(await cloudFinInputSha256(reordered), digest, "canonical: key order doesn't matter")
  assert.equal(await cloudFinInputSha256({ ...launch(), model: undefined }), digest, "an absent field isn't written")
  for (const changed of [{ op: "start:other" }, { brief: { objective: "Fix the lexer" } }, { harness: "claude" }, { access: "auto" }, { source: "c".repeat(64) }, { model: "gpt-6" }, { fast: true }, { parentThread: "22222222-2222-4222-8222-222222222222" }])
    assert.notEqual(await cloudFinInputSha256({ ...launch(), ...changed }), digest, `${Object.keys(changed)[0]} changes it`)
})
