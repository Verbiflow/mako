import assert from "node:assert/strict"
import { z } from "zod"
import { classifyProviderFailure, failureEvidenceOf, providerTextEvidence, type ProviderFailureKind } from "@mako/host/contracts/provider-failure"
import { NativeVerificationPendingError, NATIVE_VERIFICATION_REASONS } from "@mako/host/contracts/native-verification"
import { codexDecoderSource } from "@mako/host/harnesses/codex/decoder-source"
import { openCodeDecoderSource } from "@mako/host/harnesses/opencode/decoder-source"
import { createLiveEngine, type EngineLive } from "@mako/host/harnesses/live-engine"
import type { JsonValue } from "@mako/host/contracts/json"
import { ProviderFailureEvidenceSchema, type ProviderFailureEvidence } from "@mako/host/contracts/provider-failure-evidence"
import { transientCause, type RetryCause } from "@mako/host/contracts/delivery-retry"

const failures: string[] = []
type FailureReading = ProviderFailureKind | RetryCause | ProviderFailureEvidence | boolean | undefined
function check(label: string, actual: FailureReading, expected: FailureReading) {
  try { assert.deepEqual(actual, expected, label) } catch { failures.push(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`) }
}
// Written regression corpus from review. Structured cases below additionally replay recorded native shapes.
const corpus = {
  claude: ["API Error: 429 Too Many Requests", "You've hit your usage limit. Try again in 3 hours."],
  codex: ["stream error: exceeded retry limit, last status: 429 Too Many Requests", "unexpected status 429 Too Many Requests: usage_limit_reached"],
  cursor: ["[resource_exhausted] Rate limit exceeded"],
  grok: ["Grok: rate limit exceeded"],
  devin: ["429 Too Many Requests"],
  opencode: ["AI_APICallError: Rate limit exceeded", "Request failed: rate_limit_error"],
}
for (const [harness, messages] of Object.entries(corpus)) for (const message of messages) {
  check(`${harness} native wrapper`, providerTextEvidence(message).kind, "rate-limited")
  check(`${harness} host catch`, classifyProviderFailure(message, undefined, failureEvidenceOf({ error: new Error(message) })).kind, "unknown")
}
for (const message of ["The host says Request failed: rate_limit_error", "An old record says Grok: rate limit exceeded", "stream error: exceeded retry limit, last status: 403 invalid token; usage_limit_reached"]) {
  check("embedded wrapper or permanent refusal is not quota", providerTextEvidence(message).kind === "rate-limited", false)
}
const nativeCases: [JsonValue, ProviderFailureKind][] = [
  ["usageLimitExceeded", "rate-limited"], ["usage-limit-exceeded", "rate-limited"],
  [{ responseTooManyFailedAttempts: { httpStatusCode: 429 } }, "rate-limited"],
  [{ responseStreamDisconnected: { httpStatusCode: 429 } }, "rate-limited"],
  [{ httpConnectionFailed: { httpStatusCode: 401 } }, "auth"],
  [{ responseStreamConnectionFailed: { httpStatusCode: 503 } }, "provider-unavailable"],
  [{ futureFailure: { httpStatusCode: 429 } }, "unknown"],
  [{ httpConnectionFailed: { httpStatusCode: "429" } }, "unknown"],
  [{ usageLimitExceeded: {} }, "unknown"],
  [{ httpConnectionFailed: { httpStatusCode: 429 }, futureFailure: {} }, "unknown"],
]
for (const [codexErrorInfo, expected] of nativeCases) for (const completed of [false, true]) {
  const decoder = codexDecoderSource.open({ threadId: "thread" })
  const error = { message: "Native request failed", codexErrorInfo, additionalDetails: null }
  const events = decoder.decode(completed
    ? { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "failed", items: [], error } } }
    : { method: "error", params: { threadId: "thread", willRetry: false, error } })
  const state = events.find(event => event.kind === "state")
  const evidence = state?.kind === "state" ? state.patch.failureEvidence : undefined
  check(`Codex structured ${JSON.stringify(codexErrorInfo)} completed=${completed}`, classifyProviderFailure(error.message, undefined, evidence).kind, expected)
}
const open = openCodeDecoderSource.open({ root: "root", cwd: "/fixture", launchAccess: "ask", contextSize: null })
const missingMessage = codexDecoderSource.open({ threadId: "thread" }).decode({ method: "turn/completed", params: {
  threadId: "thread", turn: { id: "turn", status: "failed", items: [], error: { codexErrorInfo: "usageLimitExceeded" } },
} }).find(event => event.kind === "state")
check("native quota needs no prose", missingMessage?.kind === "state" ? missingMessage.patch.failureEvidence : undefined, { kind: "rate-limited", source: "native-limit" })
const events = open.decode({ type: "session.execution.failed", id: "event", created: 1, data: { sessionID: "root", error: { type: "provider.rate-limit", message: "Native request failed" } } })
const fact = events.find(event => event.kind === "effect" && event.effect.type === "turn")
// Decode effects are provider-owned: inspect their JSON-shaped retained verdict without asserting a cast.
const serialized = z.object({ effect: z.object({ turn: z.object({ error: z.object({ failureEvidence: ProviderFailureEvidenceSchema.optional() }) }) }) }).safeParse(fact).data
check("OpenCode native error type beats neutral prose", serialized?.effect?.turn?.error?.failureEvidence, { kind: "rate-limited", source: "native-limit" })

const live: EngineLive = { state: { id: "fixture", harness: "fixture", cwd: "/fixture", status: "running", connection: "connected", modes: [], configOptions: [], currentMode: null }, emit() {} }
createLiveEngine<EngineLive>().sink(live, { effect() {} }).patch({ status: "failed", error: "429 Too Many Requests" })
check("engine sink never guesses provider origin", live.state.failureEvidence, { kind: "unknown", source: "host" })
const error = new NativeVerificationPendingError(NATIVE_VERIFICATION_REASONS.identity)
const evidence = failureEvidenceOf({ error })
check("typed native verification retry", evidence, { kind: "launch-stalled", source: "host" })
check("identity retry keeps short backoff", transientCause(error.message, "launch-stalled", false, evidence), "launch-stalled")
const legacy: ProviderFailureEvidence = { kind: "unknown", source: "provider-error" }
check("legacy exact identity wording", classifyProviderFailure(NATIVE_VERIFICATION_REASONS.identity, undefined, legacy).kind, "launch-stalled")
assert.deepEqual(failures, [])
console.log("PASS: per-harness quota corpus, actual Codex/OpenCode decoders, engine sink origin and typed/legacy identity retry")
