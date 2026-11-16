import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { makoFacts, makoLogDifference } from "@mako/host/conversations/mako-log"
import { HostFailureError, providerCall } from "@mako/host/contracts/provider-failure"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

const quota = "You have hit your usage limit. Try again in 3 hours."
async function until(ready: () => boolean) {
  const end = Date.now() + 10_000
  while (!ready()) {
    assert.ok(Date.now() < end, "scratch host settled")
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
for (const phase of ["host-tools", "host-instructions", "host-identity", "native-start", "native-send"] as const) {
  const root = mkdtempSync(join(tmpdir(), "mako-typed-failure-"))
  const id = randomUUID()
  let opens = 0
  let sends = 0
  const driver: ProviderLiveDriver = {
    ...noCapabilities, provider: "fixture", resume: fixtureResume(),
    nativeExclusion: NO_NATIVE_EXCLUSION, nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    launchEnvironment: { kind: "unavailable", reason: "Scripted origin fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Scripted origin fixture" },
    approvalEvidence: { kind: "submission-only", reason: "Scripted origin fixture" },
    planning: { via: "setting", option: "plan", proposal: "Fixture", feedback: { kind: "next-message", reason: "Fixture" } },
    backgroundStop: { kind: "ends-with-turn", evidence: "Fixture" }, turnRecovery: { kind: "manual", reason: "Fixture" },
    available: () => true,
    async start(cwd, options) {
      opens++
      if (phase === "native-start") return providerCall(Promise.reject(new Error(quota)))
      if (phase === "host-identity") throw new HostFailureError("wrong-account", quota)
      const session: LiveSessionState = { id: options.conversationId, harness: "fixture", cwd, nativeId: "fixture-native", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }
      return session
    },
    async prompt(_id, _text, _attachments, _settings, dispatch) {
      sends++
      dispatch.report({ kind: "not-accepted", source: "preflight", reason: quota })
      return providerCall(Promise.reject(new Error(quota)))
    },
    async permission() {}, async cancel() {}, async setMode() {}, close() {},
  }
  const owner = new LiveConversations({ root, appPath: root, driver: () => driver, history: async () => null, emit() {},
    tools: async () => { if (phase === "host-tools") throw new Error(quota); return undefined },
    controlInstructions: async () => { if (phase === "host-instructions") throw new Error(quota); return { standing: {}, notices: [] } },
  })
  try {
    await owner.start("fixture", root, { conversationId: id })
    const requestId = randomUUID()
    owner.submit(id, requestId, "Keep this message")
    await until(() => {
      const request = owner.snapshot(id)?.requests.find((item) => item.id === requestId)
      return request?.status === "failed" || request?.status === "held"
    })
    const request = owner.snapshot(id)!.requests.find((item) => item.id === requestId)!
    if (phase.startsWith("host-")) {
      assert.equal(request.status, "failed")
      assert.equal(request.failure, phase === "host-identity" ? "wrong-account" : "unknown")
      assert.equal(request.failureEvidence?.source, "host")
      assert.equal(request.retry, undefined)
      assert.equal(request.signIn, undefined)
      assert.equal(sends, 0)
      if (phase === "host-tools") assert.equal(opens, 0)
    } else {
      assert.equal(request.status, "held")
      assert.equal(request.retry?.cause, "rate-limited")
      assert.equal(request.retry?.until, request.retry!.at - 30_000, "native reset, not a host wording match")
      assert.equal(request.signIn, undefined)
      assert.equal(sends, phase === "native-send" ? 1 : 0)
    }
    const saved = new LiveJournal(root, id)
    const persisted = saved.read()?.requests.find((item) => item.id === requestId)
    assert.deepEqual(persisted?.failureEvidence, request.failureEvidence)
    assert.deepEqual(persisted?.retry, request.retry)
    assert.equal(makoLogDifference(saved.makoLog(), makoFacts(saved.read()!)), undefined, "log replay restores exact failure evidence, not the legacy fallback")
    if (phase === "host-identity") {
      const before = saved.read()!
      const nativeEvidence = { kind: "auth", source: "native-error" } as const
      const after = { ...before, requests: before.requests.map(item => item.id === requestId ? { ...item, failure: "auth" as const, failureEvidence: nativeEvidence } : item) }
      saved.commit(after, before)
      assert.deepEqual(saved.read()?.requests.find(item => item.id === requestId)?.failureEvidence, nativeEvidence)
      assert.equal(makoLogDifference(saved.makoLog(), makoFacts(saved.read()!)), undefined, "new native-error origin survives actual row and log replay with the legacy fallback")
    }
    const opaque = { kind: "network", source: "host", exact: { vendorOwned: "keep verbatim" } }
    const future = { kind: "permission.future", value: { key: "opaque", set: { vendorPayload: { failureEvidence: opaque } } } }
    const nested = { kind: "request.future", value: { key: requestId, set: { vendorPayload: { failureEvidence: opaque } } } }
    saved["appendLog"]([future, nested], "host")
    assert.deepEqual(saved.makoLog().at(-2)?.value, future.value, "unknown native/permission payloads stay opaque")
    assert.deepEqual(saved.makoLog().at(-1)?.value, nested.value, "a known request patch does not rewrite nested provider data")
    saved.close()
    if (phase.startsWith("host-")) {
      const db = new DatabaseSync(join(root, id + ".sqlite"), { readOnly: true })
      try {
        const rows = z.array(z.object({ value: z.string() })).parse(db.prepare("SELECT value FROM requests").all())
        assert.ok(rows.some(row => row.value.includes('"exact"')), "the actual journal stores a legacy-readable fallback beside the exact evidence")
        const legacy = z.object({ id: z.string(), failureEvidence: z.object({ kind: z.literal("unknown"), source: z.literal("provider-error") }) })
        assert.ok(rows.some(row => legacy.safeParse(JSON.parse(row.value)).data?.id === requestId), "an old request reader still retains the exact request ID")
      } finally { db.close() }
    }
    console.log(`PASS: actual host/store ${phase}, native dispatch counts and durable failure/reset provenance`)
  } finally {
    await owner.stop()
    rmSync(root, { recursive: true, force: true })
  }
}
