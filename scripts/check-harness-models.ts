import assert from "node:assert/strict"
import { settingValueLabel } from "../src/components/composer/settings-source.ts"
import {
  canonicalHarnessModelId,
  resolveHarnessTuning,
} from "../electron/harness-models.ts"
import {
  normalizeClaudeModels,
  normalizeCodexModels,
  normalizeCursorModels,
  normalizeDevinModels,
  normalizeGrokModels,
} from "@mako/sessions/model-catalog"
import {
  modelByIdentity,
  optionAccepts,
  resolveSessionSettings,
} from "@mako/sessions/settings"
import { claudeProfileLoader } from "../electron/providers/claude/profile.ts"
import { devinProfileLoader } from "../electron/providers/devin/profile.ts"
import { availableProviderProfile } from "../electron/providers/profile-loader.ts"
import type { HarnessModel, HarnessProfile } from "../electron/shared.ts"

const claudeFixture = [
  {
    value: "default",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Default",
  },
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Opus (1M context)",
    description: "Frontier model",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"],
    supportsFastMode: true,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet",
    supportsEffort: false,
  },
]

const codexFixture = {
  data: ["sol", "terra", "luna"].map((name, index) => ({
    model: `gpt-5.6-${name}`,
    displayName: `GPT-5.6 ${name[0]!.toUpperCase()}${name.slice(1)}`,
    isDefault: index === 0,
    defaultReasoningEffort: index === 0 ? "low" : "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
    ],
    serviceTiers: [
      { id: "priority", name: "Fast", description: "Faster responses" },
    ],
  })),
}

const cursorFixture = {
  models: [
    { value: "auto-smart", name: "Auto", configOptions: [] },
    {
      value: "claude-opus-5[effort=high,fast=true]",
      name: "Claude Opus 5",
      configOptions: [
        {
          id: "effort",
          name: "Effort",
          type: "select",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
        {
          id: "fast",
          name: "Fast",
          type: "select",
          currentValue: "true",
          options: {
            values: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        },
      ],
    },
  ],
}

const grokFixture = {
  output: [
    "Default model: grok-4.6",
    "Available models:",
    "  * grok-4.6 (default)",
    "  - grok-4.5",
  ].join("\n"),
  cache: {
    models: {
      "grok-4.6": {
        info: {
          name: "Grok 4.6",
          context_window: 500_000,
          reasoning_effort: "high",
          reasoning_efforts: [
            { value: "low", label: "Low", default: false },
            { value: "high", label: "High", default: true },
          ],
        },
      },
      "grok-4.5": {
        info: {
          name: "Grok 4.5",
          reasoning_effort: "medium",
          reasoning_efforts: [
            { value: "medium", label: "Medium", default: true },
          ],
        },
      },
    },
  },
}

const devinFixture = {
  families: [
    {
      family_label: "Adaptive",
      slug: "adaptive",
      aliases: [],
      variants: [
        {
          model_uid: "adaptive",
          label: "Adaptive",
          description: "Automatically balances quality and cost",
        },
      ],
    },
    {
      family_label: "Adaptive duplicate",
      slug: "adaptive",
      aliases: [],
      variants: [{ model_uid: "adaptive-copy", label: "Adaptive copy" }],
    },
    {
      family_label: "GPT-5.6 Sol",
      slug: "gpt-5.6-sol",
      aliases: ["gpt"],
      variants: [
        {
          model_uid: "gpt-5-6-sol-medium",
          label: "GPT-5.6 Sol Medium Thinking",
          max_context_tokens: 1_000_000,
          max_output_tokens: 128_000,
        },
        {
          model_uid: "gpt-5-6-sol-high",
          label: "GPT-5.6 Sol High Thinking",
          max_context_tokens: 800_000,
          max_output_tokens: 96_000,
        },
        {
          model_uid: "gpt-5-6-sol-high-priority",
          label: "GPT-5.6 Sol High Thinking Fast",
          max_context_tokens: 700_000,
          max_output_tokens: 64_000,
        },
      ],
    },
  ],
}

function option(model: HarnessModel, id: string) {
  return model.options.find((entry) => entry.id === id)
}

function assertFixtureProfiles(): void {
  const claude = normalizeClaudeModels(claudeFixture)
  assert.equal(claude.defaultModel, "claude-opus-5[1m]")
  assert.deepEqual(
    claude.models.map(({ id, launchId, label }) => ({ id, launchId, label })),
    [
      {
        id: "claude-opus-5[1m]",
        launchId: "opus[1m]",
        label: "Opus 5 (1M context)",
      },
      { id: "claude-sonnet-5", launchId: "sonnet", label: "Sonnet 5" },
    ]
  )
  const claudeProfile = availableProviderProfile(claudeProfileLoader, claude)
  assert.equal(
    resolveHarnessTuning(claudeProfile, { model: "claude-opus-5[1m]" })?.model,
    "opus[1m]"
  )

  const codex = normalizeCodexModels(codexFixture)
  assert.deepEqual(
    codex.models.slice(0, 3).map((model) => model.id),
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
  )
  assert.equal(codex.defaultModel, "gpt-5.6-sol")
  for (const model of codex.models) {
    const tier = option(model, "serviceTier")
    assert.equal(tier?.kind, "select")
    if (tier?.kind === "select")
      assert.deepEqual(
        tier.values.map((entry) => entry.value),
        ["default", "priority"]
      )
  }

  const cursor = normalizeCursorModels(
    cursorFixture,
    "claude-opus-5[effort=high,fast=true]"
  )
  assert.equal(cursor.defaultModel, undefined)
  assert.equal(cursor.configuredModel, "claude-opus-5[effort=high,fast=true]")
  const cursorModel = cursor.models.find(
    (model) => model.id === "claude-opus-5[effort=high,fast=true]"
  )
  assert(cursorModel)
  assert.equal(cursorModel.id, "claude-opus-5[effort=high,fast=true]")
  for (const entry of cursorModel.options) {
    if (entry.kind === "select") {
      assert(entry.values.every((value) => value.value === `${value.value}`))
    }
  }
  const fast = option(cursorModel, "fast")
  assert.equal(fast?.kind, "select")
  if (fast?.kind === "select") {
    assert.equal(fast.presentation, "toggle")
    assert.equal(settingValueLabel(fast, "false"), "Standard")
    assert.equal(settingValueLabel(fast, "true"), "Fast")
    assert.equal(
      settingValueLabel({ ...fast, role: undefined }, "false"),
      "Off"
    )
    assert.equal(
      settingValueLabel(
        { kind: "boolean", id: "enabled", label: "Enabled" },
        false
      ),
      "Off"
    )
    assert.deepEqual(
      fast.values.map((entry) => entry.value),
      ["false", "true"]
    )
  }

  const grok = normalizeGrokModels(grokFixture.output, grokFixture.cache)
  assert.equal(grok.defaultModel, "grok-4.6")
  assert.deepEqual(
    grok.models.map((model) => model.id),
    ["grok-4.6", "grok-4.5"]
  )
  assert.deepEqual(
    grok.models.map((model) =>
      option(model, "effort")?.kind === "select"
        ? option(model, "effort")!.values.map((entry) => entry.value)
        : []
    ),
    [["low", "high"], ["medium"]]
  )

  const devin = normalizeDevinModels(devinFixture)
  assert.equal(devin.defaultModel, undefined)
  assert.equal(
    devin.models.filter((model) => model.id === "adaptive").length,
    1
  )
  const sol = devin.models.find((model) => model.id === "gpt-5.6-sol")
  assert(sol)
  assert.equal(sol.launchId, "gpt-5-6-sol-medium")
  assert.deepEqual(
    sol.variants?.map(({ id, contextWindow, maxOutputTokens }) => ({
      id,
      contextWindow,
      maxOutputTokens,
    })),
    [
      {
        id: "gpt-5-6-sol-medium",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
      },
      {
        id: "gpt-5-6-sol-high",
        contextWindow: 800_000,
        maxOutputTokens: 96_000,
      },
      {
        id: "gpt-5-6-sol-high-priority",
        contextWindow: 700_000,
        maxOutputTokens: 64_000,
      },
    ]
  )
  const devinProfile = availableProviderProfile(devinProfileLoader, devin)
  const selected = { model: "gpt", options: { effort: "high", fast: true } }
  assert.equal(
    resolveHarnessTuning(devinProfile, selected)?.model,
    "gpt-5-6-sol-high-priority"
  )
  assert.equal(
    resolveHarnessTuning(devinProfile, { model: "gpt-5.6-sol" })?.model,
    "gpt-5-6-sol-medium"
  )
  assert.equal(canonicalHarnessModelId(devinProfile, "gpt"), "gpt-5.6-sol")
  assert.equal(
    canonicalHarnessModelId(devinProfile, "gpt-5-6-sol-medium"),
    "gpt-5.6-sol"
  )
  assert.equal(
    canonicalHarnessModelId(devinProfile, "removed-model"),
    undefined
  )
  assert.deepEqual(
    resolveHarnessTuning(devinProfile, {
      model: "removed-model",
      options: { effort: "high" },
    }),
    {
      model: "removed-model",
      options: { effort: "high" },
    }
  )

  const noAdaptive = normalizeDevinModels({
    families: devinFixture.families.slice(2),
  })
  assert.equal(
    noAdaptive.models.some((model) => model.id === "adaptive"),
    false
  )
  assert.equal(noAdaptive.defaultModel, undefined)
  const reportedDefault = normalizeDevinModels({
    default_model: "gpt-5-6-sol-high",
    families: devinFixture.families.slice(2),
  })
  assert.equal(reportedDefault.defaultModel, "gpt-5.6-sol")
}

function assertGenericProfile(profile: HarnessProfile): void {
  assert(profile.models.length > 0, `${profile.id} reported no models`)
  assert.equal(
    new Set(profile.models.map((model) => model.id)).size,
    profile.models.length
  )
  if (profile.defaultModel) {
    assert(
      canonicalHarnessModelId(profile, profile.defaultModel),
      `${profile.id} default is not canonical`
    )
  }
  if (profile.configuredModel) {
    assert(
      canonicalHarnessModelId(profile, profile.configuredModel),
      `${profile.id} configured model is not canonical`
    )
  }
}

function assertLiveProfile(profile: HarnessProfile): void {
  assert.ok(
    profile.available && !profile.pending,
    `${profile.id}: ${profile.error ?? "discovery incomplete"}`
  )
  assert.equal(
    profile.configurationError,
    undefined,
    `${profile.id}: configuration discovery failed`
  )
  assertGenericProfile(profile)
  const model = modelByIdentity(profile.models, profile.settings?.model)
  assert.ok(
    model,
    `${profile.id} must report an effective model present in its catalog`
  )
  const resolved = resolveSessionSettings({
    models: profile.models,
    context: "new",
    phase: "launch",
    defaults: profile.settings,
  })
  assert.equal(resolved.model.kind, "known")
  assert.deepEqual(resolved.issues, [], `${profile.id} defaults must be valid`)
  assert.equal(
    new Set(model.options.map((option) => option.id)).size,
    model.options.length
  )
  for (const option of model.options) {
    const value = resolved.options[option.id]
    if (option.role)
      assert.ok(
        value?.kind === "known",
        `${profile.id}: ${model.id} did not report ${option.id}`
      )
    if (value?.kind === "known")
      assert.ok(
        optionAccepts(option, value.value),
        `${profile.id}: ${option.id} default is not supported`
      )
  }
  console.log(`${profile.id}: ${JSON.stringify(resolved.settings)}`)
}

assertFixtureProfiles()
if (process.argv.includes("--live")) {
  // Native SDK children execute JavaScript directly; tsx's import remapping
  // does not apply to their separate processes. Use the built host for live checks.
  const { harnessProfile } = await import("../dist-electron/harnesses.js")
  const { providerHost } = await import("../dist-electron/providers/index.js")
  const loaders = providerHost.profiles.list()
  assert.ok(loaders.length > 0, "No providers registered")
  const failures: string[] = []
  for (const loader of loaders) {
    try {
      assertLiveProfile(
        await harnessProfile(loader.provider, true, process.cwd())
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${loader.provider}: ${message}`)
      console.error(`FAIL: ${loader.provider}: ${message}`)
    }
  }
  assert.deepEqual(
    failures,
    [],
    "Every registered provider must pass fresh discovery"
  )
  console.log(
    `Harness model checks passed: fixtures + ${loaders.length} freshly discovered profiles`
  )
} else {
  console.log(
    "Harness model fixture checks passed; live discovery not requested"
  )
}
