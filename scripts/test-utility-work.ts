import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelOption, SessionModel } from "@mako/sessions/settings"
import { agentOrder, harnessesByRecency } from "../electron/contracts/agent-order.ts"
import { harnessOrder, isDefaultOrder, lightDefault, lightModel, lightOptions, workDefault } from "../electron/contracts/harness-defaults.ts"
import type { UtilityConnection, UtilityModelSettings } from "../electron/contracts/utility-models.ts"
import type { UtilityTask, UtilityWorkChoices } from "../electron/contracts/utility-work.ts"
import { providerHost } from "../electron/providers/index.ts"
import type { UtilityCompletion } from "../electron/providers/utility-runner.ts"
import { UtilityModelStore } from "../electron/utility-model-store.ts"
import { parseConnection, utilityProviders } from "../electron/utility-models.ts"
import { UtilityWork, type UtilityAgent } from "../electron/utility-work.ts"

// One harness order for setup and commits: the person's, then Mako's, which is the order harnesses install in.
const MAKO_ORDER = providerHost.harnesses.list().map(({ provider }) => provider)
const defaults = (harness: string) => providerHost.profiles.get(harness)?.defaults
assert.deepEqual(MAKO_ORDER, ["claude", "codex", "cursor", "opencode", "grok", "devin"])
assert.deepEqual(harnessOrder(undefined, MAKO_ORDER), MAKO_ORDER, "Mako's order until the person saves one")
assert.deepEqual(harnessOrder(["grok", "codex"], ["claude", "codex", "grok", "pi"]), ["grok", "codex", "claude", "pi"], "the saved order first, then Mako's")
assert.deepEqual(harnessOrder(["gone", "codex"], ["claude", "codex"]), ["codex", "claude"], "a harness that went away is dropped")
assert.equal(isDefaultOrder(["claude", "codex", "grok"], ["claude", "codex", "grok"]), true)
assert.equal(isDefaultOrder(["codex", "claude"], ["claude", "codex"]), false)
assert.equal(isDefaultOrder(["claude"], ["claude", "codex"]), false, "an order missing a harness is not Mako's")
assert.deepEqual(agentOrder({ signedIn: ["codex", "claude"], order: MAKO_ORDER }), ["claude", "codex"])
assert.deepEqual(agentOrder({ signedIn: ["codex", "claude"], order: ["codex", "claude"] }), ["codex", "claude"])
assert.deepEqual(agentOrder({ signedIn: ["codex", "claude"], order: MAKO_ORDER, recent: ["cursor", "codex"] }), ["codex", "claude"], "a recent harness that isn't signed in is skipped")
assert.deepEqual(harnessesByRecency([
  { harness: "claude", updatedAt: "2026-10-01T00:00:00Z" },
  { harness: "codex", updatedAt: "2026-10-03T00:00:00Z" },
  { harness: "claude", updatedAt: "2026-10-02T00:00:00Z" },
  { harness: "cursor" },
]), ["codex", "claude", "cursor"])

const effort = (values: string[], current?: string): ModelOption => ({ id: "effort", label: "Effort", role: "reasoning", kind: "select", current, values: values.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })) })
const fast: ModelOption = { id: "fast", label: "Fast", role: "speed", kind: "boolean", current: false }
const tier: ModelOption = { id: "serviceTier", label: "Speed", role: "speed", kind: "select", current: "default", values: [{ value: "default", label: "Standard" }, { value: "priority", label: "Fast" }], booleanValues: { on: "priority", off: "default" } }
const model = (id: string, label: string, options: ModelOption[] = [], description?: string): SessionModel => ({ id, label, description, options })
const levels = ["low", "medium", "high", "xhigh", "max"]

// Mako's maintained defaults, read against each harness's own catalog.
const claudeModels = [
  model("claude-opus-5-5", "Opus 5.5", [effort(levels, "medium"), fast]),
  model("claude-fable-5-1", "Fable 5.1", [effort(levels), fast]),
  model("claude-haiku-4-5-20251001", "Haiku 4.5", [fast]),
]
const codexModels = [
  model("gpt-6.1-sol", "GPT-6.1 Sol", [effort([...levels, "ultra"], "low"), tier]),
  model("gpt-6-astra", "GPT-6 Astra", [effort(levels, "medium"), tier]),
  model("gpt-6-luna", "GPT-6 Luna", [effort(levels, "medium"), tier]),
]
assert.deepEqual(workDefault(defaults("claude"), claudeModels), { model: "claude-opus-5-5", options: { effort: "high", fast: false } }, "new conversations and setup start on Opus 5.5 at high, not Fable")
assert.deepEqual(workDefault(defaults("codex"), codexModels), { model: "gpt-6.1-sol", options: { effort: "medium", serviceTier: "default" } }, "not the Astra a config file pins")
assert.equal(workDefault(defaults("codex"), [model("gpt-5.5", "GPT-5.5")]), undefined, "a catalog without Mako's pick keeps the harness's own default")
assert.equal(workDefault(defaults("pi"), claudeModels), undefined, "a harness Mako has no defaults for keeps its own")
const cursorFast: ModelOption = { id: "fast", label: "Fast", role: "speed", kind: "select", values: [{ value: "false", label: "Off" }, { value: "true", label: "On" }] }
const cursorModels = [
  model("auto-smart", "Auto"),
  model("grok-4.7", "Grok 4.7", [effort(["low", "medium", "high", "xhigh"]), cursorFast]),
  model("claude-opus-5-5", "Claude Opus 5.5", [effort(levels), cursorFast]),
]
assert.deepEqual(workDefault(defaults("cursor"), cursorModels), { model: "claude-opus-5-5", options: { effort: "high", fast: "false" } }, "Cursor works on Opus 5.5, not Auto")
assert.deepEqual(lightDefault(defaults("cursor"), cursorModels), { model: cursorModels[1], options: { effort: "low", fast: "false" } }, "and names things with Grok 4.7 at low")
const openCodeModels = [
  model("openai/gpt-6.1-sol", "GPT-6.1 Sol", [effort(levels)]),
  model("opencode/muse-spark-1.3-contributor-free", "Muse Spark 1.3 Free", [effort(["minimal", "low", "medium", "high", "xhigh"])]),
]
assert.equal(workDefault(defaults("opencode"), openCodeModels), undefined, "OpenCode keeps its own default, the free model it changes itself")
assert.deepEqual(lightDefault(defaults("opencode"), openCodeModels, "opencode/muse-spark-1.3-contributor-free"), { model: openCodeModels[1], options: { effort: "low" } }, "and its own default runs light at low")

const claudeLight = lightDefault(defaults("claude"), claudeModels)
assert.equal(claudeLight?.model.id, "claude-haiku-4-5-20251001", "a dated id matches the pick it was released as")
assert.deepEqual(claudeLight?.options, { fast: false }, "Haiku has no reasoning level; its fast lane stays off")
assert.deepEqual(lightDefault(defaults("codex"), codexModels)?.options, { effort: "low", serviceTier: "default" }, "Luna at low reasoning, standard lane")
assert.equal(lightDefault(defaults("grok"), [model("grok-4.7", "Grok 4.7", [effort(["xhigh", "high", "medium", "low"])]), model("grok-4.7-build-fast", "Build fast")])?.model.id, "grok-4.7", "Grok's own model at low, not the pricier fast build")
assert.deepEqual(lightDefault(defaults("grok"), [model("grok-4.7", "Grok 4.7", [effort(["xhigh", "high", "medium", "low"])])])?.options, { effort: "low" })
assert.deepEqual(lightDefault(defaults("devin"), [model("gemini-3.8-flash", "Gemini 3.8 Flash", [effort(["low", "medium", "high"], "high")])])?.options, { effort: "low" }, "the next pick when the first isn't offered")

// Without a pick, the catalog's own fast or cheap model, at its lowest sensible level.
assert.equal(lightModel([model("big", "Big", [], "Most capable"), model("luna", "Luna", [], "Fast and affordable")])?.id, "luna")
assert.equal(lightModel([model("old-mini", "Old mini", [], "Fast. Older model"), model("lite", "Lite")])?.id, "lite")
assert.equal(lightModel([model("big", "Big", [], "Most capable")]), undefined, "a catalog that offers no light model offers none")
assert.deepEqual(lightDefault(defaults("pi"), [model("pi-mini", "Pi mini", [effort(["minimal", "medium", "high"]), tier])])?.options, { effort: "minimal", serviceTier: "default" })
assert.deepEqual(lightOptions(model("x", "X", [effort(["none", "low", "high"]), { id: "fast", label: "Fast", role: "speed", kind: "select", values: [{ value: "false", label: "Off" }, { value: "true", label: "On" }] }])), { effort: "low", fast: "false" })

const calls: Array<UtilityCompletion & { harness: string }> = []
const agent = (harness: string, label: string, models: SessionModel[]): UtilityAgent => ({
  harness,
  label,
  models,
  defaults: defaults(harness),
  runner: {
    complete: async (request) => {
      calls.push({ ...request, harness })
      return request.schema ? JSON.stringify({ title: "Named" }) : "Named"
    },
  },
})
const claude = agent("claude", "Claude Code", claudeModels)
const codex = agent("codex", "Codex", codexModels)
const heavyOnly = agent("devin", "Devin", [model("adaptive", "Adaptive")])

const connection = parseConnection({ provider: "google", model: "gemini-flash", contextTokens: 1_000_000 })
let agents: UtilityAgent[] = []
let connections: UtilityConnection[] = []
let issues: UtilityModelSettings["issues"] = []
let savedOrder: string[] = []
const choices: UtilityWorkChoices = { commit: "auto" }
const models: ConstructorParameters<typeof UtilityWork>[0]["models"] = {
  choices: async () => ({ ...choices }),
  choose: async (task, choice) => { choices[task] = choice },
  harnessOrder: async () => [...savedOrder],
  saveHarnessOrder: async (order) => { savedOrder = [...order] },
  settings: async () => ({ providers: utilityProviders, connections, issues, secureStorage: true }),
  load: async (provider) => (provider === connection.provider && connections.includes(connection) ? { ...connection, apiKey: "synthetic" } : null),
}
// A resolver reads the agents once per short window; each check starts fresh.
const fresh = () => new UtilityWork({ agents: async () => agents, runners: () => ["claude", "codex"], models })

const ready = async (task: UtilityTask, requested?: string) => {
  const resolved = await fresh().resolve(task, requested)
  assert.equal(resolved.kind, "ready", JSON.stringify(resolved))
  return resolved.kind === "ready" ? resolved.model : assert.fail()
}

agents = []
assert.equal((await fresh().resolve("commit")).kind, "unavailable", "nothing signed in and nothing connected drafts nothing")
assert.match((await fresh().settings()).commit.reason ?? "", /no signed-in harness offers a light model/)

agents = [codex, heavyOnly, claude]
let chosen = await ready("commit")
assert.equal(chosen.id, "agent:claude/claude-haiku-4-5-20251001", "Automatic follows Mako's order, not the order harnesses report in")
assert.equal(await chosen.complete({ instructions: "Name it", prompt: "work", maxOutputTokens: 100, reasoning: "low" }, AbortSignal.timeout(1_000)), "Named")
assert.deepEqual(calls.at(-1), { harness: "claude", model: "claude-haiku-4-5-20251001", options: { fast: false }, instructions: "Name it", prompt: "work", schema: undefined, signal: calls.at(-1)?.signal })

await fresh().saveHarnessOrder(["codex", "claude"])
chosen = await ready("commit")
assert.equal(chosen.id, "agent:codex/gpt-6-luna", "the person's order decides")
await chosen.complete({ instructions: "", prompt: "", maxOutputTokens: 100, reasoning: "low" }, AbortSignal.timeout(1_000))
assert.deepEqual(calls.at(-1)?.options, { effort: "low", serviceTier: "default" }, "light runs are at low reasoning on the standard lane")
await chosen.complete({ instructions: "", prompt: "", maxOutputTokens: 100, reasoning: "high" }, AbortSignal.timeout(1_000))
assert.deepEqual(calls.at(-1)?.options, { effort: "high", serviceTier: "default" }, "a deep commit draft raises the reasoning level")

const settings = await fresh().settings()
assert.deepEqual(settings.harnessOrder, ["codex", "claude"])
assert.deepEqual(settings.runners, ["claude", "codex"])
assert.deepEqual(settings.commit.resolved, { id: "agent:codex/gpt-6-luna", label: "GPT-6 Luna", via: "Codex", kind: "agent", source: "codex", light: true })
assert.deepEqual(settings.commit.options.map((option) => option.id), [
  "agent:codex/gpt-6-luna",
  "agent:codex/gpt-6.1-sol",
  "agent:codex/gpt-6-astra",
  "agent:claude/claude-haiku-4-5-20251001",
  "agent:claude/claude-opus-5-5",
  "agent:claude/claude-fable-5-1",
  "agent:devin/adaptive",
], "each harness's light model first, then its others, in the person's order")
savedOrder = []

// A model chosen by hand still runs light.
await fresh().choose("commit", "agent:claude/claude-opus-5-5")
chosen = await ready("commit")
await chosen.complete({ instructions: "", prompt: "", maxOutputTokens: 100, reasoning: "low" }, AbortSignal.timeout(1_000))
assert.deepEqual(calls.at(-1)?.options, { effort: "low", fast: false }, "a hand-picked model runs at its lowest level with the fast lane off")
choices.commit = "auto"

connections = [connection]
chosen = await ready("commit")
assert.equal(chosen.id, "agent:claude/claude-haiku-4-5-20251001", "Automatic prefers a signed-in harness over a connection")
chosen = await ready("commit", "google/gemini-flash")
assert.equal(chosen.id, "google/gemini-flash", "a window's own pick runs that model")
assert.equal(chosen.contextTokens, 1_000_000)

agents = [heavyOnly]
assert.equal((await ready("commit")).id, "google/gemini-flash", "a harness with no light model is passed over for the connection")
agents = []
chosen = await ready("commit")
assert.equal(chosen.id, "google/gemini-flash", "with no harness, Automatic takes the first connection")
issues = [{ provider: "google", message: "locked" }]
assert.equal((await fresh().resolve("commit")).kind, "unavailable", "a connection the host can't open is skipped")
issues = []

// A chosen model is used only while it's there; nothing stands in for it.
agents = [codex, claude]
await fresh().choose("commit", "agent:claude/claude-haiku-4-5-20251001")
assert.equal(choices.commit, "agent:claude/claude-haiku-4-5-20251001")
agents = [codex]
const lost = await fresh().resolve("commit")
assert.equal(lost.kind, "unavailable", "a harness that signed out leaves its task unavailable, never switched")
assert.match(lost.kind === "unavailable" ? lost.reason : "", /claude-haiku-4-5-20251001 isn't available: its harness isn't signed in/)
const lostSettings = await fresh().settings()
assert.equal(lostSettings.commit.resolved, undefined)
await assert.rejects(fresh().choose("commit", "agent:claude/claude-haiku-4-5-20251001"), /isn't available now/, "only a model listed now can be chosen")
await assert.rejects(fresh().choose("commit", "off"), /isn't available now/, "commit messages can't be off")
choices.commit = "auto"

// Schema replies are checked to be JSON before drafting reads them.
const broken = agent("claude", "Claude Code", claudeModels)
broken.runner.complete = async () => "not json"
agents = [broken]
await assert.rejects(
  (await ready("commit")).complete({ instructions: "", prompt: "", schema: { type: "object" }, maxOutputTokens: 10, reasoning: "low" }, AbortSignal.timeout(1_000)),
  /other than the JSON asked for/
)

// The store keeps the choices and the harness order, drops the title choice
// older builds saved, and gives a disconnected provider's tasks back to Automatic.
const root = await mkdtemp(join(tmpdir(), "mako-utility-work-"))
try {
  const encryption = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString("utf8") }
  const store = new UtilityModelStore(root, encryption)
  assert.deepEqual(await store.choices(), { commit: "auto" }, "Automatic by default")
  assert.deepEqual(await store.harnessOrder(), [], "Mako's order until the person reorders")
  await writeFile(join(root, "utility-work.json"), JSON.stringify({ title: "off", commit: "auto" }))
  assert.deepEqual(await store.choices(), { commit: "auto" }, "an older build's title choice is ignored")
  await Promise.all([store.choose("commit", "google/gemini-flash"), store.saveHarnessOrder(["codex", "claude", "codex"])])
  assert.deepEqual(JSON.parse(await readFile(join(root, "utility-work.json"), "utf8")), { commit: "google/gemini-flash", order: ["codex", "claude"] }, "two changes at once both land, repeats are dropped, and the title choice goes")
  await assert.rejects(store.saveHarnessOrder(["../codex"]), "an order holds harness ids only")
  await store.disconnect("google")
  assert.deepEqual(await store.choices(), { commit: "auto" })
  assert.deepEqual(await store.harnessOrder(), ["codex", "claude"], "disconnecting a model leaves the order alone")
  await store.saveHarnessOrder([])
  assert.deepEqual(await store.harnessOrder(), [], "an empty order goes back to Mako's")
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("Utility work: one harness order, Mako's work and light defaults per harness, light runs at low reasoning without the fast lane, Automatic (harnesses, then connections), a window's pick, chosen models never replaced, JSON replies, stored choices and order passed")
