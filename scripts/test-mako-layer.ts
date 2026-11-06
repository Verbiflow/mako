import assert from "node:assert/strict"
import { NATIVE_CAPABILITIES, TOOL_FAMILIES, replacementPath, type LayerCapabilities } from "@mako/host/contracts/mako-layer"
import { nativeSpawnsOff, type RoutedThread } from "@mako/host/contracts/native-routing"
import { conversationServers, launchInstructions, type ConversationTools } from "@mako/host/harnesses/live-driver"
import { layerOf } from "@mako/host/harnesses/mako-layer"
import { claudeLayer, type ClaudeLayerFragment } from "@mako/host/harnesses/claude/layer"
import { codexLayer } from "@mako/host/harnesses/codex/layer"
import { cursorLayer, type CursorLayerFragment } from "@mako/host/harnesses/cursor/layer"
import { opencodeLayer } from "@mako/host/harnesses/opencode/layer"
import { acpLayer } from "@mako/host/harnesses/acp-layer"
import { GROK_LAYER } from "@mako/host/harnesses/grok/layer"
import { DEVIN_LAYER } from "@mako/host/harnesses/devin/layer"
import { MAKO_TOOL_TIMEOUT_MS } from "@mako/host/tools/index"

/**
 * Servers and switches are what each driver built before the layer.
 * Instructions are the primer blocks (`launchInstructions`), which an
 * Apex's role changes. Compared as JSON so key order counts too.
 */
const same = <Value>(actual: Value, expected: Value, what: string) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), what)

const grants: Array<ConversationTools | undefined> = [
  undefined,
  { token: "grant-a", computerUrl: "http://127.0.0.1:1/computer" },
  { token: "grant-b", computerUrl: "http://127.0.0.1:1/computer", makoUrl: "http://127.0.0.1:1/mako" },
]
const routings: Array<(() => RoutedThread) | undefined> = [undefined, () => ({ role: "thread" }), () => ({ role: "apex" })]
const acpRoutings = [
  { kind: "at-launch", via: "a switch", verified: { version: "1", how: "fixture" } },
  { kind: "words", reason: "fixture" },
] as const

let cases = 0
for (const tools of grants) for (const routing of routings) {
  const options = { conversationTools: tools, nativeRouting: routing }
  const servers = tools ? conversationServers(tools) : []
  const off = routing ? nativeSpawnsOff(routing()) : false
  const bearer = tools ? `Bearer ${tools.token}` : ""

  const claude = claudeLayer.apply(layerOf(options), "c")
  const claudeServers: ClaudeLayerFragment["servers"] = {}
  for (const { name, url } of servers) claudeServers[name] = { type: "http", url, headers: { Authorization: bearer }, timeout: MAKO_TOOL_TIMEOUT_MS }
  same(claude.servers, claudeServers, "claude servers")
  same(claude.append, launchInstructions(options), "claude append")
  for (const requested of [undefined, true, false])
    same(claude.agentTeams(requested), requested === undefined ? undefined : requested && routing?.().role !== "apex" ? "1" : "0", "claude agent teams")

  const codex = codexLayer.apply(layerOf(options), "c")
  same(codex.servers, servers, "codex servers")
  same(codex.instructions, launchInstructions(options), "codex instructions")
  same(codex.config(), off ? { "agents.enabled": false, "features.multi_agent_v2": false } : {}, "codex config")

  const cursor = cursorLayer.apply(layerOf(options), "c")
  const cursorServers: CursorLayerFragment["servers"] = {}
  for (const { name, url } of servers) cursorServers[name] = { type: "http", url, headers: { Authorization: bearer } }
  same(cursor.servers, cursorServers, "cursor servers")
  same(cursor.noTask(), off || undefined, "cursor noTask")

  const opencode = opencodeLayer.apply(layerOf(options), "c")
  same(opencode.servers, servers.map(({ name, url }) => ({ name, config: { type: "remote", url, headers: { Authorization: bearer }, oauth: false } })), "opencode servers")
  same(opencode.spawnsDenied(), off, "opencode spawns")

  for (const nativeRouting of acpRoutings) {
    const acp = acpLayer("acp", GROK_LAYER, nativeRouting).apply(layerOf(options), "c")
    same(acp.servers, servers.map(({ name, url }) => ({ type: "http", name, url, headers: [{ name: "Authorization", value: bearer }] })), "acp servers")
    same(acp.spawnsOff(), nativeRouting.kind !== "words" && off, "acp spawns")
  }
  cases += 1
}

// The contract's rules, on every harness's declaration.
const declared: Array<{ harness: string; capabilities: LayerCapabilities }> = [
  claudeLayer, codexLayer, cursorLayer, opencodeLayer,
  { harness: "grok", capabilities: GROK_LAYER },
  { harness: "devin", capabilities: DEVIN_LAYER },
]
for (const { harness, capabilities } of declared) {
  assert.equal(capabilities.personSetup, "kept", `${harness} keeps the person's setup`)
  const { instructions, toolServing, removal, interception, subagents, hooks } = capabilities
  for (const [name, support] of Object.entries({ instructions, toolServing, removal, interception, subagents, hooks }))
    assert.ok(support.kind === "native" ? support.how.length > 0 : support.kind === "fallback" ? support.loses.length > 0 : support.reason.length > 0, `${harness} says how it stands on ${name}`)
}
assert.deepEqual(declared.map(({ capabilities }) => replacementPath(capabilities, "remove")), ["removal", "removal", "removal", "removal", "removal", "removal"])
assert.deepEqual(declared.map(({ capabilities }) => replacementPath(capabilities, "guide")), ["guide", "guide", "guide", "guide", "guide", "guide"])

// Every native capability Mako replaces names a family Mako serves.
for (const [native, { by }] of Object.entries(NATIVE_CAPABILITIES)) assert.ok(by in TOOL_FAMILIES, `${native} is replaced by a family`)
const families = layerOf({ conversationTools: grants[2] }).servers.flatMap((server) => server.families)
assert.deepEqual([...families].sort(), Object.keys(TOOL_FAMILIES).sort(), "the two servers serve every family")

console.log(`mako layer: ok (${cases} launches on every adapter)`)
