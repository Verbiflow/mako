import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "../electron/live-conversations.ts"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.ts"
import { NO_NATIVE_EXCLUSION } from "../electron/contracts/execution-context.ts"
import { NO_NATIVE_PROMPT_IDENTITY } from "../electron/contracts/native-prompt-identity.ts"
import type { LiveDriverEvent, LiveSessionState } from "../electron/shared.ts"
import { spendBetween } from "../electron/session-usage.ts"
import { providerHost } from "../electron/providers/index.ts"
import { usageHarnesses, usageSummary } from "../electron/usage.ts"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

// Cursor's and Devin's stores keep no token counts, so what Mako measured
// while a request ran is the record the usage summary reads for them.
const tokens = (input: number, cacheRead: number, output: number) => ({ input, cacheRead, cacheWrite: 0, output })
assert.deepEqual(spendBetween({ tokens: tokens(100, 50, 10) }, { tokens: tokens(160, 90, 25) }), { tokens: tokens(60, 40, 15) })
assert.deepEqual(spendBetween({ tokens: tokens(500, 0, 50) }, { tokens: tokens(30, 0, 5) }), { tokens: tokens(30, 0, 5) }, "a meter that started over counts from zero")
assert.deepEqual(spendBetween(undefined, { cost: { amount: 0.25, currency: "USD" } }), { cost: 0.25 })
assert.deepEqual(spendBetween({ tokens: tokens(1, 0, 1) }, { tokens: tokens(1, 0, 1) }), {}, "a turn that spent nothing records nothing")

const root = mkdtempSync(join(tmpdir(), "mako-request-spend-"))
const conversations = join(root, "conversations")
const emitters = new Map<string, (event: LiveDriverEvent) => void>()
const sessions = new Map<string, LiveSessionState>()
const driver: ProviderLiveDriver = {
  ...noCapabilities,
  resume: fixtureResume(),
  launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeExclusion: NO_NATIVE_EXCLUSION,
  nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
  approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
  planning: { via: "setting", option: "plan", proposal: "Injected driver fixture" },
  backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
  turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
  provider: "cursor",
  available: () => true,
  async start(cwd, options) {
    assert.ok(options.emit, "the host gives every driver an event sink")
    emitters.set(options.conversationId, options.emit)
    const session: LiveSessionState = {
      id: options.conversationId,
      nativeId: `agent-${options.conversationId}`,
      harness: "cursor",
      cwd,
      status: "ready",
      connection: "connected",
      modes: [],
      currentMode: null,
      configOptions: [],
      settings: { model: "composer-2" },
      usage: { tokens: tokens(100, 50, 10) },
    }
    sessions.set(options.conversationId, session)
    return session
  },
  async prompt(id) {
    const session = sessions.get(id)!
    const emit = emitters.get(id)!
    emit({ type: "live-session", session: { ...session, status: "running" } })
    setTimeout(() => emit({ type: "live-session", session: { ...session, status: "ready", usage: { tokens: tokens(160, 90, 25) } } }), 5)
  },
  async cancel() {},
  async permission() {},
  async setMode() {},
  async close() {},
}
const owner = new LiveConversations({
  root: conversations,
  appPath: root,
  driver: () => driver,
  emit: () => {},
  history: async (path) => ({
    ref: { harness: "claude", nativeId: "source", path, cwd: "/work/spend", title: "Spend" },
    entries: [{ kind: "user", text: "Hello" }],
    start: 0,
    total: 1,
    hasEarlier: false,
  }),
  resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
})

try {
  const id = randomUUID()
  await owner.capture(id, join(root, "source.jsonl"))
  const requestId = randomUUID()
  owner.transfer(id, { id: requestId, provider: "cursor", text: "Go", attachments: [] })
  const deadline = Date.now() + 5_000
  let request
  for (;;) {
    request = owner.snapshot(id)?.requests.find((item) => item.id === requestId)
    if (request?.status === "completed") break
    if (Date.now() > deadline) throw new Error(`Timed out; request is ${request?.status}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.deepEqual(request.usageFrom, { tokens: tokens(100, 50, 10) })
  assert.equal(request.spend?.provider, "cursor")
  assert.equal(request.spend?.model, "composer-2")
  assert.deepEqual(request.spend?.tokens, tokens(60, 40, 15))
  await owner.close(id)

  const summary = await usageSummary(usageHarnesses(providerHost), join(root, "no-sessions"), join(root, "home"), conversations)
  const cursor = summary.sources?.find((source) => source.source === "Cursor")
  assert.equal(cursor?.recordedByMako, true)
  assert.equal(cursor?.messages, 1)
  assert.equal(cursor?.input, 60)
  assert.equal(cursor?.cacheRead, 40)
  assert.equal(cursor?.output, 15)
  assert.equal(summary.models?.[0]?.model, "composer-2")
  console.log("Request spend: a Cursor turn records what it spent from the meter, and the usage summary counts it")
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
  process.exit()
}
