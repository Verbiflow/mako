import assert from "node:assert/strict"
import {
  normalizeClaudeModels,
  normalizeCodexModels,
  normalizeGrokModels,
  type HarnessModelCatalog,
} from "@mako/sessions/model-catalog"
import type { SessionSettings } from "@mako/sessions/settings"
import { resolveHarnessTuning, withCatalogDefaults } from "../electron/harness-models.ts"
import { claudeNativeRunner } from "../electron/providers/claude/native-runner.ts"
import { claudeProfileLoader } from "../electron/providers/claude/profile.ts"
import { codexNativeRunner } from "../electron/providers/codex/native-runner.ts"
import { codexProfileLoader } from "../electron/providers/codex/profile.ts"
import { grokNativeRunner } from "../electron/providers/grok/native-runner.ts"
import { grokProfileLoader } from "../electron/providers/grok/profile.ts"
import type { NativeRunner } from "../electron/providers/native-runner.ts"
import {
  availableProviderProfile,
  type ProviderProfileLoader,
} from "../electron/providers/profile-loader.ts"
import type { HarnessProfile } from "../electron/shared.ts"

/**
 * One selection, two transports, one meaning.
 *
 * A provider's ACP session receives a resolved `SessionSettings` and applies
 * every option by id. Its headless CLI receives the same settings through
 * its native runner. This test feeds each model and option value a provider
 * catalog offers through the runner and reads the built command back, so a
 * flag the CLI mangles, an option it silently drops, or an id it composes
 * wrongly fails here instead of in a user's reply. Cursor is absent because
 * it has one transport, the SDK, and nothing to agree with.
 */

const claudeCatalog = normalizeClaudeModels([
  { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default" },
  { value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus (1M context)", supportsEffort: true, supportedEffortLevels: ["low", "high"], supportsFastMode: true },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", supportsEffort: false },
])

const codexCatalog = normalizeCodexModels({
  data: ["sol", "terra"].map((name, index) => ({
    model: `gpt-5.6-${name}`,
    displayName: `GPT-5.6 ${name}`,
    isDefault: index === 0,
    defaultReasoningEffort: index === 0 ? "low" : "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }],
    serviceTiers: [{ id: "priority", name: "Fast", description: "Faster responses" }],
  })),
})

const grokCatalog = normalizeGrokModels(
  ["Default model: grok-4.6", "Available models:", "  * grok-4.6 (default)", "  - grok-4.5"].join("\n"),
  { models: { "grok-4.6": { info: { name: "Grok 4.6", reasoning_efforts: [{ value: "low", label: "Low" }, { value: "high", label: "High", default: true }] } } } }
)

interface Subject {
  runner: NativeRunner
  loader: ProviderProfileLoader
  catalog: HarnessModelCatalog
}

const subjects: Subject[] = [
  { runner: claudeNativeRunner, loader: claudeProfileLoader, catalog: claudeCatalog },
  { runner: codexNativeRunner, loader: codexProfileLoader, catalog: codexCatalog },
  { runner: grokNativeRunner, loader: grokProfileLoader, catalog: grokCatalog },
]

/** Every model with its defaults, then each option moved to each of its values one at a time. */
function selections(profile: HarnessProfile): SessionSettings[] {
  const out: SessionSettings[] = []
  for (const model of profile.models) {
    out.push({ model: model.id })
    for (const option of model.options) {
      if (option.kind === "select")
        for (const choice of option.values) out.push({ model: model.id, options: { [option.id]: choice.value } })
      if (option.kind === "boolean") for (const value of [true, false]) out.push({ model: model.id, options: { [option.id]: value } })
    }
  }
  return out
}

let checked = 0
for (const subject of subjects) {
  const profile = availableProviderProfile(subject.loader, subject.catalog)
  for (const selection of selections(profile)) {
    const settings = resolveHarnessTuning(profile, selection)
    assert.ok(settings?.model, `${subject.runner.provider}: ${JSON.stringify(selection)} resolves`)
    const label = `${subject.runner.provider} ${JSON.stringify(settings)}`
    const prepared = await subject.runner.prepare!(withCatalogDefaults(profile, settings), {})
    const command = subject.runner.resume("session", "hello", prepared.options)
    const back = subject.runner.describe(command, profile.models)
    assert.equal(back.model, settings.model, `${label}: the command names the selected model`)
    for (const [id, value] of Object.entries(settings.options ?? {})) {
      if (value === undefined) continue
      if (!subject.runner.carries.includes(id)) {
        assert.ok(prepared.dropped.includes(id), `${label}: uncarried ${id} is reported as dropped`)
        continue
      }
      assert.ok(!prepared.dropped.includes(id), `${label}: carried ${id} is not dropped`)
      if (prepared.implicit?.includes(id)) {
        assert.equal(back.options?.[id], undefined, `${label}: an implicit ${id} is unstated by the command`)
        continue
      }
      assert.equal(String(back.options?.[id]), String(value), `${label}: the command states ${id}`)
    }
    for (const id of prepared.dropped)
      assert.ok(!subject.runner.carries.includes(id), `${label}: ${id} cannot be both carried and dropped`)
    checked += 1
  }
}
assert.ok(checked > 20, `enough selections were checked (${checked})`)
console.log(`Transport agreement: ${checked} selections across ${subjects.length} providers read back from their command lines`)
