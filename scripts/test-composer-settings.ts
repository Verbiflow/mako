import assert from "node:assert/strict"

// The renderer state layer is React-free, but modules read `window` at load.
Object.assign(globalThis, {
  window: {
    mako: {},
    addEventListener() {},
    removeEventListener() {},
    setInterval() {},
    clearInterval() {},
    location: { search: "" },
  },
})

const {
  composerModelLabel,
  currentSettingsTarget,
  resolveComposerSettingsInput,
  resolveSettingsTarget,
  threadSettingsTarget,
} = await import("../src/state/composer-settings.ts")
const { beginStart } = await import("../src/state/acp-start.ts")
const { acpStore } = await import("../src/state/acp-state.ts")
const { threadsStore } = await import("../src/state/thread-store.ts")
type HarnessProfile = import("../src/lib/types.ts").HarnessProfile
type ThreadRef = import("../src/lib/types.ts").ThreadRef

const cwd = "/repo"
const profile: HarnessProfile = {
  id: "claude",
  label: "Claude Code",
  available: true,
  transport: "acp",
  models: [{ id: "opus", label: "Opus 5", options: [] }],
  settings: { model: "opus" },
}

function label(
  target: ReturnType<typeof resolveSettingsTarget>,
  session?: { model?: string },
  reporting = false
): string {
  const { resolved, model } = resolveComposerSettingsInput({
    target,
    profile,
    session,
  })
  return (
    model?.label ??
    (resolved.model.kind === "known" ? resolved.model.value : undefined) ??
    composerModelLabel({ target, profile, reporting })
  )
}

// A fresh composer shows the provider default before the send.
const fresh = resolveSettingsTarget({ harness: "claude", workspace: cwd })
assert.deepEqual(fresh, { kind: "new", harness: "claude", cwd })
assert.equal(label(fresh), "Opus 5")

// Sending creates a starting conversation. It carries the target the send
// resolved with, and the composer keeps resolving through that target, so the
// label cannot change between pressing Enter and the provider's first report.
threadsStore.set({ composerHarness: "claude" })
const starting = beginStart({
  harness: "claude",
  cwd,
  blocks: [{ type: "user", text: "hello" }],
  hiddenUserPrompt: null,
})
assert.equal(starting.settingsTarget.kind, "new")
assert.equal(acpStore.get().activeKey, starting.key)
assert.deepEqual(currentSettingsTarget("claude"), starting.settingsTarget)
const duringStart = resolveSettingsTarget({
  harness: "claude",
  live: {
    id: starting.key,
    harness: "claude",
    cwd,
    settingsTarget: starting.settingsTarget,
  },
  workspace: cwd,
})
assert.equal(duringStart, starting.settingsTarget)
assert.equal(label(duringStart), "Opus 5")

// Without that target the same conversation resolves as an existing session
// with no settings: the provider's default, not the saved choice the send was
// built from, which is the flicker this guards.
const asExisting = resolveSettingsTarget({
  harness: "claude",
  live: { id: starting.key, harness: "claude", cwd },
  workspace: cwd,
})
assert.equal(asExisting.kind, "live")
const unrecorded = resolveComposerSettingsInput({
  target: asExisting,
  profile,
  session: {},
}).resolved.model
assert.deepEqual(unrecorded, { kind: "known", value: "opus", source: "provider" })
assert.equal(
  resolveComposerSettingsInput({
    target: asExisting,
    profile: { ...profile, settings: undefined },
    session: {},
  }).resolved.model.kind,
  "unknown",
  "a profile without defaults leaves an unrecorded model unknown"
)

// A stored target from another provider is never borrowed.
const foreign = resolveSettingsTarget({
  harness: "codex",
  live: {
    id: starting.key,
    harness: "claude",
    cwd,
    settingsTarget: starting.settingsTarget,
  },
  workspace: cwd,
})
assert.deepEqual(foreign, { kind: "new", harness: "codex", cwd })

// Resuming a thread keeps resolving through that thread's own settings.
const ref: ThreadRef = {
  harness: "claude",
  nativeId: "native-1",
  path: "/sessions/one.jsonl",
  cwd,
  model: "opus",
}
const resumed = beginStart({
  settingsTarget: threadSettingsTarget(ref),
  harness: "claude",
  cwd,
  threadPath: ref.path,
  blocks: [],
  hiddenUserPrompt: null,
})
const resuming = resolveSettingsTarget({
  harness: "claude",
  ref,
  live: {
    id: resumed.key,
    harness: "claude",
    cwd,
    path: ref.path,
    settingsTarget: resumed.settingsTarget,
  },
})
assert.deepEqual(resuming, threadSettingsTarget(ref))
assert.equal(label(resuming, { model: ref.model }), "Opus 5")

// The fallback copy names the actual state instead of blaming the provider.
const thread = threadSettingsTarget(ref)
assert.equal(
  composerModelLabel({ target: thread, profile, reporting: true }),
  "Loading model…"
)
assert.equal(
  composerModelLabel({ target: thread, profile, reporting: false }),
  "Model not recorded"
)
assert.equal(
  composerModelLabel({ target: fresh, profile, reporting: false }),
  "Choose a model"
)
assert.equal(
  composerModelLabel({ target: thread, profile: undefined, reporting: false }),
  "Loading model…"
)
assert.equal(
  composerModelLabel({
    target: thread,
    profile: { ...profile, available: false, pending: true, models: [] },
    reporting: false,
  }),
  "Loading model…"
)
assert.equal(
  composerModelLabel({
    target: thread,
    profile: { ...profile, available: false, models: [], error: "not installed" },
    reporting: true,
  }),
  "Model unavailable"
)
assert.equal(
  composerModelLabel({
    target: fresh,
    profile,
    error: "Model settings could not be loaded",
    reporting: true,
  }),
  "Model unavailable"
)

console.log("composer settings: starting conversations keep their send target")

// A running ACP session reports which of its current model's options it can
// change. Another model's options are not "fixed for this session": choosing
// that model switches the session, so its catalog options stay editable. The
// Cursor picker once showed Grok 4.6's effort as unchangeable while the
// session was still on Fable, which was never true.
{
  const cursor: HarnessProfile = {
    id: "cursor",
    label: "Cursor",
    available: true,
    transport: "acp",
    models: [
      {
        id: "claude-fable-5-1",
        label: "Claude Fable 5.1",
        options: [
          { kind: "select", id: "effort", label: "Effort", role: "reasoning", values: [{ value: "high", label: "High" }] },
          { kind: "select", id: "thinking", label: "Thinking", values: [{ value: "true", label: "On" }] },
        ],
      },
      {
        id: "grok-4.6",
        label: "Grok 4.6",
        options: [
          { kind: "select", id: "effort", label: "Effort", role: "reasoning", values: [{ value: "high", label: "High" }, { value: "xhigh", label: "Extra High" }] },
          { kind: "select", id: "fast", label: "Fast", role: "speed", values: [{ value: "true", label: "Fast" }, { value: "false", label: "Off" }] },
        ],
      },
    ],
    settings: { model: "claude-fable-5-1" },
  }
  const target = { kind: "live" as const, id: "live-1", harness: "cursor", cwd }
  const live = {
    options: [
      { kind: "select" as const, id: "effort", wireId: "effort", label: "Effort", role: "reasoning" as const, current: "high", values: [{ value: "high", label: "High" }] },
    ],
  }
  const session = { model: "claude-fable-5-1", options: { effort: "high", thinking: "true" } }
  const current = resolveComposerSettingsInput({ target, profile: cursor, session, live })
  assert.equal(current.model?.id, "claude-fable-5-1")
  assert.equal(current.options.find((option) => option.id === "effort")?.disabledReason, undefined)
  assert.equal(
    current.options.find((option) => option.id === "thinking")?.disabledReason,
    "Thinking cannot be changed in this running session."
  )
  const switched = resolveComposerSettingsInput({
    target,
    profile: cursor,
    session,
    live,
    overrides: { model: "grok-4.6", options: { effort: "xhigh" } },
  })
  assert.equal(switched.model?.id, "grok-4.6")
  assert.deepEqual(
    switched.options.map((option) => [option.id, option.disabledReason]),
    [["effort", undefined], ["fast", undefined]]
  )
  assert.deepEqual(switched.resolved.issues, [])
  assert.deepEqual(switched.resolved.settings, { model: "grok-4.6", options: { effort: "xhigh" } })
  assert.equal(switched.resolved.options.fast?.kind, "unknown", "an option without a default is chosen by the user, never invented")

  const { optionLabel } = await import("../src/components/composer/settings-source.ts")
  const speed = switched.options.find((option) => option.id === "fast")
  const effort = switched.options.find((option) => option.id === "effort")
  assert.ok(speed)
  assert.ok(effort?.kind === "select", "effort is offered as a choice of levels")
  assert.equal(optionLabel(speed, { kind: "unknown" }), "Speed not reported", "the control is offered; the provider has simply not said")
  assert.equal(optionLabel(effort, { kind: "known", value: "xhigh", source: "override" }), "Extra High reasoning")
  assert.equal(
    optionLabel({ ...effort, values: [{ value: "high", label: "High Effort" }] }, { kind: "known", value: "high", source: "session" }),
    "High Effort",
    "a value that already names its noun is not given a second one"
  )
  assert.equal(optionLabel(speed, { kind: "known", value: "true", source: "session" }), "Fast")
}

// The role cycle walks only the provider's own values: effort steps through
// the select's choices, speed flips its boolean, and an unreported role is
// a no-op rather than an invented toggle.
{
  const { cycleComposerRole } = await import("../src/state/composer-settings.ts")
  const { providerStore, providerProfileKey } = await import("../src/state/providers.ts")
  const { prefsStore, setPref } = await import("../src/state/prefs.ts")
  const harnessed: HarnessProfile = {
    ...profile,
    models: [
      {
        id: "opus",
        label: "Opus 5",
        options: [
          {
            id: "effort",
            label: "Effort",
            kind: "select",
            role: "reasoning",
            values: [
              { value: "low", label: "Low" },
              { value: "high", label: "High", default: true },
            ],
          },
          { id: "fast", label: "Fast", kind: "boolean", role: "speed" },
        ],
      },
    ],
  }
  providerStore.set({
    contexts: { [providerProfileKey("claude", cwd)]: harnessed },
  })
  threadsStore.set({ composerHarness: "claude", viewing: null, opening: null })
  setPref("settingsOverrides", {})
  setPref("providerSettings", {})
  assert.equal(cycleComposerRole("reasoning"), "Low")
  assert.equal(cycleComposerRole("reasoning"), "High")
  assert.equal(cycleComposerRole("reasoning"), "Low")
  const overrides = prefsStore.get().settingsOverrides
  assert.equal(
    Object.values(overrides)[0]?.options?.effort,
    "low",
    "the cycle lands as the same override the picker writes"
  )
  assert.equal(cycleComposerRole("speed"), "on")
  assert.equal(cycleComposerRole("speed"), "off")
  assert.equal(
    Object.values(prefsStore.get().settingsOverrides)[0]?.options?.fast,
    false
  )
  providerStore.set({ contexts: {} })
}
console.log("composer settings: role cycling walks only reported options")

// The loadout orders its five picks, refuses duplicates and overflow, and a
// same-provider pick writes the model the picker would.
{
  const { addToLoadout, applyLoadoutEntry, moveLoadoutEntry, removeFromLoadout, LOADOUT_LIMIT } =
    await import("../src/state/model-loadout.ts")
  const { providerStore, providerProfileKey } = await import("../src/state/providers.ts")
  const { prefsStore, setPref } = await import("../src/state/prefs.ts")
  providerStore.set({
    profiles: { claude: profile },
    contexts: { [providerProfileKey("claude", cwd)]: profile },
  })
  acpStore.set({ conversations: {}, activeKey: null })
  threadsStore.set({ composerHarness: "claude", viewing: null, opening: null })
  setPref("modelLoadout", [])
  setPref("settingsOverrides", {})
  setPref("providerSettings", {})
  addToLoadout("claude", "opus")
  addToLoadout("claude", "sonnet")
  addToLoadout("claude", "opus")
  assert.equal(prefsStore.get().modelLoadout.length, 2, "a duplicate never repeats a slot")
  for (let i = 0; i < LOADOUT_LIMIT + 2; i++) addToLoadout("codex", `model-${i}`)
  assert.equal(prefsStore.get().modelLoadout.length, LOADOUT_LIMIT)
  setPref("modelLoadout", [{ harness: "claude", model: "opus" }, { harness: "claude", model: "sonnet" }])
  moveLoadoutEntry(1, -1)
  assert.equal(prefsStore.get().modelLoadout[0]?.model, "sonnet")
  applyLoadoutEntry(1)
  const { resolveComposerSettings, currentSettingsTarget } = await import("../src/state/composer-settings.ts")
  assert.equal(resolveComposerSettings(currentSettingsTarget()).settings.model, "opus", "a same-provider pick is the composer's model")
  assert.deepEqual(prefsStore.get().providerSettings, {}, "and only that conversation's: the harness's default is Settings' to change")
  removeFromLoadout(0)
  assert.equal(prefsStore.get().modelLoadout.length, 1)
  providerStore.set({ contexts: {} })
}
console.log("composer settings: the loadout orders, bounds, and applies its picks")

// A default chosen in Settings is kept; choosing the recommendation again
// saves nothing, so the harness follows Mako's next recommendation.
{
  const { saveHarnessDefaults } = await import("../src/state/composer-settings.ts")
  const { prefsStore, setPref } = await import("../src/state/prefs.ts")
  const reasoning = {
    id: "effort",
    label: "Effort",
    kind: "select" as const,
    role: "reasoning" as const,
    values: [{ value: "medium", label: "Medium" }, { value: "high", label: "High" }],
  }
  const recommended = {
    ...profile,
    settings: { model: "opus", options: { effort: "high" } },
    models: [{ id: "opus", label: "Opus", options: [reasoning] }, { id: "sonnet", label: "Sonnet", options: [reasoning] }],
  }
  setPref("providerSettings", {})
  saveHarnessDefaults("claude", { model: "sonnet", options: { effort: "medium" } }, recommended)
  assert.equal(prefsStore.get().providerSettings.claude?.settings.model, "sonnet", "a different model is the person's own default")
  saveHarnessDefaults("claude", { model: "opus", options: { effort: "medium" } }, recommended)
  assert.equal(prefsStore.get().providerSettings.claude?.settings.options?.effort, "medium", "so is the recommended model at another level")
  saveHarnessDefaults("claude", { model: "opus", options: { effort: "high" } }, recommended)
  assert.equal(prefsStore.get().providerSettings.claude, undefined, "the recommendation itself is not saved as the person's own")
}
console.log("composer settings: choosing the recommended default keeps following it")

// Stale saved entries remain removable, but neither shortcut nor picker may
// change intent using a model absent from the current workspace discovery.
{
  const { loadoutAvailability, availableLoadoutModel, applyLoadoutEntry, removeFromLoadout } = await import("../src/state/model-loadout.ts")
  const { providerStore, providerProfileKey } = await import("../src/state/providers.ts")
  const { prefsStore, setPref } = await import("../src/state/prefs.ts")
  const { registeredHarnessIds } = await import("./registered-harnesses.ts")
  for (const harness of registeredHarnessIds()) {
    const entry = { harness, model: "native-variant" }
    const ready: HarnessProfile = { ...profile, id: harness, models: [{ id: "current", label: "Current model", options: [], variants: [{ id: "native-variant", label: "Native variant", values: {} }] }] }
    assert.equal(loadoutAvailability(entry, ready).kind, "ready")
    assert.equal(loadoutAvailability(entry, { ...ready, pending: true }).kind, "loading")
    assert.equal(loadoutAvailability(entry, { ...ready, available: false }).kind, "unavailable")
    const missing = { ...ready, models: [] }
    providerStore.set({ profiles: { [harness]: ready }, contexts: { [providerProfileKey(harness, "")]: missing } })
    assert.equal(availableLoadoutModel(entry, ""), undefined, "workspace discovery wins over a stale global list")
    threadsStore.set({ composerHarness: harness, viewing: null, opening: null })
    setPref("modelLoadout", [entry])
    const before = prefsStore.get().providerSettings
    applyLoadoutEntry(0)
    assert.deepEqual(prefsStore.get().providerSettings, before, "unavailable shortcut leaves the chosen model unchanged")
    assert.deepEqual(prefsStore.get().modelLoadout, [entry], "a vanished model is not silently removed")
    providerStore.set({ contexts: { [providerProfileKey(harness, "")]: ready } })
    assert.equal(availableLoadoutModel(entry, ""), entry.model, "valid native variants retain their identity")
    removeFromLoadout(0)
    assert.deepEqual(prefsStore.get().modelLoadout, [])
  }
  providerStore.set({ profiles: {}, contexts: {} })
}
console.log("composer settings: all registered loadouts refuse stale workspace models and preserve native variants")

// A remembered option the default model can't take yields to that model's
// defaults: Devin's default moved to Adaptive, which has no Fast mode, and a
// new draft carrying the old `fast` could not send.
{
  const devin: HarnessProfile = {
    ...profile,
    id: "devin",
    settings: { model: "adaptive" },
    models: [
      { id: "adaptive", label: "Adaptive", options: [] },
      { id: "swe-2", label: "SWE-2", options: [{ kind: "boolean", id: "fast", label: "Fast mode", role: "speed", current: false }] },
    ],
  }
  const target = { kind: "new" as const, harness: "devin", cwd }
  const remembered = resolveComposerSettingsInput({
    target,
    profile: devin,
    preference: { source: "saved", settings: { options: { fast: true } } },
  }).resolved
  assert.deepEqual(remembered.issues, [])
  assert.deepEqual(remembered.settings, { model: "adaptive" })
  const chosen = resolveComposerSettingsInput({
    target,
    profile: devin,
    overrides: { model: "adaptive", options: { fast: true } },
  }).resolved
  assert.equal(chosen.issues.length, 1, "a choice made in this draft still says why it can't send")
}
console.log("composer settings: remembered options the model lacks fall back to its defaults")

// A new Thread is named by the words of its first prompt, not its attachment markers.
{
  const { titleFromPrompt } = await import("../src/state/acp-start.ts")
  assert.equal(titleFromPrompt("[Attachment 1] Can you take care of this?", ["app.md"]), "Can you take care of this?")
  assert.equal(
    titleFromPrompt("Look at [Referenced conversation 1] again\n---\n[Referenced conversation 1] Fix the flaky build (codex)\nhistory…"),
    "Look at Fix the flaky build again"
  )
  assert.equal(titleFromPrompt("[Attachment 1]", ["tally-app.md"]), "tally-app.md")
  assert.equal(titleFromPrompt("", []), undefined)
}
console.log("composer settings: new Thread titles skip attachment markers")

// Explicit options belong to a model and target. Switching models must neither
// carry incompatible options forward nor erase choices when switching back.
{
  const { chooseComposerModel, chooseComposerOption, resolveComposerSettings, resetComposerSettings } =
    await import("../src/state/composer-settings.ts")
  const { providerStore, providerProfileKey } = await import("../src/state/providers.ts")
  const { prefsStore, setPref } = await import("../src/state/prefs.ts")
  const { registeredHarnessIds } = await import("./registered-harnesses.ts")
  for (const harness of registeredHarnessIds()) {
    const memoryProfile: HarnessProfile = {
      ...profile, id: harness, settings: { model: "one" },
      models: [
        { id: "one", aliases: ["native-one"], label: "One", options: [
          { id: "effort", label: "Effort", kind: "select", values: [
            { value: "low", label: "Low", default: true }, { value: "high", label: "High" },
          ] },
        ] },
        { id: "two", label: "Two", options: [
          { id: "fast", label: "Fast", kind: "boolean", current: false },
        ] },
      ],
    }
    providerStore.set({ contexts: { [providerProfileKey(harness, cwd)]: memoryProfile } })
    setPref("settingsOverrides", {})
    setPref("providerSettings", {})
    setPref("modelSettings", {})
    const draft = { kind: "new" as const, harness, cwd }
    chooseComposerModel(draft, "one")
    chooseComposerOption(draft, "effort", "high")
    chooseComposerModel(draft, "two")
    assert.deepEqual(resolveComposerSettings(draft).settings, { model: "two", options: { fast: false } })
    chooseComposerOption(draft, "fast", true)
    chooseComposerModel(draft, "native-one")
    assert.deepEqual(resolveComposerSettings(draft).settings, { model: "native-one", options: { effort: "high" } })
    chooseComposerModel(draft, "two")
    assert.equal(resolveComposerSettings(draft).settings.options?.fast, true)
    // A native observation is not copied into another session's remembered intent.
    const threadOne = { kind: "thread" as const, harness, cwd, path: "/one" }
    const threadTwo = { ...threadOne, path: "/two" }
    chooseComposerModel(threadOne, "one")
    assert.equal(resolveComposerSettings(threadOne).settings.options?.effort, "low")
    chooseComposerOption(threadOne, "effort", "high")
    chooseComposerModel(threadOne, "two")
    chooseComposerModel(threadOne, "one")
    assert.equal(resolveComposerSettings(threadOne).settings.options?.effort, "high")
    chooseComposerModel(threadTwo, "one")
    assert.equal(resolveComposerSettings(threadTwo).settings.options?.effort, "low")
    // Changed native choices remain an actionable issue rather than silent coercion.
    providerStore.set({ contexts: { [providerProfileKey(harness, cwd)]: {
      ...memoryProfile, models: [{ ...memoryProfile.models[0]!, options: [] }, memoryProfile.models[1]!],
    } } })
    assert.equal(resolveComposerSettings(threadOne).issues.length, 1)
    resetComposerSettings(threadOne)
    chooseComposerModel(threadOne, "one")
    assert.deepEqual(resolveComposerSettings(threadOne).issues, [])
    setPref("modelSettings", { ...prefsStore.get().modelSettings, "old-invalid-key": {} })
    resetComposerSettings(draft)
    assert.ok(Object.keys(prefsStore.get().modelSettings).length <= 256)
  }
  providerStore.set({ contexts: {} })
}
console.log("composer settings: per-model explicit choices restore across switches and stay scoped across the registry")
