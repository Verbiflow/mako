import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PrincipalIdSchema } from "@mako/host/contracts/thread-identity"
import { compactionWorld } from "./lib/compaction-world.ts"

async function until(why: string, check: () => boolean) {
  const end = performance.now() + 2_000
  while (!check()) {
    assert.ok(performance.now() < end, why)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
const root = mkdtempSync(join(tmpdir(), "mako-compact-recovery-"))
const world = compactionWorld(root, { launch: { account: "synthetic-account", tuning: { model: "original-model" }, modeId: "fixture-mode" } })
const { id, owner, calls, launches, prompts, fail } = world
try {
  await world.start()
  const original = owner.snapshot(id)!.session.nativeId
  await owner.act(id, { kind: "compact", id: randomUUID() })
  const a = randomUUID(), b = randomUUID()
  const accepted = owner.submit(id, a, "first queued request", [{ name: "synthetic.txt", mimeType: "text/plain", data: Buffer.from("synthetic attachment").toString("base64") }],
    { model: "chosen-model" }, undefined, undefined, { kind: "person", principal: PrincipalIdSchema.parse(randomUUID()) }, { grants: ["synthetic-grant"] })
  const retained = { attachments: accepted.attachments, grants: accepted.grants, tuning: accepted.tuning, inputDigest: accepted.inputDigest, actor: accepted.actor }
  owner.submit(id, b, "second queued request")
  assert.equal(prompts.length, 0, "compaction owns the barrier")
  fail(calls[0]!)
  await until("a confirmed failed compaction gets its one host-owned retry", () => calls.length === 2)
  fail(calls[0]!)
  assert.equal(calls.length, 2, "duplicate source failure cannot create another attempt")
  fail(calls[1]!)
  await until("the held queue goes on in a new session without Resume", () => owner.snapshot(id)!.requests.filter(request => request.id === a || request.id === b).every(request => request.status === "completed"))
  const sent = owner.snapshot(id)!.requests.find(request => request.id === a)!
  assert.deepEqual({ attachments: sent.attachments, grants: sent.grants, tuning: sent.tuning, inputDigest: sent.inputDigest, actor: sent.actor }, retained, "recovery preserves the canonical request, attachments, grants and selected model")
  assert.notEqual(owner.snapshot(id)!.session.nativeId, original)
  assert.equal(launches.length, 2, "one replacement, never a new-session loop")
  assert.equal(launches[1]!.pinnedAccount?.(), "synthetic-account", "the real launch routing reads the pinned account")
  assert.equal(owner.snapshot(id)!.control!.bindings.find(binding => binding.id === owner.snapshot(id)!.control!.activeBindingId)!.account, "synthetic-account")
  assert.equal(launches[1]!.tuning?.model, "original-model", "the replacement starts with its pinned model, before individual queued selections")
  assert.equal(launches[1]!.modeId, "fixture-mode")
  assert.equal(launches[1]!.resume, undefined, "do not resume the failed binding")
  assert.equal(launches[1]!.fork, undefined, "do not fork the failed binding")
  assert.equal(prompts.length, 2)
  assert.match(prompts[0]!.text, /first queued request/)
  assert.match(prompts[1]!.text, /second queued request/)
  assert.deepEqual(owner.snapshot(id)!.requests.filter(request => request.id === a || request.id === b).map(request => request.id), [a, b])
  console.log("PASS: verified retry, exact queued requests, duplicate result and one fresh same-harness transcript replacement")
} catch (error) {
  console.error(JSON.stringify({ calls, launches: launches.map(launch => ({ id: launch.conversationId, resume: launch.resume })), prompts, snapshot: owner.snapshot(id), logs: world.logs }))
  throw error
} finally { await world.close(); rmSync(root, { recursive: true, force: true }) }
