import assert from "node:assert/strict"
import type { SessionConfigOption } from "@agentclientprotocol/sdk"
import { cursorDegradedOptions, CURSOR_MODEL_LIST_UNAVAILABLE } from "../electron/providers/cursor/session-options.ts"
import { cursorAcpSource } from "../electron/providers/cursor/acp.ts"
import { AcpOptionsUnavailableError, repairSessionOptions } from "../electron/acp-options-repair.ts"
import { acpObservedSettings, applyAcpSettings } from "../electron/acp-config.ts"
import { classifyProviderFailure } from "../electron/contracts/provider-failure.ts"

/*
 * Config options as cursor-agent 2026.09.10 answers `session/new` with the
 * parameterized model picker, recorded 2026-09-13 in a fixture directory.
 */
const MODE: SessionConfigOption = {
  id: "mode",
  name: "Mode",
  description: "Controls how the agent executes tasks",
  category: "mode",
  type: "select",
  currentValue: "agent",
  options: [
    { value: "agent", name: "Agent", description: "Full agent capabilities with tool access" },
    { value: "plan", name: "Plan", description: "Read-only mode for planning and designing before implementation" },
    { value: "ask", name: "Ask", description: "Q&A mode - no edits or command execution" },
  ],
}
const MODELS = [
  { value: "auto-smart", name: "Auto" },
  { value: "claude-opus-5", name: "Claude Opus 5" },
  { value: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
]
/** The set the agent builds when its model fetch succeeded: the current model's parameters follow the model. */
const COMPLETE: SessionConfigOption[] = [
  MODE,
  { id: "model", name: "Model", description: "Controls which model is used for responses", category: "model", type: "select", currentValue: "gpt-5.6-sol", options: MODELS },
  { id: "context", name: "Context", description: "Context size the model has available.", category: "model_config", type: "select", currentValue: "272k", options: [{ value: "272k", name: "272K" }, { value: "1m", name: "1M" }] },
  { id: "reasoning", name: "Reasoning", category: "thought_level", type: "select", currentValue: "medium", options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
  { id: "fast", name: "Fast", category: "model_config", type: "select", currentValue: "false", options: [{ value: "false", name: "Off" }, { value: "true", name: "Fast" }] },
]
/**
 * The set the same agent builds when `fetchAvailableModelsForAcp` failed:
 * `getAcpAvailableModels` swallows the error into an empty list, so the
 * model select keeps its current value with no choices and
 * `buildModelParameterConfigOptions` finds no model to take parameters from.
 * This is what the installed app saw behind "This provider cannot change
 * context in the running session" after a 15.8 s session/new.
 */
const DEGRADED: SessionConfigOption[] = [
  MODE,
  { id: "model", name: "Model", description: "Controls which model is used for responses", category: "model", type: "select", currentValue: "gpt-5.6-sol", options: [] },
]
/** Without the parameterized picker the model is one composite choice; that set is complete for what it is. */
const VARIANTS: SessionConfigOption[] = [
  MODE,
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]", options: [{ value: "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]", name: "GPT-5.6 Sol" }] },
]
const TUNING = { model: "gpt-5.6-sol", options: { context: "272k", effort: "high", fast: "false" } }

/** The typed start failure a repair ends in, or an assertion that it did not fail that way. */
async function unavailable(work: Promise<SessionConfigOption[]>, what: string): Promise<AcpOptionsUnavailableError> {
  try {
    await work
  } catch (error) {
    assert.ok(error instanceof AcpOptionsUnavailableError, `${what}: fails as the typed options error`)
    return error
  }
  return assert.fail(`${what}: expected the start to fail`)
}

// Detection: the shapes, and the repair names the model the tuning selects.
assert.equal(cursorDegradedOptions(COMPLETE, "gpt-5.6-sol"), undefined, "a complete set needs no repair")
assert.equal(cursorDegradedOptions(VARIANTS, undefined), undefined, "the variants picker's single composite choice is a choice")
assert.equal(cursorDegradedOptions([MODE], undefined), undefined, "a set with no model option is not this failure")
assert.deepEqual(cursorDegradedOptions(DEGRADED, "claude-opus-5"), {
  reason: CURSOR_MODEL_LIST_UNAVAILABLE,
  request: { configId: "model", value: "claude-opus-5" },
})
assert.deepEqual(
  cursorDegradedOptions(DEGRADED, undefined)?.request,
  { configId: "model", value: "gpt-5.6-sol" },
  "with no selection the agent's own current model is re-set"
)
assert.equal(
  cursorDegradedOptions([MODE, { ...DEGRADED[1]!, currentValue: "" }], undefined)?.request,
  undefined,
  "no model anywhere: nothing to send, the start fails at once"
)
assert.equal(cursorAcpSource.degradedOptions, cursorDegradedOptions, "the Cursor source owns the detector")

// The failure the user reads is a dropped connection: retriable, Send again offered.
const classified = classifyProviderFailure(CURSOR_MODEL_LIST_UNAVAILABLE, "Cursor")
assert.equal(classified.kind, "network")
assert.equal(classified.retriable, true)

// Before the repair, the degraded set made the saved context look unchangeable.
await assert.rejects(
  applyAcpSettings({
    settings: TUNING,
    observed: acpObservedSettings(DEGRADED, "gpt-5.6-sol"),
    options: DEGRADED,
    setOption: async () => assert.fail("no option to set"),
    setModel: async () => assert.fail("the model is already current"),
  }),
  /cannot change context in the running session/
)

// Repair: one set_config_option rebuilds the set; the tuning then applies as on a healthy start.
{
  const sent: { configId: string; value: string }[] = []
  const repaired = await repairSessionOptions({
    options: DEGRADED,
    model: TUNING.model,
    degraded: cursorDegradedOptions,
    set: async (request) => {
      sent.push(request)
      return COMPLETE
    },
    sleep: async () => assert.fail("the first attempt waits for nothing"),
  })
  assert.deepEqual(sent, [{ configId: "model", value: "gpt-5.6-sol" }])
  assert.equal(repaired, COMPLETE)
  const applied = await applyAcpSettings({
    settings: TUNING,
    observed: acpObservedSettings(repaired, "gpt-5.6-sol"),
    options: repaired,
    setOption: async (option, value) =>
      repaired.map((entry) => (entry.id === option.id ? { ...entry, currentValue: value } : entry)),
    setModel: async () => assert.fail("the model option is on the wire"),
  })
  assert.equal(applied.settings.options?.effort, "high")
  assert.equal(applied.settings.options?.context, "272k")
}

// A complete set sends nothing.
{
  const repaired = await repairSessionOptions({
    options: COMPLETE,
    model: TUNING.model,
    degraded: cursorDegradedOptions,
    set: async () => assert.fail("a complete set is not repaired"),
  })
  assert.equal(repaired, COMPLETE)
}

// The fetch failing once more is one spent attempt; the pause passes and the second ask succeeds.
{
  const REFUSAL = "Invalid model value: gpt-5.6-sol"
  const attempts: [number, string | undefined][] = []
  const pauses: number[] = []
  let calls = 0
  const repaired = await repairSessionOptions({
    options: DEGRADED,
    model: TUNING.model,
    degraded: cursorDegradedOptions,
    set: async () => {
      calls += 1
      if (calls === 1) throw new Error(REFUSAL)
      return COMPLETE
    },
    onAttempt: (attempt, refusal) => attempts.push([attempt, refusal]),
    pauseMs: 1_500,
    sleep: async (ms) => {
      pauses.push(ms)
    },
  })
  assert.equal(repaired, COMPLETE)
  assert.deepEqual(attempts, [[1, REFUSAL]])
  assert.deepEqual(pauses, [1_500])
}

// A rebuilt set that is still incomplete is also a spent attempt, and the budget is bounded.
{
  const attempts: number[] = []
  let calls = 0
  const error = await unavailable(
    repairSessionOptions({
      options: DEGRADED,
      model: TUNING.model,
      degraded: cursorDegradedOptions,
      set: async () => {
        calls += 1
        return DEGRADED
      },
      onAttempt: (attempt) => attempts.push(attempt),
      attempts: 2,
      sleep: async () => {},
    }),
    "an incomplete set after the budget"
  )
  assert.equal(error.message, CURSOR_MODEL_LIST_UNAVAILABLE, "the user reads the provider's reason")
  assert.equal(error.attempts, 2)
  assert.equal(error.lastRefusal, undefined, "the last ask was answered, with a set still incomplete")
  assert.equal(calls, 2)
  assert.deepEqual(attempts, [1, 2])
}

// Every ask refused: the last refusal is kept for the log, the reason for the user.
{
  const error = await unavailable(
    repairSessionOptions({
      options: DEGRADED,
      model: TUNING.model,
      degraded: cursorDegradedOptions,
      set: async () => {
        throw new Error("Invalid model value: gpt-5.6-sol")
      },
      attempts: 2,
      sleep: async () => {},
    }),
    "refused twice"
  )
  assert.equal(error.lastRefusal, "Invalid model value: gpt-5.6-sol")
  assert.equal(classifyProviderFailure(error.message, "Cursor").kind, "network")
}

// No model to name: the start fails without a request on the wire.
{
  const error = await unavailable(
    repairSessionOptions({
      options: [MODE, { ...DEGRADED[1]!, currentValue: "" }],
      model: undefined,
      degraded: cursorDegradedOptions,
      set: async () => assert.fail("nothing to send"),
      sleep: async () => assert.fail("nothing to wait for"),
    }),
    "no model to name"
  )
  assert.equal(error.attempts, 0)
}

console.log("Cursor session options: the failed-fetch shape is repaired by re-setting the model, bounded, and fails as a dropped connection")
