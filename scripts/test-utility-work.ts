import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionModel } from "@mako/sessions/settings"
import { agentOrder, harnessesByRecency } from "../electron/contracts/agent-order.ts"
import type { UtilityConnection, UtilityModelSettings } from "../electron/contracts/utility-models.ts"
import type { UtilityTask, UtilityWorkChoices } from "../electron/contracts/utility-work.ts"
import { lightModel, type UtilityCompletion } from "../electron/providers/utility-runner.ts"
import { UtilityModelStore } from "../electron/utility-model-store.ts"
import { utilityProviders } from "../electron/utility-models.ts"
import { UtilityWork, type UtilityAgent } from "../electron/utility-work.ts"

// One agent order for every task: the composer's pick when signed in, then
// the most recently used signed-in harness, then each harness's priority.
const priority = { claude: 0, codex: 1, cursor: 2 }
assert.deepEqual(agentOrder({ signedIn: ["codex", "claude"], priority }), ["claude", "codex"])
assert.deepEqual(agentOrder({ signedIn: ["codex", "claude"], priority, recent: ["cursor", "codex"] }), ["codex", "claude"], "a recent harness that isn't signed in is skipped")
assert.deepEqual(agentOrder({ signedIn: ["codex", "claude"], priority, recent: ["codex"], picked: "claude" }), ["claude", "codex"])
assert.deepEqual(agentOrder({ signedIn: ["codex"], priority, picked: "claude" }), ["codex"], "a pick that isn't signed in is no choice")
assert.deepEqual(harnessesByRecency([
  { harness: "claude", updatedAt: "2026-10-01T00:00:00Z" },
  { harness: "codex", updatedAt: "2026-10-03T00:00:00Z" },
  { harness: "claude", updatedAt: "2026-10-02T00:00:00Z" },
  { harness: "cursor" },
]), ["codex", "claude", "cursor"])

// The light model is the one the catalog itself calls fast or cheap, in
// catalog order, skipping models it calls older.
const model = (id: string, label: string, description?: string): SessionModel => ({ id, label, description, options: [] })
assert.equal(lightModel([model("big", "Big", "Most capable"), model("luna", "Luna", "Fast and affordable")])?.id, "luna")
assert.equal(lightModel([model("old-mini", "Old mini", "Fast. Older model"), model("lite", "Lite")])?.id, "lite")
assert.equal(lightModel([model("big", "Big", "Most capable")]), undefined, "a catalog that offers no light model offers none")

const calls: Array<UtilityCompletion & { harness: string }> = []
const agent = (harness: string, label: string, models: SessionModel[]): UtilityAgent => ({
  harness,
  label,
  models,
  runner: {
    provider: harness,
    light: lightModel,
    complete: async (request) => {
      calls.push({ ...request, harness })
      return request.schema ? JSON.stringify({ title: "Named" }) : "Named"
    },
  },
})
const claude = agent("claude", "Claude Code", [model("opus", "Opus", "Most capable"), model("haiku", "Haiku", "Fastest model for quick answers")])
const codex = agent("codex", "Codex", [model("big", "GPT big", "Frontier"), model("luna", "GPT Luna", "Fast and affordable")])
const heavyOnly = agent("cursor", "Cursor", [model("auto", "Auto")])

const connection: UtilityConnection = { provider: "google", model: "gemini-flash", contextTokens: 1_000_000 }
let agents: UtilityAgent[] = []
let connections: UtilityConnection[] = []
let issues: UtilityModelSettings["issues"] = []
const choices: UtilityWorkChoices = { title: "auto", commit: "auto" }
const models: ConstructorParameters<typeof UtilityWork>[0]["models"] = {
  choices: async () => ({ ...choices }),
  choose: async (task, choice) => { choices[task] = choice },
  settings: async () => ({ providers: utilityProviders, connections, issues, secureStorage: true }),
  load: async (provider) => (provider === connection.provider && connections.includes(connection) ? { ...connection, apiKey: "synthetic" } : null),
}
// A resolver reads the agents once per short window; each check starts fresh.
const fresh = () => new UtilityWork({ agents: async () => agents, models })

const ready = async (task: UtilityTask, requested?: string) => {
  const resolved = await fresh().resolve(task, requested)
  assert.equal(resolved.kind, "ready", JSON.stringify(resolved))
  return resolved.kind === "ready" ? resolved.model : assert.fail()
}

agents = []
assert.equal((await fresh().resolve("title")).kind, "unavailable", "nothing signed in and nothing connected names nothing")
assert.match((await fresh().settings()).commit.reason ?? "", /no signed-in agent app offers a light model/)

agents = [heavyOnly, codex, claude]
let chosen = await ready("title")
assert.equal(chosen.id, "agent:codex/luna", "Automatic skips an agent with no light model and takes the next one's light model")
assert.equal(chosen.label, "GPT Luna")
assert.equal(chosen.via, "Codex")
assert.equal(await chosen.complete({ instructions: "Name it", prompt: "work", maxOutputTokens: 100, reasoning: "low" }, AbortSignal.timeout(1_000)), "Named")
assert.deepEqual(calls.at(-1), { harness: "codex", model: "luna", instructions: "Name it", prompt: "work", schema: undefined, reasoning: "low", signal: calls.at(-1)?.signal })

const settings = await fresh().settings()
assert.deepEqual(settings.title.resolved, { id: "agent:codex/luna", label: "GPT Luna", via: "Codex", kind: "agent", source: "codex", light: true })
assert.deepEqual(settings.title.options.map((option) => option.id), [
  "agent:cursor/auto",
  "agent:codex/luna",
  "agent:codex/big",
  "agent:claude/haiku",
  "agent:claude/opus",
], "each agent's light model is listed first, then its others, in agent order")

connections = [connection]
chosen = await ready("commit")
assert.equal(chosen.id, "agent:codex/luna", "Automatic prefers a signed-in agent over a connection")
chosen = await ready("commit", "google/gemini-flash")
assert.equal(chosen.id, "google/gemini-flash", "a window's own pick runs that model")
assert.equal(chosen.contextTokens, 1_000_000)

agents = []
chosen = await ready("commit")
assert.equal(chosen.id, "google/gemini-flash", "with no agent, Automatic takes the first connection")
issues = [{ provider: "google", message: "locked" }]
assert.equal((await fresh().resolve("commit")).kind, "unavailable", "a connection the host can't open is skipped")
issues = []

// A chosen model is used only while it's there; nothing stands in for it.
agents = [codex, claude]
await fresh().choose("title", "agent:claude/haiku")
assert.equal(choices.title, "agent:claude/haiku")
assert.equal((await ready("title")).id, "agent:claude/haiku")
agents = [codex]
const lost = await fresh().resolve("title")
assert.equal(lost.kind, "unavailable", "an agent that signed out leaves its task unavailable, never switched")
assert.match(lost.kind === "unavailable" ? lost.reason : "", /haiku isn't available/)
const lostSettings = await fresh().settings()
assert.equal(lostSettings.title.choice, "agent:claude/haiku")
assert.equal(lostSettings.title.resolved, undefined)
await assert.rejects(fresh().choose("commit", "agent:claude/haiku"), /isn't available now/, "only a model listed now can be chosen")

await fresh().choose("title", "off")
assert.deepEqual(await fresh().resolve("title"), { kind: "off" })
assert.equal((await ready("commit")).id, "agent:codex/luna", "commit messages can't be off")

// Schema replies are checked to be JSON before Kiri reads them.
const broken = agent("claude", "Claude Code", [model("haiku", "Haiku", "Fastest")])
broken.runner.complete = async () => "not json"
agents = [broken]
await assert.rejects(
  (await ready("commit")).complete({ instructions: "", prompt: "", schema: { type: "object" }, maxOutputTokens: 10, reasoning: "low" }, AbortSignal.timeout(1_000)),
  /other than the JSON asked for/
)

// The store keeps the choices, moves the old title model over, and gives a
// disconnected provider's tasks back to Automatic.
const root = await mkdtemp(join(tmpdir(), "mako-utility-work-"))
try {
  const encryption = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString("utf8") }
  const store = new UtilityModelStore(root, encryption)
  assert.deepEqual(await store.choices(), { title: "auto", commit: "auto" }, "titles are on by default")
  await writeFile(join(root, "thread-titles.json"), JSON.stringify({ model: "google/gemini-flash" }))
  assert.deepEqual(await store.choices(), { title: "google/gemini-flash", commit: "auto" }, "the model chosen before keeps naming Threads")
  await store.choose("commit", "google/gemini-flash")
  assert.deepEqual(JSON.parse(await readFile(join(root, "utility-work.json"), "utf8")), { title: "google/gemini-flash", commit: "google/gemini-flash" })
  await assert.rejects(readFile(join(root, "thread-titles.json")), /ENOENT/, "the old file goes once its choice is moved")
  await assert.rejects(store.choose("commit", "off"), /can't be turned off/)
  await store.disconnect("google")
  assert.deepEqual(await store.choices(), { title: "auto", commit: "auto" })
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("Utility work: one agent order, catalog light models, Automatic (agents, then connections), a window's pick, chosen models never replaced, Off for titles only, JSON replies, stored choices and the old title model passed")
