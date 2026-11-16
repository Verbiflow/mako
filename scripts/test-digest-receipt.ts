import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaudeProvider } from "@mako/sessions"
import { digestReceipt } from "@mako/host/conversations/native-history"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { ProviderBinding } from "@mako/host/contracts/conversation-control"
import type { PromptDelivery } from "@mako/host/contracts/prompt-delivery"
import type { ThreadPage } from "@mako/sessions"
import { auditId } from "./performance-audit-fixtures.ts"

const binding: ProviderBinding = { id: auditId(1), provider: "fixture", nativeId: "native", path: "/fixture/native", coveredBlocks: 0, includesBase: false }
const delivery: PromptDelivery = { bindingId: binding.id, attemptId: auditId(2), ownerEpoch: "fixture", gated: true, evidence: { kind: "submitted", source: "transport-call" } }
const page: ThreadPage = { ref: { harness: binding.provider, nativeId: binding.nativeId!, path: binding.path! }, entries: [], start: 0, total: 0, hasEarlier: false }
const supplied = { kind: "supplied-message-id", evidence: "Scripted adapter preserves the supplied attempt ID" } as const
assert.equal(digestReceipt(page, binding, { nativeDelivery: delivery }, NO_NATIVE_PROMPT_IDENTITY), "unknown")
assert.equal(digestReceipt(null, binding, { nativeDelivery: delivery }, supplied), "unknown")
assert.equal(digestReceipt(page, binding, { nativeDelivery: delivery }, supplied), "absent")
const received: ThreadPage = { ...page, total: 1, entries: [{ type: "user", text: "Unrelated words", id: delivery.attemptId }] }
assert.equal(digestReceipt(received, binding, { nativeDelivery: delivery }, supplied), "present")
assert.equal(digestReceipt(received, binding, { nativeDelivery: delivery }, NO_NATIVE_PROMPT_IDENTITY), "unknown", "an undeclared native-ID contract cannot prove absence or presence")
for (const incomplete of [
  { ...page, preview: true }, { ...page, start: 1 }, { ...page, total: 2 }, { ...page, hasEarlier: true },
  { ...page, ref: { ...page.ref, nativeId: "different" } }, { ...page, ref: { ...page.ref, harness: "different" } },
  { ...page, ref: { ...page.ref, path: "/different" } },
  { ...page, total: 1, entries: [{ type: "user" as const, text: "Report words are not identity" }] },
]) assert.equal(digestReceipt(incomplete, binding, { nativeDelivery: delivery }, supplied), "unknown")
assert.equal(digestReceipt(page, { ...binding, path: undefined }, { nativeDelivery: delivery }, supplied), "unknown")
assert.equal(digestReceipt(page, { ...binding, id: auditId(9) }, { nativeDelivery: delivery }, supplied), "unknown")
assert.equal(digestReceipt(page, binding, { nativeDelivery: { ...delivery, gated: undefined } }, supplied), "unknown", "legacy delivery cannot borrow the current adapter's identity guarantee")
assert.equal(digestReceipt(null, binding, { nativeDelivery: { ...delivery, evidence: { kind: "accepted", source: "native-response" } } }, supplied), "present")
assert.equal(digestReceipt(null, binding, { nativeDelivery: { ...delivery, evidence: { kind: "prepared" } } }, NO_NATIVE_PROMPT_IDENTITY), "absent")
assert.equal(digestReceipt(null, binding, { nativeDelivery: { ...delivery, gated: undefined, evidence: { kind: "prepared" } } }, supplied), "unknown", "legacy prepared is not proof of non-submission")
const root = mkdtempSync(join(tmpdir(), "mako-native-receipt-"))
try {
  const file = join(root, `${auditId(3)}.jsonl`)
  writeFileSync(file, JSON.stringify({ type: "user", uuid: delivery.attemptId, parentUuid: null, sessionId: auditId(3), cwd: "/fixture", version: "2.1.310", timestamp: "2026-11-15T00:00:00Z", message: { role: "user", content: "Synthetic digest" } }) + "\n")
  const native = await new ClaudeProvider(root).read(file)
  assert.ok(native)
  assert.equal(native.entries.find(entry => entry.type === "user")?.id, delivery.attemptId, "real decoder preserves the supplied UUID as Entry.id")
  const source = { ...binding, provider: "claude", nativeId: native.ref.nativeId, path: file }
  assert.equal(digestReceipt({ ...native, start: 0, total: native.entries.length, hasEarlier: false }, source, { nativeDelivery: delivery }, supplied), "present")
} finally { rmSync(root, { recursive: true, force: true }) }
console.log("PASS: digest receipt separates native acceptance, proven absence, missing IDs, unreadable/partial/misbound history and gated prepared evidence")
