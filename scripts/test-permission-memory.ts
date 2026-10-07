import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "../electron/live-conversations.ts"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.ts"
import { NO_NATIVE_EXCLUSION } from "../electron/contracts/execution-context.ts"
import { NO_NATIVE_PROMPT_IDENTITY } from "../electron/contracts/native-prompt-identity.ts"
import { createMakoBridge } from "../electron/shared.ts"
import { acp, acpStore } from "../src/state/acp.ts"
import { applyLiveSnapshot } from "../src/state/live-recovery.ts"
import { prefsStore } from "../src/state/prefs.ts"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

const root = await mkdtemp(join(tmpdir(), "mako-mode-memory-"))
const id = randomUUID()
const session = {
  id,
  harness: "fixture",
  cwd: root,
  status: "ready" as const,
  connection: "connected" as const,
  modes: [
    { id: "ask", name: "Ask" },
    { id: "accept-edits", name: "Accept edits" },
  ],
  currentMode: "ask",
  configOptions: [],
}
const applied: string[] = []
const prompts: string[] = []
const gate = Promise.withResolvers<void>()
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
  provider: "fixture",
  available: () => true,
  start: async (_cwd, options) => ({ ...session, id: options.conversationId }),
  prompt: async (_id, text) => {
    prompts.push(text)
  },
  setMode: async (_id, mode) => {
    applied.push(mode)
    await gate.promise
  },
  close: () => {},
  cancel: async () => {},
  permission: async () => {},
}
const owner = new LiveConversations({
  root,
  appPath: root,
  driver: () => driver,
  history: async () => null,
  emit: () => {},
})
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
try {
  await owner.start("fixture", root, {
    conversationId: id,
    modeId: "accept-edits",
    initialRequest: { id: randomUUID(), text: "First prompt", attachments: [] },
  })
  await tick()
  assert.deepEqual(applied, ["accept-edits"])
  assert.equal(
    prompts.length,
    0,
    "The first prompt waits for the provider to apply the saved permission mode"
  )
  gate.resolve()
  await tick()
  assert.deepEqual(prompts, ["First prompt"])
  assert.equal(owner.snapshot(id)?.session.currentMode, "accept-edits")
  const snapshot = owner.snapshot(id)
  assert.ok(snapshot)
  const bridge = createMakoBridge({
    invoke: async (channel) => {
      throw new Error(`The fixture host does not serve ${channel}`)
    },
    onEvent: () => () => {},
    onTerminalEvent: () => () => {},
    pathForFile: () => null,
    resolveFileUrl: (url) => url,
  })
  const modeChanges: Array<[string, string]> = []
  Object.assign(globalThis, {
    window: {
      mako: {
        ...bridge,
        liveSetMode: async (key: string, mode: string) => {
          modeChanges.push([key, mode])
        },
      },
    },
  })
  applyLiveSnapshot(snapshot)
  acpStore.set({ activeKey: id })
  await acp.setMode("ask")
  assert.deepEqual(modeChanges, [[id, "ask"]])
  assert.equal(prefsStore.get().providerModes.fixture, "ask")
  assert.equal(
    prefsStore.get().providerModes.claude,
    undefined,
    "Permission policy is remembered per provider, never blindly translated across providers"
  )
  const invalid = randomUUID()
  await owner.start("fixture", root, {
    conversationId: invalid,
    modeId: "removed-mode",
    initialRequest: { id: randomUUID(), text: "Must not run", attachments: [] },
  })
  await tick()
  assert.equal(owner.snapshot(invalid)?.session.status, "failed")
  assert.equal(prompts.includes("Must not run"), false)
  console.log(
    "Permission memory: acknowledged per-provider preference, startup ordering, and no silent fallback from an unavailable mode verified"
  )
} finally {
  owner.stop()
  await rm(root, { recursive: true, force: true })
}
