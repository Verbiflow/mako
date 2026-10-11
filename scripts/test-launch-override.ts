import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

// A launch-only harness reads its access level when its process starts. When
// its own settings override the level asked for (Grok honouring Claude Code's
// permissions.defaultMode in place of Ask), the session runs at the level it
// launched at and starts; selecting the asked level again could only fail.
// A session launched at the asked level but in a native mode is still put back.
const root = mkdtempSync(join(tmpdir(), "mako-launch-override-"))
const waitFor = async (check: () => boolean, message: string) => {
  for (let i = 0; i < 400 && !check(); i++) await delay(5)
  assert.ok(check(), message)
}
try {
  const modes: LiveSessionState["modes"] = [
    { id: "access:ask", name: "Ask before acting", access: "ask", enforcement: "launch" },
    { id: "access:auto", name: "Auto review", access: "auto", enforcement: "launch" },
    { id: "plan", name: "Plan", access: "plan", enforcement: "provider" },
  ]
  let reported: Pick<LiveSessionState, "currentMode" | "launchMode"> = { currentMode: "access:auto", launchMode: "access:auto" }
  const applied: string[] = []
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
    provider: "launch-only",
    available: () => true,
    start: async (_cwd, options) => ({
      id: options.conversationId, harness: "launch-only", cwd: root, status: "ready", connection: "connected",
      modes, configOptions: [], ...reported,
    }),
    prompt: async () => {}, permission: async () => {}, cancel: async () => {}, close: async () => {},
    setMode: async (_id, modeId) => {
      applied.push(modeId)
      if (modeId === "access:ask") throw new Error("launch-only reads Ask before acting when its session starts")
    },
  }
  const owner = new LiveConversations({ appPath: root, root: join(root, "journals"), driver: () => driver, history: async () => null, emit: () => {} })
  try {
    const overridden = randomUUID()
    await owner.start("launch-only", root, { conversationId: overridden, modeId: "access:ask" })
    await waitFor(() => owner.snapshot(overridden)?.session.connection === "connected", "the overridden launch did not start")
    const started = owner.snapshot(overridden)!.session
    assert.equal(started.status, "ready", "a launch its settings overrode still starts")
    assert.equal(started.currentMode, "access:auto", "the session shows the level it runs at")
    assert.deepEqual(applied, [], "the asked level is not selected again")

    reported = { currentMode: "plan", launchMode: "access:auto" }
    const native = randomUUID()
    await owner.start("launch-only", root, { conversationId: native, modeId: "access:auto" })
    await waitFor(() => owner.snapshot(native)?.session.currentMode === "access:auto", "the native mode was not left")
    assert.deepEqual(applied, ["access:auto"], "a session launched at the asked level is put back from its native mode")
  } finally {
    owner.stop()
  }
  console.log("Launch overrides: a launch-only level the harness's settings overrode starts at the level it runs at; one launched as asked leaves a native mode")
} finally {
  rmSync(root, { recursive: true, force: true })
}
