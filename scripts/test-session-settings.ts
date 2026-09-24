import { forward } from "../electron/acp-notifications.ts"
import { normalizeCodexModels } from "@mako/sessions/model-catalog"
import assert from "node:assert/strict"
import type { SessionConfigOption } from "@agentclientprotocol/sdk"
import { applyAcpSettings } from "../electron/acp-config.ts"
import { codexInteractiveConfig, codexWireSettings } from "../electron/providers/codex/settings.ts"

const model: SessionConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "a",
  options: [
    { value: "a", name: "A" },
    { value: "b", name: "B" },
  ],
}
const effort: SessionConfigOption = {
  id: "reasoning_effort",
  name: "Reasoning",
  category: "thought_level",
  type: "select",
  currentValue: "low",
  options: [
    { value: "low", name: "Low" },
    { value: "high", name: "High" },
  ],
}
const order: string[] = []
const applied = await applyAcpSettings({
  settings: { model: "b", options: { effort: "high" } },
  observed: { model: "a", options: { effort: "low" } },
  options: [model, effort],
  async setOption(option, value) {
    order.push(`${option.id}:${value}`)
    return [
      option.id === "model"
        ? { ...model, currentValue: String(value) }
        : { ...model, currentValue: "b" },
      option.id === effort.id
        ? { ...effort, currentValue: String(value) }
        : effort,
    ]
  },
  async setModel() {
    assert.fail("model must use its reported config option")
  },
})
assert.deepEqual(order, ["model:b", "reasoning_effort:high"])
assert.deepEqual(applied.settings, { model: "b", options: { effort: "high" } })

// Devin folds effort into the model id and exposes no effort option. A
// resolved launch therefore carries only the variant id, and applying it
// must touch the model option alone rather than refusing the session.
const variantModel: SessionConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "swe-1-7-medium",
  options: [
    { value: "swe-1-7-medium", name: "SWE-1.7 Medium" },
    { value: "swe-1-7-high", name: "SWE-1.7 High" },
  ],
}
const variantOrder: string[] = []
const variantApplied = await applyAcpSettings({
  settings: { model: "swe-1-7-high" },
  observed: { model: "swe-1-7-medium", options: {} },
  options: [variantModel],
  async setOption(option, value) {
    variantOrder.push(`${option.id}:${value}`)
    return [{ ...variantModel, currentValue: String(value) }]
  },
  async setModel() {
    assert.fail("model must use its reported config option")
  },
})
assert.deepEqual(variantOrder, ["model:swe-1-7-high"])
assert.deepEqual(variantApplied.settings, { model: "swe-1-7-high", options: {} })
await assert.rejects(
  applyAcpSettings({
    settings: { options: { fast: false } },
    observed: { options: { fast: true } },
    options: [],
    async setOption() {
      assert.fail()
    },
    async setModel() {
      assert.fail()
    },
  }),
  /cannot change fast/
)
await assert.rejects(
  applyAcpSettings({
    settings: { options: { effort: "high" } },
    observed: {},
    options: [effort],
    async setOption() {
      throw new Error("provider rejected setting")
    },
    async setModel() {
      assert.fail()
    },
  }),
  /provider rejected/
)
const { accessModeId } = await import("../electron/contracts/access.ts")
const mode: SessionConfigOption = {
  id: "mode",
  name: "Mode",
  category: "mode",
  type: "select",
  currentValue: "agent",
  options: [
    { value: "agent", name: "Agent" },
    { value: "plan", name: "Plan" },
    { value: "ask", name: "Ask" },
  ],
}
const hostModeCalls: string[] = []
const hostMode = await applyAcpSettings({
  settings: { options: { mode: accessModeId("full") } },
  observed: { options: { mode: "agent" } },
  options: [mode],
  async setOption(option, value) {
    hostModeCalls.push(`${option.id}:${value}`)
    return [{ ...mode, currentValue: String(value) }]
  },
  async setModel() {
    assert.fail("host access is not a native model")
  },
})
assert.deepEqual(hostModeCalls, [])
assert.equal(hostMode.settings.options?.mode, "agent")
const nativeModeCalls: string[] = []
const nativeMode = await applyAcpSettings({
  settings: { options: { mode: "plan" } },
  observed: { options: { mode: "agent" } },
  options: [mode],
  async setOption(option, value) {
    nativeModeCalls.push(`${option.id}:${value}`)
    return [{ ...mode, currentValue: String(value) }]
  },
  async setModel() {
    assert.fail()
  },
})
assert.deepEqual(nativeModeCalls, ["mode:plan"])
assert.equal(nativeMode.settings.options?.mode, "plan")
await applyAcpSettings({
  settings: { options: { mode: accessModeId("full") } },
  observed: {},
  options: [],
  async setOption() {
    assert.fail("host access is not a missing config option")
  },
  async setModel() {
    assert.fail()
  },
})
const mixedCalls: string[] = []
const mixed = await applyAcpSettings({
  settings: { options: { mode: accessModeId("full"), effort: "high" } },
  observed: { options: { mode: "agent", effort: "low" } },
  options: [mode, effort],
  async setOption(option, value) {
    mixedCalls.push(`${option.id}:${value}`)
    return [
      option.id === "mode" ? { ...mode, currentValue: String(value) } : mode,
      option.id === effort.id
        ? { ...effort, currentValue: String(value) }
        : effort,
    ]
  },
  async setModel() {
    assert.fail()
  },
})
assert.deepEqual(mixedCalls, ["reasoning_effort:high"])
assert.equal(mixed.settings.options?.mode, "agent")
assert.equal(mixed.settings.options?.effort, "high")
assert.deepEqual(
  codexWireSettings({ options: { serviceTier: "default", effort: "high" } }),
  { model: undefined, effort: "high", serviceTier: "default" }
)
assert.equal(codexWireSettings().serviceTier, undefined)
assert.deepEqual(codexInteractiveConfig(), { "features.default_mode_request_user_input": true })
assert.deepEqual(codexInteractiveConfig("high"), {
  "features.default_mode_request_user_input": true,
  model_reasoning_effort: "high",
})
assert.equal("config" in codexWireSettings(), false, "Interactive questions must not alter headless launch settings")
console.log(
  "Session settings transports: sequential ACP acknowledgement and rejection, Codex reset"
)

const dualCatalog = normalizeCodexModels({
  data: [
    {
      model: "test",
      serviceTiers: [
        { id: "priority", name: "Fast", description: "Provider detail" },
      ],
      additionalSpeedTiers: ["fast"],
    },
  ],
})
const speed = dualCatalog.models[0]!.options.find(
  (option) => option.id === "serviceTier"
)
assert.equal(speed?.kind, "select")
if (speed?.kind === "select") {
  assert.deepEqual(speed.values, [
    { value: "default", label: "Standard", default: true },
    {
      value: "priority",
      label: "Fast",
      description: "Provider detail",
      aliases: ["fast"],
    },
  ])
  assert.equal(
    speed.current,
    "default",
    "Codex reports a null default tier for the standard tier; it is a proven default, not an unknown one"
  )
}
const elevatedCatalog = normalizeCodexModels({
  data: [
    {
      model: "elevated",
      defaultServiceTier: "fast",
      serviceTiers: [{ id: "priority", name: "Fast" }],
      additionalSpeedTiers: ["fast"],
    },
  ],
})
const elevated = elevatedCatalog.models[0]!.options.find(
  (option) => option.id === "serviceTier"
)
assert.equal(elevated?.current, "priority")
if (elevated?.kind === "select")
  assert.deepEqual(
    elevated.values.map((value) => [value.value, value.default ?? false]),
    [["default", false], ["priority", true]]
  )
assert.equal(
  codexWireSettings({ options: { serviceTier: "fast" } }).serviceTier,
  "priority"
)

const observedChanges: unknown[] = []
forward(
  { id: "live" },
  {
    sessionId: "session",
    update: {
      sessionUpdate: "config_option_update",
      configOptions: [{ ...effort, currentValue: "high" }],
    },
  },
  () => assert.fail("config is a state update"),
  (_live, patch) => observedChanges.push(patch.settings),
  { model: "a", options: { effort: "low" } }
)
assert.deepEqual(observedChanges, [{ model: "a", options: { effort: "high" } }])

const { ClaudeSettingsResponseSchema } = await import("../electron/providers/claude/settings.ts")
const settingsResponse = (effective: Record<string, string | boolean>) => ({type:"control_response",response:{subtype:"success",response:{applied:{effort:"high",model:"fable"},effective,sources:[{secret:"fixture-secret"}]}}})
assert.deepEqual(ClaudeSettingsResponseSchema.parse(settingsResponse({fastMode:true,apiKey:"fixture-secret"})),{effort:"high",fast:true})
assert.deepEqual(ClaudeSettingsResponseSchema.parse(settingsResponse({fastMode:true,fastModePerSessionOptIn:true})),{effort:"high",fast:false})
assert.deepEqual(ClaudeSettingsResponseSchema.parse(settingsResponse({})),{effort:"high",fast:false})
assert.equal(ClaudeSettingsResponseSchema.safeParse({type:"control_response",response:{subtype:"error"}}).success,false)
