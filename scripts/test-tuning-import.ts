import assert from "node:assert/strict"
import { mock } from "node:test"
import { resolveSessionSettings } from "@mako/sessions/settings"

const storage = new Map<string, string>()
globalThis.localStorage = {
  get length() {
    return storage.size
  },
  clear: () => storage.clear(),
  getItem: (key) => storage.get(key) ?? null,
  key: (index) => [...storage.keys()][index] ?? null,
  removeItem: (key) => void storage.delete(key),
  setItem: (key, value) => void storage.set(key, value),
}

storage.set(
  "mako.prefs.v1",
  JSON.stringify({
    composerTuning: { codex: { model: "a", effort: "high", fast: true } },
    providerTuningImported: ["codex"],
  })
)
const { prefsStore, setPref } = await import("../src/state/prefs.ts")
const { providerStore, providerProfileKey, providers } =
  await import("../src/state/providers.ts")
const { threadsStore } = await import("../src/state/thread-store.ts")
const {
  observedSessionSettings,
  resolveComposerSettings,
  settingsForSend,
  chooseComposerModel,
  chooseComposerOption,
  resetComposerSettings,
  threadSettingsTarget,
  settingsTargetKey,
  acknowledgeComposerSettings,
} = await import("../src/state/composer-settings.ts")
const { normalizeCodexModels } = await import("@mako/sessions/model-catalog")
const { acpStore } = await import("../src/state/acp-state.ts")
const catalog = normalizeCodexModels({
  data: [
    {
      model: "a",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "medium" },
        { reasoningEffort: "high" },
      ],
      serviceTiers: [{ id: "fast", name: "Fast" }],
    },
    { model: "b", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
  ],
})
const profile = {
  id: "codex",
  label: "Codex",
  available: true,
  transport: "app-server" as const,
  capabilities: [],
  ...catalog,
  settings: { model: "b", options: { effort: "low" } },
}
providerStore.set({
  contexts: { [providerProfileKey("codex", "/workspace")]: profile },
})
const draft = { kind: "new" as const, harness: "codex", cwd: "/workspace" }
assert.equal(prefsStore.get().providerSettings.codex.source, "legacy")
const migrated = resolveComposerSettings(draft)
assert.equal(migrated.model.kind === "known" && migrated.model.value, "a")
assert.equal(migrated.settings.options?.serviceTier, "priority")
assert.equal(migrated.settings.options?.fast, undefined)
assert.deepEqual(await settingsForSend(draft), migrated.settings)

providerStore.set({ contexts: {} })
const legacyGate = Promise.withResolvers<void>()
const legacyDiscovery = mock.method(providers, "load", async () => {
  await legacyGate.promise
  providerStore.set({
    contexts: { [providerProfileKey("codex", "/workspace")]: profile },
  })
})
let legacyResolved = false
const migrating = settingsForSend(draft).then((settings) => {
  legacyResolved = true
  return settings
})
await Promise.resolve()
assert.equal(
  legacyResolved,
  false,
  "Legacy option names still require authoritative migration metadata"
)
legacyGate.resolve()
assert.deepEqual(await migrating, migrated.settings)
legacyDiscovery.mock.restore()

resetComposerSettings(draft)
assert.equal(resolveComposerSettings(draft).settings.model, "b")
const changed = {
  ...profile,
  settings: { model: "a", options: { effort: "medium" } },
}
providerStore.set({
  contexts: { [providerProfileKey("codex", "/workspace")]: changed },
})
assert.equal(resolveComposerSettings(draft).settings.model, "a")
assert.deepEqual(prefsStore.get().providerSettings, {})

const ref = {
  harness: "codex",
  nativeId: "one",
  path: "/one",
  cwd: "/workspace",
  model: "a",
  settings: { model: "a", options: { effort: "low", serviceTier: "priority" } },
}
const second = {
  ...ref,
  path: "/two",
  nativeId: "two",
  model: "b",
  settings: { model: "b" },
}
threadsStore.set({ threads: [ref, second] })
const target = threadSettingsTarget(ref)
chooseComposerModel(draft, "b")
assert.equal(resolveComposerSettings(target).settings.model, "a")
chooseComposerOption(target, "serviceTier", "default")
assert.equal(
  resolveComposerSettings(target).settings.options?.serviceTier,
  "default"
)
assert.equal(resolveComposerSettings(target).settings.options?.effort, "low")
assert.equal(
  resolveComposerSettings(threadSettingsTarget(second)).settings.model,
  "b"
)
assert.deepEqual(
  await settingsForSend(target),
  resolveComposerSettings(target).settings
)

const { replaceAcpConversation } = await import("../src/state/acp-state.ts")
const observed = {
  kind: "live" as const,
  key: "live",
  draftKey: "/one",
  harness: "codex",
  cwd: "/workspace",
  threadPath: "/one",
  blocks: [],
  queued: [],
  hiddenUserPrompt: null,
  createdAt: 1,
  updatedAt: 1,
  permission: null,
  sending: false,
  canceling: false,
  session: {
    id: "live",
    harness: "codex",
    cwd: "/workspace",
    connection: "connected" as const,
    status: "ready" as const,
    modes: [],
    currentMode: null,
    configOptions: [],
    settings: {
      model: "a",
      options: { effort: "high", serviceTier: "default" },
    },
  },
}
replaceAcpConversation("live", observed)
acknowledgeComposerSettings(observed)
assert.equal(
  prefsStore.get().settingsOverrides[settingsTargetKey(target)],
  undefined
)
assert.equal(resolveComposerSettings(target).settings.options?.effort, "high")
chooseComposerOption(target, "serviceTier", "priority")
acknowledgeComposerSettings(observed)
assert.equal(
  resolveComposerSettings(target).settings.options?.serviceTier,
  "priority"
)
resetComposerSettings(target)
assert.equal(
  resolveComposerSettings(target).settings.options?.serviceTier,
  "default"
)
const restored = {
  ...observed,
  threadPath: undefined,
  session: {
    ...observed.session,
    nativeId: "one",
    settings: { model: "a", options: {} },
  },
}
replaceAcpConversation("live", restored)
threadsStore.set({ viewing: null, opening: null })
const restoredTarget = {
  kind: "live" as const,
  id: "live",
  harness: "codex",
  cwd: "/workspace",
}
assert.equal(
  resolveComposerSettings(restoredTarget).settings.options?.effort,
  "low"
)
assert.deepEqual(
  await settingsForSend(restoredTarget),
  resolveComposerSettings(restoredTarget).settings
)

const { accessModeId } = await import("../electron/contracts/access.ts")
const cursorMode = {
  kind: "select" as const,
  id: "mode",
  label: "Mode",
  current: "agent",
  values: [
    { value: "agent", label: "Agent" },
    { value: "plan", label: "Plan" },
    { value: "ask", label: "Ask" },
  ],
}
providerStore.set({
  contexts: {
    [providerProfileKey("cursor", "/workspace")]: {
      id: "cursor",
      label: "Cursor",
      available: true,
      transport: "acp" as const,
      capabilities: [],
      models: [{ id: "composer", label: "Composer", options: [cursorMode] }],
      settings: { model: "composer", options: { mode: "agent" } },
    },
  },
})
setPref("providerModes", { cursor: accessModeId("full") })
const cursorLive = {
  ...observed,
  key: "cursor-live",
  draftKey: "cursor-live",
  harness: "cursor",
  threadPath: undefined,
  session: {
    ...observed.session,
    id: "cursor-live",
    harness: "cursor",
    modes: [
      {
        id: "agent",
        name: "Agent",
        access: "ask" as const,
        enforcement: "provider" as const,
      },
      {
        id: accessModeId("full"),
        name: "Full access",
        access: "full" as const,
        enforcement: "launch" as const,
      },
    ],
    currentMode: accessModeId("full"),
    configOptions: [cursorMode],
    settings: { model: "composer", options: { mode: "agent" } },
  },
}
replaceAcpConversation("cursor-live", cursorLive)
const cursorTarget = {
  kind: "live" as const,
  id: "cursor-live",
  harness: "cursor",
  cwd: "/workspace",
}
const cursorSend = await settingsForSend(cursorTarget)
assert.equal(cursorSend.options?.mode, "agent")
assert.equal(
  await settingsForSend({
    kind: "new",
    harness: "cursor",
    cwd: "/workspace",
  }).then((settings) => settings.options?.mode),
  "agent"
)
acpStore.set({ conversations: {}, activeKey: null })
console.log(
  "Settings migration, live provenance, scoped edits, acknowledgements, and display/dispatch parity passed"
)

assert.deepEqual(
  observedSessionSettings(
    { settings: { model: "fable", options: { effort: "high", fast: false } } },
    { model: "fable", options: {} }
  ),
  { model: "fable", options: { effort: "high", fast: false } }
)
assert.deepEqual(
  observedSessionSettings(
    { settings: { model: "fable", options: { effort: "high" } } },
    { model: "opus", options: {} }
  ),
  { model: "opus", options: {} }
)
assert.equal(
  observedSessionSettings(
    { settings: { model: "fable", options: { effort: "high" } } },
    { model: "fable", options: { effort: "low" } }
  ).options?.effort,
  "low"
)
const claudeAliases = [
  {
    id: "claude-fable-5-1",
    label: "Fable",
    aliases: ["claude-fable-5-1[1m]"],
    options: [],
  },
]
assert.deepEqual(
  observedSessionSettings(
    { settings: { model: "claude-fable-5-1", options: { effort: "high" } } },
    { model: "claude-fable-5-1[1m]", options: {} },
    claudeAliases
  ),
  { model: "claude-fable-5-1[1m]", options: { effort: "high" } }
)

const { normalizeClaudeModels, claudeVersionedLabel } =
  await import("@mako/sessions/model-catalog")
// Claude Code names the Fable row by family alone; the id knows the version.
assert.equal(claudeVersionedLabel("claude-fable-5-1", "Fable"), "Fable 5.1")
assert.equal(
  claudeVersionedLabel("claude-opus-5[1m]", "Opus (1M context)"),
  "Opus 5 (1M context)"
)
assert.equal(
  claudeVersionedLabel("claude-haiku-4-5-20251001", "Haiku"),
  "Haiku 4.5"
)
assert.equal(
  claudeVersionedLabel("claude-sonnet-4-6[1m]", "Sonnet 4.6 (1M context)"),
  "Sonnet 4.6 (1M context)"
)
assert.equal(claudeVersionedLabel("fable", "Fable"), "Fable")
assert.equal(
  claudeVersionedLabel("claude-fable-5-1", undefined),
  "claude-fable-5-1"
)
const fixedSpeed = normalizeClaudeModels([
  {
    value: "fable",
    resolvedModel: "fable",
    displayName: "Fable",
    supportsFastMode: false,
  },
])
const fixedSpeedView = resolveSessionSettings({
  models: fixedSpeed.models,
  context: "new",
  overrides: { model: "fable" },
})
assert.deepEqual(fixedSpeedView.issues, [])
assert.equal(
  fixedSpeedView.options.fast?.kind === "known" &&
    fixedSpeedView.options.fast.value,
  false
)
