import assert from "node:assert/strict"
import { resolveSessionSettings, resolveModelLaunch, SessionModelSchema } from "../dist/settings.js"

const models = [{ id: "a", label: "A", options: [
  { kind: "select", id: "effort", label: "Reasoning", role: "reasoning", current: "medium", values: [
    { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" },
  ] },
  { kind: "select", id: "tier", label: "Speed", role: "speed", values: [
    { value: "default", label: "Standard" }, { value: "fast", label: "Fast" },
  ] },
] }, { id: "b", label: "B", options: [] }]

const inherited = resolveSessionSettings({ models, context: "new" })
assert.equal(inherited.model.kind, "unknown")
assert.deepEqual(inherited.settings, {})

const configured = resolveSessionSettings({ models, context: "new", defaults: {
  model: "a", options: { effort: "high", tier: "fast" },
} })
assert.equal(configured.options.effort.source, "provider")
assert.equal(configured.settings.options.tier, "fast")

const existing = resolveSessionSettings({ models, context: "existing",
  session: { model: "a", options: { effort: "low", tier: "fast" } },
  preference: { source: "saved", settings: { model: "b" } },
  overrides: { options: { tier: "default" } },
})
assert.equal(existing.model.value, "a")
assert.equal(existing.settings.model, existing.model.value)
assert.equal(existing.settings.options.effort, "low")
assert.equal(existing.settings.options.tier, "default")
assert.equal(existing.options.tier.source, "override")

const unknownEffort = resolveSessionSettings({ models, context: "existing", session: { model: "a" } })
assert.equal(unknownEffort.options.effort.kind, "unknown")
assert.equal(unknownEffort.settings.options, undefined)

const switched = resolveSessionSettings({ models, context: "existing",
  session: { model: "a", options: { effort: "high" } }, overrides: { model: "b" },
})
assert.deepEqual(switched.settings, { model: "b" })

// Speed is an account choice, so it follows a model switch when the new model
// offers the same tier; effort belongs to the model and starts from its default.
const tiered = [...models, { id: "c", label: "C", options: [
  { kind: "select", id: "effort", label: "Reasoning", role: "reasoning", current: "low", values: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] },
  { kind: "select", id: "tier", label: "Speed", role: "speed", current: "default", values: [{ value: "default", label: "Standard", default: true }, { value: "fast", label: "Fast" }] },
] }, { id: "d", label: "D", options: [
  { kind: "select", id: "tier", label: "Speed", role: "speed", current: "default", values: [{ value: "default", label: "Standard", default: true }] },
] }]
const carried = resolveSessionSettings({ models: tiered, context: "existing",
  session: { model: "a", options: { effort: "high", tier: "fast" } }, overrides: { model: "c" },
})
assert.deepEqual(carried.settings, { model: "c", options: { effort: "low", tier: "fast" } })
assert.equal(carried.options.tier.source, "session")
assert.equal(carried.options.effort.source, "model-default")
const narrowed = resolveSessionSettings({ models: tiered, context: "existing",
  session: { model: "a", options: { tier: "fast" } }, overrides: { model: "d" },
})
assert.deepEqual(narrowed.settings, { model: "d", options: { tier: "default" } }, "a tier the new model lacks falls back to its default, never to unknown")
assert.equal(narrowed.issues.length, 0)
const preferred = resolveSessionSettings({ models: tiered, context: "new",
  preference: { source: "saved", settings: { model: "c" } }, defaults: { model: "a", options: { tier: "fast" } },
})
assert.equal(preferred.settings.options.tier, "fast", "the account's configured tier applies to a preferred model too")
assert.equal(resolveSessionSettings({ models: tiered, context: "new", overrides: { model: "c", options: { tier: "default" } }, defaults: { model: "a", options: { tier: "fast" } } }).settings.options.tier, "default")

const invalid = resolveSessionSettings({ models, context: "new", overrides: { model: "a", options: { effort: "ultra" } } })
assert.equal(invalid.issues.length, 1)
assert.throws(() => resolveModelLaunch(models, invalid.settings), /not supported/)
assert.deepEqual(resolveModelLaunch(models, { model: "private-model" }), { model: "private-model" })

const family = [{ id: "family", label: "Family", launchId: "high-fast", options: [
  { kind: "select", id: "effort", label: "Reasoning", current: "high", values: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] },
  { kind: "boolean", id: "fast", label: "Fast", current: true },
], variants: [
  { id: "low-standard", label: "Low", values: { effort: "low", fast: false } },
  { id: "high-fast", label: "High Fast", values: { effort: "high", fast: true } },
] }]
assert.equal(resolveModelLaunch(family, { model: "family" }).model, "high-fast")
assert.equal(resolveModelLaunch(family, { model: "low-standard" }).model, "low-standard")
assert.throws(() => resolveModelLaunch(family, { model: "family", options: { fast: false } }), /not available together/)
// A variant id carries its own values; the transport must not receive them again.
assert.deepEqual(resolveModelLaunch(family, { model: "family", options: { effort: "low", fast: false } }), { model: "low-standard" })
assert.deepEqual(resolveModelLaunch(family, { model: "family", options: { effort: "high", agentTeams: true } }), { model: "high-fast", options: { agentTeams: true } })
assert.deepEqual(SessionModelSchema.parse(models[0]), models[0])
console.log("Shared session settings: provenance, inheritance, explicit reset, model changes, and variants passed")

const { normalizeAcpOptions, normalizeCursorModels, normalizeGrokModels } = await import("../dist/model-catalog.js")
const cursorOptions = [
  { id: "thinking", name: "Thinking", category: "thought_level", type: "select", currentValue: "true", options: [{ value: "true", name: "On" }, { value: "false", name: "Off" }] },
  { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "high", name: "High" }] },
  { id: "fast", name: "Fast", category: "other", type: "select", currentValue: "false", options: [{ value: "true", name: "On" }, { value: "false", name: "Off" }] },
]
const normalized = normalizeAcpOptions(cursorOptions)
assert.deepEqual(normalized.map(o => [o.id, o.role]), [["thinking", undefined], ["effort", "reasoning"], ["fast", "speed"]])
assert.deepEqual(normalizeCursorModels({ models: [{ value: "opus", name: "Opus", configOptions: cursorOptions }] }, "opus").settings, { model: "opus", options: { thinking: "true", effort: "high", fast: "false" } })
assert.deepEqual(normalizeGrokModels("* grok (default)", { models: { grok: { info: { reasoning_effort: "high", reasoning_efforts: [{ value: "high", default: true }] } } } }).settings, { model: "grok", options: { effort: "high" } })
console.log("Installed-provider regressions: distinct Cursor controls and preserved Cursor/Grok defaults")
const { normalizeClaudeModels, cursorModelSettings } = await import("../dist/model-catalog.js")
const claudeCatalog = normalizeClaudeModels([{value:"fable",resolvedModel:"claude-fable-5-1",displayName:"Fable",supportsEffort:true,supportedEffortLevels:["high"]}])
assert.equal(resolveModelLaunch(claudeCatalog.models,{model:"claude-fable-5-1[1m]",options:{effort:"high"}}).model,"claude-fable-5-1[1m]")
assert.deepEqual(cursorModelSettings("opus[thinking=true,reasoning=high,fast=false]"),{model:"opus",options:{thinking:"true",effort:"high",fast:"false"}})

const { normalizeCursorSdkModels } = await import("../dist/index.js")
const sdk = normalizeCursorSdkModels([
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", parameters: [
    { id: "context", displayName: "Context", values: [{ value: "300k", displayName: "300K" }, { value: "1m", displayName: "1M" }] },
    { id: "effort", displayName: "Effort", values: [{ value: "low", displayName: "Low" }, { value: "high", displayName: "High" }] },
    { id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true", displayName: "Fast\u200b\u200b" }] },
  ], variants: [{ params: [{ id: "context", value: "1m" }, { id: "effort", value: "high" }, { id: "fast", value: "false" }], displayName: "Claude Opus 5.5", isDefault: true }] },
  { id: "grok-4.7", displayName: "Grok 4.7", parameters: [
    { id: "reasoning_effort", displayName: "Effort", values: [{ value: "low" }, { value: "high" }] },
  ] },
])
const [opus, grok] = sdk.models
// Every family's reasoning parameter is the composer's effort, whatever the SDK calls it.
assert.deepEqual(opus.options.map(o => [o.id, o.wireId, o.role]), [["context", "context", "context"], ["effort", "effort", "reasoning"], ["fast", "fast", "speed"]])
assert.deepEqual(grok.options.map(o => [o.id, o.wireId, o.role]), [["effort", "reasoning_effort", "reasoning"]])
assert.equal(opus.options[2].values[1].label, "Fast")
// A choice saved under the SDK's own id still resolves, and does not raise an unsupported-option issue.
const saved = resolveSessionSettings({ models: sdk.models, context: "new", preference: { source: "saved", settings: { model: "grok-4.7", options: { reasoning_effort: "low" } } } })
assert.deepEqual(saved.settings, { model: "grok-4.7", options: { effort: "low" } })
assert.deepEqual(saved.issues, [])
// A new conversation on the provider's default model reads that model's defaults; an existing one does not guess.
const fresh = resolveSessionSettings({ models: sdk.models, context: "new", defaults: { model: "claude-opus-5-5" } })
assert.deepEqual(fresh.options.effort, { kind: "known", value: "high", source: "model-default" })
const continued = resolveSessionSettings({ models: sdk.models, context: "existing", defaults: { model: "claude-opus-5-5" } })
assert.deepEqual(continued.options.effort, { kind: "unknown" })
console.log("Cursor SDK roles: reasoning under every family's name, context windows, and saved wire ids")

const autos = normalizeCursorSdkModels([
  { id: "auto-smart", displayName: "Auto", parameters: [{ id: "optimize_for", values: [{ value: "balanced" }, { value: "cost" }] }] },
  { id: "default", displayName: "Auto" },
  { id: "composer-2.5", displayName: "Composer 2.5" },
])
// Cursor's account default and the model it names are one row, and the bare id still resolves.
assert.deepEqual(autos.models.map(m => [m.id, m.aliases]), [["auto-smart", ["default"]], ["composer-2.5", undefined]])
assert.equal(resolveSessionSettings({ models: autos.models, context: "new", preference: { source: "saved", settings: { model: "default" } } }).issues.length, 0)
console.log("Cursor SDK catalog: one Auto row")
