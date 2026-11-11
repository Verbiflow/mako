import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { ProjectManifestSchema, SlotRequestSchema, ReadyReceiptSchema, plainProtocolValue, readCapableRole } from "../dist/handoff-project.js"
function manifest() {
  return { version: 2, move: randomUUID(), sourceThread: randomUUID(), destination: "t-test", project: "/Users/fixture/project",
    sessions: [{ session: randomUUID(), ownershipGeneration: 7 }], slots: [
      { slot: "primary", kind: "primary", url: "https://github.com/Owner/Primary", repositoryId: "R1", path: "/Users/fixture/project/primary", checkpoint: "a".repeat(64) },
      { slot: "secondary", kind: "secondary", url: "https://github.com/Owner/Secondary", repositoryId: "REPO_SECONDARY", path: "/Users/fixture/project/secondary", checkpoint: "b".repeat(64) }] }
}
test("schema canonicalizes registry order and GitHub case", () => { const m = manifest(); m.slots.reverse(); const parsed = ProjectManifestSchema.parse(m); assert.equal(parsed.slots[0].slot, "primary"); assert.equal(parsed.slots[0].url, "https://github.com/owner/primary") })
for (const url of ["https://github.com:443/O/R", "https://github.com/O/R?x", "https://github.com/O/%52", "https://other.invalid/O/R", "https://github.com/O/R.git"]) test("repository aliases/redirect targets refused: " + url, () => { const m = manifest(); m.slots[1].url = url; assert.equal(ProjectManifestSchema.safeParse(m).success, false) })
test("slot-only DTO refuses runtime-supplied URL/path/account/mode", () => { for (const field of ["url", "path", "account", "mode"]) assert.equal(SlotRequestSchema.safeParse({ grant: randomUUID(), digest: "a".repeat(64), revision: 1, slot: "secondary", operation: randomUUID(), [field]: "not-authority" }).success, false) })
test("clone-ready cannot claim an applied checkpoint", () => {
  const m = manifest(), receipt = { phase: "ready-for-arrival", binding: { grant: m.move, digest: "a".repeat(64), revision: 1, runtime: {
    machine: "m-test", machineGeneration: 3, boot: "BOOT", destination: "t-test", agent: { preparationVersion: 2, build: "AGENT", sourceDigest: "a".repeat(64) }, host: { preparationVersion: 2, build: "HOST", sourceDigest: "a".repeat(64) } } },
    operation: randomUUID(), slots: m.slots.map((slot) => ({ slot: slot.slot, repositoryId: slot.repositoryId, path: slot.path, state: "clone-ready" })) }
  assert.equal(ReadyReceiptSchema.safeParse(receipt).success, true)
  Object.assign(receipt.slots[0], { checkpoint: "c".repeat(64) })
  assert.equal(ReadyReceiptSchema.safeParse(receipt).success, false)
})
test("data copier refuses hostile nested getter before execution", () => { let invoked = 0; const nested = Object.defineProperty({}, "secret", { enumerable: true, get() { invoked++; return "SYNTHETIC_CANARY" } }); assert.throws(() => plainProtocolValue({ nested }), /bad-input/); assert.equal(invoked, 0) })
test("data copier bounds cyclic/oversized/nondata inputs", () => { const cyclic = {}; cyclic.self = cyclic; for (const value of [cyclic, { huge: "x".repeat(32769) }, { callback() {} }, Object.assign(new Date(), { value: "x" })]) assert.throws(() => plainProtocolValue(value), /bad-input/) })
test("read capability never treats unknown role/object as authorization", () => { for (const role of ["read", "triage", "write", "maintain", "admin"]) assert.equal(readCapableRole(role), true); for (const role of ["none", "unknown", {}, null]) assert.equal(readCapableRole(role), false) })
test("60KB aggregate refuses before any JSON serialization", () => {
  const original = JSON.stringify; let calls = 0
  try { JSON.stringify = (...args) => { calls++; return original(...args) }; assert.throws(() => plainProtocolValue({ a: "x".repeat(20000), b: "x".repeat(20000), c: "x".repeat(20000) }), /bad-input/) }
  finally { JSON.stringify = original }
  assert.equal(calls, 0)
})
test("many-key budget stops descriptor reads incrementally", () => {
  const source = Object.fromEntries(Array.from({ length: 500 }, (_, index) => ["key" + index, "x".repeat(100)])); let descriptors = 0
  const value = new Proxy(source, { getOwnPropertyDescriptor(target, key) { descriptors++; return Reflect.getOwnPropertyDescriptor(target, key) } })
  assert.throws(() => plainProtocolValue(value), /bad-input/); assert.ok(descriptors > 1 && descriptors < 500)
})
for (const [name, value, fits] of [["UTF8", "€", 10922], ["astral", "😀", 8191], ["short escape", "\n", 16383], ["long escape", "\u0000", 5461], ["lone surrogate", "\ud800", 5461]]) test("incremental JSON byte accounting " + name, () => {
  assert.equal(plainProtocolValue(value.repeat(fits)), value.repeat(fits)); assert.throws(() => plainProtocolValue(value.repeat(fits + 1)), /bad-input/)
})
test("large key charged before descriptor lookup, no arbitrary value coercion", () => {
  let reads = 0; const key = "k".repeat(32769)
  const value = new Proxy({}, { ownKeys: () => [key], getOwnPropertyDescriptor: () => { reads++; return { value: "x", enumerable: true, configurable: true } } })
  assert.throws(() => plainProtocolValue(value), /bad-input/); assert.equal(reads, 0)
})
test("incremental copier still rejects nonenumerable/index accessors without running them", () => {
  let invoked = 0; const object = Object.defineProperty({}, "hidden", { get() { invoked++; return "x" } }); const array = []
  Object.defineProperty(array, "0", { enumerable: true, get() { invoked++; return "x" } })
  assert.throws(() => plainProtocolValue(object), /bad-input/); assert.throws(() => plainProtocolValue(array), /bad-input/); assert.equal(invoked, 0)
})
test("proxy ownKeys failure propagates; parser does not promise synchronous preemption", () => {
  const error = new Error("synthetic-ownKeys-failure"), proxy = new Proxy({}, { ownKeys() { throw error } })
  assert.throws(() => plainProtocolValue(proxy), (value) => value === error)
})

test("read-role boundary never reads hostile caller properties", () => {
  let reads = 0
  const role = new Proxy({}, { get() { reads++; throw new Error("unexpected-role-read") } })
  assert.equal(readCapableRole(role), false)
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  assert.equal(readCapableRole(revoked.proxy), false)
  assert.equal(reads, 0)
})
test("node and depth caps remain separate from the byte cap", () => {
  assert.equal(plainProtocolValue(Array(4095).fill(null)).length, 4095)
  assert.throws(() => plainProtocolValue(Array(4096).fill(null)), /bad-input/)
  const nested = count => { let value = null; for (let i = 0; i < count; i++) value = { child: value }; return value }
  assert.ok(plainProtocolValue(nested(16)))
  assert.throws(() => plainProtocolValue(nested(17)), /bad-input/)
})
test("bounded copier rejects a type-tag accessor without using object formatting", () => {
  let reads = 0
  const value = Object.defineProperty({}, Symbol.toStringTag, { get() { reads++; return "Object" } })
  assert.throws(() => plainProtocolValue(value), /bad-input/)
  assert.equal(reads, 0)
  // Existing toString-based classifiers cannot replace these checks at this hostile boundary.
  assert.equal(Object.prototype.toString.call(value), "[object Object]")
  assert.equal(reads, 1)
})
