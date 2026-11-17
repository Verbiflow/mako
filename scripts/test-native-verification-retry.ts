import { assessProviderResume } from "@mako/host/harnesses/provider-recovery"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { launchContext } from "@mako/host/base/execution-context"
import { resumeVerdict } from "@mako/host/harnesses/native-continuation"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"
import { registeredHarnessIds } from "./registered-harnesses.ts"

async function until(test: () => boolean, message: string) {
  const deadline = performance.now() + 4_000
  while (!test()) {
    assert.ok(performance.now() < deadline, message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function check(provider: string, fault: "identity" | "probe" | "mismatch" | "read", stop = false) {
  const root = mkdtempSync(join(tmpdir(), "mako-verification-retry-"))
  const id = randomUUID()
  const reply = randomUUID()
  const path = join(root, "native-record")
  const sent: string[] = []
  const starts: Array<string | undefined> = []
  let healthy = false
  let emit: NonNullable<Parameters<ProviderLiveDriver["start"]>[1]["emit"]> | undefined
  let session: LiveSessionState
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    resume: fixtureResume({ inspect: async () => {
      if (fault === "read" && !healthy) throw new Error("Synthetic native source read failure")
      return { kind: "available", checkpoint: "fixture-checkpoint", strategy: "same-session" }
    } }),
    launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
    backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
    turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
    provider, available: () => true,
    async start(cwd, options) {
      starts.push(options.resume)
      emit = options.emit
      const context = launchContext("fixture-native", { kind: "reported", via: "fixture native identity" }, { name: "default" })
      context.runtime = { kind: "reported", version: "1.0.0", via: "fixture" }
      context.store = { kind: "located", path }
      context.service = { kind: "reported", authority: "fixture-service", via: "fixture" }
      context.identity = options.resume && !healthy && fault === "identity"
        ? { kind: "unavailable", reason: "The native identity request timed out." }
        : { kind: "reported", principal: options.resume && fault === "mismatch" ? "different@example.test" : "expected@example.test", backend: "fixture", via: "fixture native identity" }
      session = { id: options.conversationId, nativeId: "native-saved", nativePath: path, harness: provider, cwd, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [], executionContext: context }
      return session
    },
    async prompt(_binding, text, _attachments, _tuning, dispatch) {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      sent.push(text)
      emit?.({ type: "live-session", session: { ...session, status: "running" } })
      emit?.({ type: "live-session", session: { ...session, lastStop: "end_turn" } })
    },
    async close() {}, async cancel() {}, async permission() {}, async setMode() {},
  }
  const owner = new LiveConversations({
    root: join(root, "journals"), appPath: root, driver: () => driver, history: async () => null, emit: () => {},
    resumeVerdict: (binding) => fault === "read" ? assessProviderResume(binding, driver) : resumeVerdict(binding, {
      provider,
      probe: async () => fault === "probe" && !healthy ? { kind: "unavailable", reason: "failed" } : { kind: "available", sessions: [] },
    }, async () => ({ kind: "available", checkpoint: "fixture-checkpoint" })),
  })
  try {
    await owner.start(provider, root, { conversationId: id })
    owner.submit(id, randomUUID(), "Seed the saved conversation")
    await until(() => owner.snapshot(id)?.requests[0]?.status === "completed", "the seed turn did not complete")
    assert.equal(owner.hibernateIfIdle(id), true)
    await until(() => owner.snapshot(id)?.session.connection === "hibernated", "the seed session did not hibernate")
    owner.submit(id, reply, "Continue the saved work")
    const request = () => owner.snapshot(id)!.requests.find((row) => row.id === reply)!
    await until(() => request().status === "held" || request().status === "failed", "the verification refusal did not settle")
    assert.equal(sent.length, 1, "no unverified input reaches the native process")
    if (fault === "mismatch") {
      assert.equal(request().status, "failed", "a real principal conflict is never converted into a retry grant")
      assert.equal(request().retry, undefined)
      return
    }
    assert.equal(request().status, "held", "a temporary verification read holds the same input for re-verification")
    const retry = request().retry!
    assert.ok(retry)
    assert.notEqual(retry.cause, "rate-limited", "identity/ownership verification is not a quota")
    assert.equal(retry.until, undefined, "verification never waits for an account reset")
    assert.ok(retry.at - retry.since <= 30_000, "the first re-verification is prompt")
    if (stop) await owner.cancel(id)
    healthy = true
    owner.wakeDue(retry.at + 1)
    if (stop) {
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(sent.length, 1, "Stop cancels the automatic retry")
      return
    }
    await until(() => request().status === "completed", "input did not resume after native verification recovered")
    assert.equal(sent.length, 2, "original queued input goes once after verification")
    assert.ok(starts.slice(1).every((native) => native === "native-saved"), "recovery rebinds the saved native session, never evades the guard with a new session")
    assert.equal(owner.snapshot(id)?.control?.bindings.length, 1)
  } finally {
    await owner.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

for (const harness of registeredHarnessIds()) {
  await check(harness, "identity")
  await check(harness, "probe")
}
await check("codex", "read")
await check("codex", "read", true)
await check("codex", "mismatch")
await check("codex", "identity", true)
console.log("PASS: native verification holds unsent input, rechecks promptly without quota semantics, rebinds once, and preserves real identity conflicts and Stop")
