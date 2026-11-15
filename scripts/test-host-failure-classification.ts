import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { z } from "zod"
import { HOST_FAILURE_KINDS, HostFailureError, classifyProviderFailure, classifyStartFailure, failureEvidenceOf, providerCall } from "@mako/host/contracts/provider-failure"
import { ProviderFailureEvidenceSchema, storedFailureEvidence } from "@mako/host/contracts/provider-failure-evidence"
import { ExecutionAccountChanged, ExecutionIdentityMismatch } from "@mako/host/harnesses/accounts"
import { MissingWorkingDirectoryError } from "@mako/host/harnesses/provider-process"
import { SessionBusyError } from "@mako/host/contracts/session-hold"
import { HandoffRefused, TurnInProgressError } from "@mako/host/harnesses/prompt-dispatch"
import { transientCause } from "@mako/host/contracts/delivery-retry"

const nativeLimit = "You have hit your usage limit. Try again in 3 hours."
assert.equal(classifyProviderFailure(nativeLimit).kind, "unknown", "unmarked text cannot attest to provider origin")
for (const kind of HOST_FAILURE_KINDS) {
  const error = new HostFailureError(kind, nativeLimit)
  const evidence = failureEvidenceOf({ error })
  assert.equal(classifyProviderFailure(error.message, undefined, evidence).kind, kind)
  assert.equal(classifyStartFailure(error.message, true, evidence), kind)
  assert.deepEqual(ProviderFailureEvidenceSchema.parse(evidence), evidence)
  if (kind !== "network" && kind !== "launch-stalled") assert.equal(transientCause(error.message, kind, false, evidence), undefined)
}
assert.equal(ProviderFailureEvidenceSchema.safeParse({ source: "host", kind: "rate-limited" }).success, false)
const hostFacts = [
  new Error(nativeLimit),
  new ExecutionAccountChanged("selection"), new ExecutionAccountChanged("credentials"),
  new ExecutionIdentityMismatch(nativeLimit, "429 Too Many Requests"),
  new MissingWorkingDirectoryError(nativeLimit), new SessionBusyError(nativeLimit),
  new HandoffRefused("stopped"), new HandoffRefused("unsaved"), new HandoffRefused("superseded"), new HandoffRefused("withdrawn"),
  new TurnInProgressError(nativeLimit),
]
for (const error of hostFacts) {
  const evidence = failureEvidenceOf({ error })
  assert.equal(evidence.source, "host")
  assert.notEqual(classifyProviderFailure(error.message, undefined, evidence).kind, "rate-limited", error.name)
}
const ownership = "The adapter could not verify native identity; retry after the ownership read completes"
assert.notEqual(classifyProviderFailure(ownership).kind, "rate-limited", "a provider-like suggestion alone is not quota evidence")
for (const text of ["Approval evidence capacity reached", "Native question history exceeds the evidence capacity", "Disk quota exceeded", "A host queue says try again later", "The source contains 429 from an earlier operation"]) {
  assert.notEqual(classifyProviderFailure(text).kind, "rate-limited", text)
}
for (const text of [nativeLimit, "429 Too Many Requests", "API Error: 429", "overloaded_error: Overloaded", "Quota exhausted"]) {
  const error = await providerCall(Promise.reject(new Error(text))).catch((error: Error) => error)
  assert.equal(classifyProviderFailure(error.message, undefined, failureEvidenceOf({ error })).kind, "rate-limited", "native provider call retains anchored native shapes")
}
const hostInNativeCall = await providerCall(Promise.reject(new HostFailureError("wrong-account", nativeLimit))).catch((error: Error) => error)
assert.equal(classifyProviderFailure(hostInNativeCall.message, undefined, failureEvidenceOf({ error: hostInNativeCall })).kind, "wrong-account", "native call wrapper preserves a typed host refusal")

// Inventory every host-authored Error/FailureError string, not a hand-maintained sample.
// Interpolations are adversarial account/folder text. Their source remains host even if they quote a native error.
const root = join(import.meta.dirname, "../packages/host/src")
let strings = 0
const files = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(folder, entry.name)) : entry.name.endsWith(".ts") ? [join(folder, entry.name)] : [])
for (const file of files(root)) {
  const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && /(?:Error|Failure)$/.test(node.expression.getText(ast))) {
      for (const argument of node.arguments ?? []) {
        let text: string | undefined
        if (ts.isStringLiteralLike(argument)) text = argument.text
        else if (ts.isTemplateExpression(argument)) text = argument.head.text + argument.templateSpans.map((span) => nativeLimit + span.literal.text).join("")
        if (text !== undefined) {
          strings++
          assert.notEqual(classifyProviderFailure(text).kind, "rate-limited", "a string with no native provenance is never quota evidence")
          const evidence = failureEvidenceOf({ error: new HostFailureError("unknown", text) })
          assert.notEqual(classifyProviderFailure(text, undefined, evidence).kind, "rate-limited", `${relative(root, file)}:${ast.getLineAndCharacterOfPosition(node.pos).line + 1}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
}
assert.ok(strings > 500, `host-authored inventory unexpectedly shrank: ${strings}`)
console.log(`PASS: ${strings} actual host-authored failure strings with adversarial interpolations, typed host kinds, mixed boundary and anchored native quota controls`)

// Exact pre-change readers, not a permissive substitute. They can retain every new evidence variant.
const oldEvidence = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("auth"),source:z.enum(["credential-missing","refresh-failed","provider-auth-error"])}),
  z.object({kind:z.literal("permission"),source:z.literal("provider-permission-error")}),
  z.object({kind:z.literal("unknown"),source:z.literal("provider-error")}),
  z.object({kind:z.literal("provider-unavailable"),source:z.enum(["credential-current","gateway-response","unconfirmed-auth"])}),
])
for (const evidence of [...HOST_FAILURE_KINDS.map(kind => ({kind,source:"host" as const})),
  {kind:"rate-limited" as const,source:"native-limit" as const},
  {kind:"network" as const,source:"provider-text" as const}]) {
  const stored=storedFailureEvidence(evidence)
  assert.deepEqual(oldEvidence.parse(stored), {kind:"unknown",source:"provider-error"})
  assert.deepEqual(ProviderFailureEvidenceSchema.parse(stored), evidence)
}
console.log("PASS: legacy evidence reader retains requests, exact current kind/origin round-trips")

const wrappedSetting = "API error: 400 Bad Request: unknown model permanently-retired-model"
const wrappedNative = await providerCall(Promise.reject(new Error(wrappedSetting))).catch((error: Error) => error)
const wrappedEvidence = failureEvidenceOf({ error: wrappedNative })
assert.equal(transientCause(wrappedSetting, classifyProviderFailure(wrappedSetting, undefined, wrappedEvidence).kind, false, wrappedEvidence), undefined, "admitting native text cannot turn permanent input refusal into automatic service retries")
const future = ProviderFailureEvidenceSchema.parse({kind:"unknown",source:"provider-error",exact:{kind:"future-kind",source:"future-origin"}})
assert.equal(classifyProviderFailure(nativeLimit, undefined, future).kind, "unknown", "unsupported exact origins fail closed instead of reclassifying their fallback prose")
