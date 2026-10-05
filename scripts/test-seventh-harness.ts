import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotIcon } from "lucide-react"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { harnessOrder, workDefault } from "../electron/contracts/harness-defaults.ts"
import { installClaude } from "../electron/providers/claude/index.ts"
import { installHarness, lacks, type HarnessDefinition } from "../electron/providers/harness-definition.ts"
import { describeHarnesses, harnessLabel } from "../electron/providers/harness-descriptors.ts"
import { createProviderHost } from "../electron/providers/host.ts"
import { providerHost } from "../electron/providers/index.ts"
import { usageHarnesses, usageSummary } from "../electron/usage.ts"
import { sectionKeywords, type SettingsSection } from "../src/components/settings/sections/manifest.ts"
import { HarnessIcon, ProviderIcon } from "../src/components/ui/provider-icon.tsx"
import { threadsStore } from "../src/state/thread-store.ts"
import { renderHarnessDescriptors } from "./harness-descriptors.ts"

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
  hooks: lacks("synthetic"),
  commands: lacks("synthetic"),
  toolEditing: lacks("synthetic"),
  skillEditing: lacks("synthetic"),
  mcpEditing: lacks("synthetic"),
  live: { ...codexLive, provider: "seventh" },
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
