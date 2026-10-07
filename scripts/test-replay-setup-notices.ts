import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { mcpServerFailedEvent } from "@mako/sessions/events"
import { LiveConversations } from "../electron/live-conversations.js"
import type { LiveDriverEvent, LiveSessionState } from "../electron/shared.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"
import { NO_NATIVE_EXCLUSION } from "../electron/contracts/execution-context.js"
import { NO_NATIVE_PROMPT_IDENTITY } from "../electron/contracts/native-prompt-identity.js"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

// Waking a conversation streams the provider's saved history back, which the
// host drops. A setup notice said while waking is about this launch, so it
// still reaches the transcript.
const root = mkdtempSync(join(tmpdir(), "mako-replay-setup-"))
const waitFor = async (check: () => boolean, message: string) => {
  for (let i = 0; i < 400 && !check(); i++) await delay(5)
  assert.ok(check(), message)
}
try {
  const id = randomUUID()
  let emit: ((event: LiveDriverEvent) => void) | undefined
  let starts = 0
  const session = (bindingId: string, status: LiveSessionState["status"] = "ready"): LiveSessionState => ({
    id: bindingId, nativeId: "native-replay", nativePath: join(root, "native-replay"), harness: "test-provider", cwd: root,
    status, connection: "connected", modes: [], currentMode: null, configOptions: [],
  })
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    resume: fixtureResume(),
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
    backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
    turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
    provider: "test-provider", available: () => true,
    start: async (_cwd, options) => {
      starts++
      emit = options.emit
      if (options.resume) {
        emit?.({ type: "live-update", id: options.conversationId, update: { kind: "text", text: "the first answer" } })
        emit?.({ type: "live-update", id: options.conversationId, update: { kind: "event", ...mcpServerFailedEvent("search", "sign-in required") } })
      }
      return session(options.conversationId)
    },
    prompt: async (bindingId) => {
      emit?.({ type: "live-session", session: session(bindingId, "running") })
      if (starts === 1) emit?.({ type: "live-update", id: bindingId, update: { kind: "text", text: "the first answer" } })
      emit?.({ type: "live-session", session: session(bindingId) })
    },
    permission: async () => {}, cancel: async () => {}, close: async () => {}, setMode: async () => {},
  }
  const owner = new LiveConversations({
    appPath: root, root: join(root, "journals"), driver: () => driver, history: async () => null, emit: () => {},
    providerIdleMs: 15, resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
  })
  try {
    await owner.start("test-provider", root, { conversationId: id })
    owner.submit(id, randomUUID(), "first")
    await waitFor(() => owner.snapshot(id)?.requests[0]?.status === "completed", "the first turn did not complete")
    await waitFor(() => owner.snapshot(id)?.session.connection === "hibernated", "the idle provider did not hibernate")
    owner.submit(id, randomUUID(), "second")
    await waitFor(() => owner.snapshot(id)?.requests[1]?.status === "completed", "the woken turn did not complete")
    assert.equal(starts, 2)
    const text = JSON.stringify(owner.snapshot(id)?.blocks ?? [])
    assert.equal(text.split("the first answer").length - 1, 1, "replayed history is not drawn again")
    const notice = mcpServerFailedEvent("search", "sign-in required")
    assert.equal(text.split(JSON.stringify(notice.detail)).length - 1, 1, "a setup notice said while waking reaches the transcript, once")
  } finally {
    owner.close(id)
  }
  console.log("Replay: waking drops replayed history and keeps this launch's setup notices")
} finally {
  rmSync(root, { recursive: true, force: true })
}
