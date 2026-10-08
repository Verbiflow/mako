import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotIcon } from "lucide-react"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { z } from "zod"
import { harnessOrder, workDefault } from "../electron/contracts/harness-defaults.ts"
import { installClaude } from "../electron/providers/claude/index.ts"
import { installHarness, lacks, type HarnessDefinition } from "../electron/providers/harness-definition.ts"
import { byDefault, harnessLacks, implemented } from "../electron/providers/live-capabilities.ts"
import { describeHarnesses, harnessLabel } from "../electron/providers/harness-descriptors.ts"
import { createProviderHost } from "../electron/providers/host.ts"
import { providerHost } from "../electron/providers/index.ts"
import { usageHarnesses, usageSummary } from "../electron/usage.ts"
import { sectionKeywords, type SettingsSection } from "../src/components/settings/sections/manifest.ts"
import { HarnessIcon, ProviderIcon } from "../src/components/ui/provider-icon.tsx"
import { threadsStore } from "../src/state/thread-store.ts"
import { renderHarnessDescriptors } from "./harness-descriptors.ts"

const FlowsReport = z.object({ results: z.array(z.object({ flow: z.string(), result: z.string(), reason: z.string().optional() })) })

/**
 * A new harness is one definition. This installs a seventh through
 * `installHarness` alone, editing nothing else, and checks it reaches every
 * place a harness appears: its name, mark, defaults and order, Settings
 * search, the usage table and the dev snapshot.
 */

const codexLive = providerHost.liveDrivers.get("codex")
const codexProfile = providerHost.profiles.get("codex")
assert.ok(codexLive && codexProfile)
const mark = {
  viewBox: "0 0 16 16",
  paths: [{ d: "M0 0h16v16H0zM4 4v8h8V4z", fillRule: "evenodd" as const }],
  tint: "#2F6F4E",
  gradient: [{ offset: 0, color: "#2F6F4E" }, { offset: 1, color: "#9BD3B5" }],
}
const defaults = { work: [{ model: "seven-large", options: { effort: "high" } }] }
const seventh: HarnessDefinition = {
  provider: "seventh",
  presentation: { mark },
  diagnostics: {},
  usage: {
    context: implemented("Seven's own context reading."),
    window: implemented("The window in the same reading."),
    compaction: byDefault("Seven doesn't say what a compaction left."),
    tokens: implemented("Each turn's tokens."),
    cost: harnessLacks("Seven reports no cost."),
    missedCalls: harnessLacks("Seven never says it left a call out."),
    resetCredits: harnessLacks("Seven has no reset credits."),
  },
  hooks: lacks("synthetic"),
  commands: lacks("synthetic"),
  toolEditing: lacks("synthetic"),
  skillEditing: lacks("synthetic"),
  mcpEditing: lacks("synthetic"),
  live: { ...codexLive, provider: "seventh", contextBreakdown: { kind: "not-built", reason: "Seven itemizes its context; Mako does not read it yet" } },
  decoder: lacks("synthetic"),
  profile: { ...codexProfile, provider: "seventh", label: "Seventh Agent", defaults },
  accounts: lacks("synthetic"),
  acp: lacks("synthetic"),
  nativeRunner: lacks("synthetic"),
  processProbe: lacks("synthetic"),
  mcp: lacks("synthetic"),
  skills: lacks("synthetic"),
  sessionEmitter: lacks("synthetic"),
  connection: lacks("synthetic"),
  updates: lacks("synthetic"),
  usageHistory: lacks("Its store keeps no token counts"),
  artifactPreview: lacks("synthetic"),
}

const host = createProviderHost()
installClaude(host)
installHarness(host, seventh)

// Its name, wherever Mako shows one: transcripts and the usage table.
assert.deepEqual(host.harnesses.list().map(({ provider }) => [provider, harnessLabel(host, provider)]), [["claude", "Claude Code"], ["seventh", "Seventh Agent"]])
assert.equal(host.harnesses.get("seventh")?.absent.usageHistory?.reason, "Its store keeps no token counts")
// Where it stands on each live capability: what it declared, and what its driver says.
const capabilities = host.harnesses.get("seventh")!.capabilities
assert.deepEqual(capabilities.contextBreakdown, { state: "absent", by: "mako", reason: "Seven itemizes its context; Mako does not read it yet" })
assert.equal(capabilities.compaction.state, "implemented", "compaction is read from the driver's own declaration")
assert.equal(capabilities.residency.state, "implemented")
// What it reports about usage: its declaration, with the breakdown and the spend outside Mako in the words of the families that implement them.
const reported = host.harnesses.get("seventh")!.usage
assert.deepEqual(reported.cost, { state: "absent", by: "harness", reason: "Seven reports no cost." })
assert.deepEqual(reported.contextBreakdown, capabilities.contextBreakdown)
assert.deepEqual(reported.outsideMako, { state: "absent", by: "harness", reason: "Its store keeps no token counts, so only its sessions in Mako are counted." })
assert.throws(() => installHarness(createProviderHost(), { ...seventh, usage: { ...seventh.usage, window: harnessLacks("no window") } }), /context fill without its window/)
assert.throws(() => installHarness(createProviderHost(), { ...seventh, usage: { ...seventh.usage, resetCredits: implemented("credits") } }), /reset credits its accounts can't spend/)
assert.throws(() => installHarness(createProviderHost(), { ...seventh, usage: { ...seventh.usage, cost: byDefault("later") } }), /only after compaction/)
assert.throws(() => installHarness(createProviderHost(), { ...seventh, profile: { ...seventh.profile, defaults: { work: [] } } }), /picks no model for new conversations and doesn't say why/)

// Mako's order is the order harnesses install in; a new one follows the rest.
const installed = host.harnesses.list().map(({ provider }) => provider)
assert.deepEqual(harnessOrder(undefined, installed), ["claude", "seventh"])
assert.deepEqual(harnessOrder(["seventh"], installed), ["seventh", "claude"])

// What the renderer is told: its mark and defaults travel with it.
const described = describeHarnesses(host, { live: () => true, resumable: new Set() }).find(({ provider }) => provider === "seventh")
assert.ok(described)
assert.equal(described.displayName, "Seventh Agent")
assert.deepEqual(described.presentation, { mark })
assert.deepEqual(described.defaults, defaults)
assert.deepEqual(described.usage, reported, "the window reads the same usage declaration")
assert.equal(described.live, true)
const catalog = [{ id: "seven-large", label: "Seven Large", options: [{ id: "effort", label: "Effort", role: "reasoning" as const, kind: "select" as const, values: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] }] }]
assert.deepEqual(workDefault(described.defaults, catalog), { model: "seven-large", options: { effort: "high" } })

// The renderer draws its mark from data and finds it in Settings search.
threadsStore.set({ descriptors: [described] })
const icon = renderToStaticMarkup(createElement(HarnessIcon, { harness: "seventh" }))
assert.match(icon, /viewBox="0 0 16 16"/)
assert.match(icon, /d="M0 0h16v16H0zM4 4v8h8V4z"/)
assert.match(icon, /fill-rule="evenodd"/)
assert.match(icon, /stop-color="#9BD3B5"/)
assert.match(renderToStaticMarkup(createElement(ProviderIcon, { provider: "seventh" })), /M0 0h16v16H0z/, "a model the harness serves itself wears its mark")
const agents: SettingsSection = { id: "agents", title: "Agents", group: "Providers", icon: BotIcon, keywords: ["login"], perHarness: true, Component: () => null }
assert.ok(sectionKeywords(agents, [described]).includes("Seventh Agent"))
assert.ok(!sectionKeywords({ ...agents, perHarness: undefined }, [described]).includes("Seventh Agent"))

// Without a usage history of its own, Mako's measurements are its record, under its name.
const usage = usageHarnesses(host).find(({ provider }) => provider === "seventh")
assert.deepEqual(usage && { label: usage.label, history: usage.history }, { label: "Seventh Agent", history: undefined })
const root = await mkdtemp(join(tmpdir(), "mako-seventh-"))
try {
  const summary = await usageSummary(usageHarnesses(host), join(root, "sessions"), join(root, "home"), join(root, "conversations"))
  assert.equal(summary.sessions, 0)
} finally {
  await rm(root, { recursive: true, force: true })
}

// The dev snapshot the mock and the harness-name lint read.
const snapshot = renderHarnessDescriptors(host)
assert.match(snapshot, /"provider": "seventh"/)
assert.match(snapshot, /"displayName": "Seventh Agent"/)

console.log("Seventh harness: one definition reaches its name, mark, defaults, order, Settings search, usage and the dev snapshot")

// The session flows, against a seventh definition whose ACP agent is scripted
// (`fixtures/stand-in-harness.mjs`): each flow it declares passes, and each
// other one is skipped with the reason its definition gives.
const flows = spawnSync(process.execPath, ["scripts/test-session-flows.mjs", "--stand-in"], { encoding: "utf8", timeout: 5 * 60_000 })
const flowsRoot = /^Session flows: (.+)$/m.exec(flows.stdout)?.[1]
try {
  assert.equal(flows.status, 0, `${flows.stdout}\n${flows.stderr}`)
  assert.ok(flowsRoot)
  const report = FlowsReport.parse(JSON.parse(await readFile(join(flowsRoot, "report.json"), "utf8")))
  assert.deepEqual(Object.fromEntries(report.results.map(({ flow, result, reason }) => [flow, result === "skipped" ? `skipped: ${reason}` : result])), {
    "first-turn": "passed",
    "follow-up": "passed",
    restart: "passed",
    question: "skipped: questions absent (harness has none): The stand-in agent asks no questions.",
    plan: "passed",
    steer: "passed",
    "steered-fork": "skipped: the harness does not fork natively",
    interrupt: "passed",
    "killed-turn": "passed",
    fork: "passed",
    import: "passed",
    compaction: "skipped: compaction absent (harness has none): The stand-in agent never compacts.",
    image: "passed",
    subagent: "skipped: nativeAgents absent (harness has none): The stand-in agent starts no subagents.",
    "universal-skill": "skipped: its skill source doesn't claim .agents/skills",
    "native-transcript": "skipped: only the Cursor SDK writes a transcript Mako's patch appends to",
  })
} finally {
  if (flowsRoot) await rm(flowsRoot, { recursive: true, force: true })
}

console.log("Seventh harness: the session flows run against a stand-in agent, passing what it declares and skipping the rest with its reasons")
