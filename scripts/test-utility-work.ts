import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelOption, SessionModel } from "@mako/sessions/settings"
import { agentOrder, harnessesByRecency } from "../electron/contracts/agent-order.ts"
import { harnessOrder, isDefaultOrder, workDefault } from "../electron/contracts/harness-defaults.ts"
import type { UtilityConnection, UtilityModelSettings } from "../electron/contracts/utility-models.ts"
import type { UtilityWorkChoices } from "../electron/contracts/utility-work.ts"
import { providerHost } from "../electron/providers/index.ts"
import { UtilityModelStore } from "../electron/utility-model-store.ts"
import { memorySecrets } from "../electron/secrets.ts"
import { parseConnection, utilityProviders } from "../electron/utility-models.ts"
import { UtilityWork } from "../electron/utility-work.ts"

// One harness order for setup: the person's, then Mako's, which is the order harnesses install in.
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
const model = (id: string, label: string, options: ModelOption[] = []): SessionModel => ({ id, label, options })
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
const openCodeModels = [
  model("openai/gpt-6.1-sol", "GPT-6.1 Sol", [effort(levels)]),
  model("opencode/muse-spark-1.3-contributor-free", "Muse Spark 1.3 Free", [effort(["minimal", "low", "medium", "high", "xhigh"])]),
]
assert.equal(workDefault(defaults("opencode"), openCodeModels), undefined, "OpenCode keeps its own default, the free model it changes itself")

// Commit messages run on API connections only.
const google = parseConnection({ provider: "google", model: "gemini-flash", contextTokens: 1_000_000 })
const openai = parseConnection({ provider: "openai", model: "gpt-mini", contextTokens: 400_000 })
let connections: UtilityConnection[] = []
let issues: UtilityModelSettings["issues"] = []
const choices: UtilityWorkChoices = { commit: "auto" }
const work = new UtilityWork({
  models: {
    choices: async () => ({ ...choices }),
    choose: async (task, choice) => { choices[task] = choice },
    settings: async () => ({ providers: utilityProviders, connections, issues, secureStorage: true }),
    load: async (provider) => {
      const found = connections.find((connection) => connection.provider === provider)
      return found ? { ...found, baseUrl: found.baseUrl, apiKey: "synthetic" } : null
    },
  },
})

assert.equal((await work.resolve("commit")).kind, "unavailable", "no key drafts nothing")
assert.match((await work.settings()).commit.reason ?? "", /Connect an API key in Settings › Git/)
assert.deepEqual((await work.settings()).commit.options, [], "no harness is ever offered")

connections = [google, openai]
let resolved = await work.resolve("commit")
assert.equal(resolved.kind === "ready" ? resolved.model.id : resolved.reason, "google/gemini-flash", "Automatic takes the first connection")
assert.equal(resolved.kind === "ready" ? resolved.model.contextTokens : 0, 1_000_000)
let settings = await work.settings()
assert.deepEqual(settings.commit.options, [
  { id: "google/gemini-flash", label: "gemini-flash", via: "Google", source: "google" },
  { id: "openai/gpt-mini", label: "gpt-mini", via: "OpenAI", source: "openai" },
])
assert.deepEqual(settings.commit.resolved?.id, "google/gemini-flash")

await work.choose("commit", "openai/gpt-mini")
resolved = await work.resolve("commit")
assert.equal(resolved.kind === "ready" ? resolved.model.id : resolved.reason, "openai/gpt-mini", "a chosen key is used")
resolved = await work.resolve("commit", "google/gemini-flash")
assert.equal(resolved.kind === "ready" ? resolved.model.id : resolved.reason, "google/gemini-flash", "a window's own pick runs that key")

// A chosen key is used only while it's there; nothing stands in for it.
connections = [google]
const lost = await work.resolve("commit")
assert.equal(lost.kind, "unavailable", "a removed key leaves its task unavailable, never switched")
assert.match(lost.kind === "unavailable" ? lost.reason : "", /openai\/gpt-mini is no longer connected/)
settings = await work.settings()
assert.equal(settings.commit.resolved, undefined)
await assert.rejects(work.choose("commit", "openai/gpt-mini"), /isn't connected now/, "only a key connected now can be chosen")
await assert.rejects(work.choose("commit", "agent:claude/claude-haiku-4-5"), /isn't connected now/, "a harness's model can't be chosen")
choices.commit = "auto"

issues = [{ provider: "google", message: "locked" }]
assert.equal((await work.resolve("commit")).kind, "unavailable", "a connection the host can't open is skipped")
issues = []

// The store keeps the choices and the harness order, drops what older builds
// saved that no longer exists, and gives a disconnected provider's tasks back
// to Automatic.
const root = await mkdtemp(join(tmpdir(), "mako-utility-work-"))
try {
  const store = new UtilityModelStore(root, memorySecrets())
  assert.deepEqual(await store.choices(), { commit: "auto" }, "Automatic by default")
  assert.deepEqual(await store.harnessOrder(), [], "Mako's order until the person reorders")
  await writeFile(join(root, "utility-work.json"), JSON.stringify({ title: "off", commit: "auto" }))
  assert.deepEqual(await store.choices(), { commit: "auto" }, "an older build's title choice is ignored")
  await writeFile(join(root, "utility-work.json"), JSON.stringify({ commit: "agent:claude/claude-haiku-4-5", order: ["codex"] }))
  assert.deepEqual(await store.choices(), { commit: "auto" }, "an older build's harness choice reads as Automatic")
  assert.deepEqual(await store.harnessOrder(), ["codex"], "and its harness order stays")
  await store.saveHarnessOrder([])
  await Promise.all([store.choose("commit", "google/gemini-flash"), store.saveHarnessOrder(["codex", "claude", "codex"])])
  assert.deepEqual(JSON.parse(await readFile(join(root, "utility-work.json"), "utf8")), { commit: "google/gemini-flash", order: ["codex", "claude"] }, "two changes at once both land, and repeats are dropped")
  await assert.rejects(store.saveHarnessOrder(["../codex"]), "an order holds harness ids only")
  await store.disconnect("google")
  assert.deepEqual(await store.choices(), { commit: "auto" })
  assert.deepEqual(await store.harnessOrder(), ["codex", "claude"], "disconnecting a model leaves the order alone")
  await store.saveHarnessOrder([])
  assert.deepEqual(await store.harnessOrder(), [], "an empty order goes back to Mako's")
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("Utility work: one harness order and Mako's work defaults per harness; commit messages on API connections only (Automatic is the first, a window's pick, chosen keys never replaced, harness models refused); stored choices, an older build's harness choice read as Automatic, and the order passed")
