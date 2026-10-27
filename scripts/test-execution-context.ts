import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { ExecutionContextSchema } from "@mako/host/contracts/execution-context"
import { assessExecutionContext, disconnectedContext, launchContext, observeNativeIdentity, reportedIdentity, reportedRuntime } from "@mako/host/base/execution-context"
import { CodexIdentityResponseSchema, codexRuntimeVersion } from "@mako/host/harnesses/codex/native-context"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { auditSnapshot } from "./performance-audit-fixtures.ts"

const context = launchContext("future-native", { kind: "reported", via: "native account" }, { name: "managed-a", dir: "/managed/a" }, "/runtime/a")
assert.equal(context.identity.kind, "pending")
assert.equal(context.runtime.kind, "unavailable")
assert.notEqual(context.account.kind, context.identity.kind, "configured account selection is never native identity evidence")
assert.equal(reportedRuntime(undefined, "hello").kind, "unavailable")
assert.equal(reportedRuntime("0.0.0-dev", "ACP initialize.agentInfo").kind, "unavailable", "Devin's handshake's 0.0.0-dev names no build: the launch asks the executable")
assert.equal(reportedRuntime("0.0.0-dev-20840", "launched native API info.version").kind, "reported", "OpenCode's dev builds are numbered after the zeros")
assert.equal(reportedIdentity(undefined, "apiKey", "account/read").kind, "unavailable")
assert.equal(disconnectedContext(context)?.identity.kind, "unavailable")
context.runtime = reportedRuntime("native-1.2", "hello")
context.identity = reportedIdentity("native@example.test", "native", "account/read")
context.store = { kind: "located", path: "/native/store/session-a" }
context.sourceImport = { source: "/native/legacy", destination: "/native/store/session-a", nativeId: "session-a", via: "fixture copy", revision: "copied-checkpoint" }
assert.deepEqual(ExecutionContextSchema.parse(context), context)
assert.equal(assessExecutionContext(context, context, false).kind, "unverified", "matching account/version facts cannot certify missing credentials or service authority")
context.credential = { kind: "configured", source: "fixture", revision: { kind: "reported", value: "opaque-revision", via: "fixture credential record" } }
context.service = { kind: "reported", authority: "fixture-service", via: "native handshake" }
assert.equal(assessExecutionContext(context, { ...context, service: { kind: "reported", authority: "other-service", via: "native handshake" } }, false).kind, "incompatible")
assert.equal(assessExecutionContext(context, { ...context, service: undefined }, false).kind, "incompatible", "loss of previously reported service evidence cannot admit input")
assert.equal(assessExecutionContext(context, { ...context, account: { kind: "unavailable", reason: "selection unavailable" } }, false).kind, "incompatible", "loss of configured selection is not an intentional account switch")
assert.equal(assessExecutionContext(context, { ...context, credential: undefined }, false).kind, "unverified", "older credential evidence remains missing")
assert.equal(assessExecutionContext(context, { ...context, credential: { kind: "configured", source: "fixture", revision: { kind: "reported", value: "new-revision", via: "fixture" } } }, false).kind, "unverified", "changed credentials require compatibility proof even with the same principal")
assert.equal(assessExecutionContext(context, context, false).kind, "compatible")
assert.equal(assessExecutionContext(undefined, context, false).kind, "unverified", "old journals do not invent compatibility")
assert.equal(assessExecutionContext(context, { ...context, transport: "changed" }, false).kind, "incompatible")
assert.equal(assessExecutionContext(context, { ...context, transport: "changed" }, true).kind, "compatible", "transport migration requires an exact import receipt at the recovery boundary")
assert.equal(assessExecutionContext(context, { ...context, runtime: reportedRuntime("native-2.0", "hello") }, false).kind, "unverified", "a runtime version change needs native schema coverage, not guessed semver compatibility")
// With a declared oldest, a change within oldest and up is one the session flows proved the client speaks.
const at = (version: string) => ({ ...context, runtime: reportedRuntime(version, "initialize") })
assert.equal(assessExecutionContext(at("0.150.0"), at("0.162.1"), false, "0.146.0").kind, "compatible", "both versions at or above oldest read compatible")
assert.equal(assessExecutionContext(at("0.162.1"), at("0.159.3"), false, "0.146.0").kind, "compatible", "moving back within the supported range is compatible too")
assert.equal(assessExecutionContext(at("0.140.0"), at("0.159.3"), false, "0.146.0").kind, "unverified", "a session saved under a version below oldest stays unproven")
const belowFloor = assessExecutionContext(at("0.150.0"), at("0.145.0"), false, "0.146.0")
assert.ok(belowFloor.kind === "unverified" && belowFloor.missing.includes("runtime-version-compatibility"), "reopening below oldest stays unproven")
assert.equal(assessExecutionContext(at("0.150.0"), at("0.159.3"), false).kind, "unverified", "without a declared oldest a change stays unproven")
assert.equal(assessExecutionContext(at("unrecognized agent"), at("0.159.3"), false, "0.146.0").kind, "unverified", "a version that doesn't read as one is never judged compatible")
// Codex 0.159.3 reports `initialize.userAgent` with the OS and terminal in it.
assert.equal(codexRuntimeVersion("mako/0.159.3 (Mac OS 26.6.2; arm64) dumb (mako; 0.0.1)"), "0.159.3", "an OS update is not a Codex version change")
assert.equal(codexRuntimeVersion("codex_cli_rs/0.160.0-alpha.2 (Linux 6.8; x86_64) xterm"), "0.160.0-alpha.2")
assert.equal(codexRuntimeVersion("unrecognized agent"), "unrecognized agent", "an unknown shape stays whole, never a guessed match")
assert.equal(assessExecutionContext(context, { ...context, identity: reportedIdentity(undefined, "other-backend", "account/read") }, false).kind, "incompatible", "backend evidence survives even when a named principal is unavailable")
assert.equal(assessExecutionContext(context, { ...context, identity: {kind:"unavailable",reason:"request failed"} }, false).kind, "incompatible", "failed identity evidence cannot admit a previously identified account")
const otherIdentity = reportedIdentity("other@example.test", "native", "account/read")
const defaultAccount = { ...context, account: { kind: "configured", name: "default", managed: false } } satisfies typeof context
assert.equal(assessExecutionContext(defaultAccount, { ...defaultAccount, identity: otherIdentity }, false).kind, "incompatible", "unchanged CLI-default selection cannot silently change principal either")
assert.equal(assessExecutionContext(context, { ...context, identity: otherIdentity }, false).kind, "incompatible", "the same managed selection must not silently report a different identity")
assert.equal(assessExecutionContext(context, { ...context, account: {kind:"configured",name:"managed-b",managed:true}, identity: otherIdentity }, false).kind, "compatible", "intentional global account switches remain allowed")
const root = await mkdtemp(join(tmpdir(), "mako-context-retention-"))
const snapshot = auditSnapshot(1, "fixture", 10, 0)
snapshot.session.executionContext = context
let journal = new LiveJournal(root, snapshot.session.id)
try {
  journal.commit(snapshot)
  journal.close()
  journal = new LiveJournal(root, snapshot.session.id)
  assert.deepEqual(journal.read()?.session.executionContext, context, "native launch facts survive journal reopen")
} finally { journal.close(); await rm(root, { recursive: true, force: true }) }

const deferred = Promise.withResolvers<typeof context.identity>()
const published: typeof context.identity[] = []
await observeNativeIdentity(() => deferred.promise, () => true, value => published.push(value), 5)
assert.equal(published[0]?.kind, "unavailable")
deferred.resolve(context.identity)
await delay(5)
assert.equal(published.length, 1, "a late answer cannot replace timeout evidence")
await observeNativeIdentity(async () => context.identity, () => false, value => published.push(value), 5)
assert.equal(published.length, 1, "a retired owner cannot publish native identity")
await observeNativeIdentity(async () => { throw new Error("native failure") }, () => true, value => published.push(value), 5)
assert.equal(published[1]?.kind, "unavailable")
assert.deepEqual(CodexIdentityResponseSchema.parse({ account: { type: "chatgpt", email: "native@example.test", planType: "pro", accessToken: "must-be-discarded" }, requiresOpenaiAuth: true, workspaceRouting: { secret: true } }), {
  account: { type: "chatgpt", email: "native@example.test", planType: "pro" }, requiresOpenaiAuth: true,
})
assert.equal(CodexIdentityResponseSchema.safeParse({ account: { type: "futureAuth", token: "unknown" }, requiresOpenaiAuth: true }).success, false)
console.log("Execution context: configured/native separation, missing facts, runtime changes within the declared oldest, journal retention, bounded reads, late-owner fencing and public-field parsing verified")
