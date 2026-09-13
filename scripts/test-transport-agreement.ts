import assert from "node:assert/strict"
import {
  normalizeClaudeModels,
  normalizeCodexModels,
  normalizeCursorModels,
  normalizeGrokModels,
  type HarnessModelCatalog,
} from "@mako/sessions/model-catalog"
import type { SessionSettings } from "@mako/sessions/settings"
import { resolveHarnessTuning, withCatalogDefaults } from "../electron/harness-models.ts"
import { claudeNativeRunner } from "../electron/providers/claude/native-runner.ts"
import { claudeProfileLoader } from "../electron/providers/claude/profile.ts"
import { codexNativeRunner } from "../electron/providers/codex/native-runner.ts"
import { codexProfileLoader } from "../electron/providers/codex/profile.ts"
import { createCursorNativeRunner } from "../electron/providers/cursor/native-runner.ts"
import { cursorProfileLoader } from "../electron/providers/cursor/profile.ts"
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
 * wrongly fails here instead of in a user's reply. Cursor's bracket ids
 * (`claude-opus-4-8[effort=high]`, rejected by the CLI) would not have
 * passed this.
 */

// cursor-agent --list-models on 2026-09-12 (cursor-agent 2026.09.10).
const CURSOR_CLI_LISTING = `Available models

auto - auto
gpt-5.3-codex-low - gpt-5.3-codex-low
gpt-5.3-codex-low-fast - gpt-5.3-codex-low-fast
gpt-5.3-codex - gpt-5.3-codex
gpt-5.3-codex-fast - gpt-5.3-codex-fast
gpt-5.3-codex-high - gpt-5.3-codex-high
gpt-5.3-codex-high-fast - gpt-5.3-codex-high-fast
gpt-5.3-codex-xhigh - gpt-5.3-codex-xhigh
gpt-5.3-codex-xhigh-fast - gpt-5.3-codex-xhigh-fast
gpt-5.2 - gpt-5.2
cursor-grok-4.6-high-fast - cursor-grok-4.6-high-fast
composer-2.5 - composer-2.5
claude-opus-5-thinking-high - claude-opus-5-thinking-high
claude-opus-5-thinking-high-fast - claude-opus-5-thinking-high-fast
gpt-5.6-sol-high - gpt-5.6-sol-high
gpt-5.6-sol-high-fast - gpt-5.6-sol-high-fast
gpt-5.6-sol-xhigh - gpt-5.6-sol-xhigh
gpt-5.6-sol-xhigh-fast - gpt-5.6-sol-xhigh-fast
claude-fable-5-thinking-high - claude-fable-5-thinking-high
claude-fable-5-thinking-xhigh - claude-fable-5-thinking-xhigh
cursor-grok-4.5-high - cursor-grok-4.5-high
cursor-grok-4.5-high-fast - cursor-grok-4.5-high-fast
gemini-3.7-flash-high - gemini-3.7-flash-high
claude-sonnet-5-thinking-high - claude-sonnet-5-thinking-high
claude-sonnet-5-thinking-xhigh - claude-sonnet-5-thinking-xhigh
gpt-5.6-luna-high - gpt-5.6-luna-high
cursor-grok-4.6-low - cursor-grok-4.6-low
cursor-grok-4.6-low-fast - cursor-grok-4.6-low-fast
cursor-grok-4.6-medium - cursor-grok-4.6-medium
cursor-grok-4.6-medium-fast - cursor-grok-4.6-medium-fast
cursor-grok-4.6-high - cursor-grok-4.6-high
cursor-grok-4.6-xhigh - cursor-grok-4.6-xhigh
cursor-grok-4.6-xhigh-fast - cursor-grok-4.6-xhigh-fast
composer-2.5-fast - composer-2.5-fast
claude-opus-5-low - claude-opus-5-low
claude-opus-5-low-fast - claude-opus-5-low-fast
claude-opus-5-medium - claude-opus-5-medium
claude-opus-5-medium-fast - claude-opus-5-medium-fast
claude-opus-5-high - claude-opus-5-high
claude-opus-5-high-fast - claude-opus-5-high-fast
claude-opus-5-thinking-low - claude-opus-5-thinking-low
claude-opus-5-thinking-low-fast - claude-opus-5-thinking-low-fast
claude-opus-5-thinking-medium - claude-opus-5-thinking-medium
claude-opus-5-thinking-medium-fast - claude-opus-5-thinking-medium-fast
claude-opus-5-thinking-xhigh - claude-opus-5-thinking-xhigh
claude-opus-5-thinking-xhigh-fast - claude-opus-5-thinking-xhigh-fast
claude-opus-5-thinking-max - claude-opus-5-thinking-max
claude-opus-5-thinking-max-fast - claude-opus-5-thinking-max-fast
claude-opus-4-8-low - claude-opus-4-8-low
claude-opus-4-8-low-fast - claude-opus-4-8-low-fast
claude-opus-4-8-medium - claude-opus-4-8-medium
claude-opus-4-8-medium-fast - claude-opus-4-8-medium-fast
claude-opus-4-8-high - claude-opus-4-8-high
claude-opus-4-8-high-fast - claude-opus-4-8-high-fast
claude-opus-4-8-xhigh - claude-opus-4-8-xhigh
claude-opus-4-8-xhigh-fast - claude-opus-4-8-xhigh-fast
claude-opus-4-8-max - claude-opus-4-8-max
claude-opus-4-8-max-fast - claude-opus-4-8-max-fast
claude-opus-4-8-thinking-low - claude-opus-4-8-thinking-low
claude-opus-4-8-thinking-low-fast - claude-opus-4-8-thinking-low-fast
claude-opus-4-8-thinking-medium - claude-opus-4-8-thinking-medium
claude-opus-4-8-thinking-medium-fast - claude-opus-4-8-thinking-medium-fast
claude-opus-4-8-thinking-high - claude-opus-4-8-thinking-high
claude-opus-4-8-thinking-high-fast - claude-opus-4-8-thinking-high-fast
claude-opus-4-8-thinking-xhigh - claude-opus-4-8-thinking-xhigh
claude-opus-4-8-thinking-xhigh-fast - claude-opus-4-8-thinking-xhigh-fast
claude-opus-4-8-thinking-max - claude-opus-4-8-thinking-max
claude-opus-4-8-thinking-max-fast - claude-opus-4-8-thinking-max-fast
gpt-5.6-sol-none - gpt-5.6-sol-none
gpt-5.6-sol-none-fast - gpt-5.6-sol-none-fast
gpt-5.6-sol-low - gpt-5.6-sol-low
gpt-5.6-sol-low-fast - gpt-5.6-sol-low-fast
gpt-5.6-sol-medium - gpt-5.6-sol-medium
gpt-5.6-sol-medium-fast - gpt-5.6-sol-medium-fast
gpt-5.6-sol-max - gpt-5.6-sol-max
gpt-5.6-sol-max-fast - gpt-5.6-sol-max-fast
gpt-5.5-none - gpt-5.5-none
gpt-5.5-none-fast - gpt-5.5-none-fast
gpt-5.5-low - gpt-5.5-low
gpt-5.5-low-fast - gpt-5.5-low-fast
gpt-5.5-medium - gpt-5.5-medium
gpt-5.5-medium-fast - gpt-5.5-medium-fast
gpt-5.5-high - gpt-5.5-high
gpt-5.5-high-fast - gpt-5.5-high-fast
gpt-5.5-extra-high - gpt-5.5-extra-high
gpt-5.5-extra-high-fast - gpt-5.5-extra-high-fast
claude-fable-5-1-low - claude-fable-5-1-low
claude-fable-5-1-medium - claude-fable-5-1-medium
claude-fable-5-1-high - claude-fable-5-1-high
claude-fable-5-1-xhigh - claude-fable-5-1-xhigh
claude-fable-5-1-max - claude-fable-5-1-max
claude-fable-5-1-thinking-low - claude-fable-5-1-thinking-low
claude-fable-5-1-thinking-medium - claude-fable-5-1-thinking-medium
claude-fable-5-1-thinking-high - claude-fable-5-1-thinking-high
claude-fable-5-1-thinking-xhigh - claude-fable-5-1-thinking-xhigh
claude-fable-5-1-thinking-max - claude-fable-5-1-thinking-max
claude-fable-5-low - claude-fable-5-low
claude-fable-5-medium - claude-fable-5-medium
claude-fable-5-high - claude-fable-5-high
claude-fable-5-xhigh - claude-fable-5-xhigh
claude-fable-5-max - claude-fable-5-max
claude-fable-5-thinking-low - claude-fable-5-thinking-low
claude-fable-5-thinking-medium - claude-fable-5-thinking-medium
claude-fable-5-thinking-max - claude-fable-5-thinking-max
cursor-grok-4.5-low - cursor-grok-4.5-low
cursor-grok-4.5-low-fast - cursor-grok-4.5-low-fast
cursor-grok-4.5-medium - cursor-grok-4.5-medium
cursor-grok-4.5-medium-fast - cursor-grok-4.5-medium-fast
gemini-3.8-flash-low - gemini-3.8-flash-low
gemini-3.8-flash-medium - gemini-3.8-flash-medium
gemini-3.8-flash-high - gemini-3.8-flash-high
gemini-3.7-flash-low - gemini-3.7-flash-low
gemini-3.7-flash-medium - gemini-3.7-flash-medium
muse-spark-1.3-minimal - muse-spark-1.3-minimal
muse-spark-1.3-low - muse-spark-1.3-low
muse-spark-1.3-medium - muse-spark-1.3-medium
muse-spark-1.3-high - muse-spark-1.3-high
muse-spark-1.3-xhigh - muse-spark-1.3-xhigh
muse-spark-1.3-max - muse-spark-1.3-max
gpt-5.6-terra-none - gpt-5.6-terra-none
gpt-5.6-terra-none-fast - gpt-5.6-terra-none-fast
gpt-5.6-terra-low - gpt-5.6-terra-low
gpt-5.6-terra-low-fast - gpt-5.6-terra-low-fast
gpt-5.6-terra-medium - gpt-5.6-terra-medium
gpt-5.6-terra-medium-fast - gpt-5.6-terra-medium-fast
gpt-5.6-terra-high - gpt-5.6-terra-high
gpt-5.6-terra-high-fast - gpt-5.6-terra-high-fast
gpt-5.6-terra-xhigh - gpt-5.6-terra-xhigh
gpt-5.6-terra-xhigh-fast - gpt-5.6-terra-xhigh-fast
gpt-5.6-terra-max - gpt-5.6-terra-max
gpt-5.6-terra-max-fast - gpt-5.6-terra-max-fast
claude-sonnet-5-low - claude-sonnet-5-low
claude-sonnet-5-medium - claude-sonnet-5-medium
claude-sonnet-5-high - claude-sonnet-5-high
claude-sonnet-5-xhigh - claude-sonnet-5-xhigh
claude-sonnet-5-max - claude-sonnet-5-max
claude-sonnet-5-thinking-low - claude-sonnet-5-thinking-low
claude-sonnet-5-thinking-medium - claude-sonnet-5-thinking-medium
claude-sonnet-5-thinking-max - claude-sonnet-5-thinking-max
claude-4.6-sonnet-medium - claude-4.6-sonnet-medium
claude-4.6-sonnet-medium-thinking - claude-4.6-sonnet-medium-thinking
claude-opus-4-7-low - claude-opus-4-7-low
claude-opus-4-7-low-fast - claude-opus-4-7-low-fast
claude-opus-4-7-medium - claude-opus-4-7-medium
claude-opus-4-7-medium-fast - claude-opus-4-7-medium-fast
claude-opus-4-7-high - claude-opus-4-7-high
claude-opus-4-7-high-fast - claude-opus-4-7-high-fast
claude-opus-4-7-xhigh - claude-opus-4-7-xhigh
claude-opus-4-7-xhigh-fast - claude-opus-4-7-xhigh-fast
claude-opus-4-7-max - claude-opus-4-7-max
claude-opus-4-7-max-fast - claude-opus-4-7-max-fast
claude-opus-4-7-thinking-low - claude-opus-4-7-thinking-low
claude-opus-4-7-thinking-low-fast - claude-opus-4-7-thinking-low-fast
claude-opus-4-7-thinking-medium - claude-opus-4-7-thinking-medium
claude-opus-4-7-thinking-medium-fast - claude-opus-4-7-thinking-medium-fast
claude-opus-4-7-thinking-high - claude-opus-4-7-thinking-high
claude-opus-4-7-thinking-high-fast - claude-opus-4-7-thinking-high-fast
claude-opus-4-7-thinking-xhigh - claude-opus-4-7-thinking-xhigh
claude-opus-4-7-thinking-xhigh-fast - claude-opus-4-7-thinking-xhigh-fast
claude-opus-4-7-thinking-max - claude-opus-4-7-thinking-max
claude-opus-4-7-thinking-max-fast - claude-opus-4-7-thinking-max-fast
gpt-5.4-low - gpt-5.4-low
gpt-5.4-medium - gpt-5.4-medium
gpt-5.4-medium-fast - gpt-5.4-medium-fast
gpt-5.4-high - gpt-5.4-high
gpt-5.4-high-fast - gpt-5.4-high-fast
gpt-5.4-xhigh - gpt-5.4-xhigh
gpt-5.4-xhigh-fast - gpt-5.4-xhigh-fast
claude-4.6-opus-high - claude-4.6-opus-high
claude-4.6-opus-max - claude-4.6-opus-max
claude-4.6-opus-high-thinking - claude-4.6-opus-high-thinking
claude-4.6-opus-max-thinking - claude-4.6-opus-max-thinking
claude-4.5-opus-high - claude-4.5-opus-high
claude-4.5-opus-high-thinking - claude-4.5-opus-high-thinking
gpt-5.2-low - gpt-5.2-low
gpt-5.2-low-fast - gpt-5.2-low-fast
gpt-5.2-fast - gpt-5.2-fast
gpt-5.2-high - gpt-5.2-high
gpt-5.2-high-fast - gpt-5.2-high-fast
gpt-5.2-xhigh - gpt-5.2-xhigh
gpt-5.2-xhigh-fast - gpt-5.2-xhigh-fast
gpt-5.6-luna-none - gpt-5.6-luna-none
gpt-5.6-luna-none-fast - gpt-5.6-luna-none-fast
gpt-5.6-luna-low - gpt-5.6-luna-low
gpt-5.6-luna-low-fast - gpt-5.6-luna-low-fast
gpt-5.6-luna-medium - gpt-5.6-luna-medium
gpt-5.6-luna-medium-fast - gpt-5.6-luna-medium-fast
gpt-5.6-luna-high-fast - gpt-5.6-luna-high-fast
gpt-5.6-luna-xhigh - gpt-5.6-luna-xhigh
gpt-5.6-luna-xhigh-fast - gpt-5.6-luna-xhigh-fast
gpt-5.6-luna-max - gpt-5.6-luna-max
gpt-5.6-luna-max-fast - gpt-5.6-luna-max-fast
gemini-3.6-flash-minimal - gemini-3.6-flash-minimal
gemini-3.6-flash-low - gemini-3.6-flash-low
gemini-3.6-flash-medium - gemini-3.6-flash-medium
gemini-3.6-flash-high - gemini-3.6-flash-high
gemini-3.1-pro - gemini-3.1-pro
gpt-5.4-mini-none - gpt-5.4-mini-none
gpt-5.4-mini-low - gpt-5.4-mini-low
gpt-5.4-mini-medium - gpt-5.4-mini-medium
gpt-5.4-mini-high - gpt-5.4-mini-high
gpt-5.4-mini-xhigh - gpt-5.4-mini-xhigh
gpt-5.4-nano-none - gpt-5.4-nano-none
gpt-5.4-nano-low - gpt-5.4-nano-low
gpt-5.4-nano-medium - gpt-5.4-nano-medium
gpt-5.4-nano-high - gpt-5.4-nano-high
gpt-5.4-nano-xhigh - gpt-5.4-nano-xhigh
claude-4.5-sonnet - claude-4.5-sonnet
claude-4.5-sonnet-thinking - claude-4.5-sonnet-thinking
gpt-5.1-low - gpt-5.1-low
gpt-5.1 - gpt-5.1
gpt-5.1-high - gpt-5.1-high
gemini-3-flash - gemini-3-flash
gemini-3.5-flash - gemini-3.5-flash
claude-4-sonnet - claude-4-sonnet
claude-4-sonnet-thinking - claude-4-sonnet-thinking
gpt-5-mini - gpt-5-mini
kimi-k3-low - kimi-k3-low
kimi-k3-high - kimi-k3-high
kimi-k3-max - kimi-k3-max
kimi-k2.7-code - kimi-k2.7-code
glm-5.2-high - glm-5.2-high
glm-5.2-max - glm-5.2-max

Tip: use --model <id> to switch.
`

const cursorCatalog = normalizeCursorModels({
  models: [
    { value: "auto-smart", name: "Auto", configOptions: [{ id: "optimize_for", type: "select", currentValue: "balanced", options: [{ value: "intelligence" }, { value: "balanced" }, { value: "cost" }] }] },
    { value: "claude-opus-4-8", name: "Claude Opus 4.8", configOptions: [
      { id: "thinking", type: "select", currentValue: "true", options: [{ value: "false" }, { value: "true" }] },
      { id: "context", type: "select", currentValue: "300k", options: [{ value: "300k" }, { value: "1m" }] },
      { id: "effort", type: "select", currentValue: "high", options: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }, { value: "max" }] },
      { id: "fast", type: "select", currentValue: "false", options: [{ value: "false" }, { value: "true" }] },
    ] },
    { value: "gpt-5.5", name: "GPT-5.5", configOptions: [
      { id: "context", type: "select", currentValue: "272k", options: [{ value: "272k" }, { value: "1m" }] },
      { id: "reasoning", type: "select", currentValue: "medium", options: [{ value: "none" }, { value: "low" }, { value: "medium" }, { value: "high" }, { value: "extra-high" }] },
      { id: "fast", type: "select", currentValue: "false", options: [{ value: "false" }, { value: "true" }] },
    ] },
    { value: "gpt-5.3-codex", name: "Codex 5.3", configOptions: [
      { id: "reasoning", type: "select", currentValue: "medium", options: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "extra-high" }] },
      { id: "fast", type: "select", currentValue: "false", options: [{ value: "false" }, { value: "true" }] },
    ] },
    { value: "grok-4.6", name: "Cursor Grok 4.6", configOptions: [
      { id: "effort", type: "select", currentValue: "high", options: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] },
      { id: "fast", type: "select", currentValue: "true", options: [{ value: "false" }, { value: "true" }] },
    ] },
    { value: "composer-2.5", name: "Composer 2.5", configOptions: [
      { id: "fast", type: "select", currentValue: "true", options: [{ value: "false" }, { value: "true" }] },
    ] },
    // The listing spells gpt-5.4's top level `xhigh` where the session says
    // `extra-high`, and has no `none` level for it at all: the first must read
    // back in the session's spelling, the second must be refused by name.
    { value: "gpt-5.4", name: "GPT-5.4", configOptions: [
      { id: "context", type: "select", currentValue: "272k", options: [{ value: "272k" }, { value: "1m" }] },
      { id: "reasoning", type: "select", currentValue: "medium", options: [{ value: "none" }, { value: "low" }, { value: "medium" }, { value: "high" }, { value: "extra-high" }] },
      { id: "fast", type: "select", currentValue: "false", options: [{ value: "false" }, { value: "true" }] },
    ] },
    { value: "claude-fable-5", name: "Claude Fable 5", configOptions: [
      { id: "thinking", type: "select", currentValue: "true", options: [{ value: "false" }, { value: "true" }] },
      { id: "effort", type: "select", currentValue: "medium", options: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }, { value: "max" }] },
    ] },
    { value: "muse-spark-1.3", name: "Muse Spark 1.3", configOptions: [
      { id: "context", type: "select", currentValue: "300k", options: [{ value: "300k" }, { value: "1m" }] },
      { id: "effort", type: "select", currentValue: "high", options: [{ value: "minimal" }, { value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }, { value: "max" }] },
    ] },
  ],
})

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
  { runner: createCursorNativeRunner(async () => parseListing(CURSOR_CLI_LISTING)), loader: cursorProfileLoader, catalog: cursorCatalog },
  { runner: claudeNativeRunner, loader: claudeProfileLoader, catalog: claudeCatalog },
  { runner: codexNativeRunner, loader: codexProfileLoader, catalog: codexCatalog },
  { runner: grokNativeRunner, loader: grokProfileLoader, catalog: grokCatalog },
]

function parseListing(listing: string): string[] {
  return listing.split("\n").flatMap((line) => {
    const match = /^([A-Za-z0-9][\w.-]*)\s+-\s+/.exec(line.trim())
    return match?.[1] ? [match[1]] : []
  })
}

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
const refused: string[] = []
for (const subject of subjects) {
  const profile = availableProviderProfile(subject.loader, subject.catalog)
  for (const selection of selections(profile)) {
    const settings = resolveHarnessTuning(profile, selection)
    assert.ok(settings?.model, `${subject.runner.provider}: ${JSON.stringify(selection)} resolves`)
    const label = `${subject.runner.provider} ${JSON.stringify(settings)}`
    let prepared
    try {
      prepared = await subject.runner.prepare!(withCatalogDefaults(profile, settings), {})
    } catch (error) {
      // A refusal is an honest answer only for a combination the CLI's own
      // list lacks; it must name the model so the user can act on it.
      assert.equal(subject.runner.provider, "cursor", `${label}: only Cursor may refuse a catalog selection`)
      assert.match(error instanceof Error ? error.message : String(error), /has no model id for/)
      refused.push(JSON.stringify(settings))
      continue
    }
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
assert.ok(checked > 40, `enough selections were checked (${checked})`)
assert.deepEqual(
  refused,
  [JSON.stringify({ model: "gpt-5.4", options: { effort: "none" } })],
  "exactly the combinations the listing lacks are refused, and nothing else"
)
console.log(`Transport agreement: ${checked} selections across ${subjects.length} providers read back from their command lines; ${refused.length} Cursor combinations refused by name`)
