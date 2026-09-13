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
  capabilities: [],
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
    capabilities: [],
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
  const speed = switched.options.find((option) => option.id === "fast")!
  const effort = switched.options.find((option) => option.id === "effort")!
  assert.equal(optionLabel(speed, { kind: "unknown" }), "Speed not reported", "the control is offered; the provider has simply not said")
  assert.equal(optionLabel(effort, { kind: "known", value: "xhigh", source: "override" }), "Extra High reasoning")
  assert.equal(
    optionLabel({ ...effort, values: [{ value: "high", label: "High Effort" }] }, { kind: "known", value: "high", source: "session" }),
    "High Effort",
    "a value that already names its noun is not given a second one"
  )
  assert.equal(optionLabel(speed, { kind: "known", value: "true", source: "session" }), "Fast")
}
