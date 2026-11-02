import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { VOCABULARIES } from "@mako/sessions/harnesses"
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import type { JsonObject } from "@mako/host/contracts/json"
import { AFTER_START } from "@mako/host/contracts/agent-tools"
import { nativeSpawnsOff, routeNativeSpawn, routedMessage, type RoutedThread } from "@mako/host/contracts/native-routing"
import { CallBounds } from "@mako/host/harnesses/call-bounds"
import { claudeCallHooks } from "@mako/host/harnesses/claude/call-hooks"
import { CLAUDE_START_TOOL, ClaudeAgentInput, claudeRoutedCall, claudeSpawn } from "@mako/host/harnesses/claude/routing"
import { codexRoutingConfig } from "@mako/host/harnesses/codex/routing"
import { launchSpawnsOff, nativeRoutingReadings, type NativeRoutingSources } from "@mako/host/harnesses/native-routing"
import type { NativeRoutingCapability } from "@mako/host/contracts/native-routing"
import { configureOpenCodePermissions, configureOpenCodeRouting, OPENCODE_SPAWN_ACTION } from "@mako/host/harnesses/opencode/permissions"
import { prepareDevinMcp } from "@mako/host/harnesses/devin/session-mcp"
import { storedDefinitions } from "./native-tools.ts"

const HookDecision = z.object({ hookSpecificOutput: z.object({ permissionDecision: z.string().optional() }).loose().optional() }).loose()
const apex: RoutedThread = { role: "apex" }
const thread: RoutedThread = { role: "thread" }

/** 4.1's table, as Claude's `Agent` calls: who decides, what the call carries, and where it goes. */
const CLAUDE_CASES: { name: string; tool: string; input: JsonObject; teams?: boolean; apex: "allow" | "deny"; thread: "allow" | "deny" }[] = [
  { name: "a background agent, Claude's default", tool: "Agent", input: { subagent_type: "general-purpose", prompt: "p", description: "d" }, apex: "deny", thread: "allow" },
  { name: "a background agent, said outright", tool: "Agent", input: { subagent_type: "general-purpose", prompt: "p", description: "d", run_in_background: true }, apex: "deny", thread: "allow" },
  { name: "a foreground agent that isn't Explore", tool: "Agent", input: { subagent_type: "general-purpose", prompt: "p", description: "d", run_in_background: false }, apex: "deny", thread: "allow" },
  { name: "Explore in the turn", tool: "Agent", input: { subagent_type: "Explore", prompt: "p", description: "d", run_in_background: false }, apex: "allow", thread: "allow" },
  { name: "Explore in the background by default", tool: "Agent", input: { subagent_type: "Explore", prompt: "p", description: "d" }, apex: "deny", thread: "allow" },
  { name: "Explore in a worktree", tool: "Agent", input: { subagent_type: "Explore", prompt: "p", description: "d", run_in_background: false, isolation: "worktree" }, apex: "deny", thread: "deny" },
  { name: "an agent in a worktree", tool: "Agent", input: { subagent_type: "general-purpose", prompt: "p", description: "d", isolation: "worktree" }, apex: "deny", thread: "deny" },
  { name: "a remote agent", tool: "Agent", input: { subagent_type: "general-purpose", prompt: "p", description: "d", isolation: "remote" }, apex: "deny", thread: "deny" },
  { name: "a named agent with agent teams on: a teammate", tool: "Agent", input: { subagent_type: "general-purpose", prompt: "p", description: "d", name: "reviewer" }, teams: true, apex: "deny", thread: "deny" },
  { name: "a named agent with agent teams off", tool: "Agent", input: { subagent_type: "general-purpose", prompt: "p", description: "d", name: "reviewer" }, apex: "deny", thread: "allow" },
  { name: "Task, the tool's name before Claude Code 2.1", tool: "Task", input: { subagent_type: "general-purpose", prompt: "p", description: "d" }, apex: "deny", thread: "allow" },
  { name: "a workflow, a script of agents", tool: "Workflow", input: { script: "x" }, apex: "deny", thread: "allow" },
]

for (const entry of CLAUDE_CASES) {
  const spawn = claudeSpawn(entry.tool, ClaudeAgentInput.parse(entry.input), entry.teams ?? false)
  assert.ok(spawn, `${entry.name}: a spawn`)
  assert.equal(routeNativeSpawn(apex, spawn).kind, entry.apex, `${entry.name}, in an Apex`)
  assert.equal(routeNativeSpawn(thread, spawn).kind, entry.thread, `${entry.name}, in an ordinary Thread`)
}

for (const tool of ["Bash", "Read", "SendMessage", "TaskStop", "mcp__mako__agents_start"])
  assert.equal(claudeSpawn(tool, {}, true), undefined, `${tool} starts no native subagent`)

// The flags, for any harness: in an Apex only an exploration in the turn stays; elsewhere only isolation and teammates go to Mako.
assert.equal(routeNativeSpawn(apex, { tool: "spawn_agent", start: "agents_start" }).kind, "deny")
assert.equal(routeNativeSpawn(thread, { tool: "spawn_agent", start: "agents_start" }).kind, "allow")
assert.equal(routeNativeSpawn(apex, { tool: "x", start: "agents_start", inTurnExplore: true }).kind, "allow")
assert.equal(routeNativeSpawn(thread, { tool: "x", start: "agents_start", isolated: true }).kind, "deny")
assert.equal(routeNativeSpawn(thread, { tool: "x", start: "agents_start", teammate: true }).kind, "deny")
assert.equal(routeNativeSpawn(apex, { tool: "x", start: "agents_start", inTurnExplore: true, isolated: true }).kind, "deny", "isolation goes to Mako even for an exploration in the turn")
assert.equal(nativeSpawnsOff(apex), true, "an Apex's harness launches with its spawning off")
assert.equal(nativeSpawnsOff(thread), false, "an ordinary Thread's harness keeps its spawning")

// The deny is one string: it names the tool as the harness calls it, and repeats agents_start's own after-start words.
const message = routedMessage(CLAUDE_START_TOOL)
assert.equal(CLAUDE_START_TOOL, "mcp__mako__agents_start")
assert.match(message, /Call `agents_start` \(mcp__mako__agents_start\) with this brief instead\./)
assert.ok(message.endsWith(AFTER_START), "the message ends as agents_start's result does")
assert.doesNotMatch(message, /\n/, "one line")
const denied = routeNativeSpawn(apex, claudeSpawn("Agent", { subagent_type: "general-purpose" }, false)!)
assert.deepEqual(denied, { kind: "deny", message })

// Claude's PreToolUse: the deny carries the message, and a denied call never reaches the call bounds, so it leaves nothing behind.
{
  const call = (tool: string, input: JsonObject, id: string): PreToolUseHookInput => ({
    hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: id,
    session_id: "s", transcript_path: "/t", cwd: "/w",
  })
  let role: RoutedThread["role"] = "thread"
  const routing = { thread: () => ({ role }), teams: false, conversation: "c" }
  const answer = claudeRoutedCall(routing, call("Agent", { subagent_type: "general-purpose" }, "a"))
  assert.equal(answer, undefined, "an ordinary Thread keeps its background agents")
  role = "apex"
  assert.deepEqual(claudeRoutedCall(routing, call("Agent", { subagent_type: "general-purpose" }, "b")), {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message },
  }, "the role is read at each spawn: a Thread that became an Apex denies from its next spawn")
  assert.equal(claudeRoutedCall(routing, call("Agent", { subagent_type: "Explore", run_in_background: false }, "c")), undefined)

  const started: string[] = []
  const bounds = new CallBounds("c")
  const before = bounds.before.bind(bounds)
  bounds.before = (id, paths) => { started.push(id); before(id, paths) }
  const hooks = claudeCallHooks(bounds, routing)
  const signal = new AbortController().signal
  const routed = await hooks.pre(call("Agent", { subagent_type: "general-purpose" }, "denied"), "denied", { signal })
  assert.equal(HookDecision.parse(routed).hookSpecificOutput?.permissionDecision, "deny")
  assert.deepEqual(await hooks.pre(call("Bash", { command: "ls" }, "kept"), "kept", { signal }), {})
  assert.deepEqual(started, ["kept"], "only the call that runs is bounded")
  assert.deepEqual(await claudeCallHooks(new CallBounds("c")).pre(call("Agent", {}, "x"), "x", { signal }), {}, "without routing nothing is denied")
}

// The switches the at-launch harnesses take.
assert.deepEqual(codexRoutingConfig("c", () => apex), { "agents.enabled": false, "features.multi_agent_v2": false })
assert.deepEqual(codexRoutingConfig("c", () => thread), {})
assert.deepEqual(codexRoutingConfig("c", undefined), {})
{
  const env: NodeJS.ProcessEnv = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ agents: { build: { permissions: [{ action: "subagent", resource: "*", effect: "allow" }] } } }) }
  configureOpenCodePermissions(env, "full")
  configureOpenCodeRouting(env, "c", () => apex)
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!)
  for (const agent of ["build", "plan"])
    assert.deepEqual(config.agents[agent].permissions.at(-1), { action: OPENCODE_SPAWN_ACTION, resource: "*", effect: "deny" }, `${agent}'s last rule is the deny, so it wins`)
  assert.equal(config.agents.build.permissions.length, 3, "the person's rule and the tier's stay before it")
  const untouched: NodeJS.ProcessEnv = {}
  configureOpenCodeRouting(untouched, "c", () => thread)
  assert.equal(untouched.OPENCODE_CONFIG_CONTENT, undefined)
}

// Devin's switch is a copy of the person's own config with subagents off, in the launch's config folder: their settings stay.
{
  const root = await mkdtemp(join(tmpdir(), "mako-native-routing-"))
  try {
    await mkdir(join(root, "devin"))
    await writeFile(join(root, "devin", "config.json"), JSON.stringify({ disabled_tools: ["webfetch"], permissions: { allow: ["Read(**)"] } }))
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: root }
    const dispose = await prepareDevinMcp([], env, true)
    assert.notEqual(env.XDG_CONFIG_HOME, root, "the launch reads a config folder of its own")
    assert.deepEqual(JSON.parse(await readFile(join(env.XDG_CONFIG_HOME!, "devin", "config.json"), "utf8")), {
      disabled_tools: ["webfetch"], permissions: { allow: ["Read(**)"] }, subagents_enabled: false,
    })
    assert.deepEqual(JSON.parse(await readFile(join(root, "devin", "config.json"), "utf8")).subagents_enabled, undefined, "the person's own file is unchanged")
    await dispose()
    const kept: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: root }
    const disposeKept = await prepareDevinMcp([], kept)
    assert.equal(JSON.parse(await readFile(join(kept.XDG_CONFIG_HOME!, "devin", "config.json"), "utf8")).subagents_enabled, undefined, "an ordinary Thread reads the person's config as it is")
    await disposeKept()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/**
 * Each at-launch control as recorded (`harness:native-tools`): the newest
 * definitions of each harness hold an Apex configuration beside each of its
 * own, which offers none of the harness's spawn tools that the ordinary one
 * offers. Claude decides each call instead, and Cursor's definitions come
 * from its SDK's schema, not a launch.
 */
for (const harness of ["codex", "grok", "opencode", "devin"]) {
  const newest = storedDefinitions(harness).at(-1)!
  const vocabulary = VOCABULARIES.find((each) => each.harness === harness)!
  const spawns = Object.entries(vocabulary.tools).filter(([, tool]) => tool.kind === "agent").flatMap(([name, tool]) => [name, ...tool.aliases ?? []])
  const apexes = newest.configurations.filter((configuration) => configuration.name.endsWith(", lead"))
  assert.ok(apexes.length, `${harness} ${newest.version} has no Apex configuration; record one with npm run harness:native-tools -- ${harness}`)
  for (const apex of apexes) {
    const ordinary = newest.configurations.find((configuration) => configuration.name === apex.name.slice(0, -", lead".length))
    assert.ok(ordinary, `${harness} ${apex.name} has no ordinary configuration beside it`)
    const offered = spawns.filter((name) => name in ordinary.tools)
    assert.deepEqual(spawns.filter((name) => name in apex.tools), [], `${harness} ${newest.version} offers ${offered.join(", ")} in ${apex.name}`)
  }
  assert.ok(newest.configurations.some((configuration) => spawns.some((name) => name in configuration.tools)), `${harness} ${newest.version}: an ordinary Thread keeps its spawn tool somewhere`)
}

// Diagnostics: a control holds on the version it was seen on, a shipped build reads as the one Mako ships.
{
  const checked = (version: string): NativeRoutingCapability => ({ kind: "at-launch", via: "a switch", verified: { version, how: "a check" } })
  const drivers = [
    { provider: "same", nativeRouting: checked("1.0.0") },
    { provider: "moved", nativeRouting: checked("1.0.0") },
    { provider: "unread", nativeRouting: checked("1.0.0") },
    { provider: "shipped", nativeRouting: checked("2.0.0") },
    { provider: "spoken", nativeRouting: { kind: "words", reason: "no switch held" } satisfies NativeRoutingCapability },
  ]
  const installed = new Map([["same", "1.0.0"], ["moved", "1.1.0"]])
  const host: NativeRoutingSources = {
    liveDrivers: { list: () => drivers },
    updateSources: { get: (harness) => harness === "shipped" ? { versions: { tested: "2.0.0", bundled: { package: "a-sdk", version: "0.2.0" } } } : undefined },
    launchReadings: { read: async (harness) => installed.get(harness) },
  }
  assert.equal(launchSpawnsOff("same", "a switch", "conversation", () => ({ role: "apex" })), true)
  assert.equal(launchSpawnsOff("same", "a switch", "conversation", () => ({ role: "thread" })), false)
  const readings = new Map((await nativeRoutingReadings(host)).map((reading) => [reading.harness, reading]))
  assert.deepEqual(Object.fromEntries([...readings].map(([harness, reading]) => [harness, reading.state])), { same: "control", moved: "unverified", unread: "unverified", shipped: "control", spoken: "words" })
  assert.equal(readings.get("moved")?.installed, "1.1.0")
  assert.equal(readings.get("unread")?.installed, undefined)
}

console.log("native routing: ok")
