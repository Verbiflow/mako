import "./lib/scratch-git.mjs"
// Native routing as each real harness runs it: the CLI Mako launches, through
// Mako's own live driver, in a sealed home, against the scripted model (no
// account; nothing leaves this machine). Each harness runs one turn as an Apex
// and one as an ordinary Thread, and in each the model calls the harness's
// own spawn tool:
//
// - as an Apex, the spawn never starts a child: the harness offered no such
//   tool, or Claude's PreToolUse denied it with the message naming
//   `agents_start`, which the model reads next; and no subagent reaches the
//   roster;
// - as an ordinary Thread, the child runs and is observed (`live-agent`), and
//   Claude's child starts with Mako's paragraph for native children.
//
// Codex also resumes the Apex's thread in a new app-server, which must keep
// spawning off. Cursor has no stand-in for its model, so its control is
// checked against its own service by `test:native-routing-cursor`.
//
//   npm run test:native-routing-live [-- <harness>...]
//
// `--evidence <dir>` writes each run's requests and events there.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import type { JsonObject } from "@mako/host/contracts/json"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import { NATIVE_CHILD_INSTRUCTIONS, type RoutedThread } from "@mako/host/contracts/native-routing"
import { installClaude } from "@mako/host/harnesses/claude/index"
import { installCodex } from "@mako/host/harnesses/codex/index"
import { installDevin } from "@mako/host/harnesses/devin/index"
import { installGrok } from "@mako/host/harnesses/grok/index"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { installOpenCode } from "@mako/host/harnesses/opencode/index"
import { admitted } from "./fixtures/admitted-start.ts"
import { sealedDrivers } from "./fixtures/sealed-drivers.ts"
import { sandboxed, type Sandbox } from "./harness-sandbox.ts"
import { pointAt, SCRIPTED_GETS } from "./scripted-harness-env.ts"
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"
import { scriptedWindsurf } from "./scripted-windsurf.ts"

const args = process.argv.slice(2)
const evidenceAt = args.indexOf("--evidence")
const evidence = evidenceAt === -1 ? undefined : args.splice(evidenceAt, 2)[1]

const CHILD_TASK = "List the files in this folder and report their names."
/** The deny's own words, as the model reads them in the spawn's result. */
const ROUTED = "routes background, parallel and writing work through Mako"

/** Each harness's spawn tool, called as its model calls it, and the mode its turn runs in. */
const SPAWNS = new Map<string, { tool: string; arguments: JsonObject; mode?: string }>([
  ["claude", { tool: "Agent", arguments: { description: "List files", prompt: CHILD_TASK, subagent_type: "general-purpose", run_in_background: false }, mode: "bypassPermissions" }],
  ["codex", { tool: "spawn_agent", arguments: { task_name: "list_files", message: CHILD_TASK } }],
  ["grok", { tool: "spawn_subagent", arguments: { description: "List files", prompt: CHILD_TASK }, mode: "access:full" }],
  ["opencode", { tool: "subagent", arguments: { agent: "general", description: "List files", prompt: CHILD_TASK } }],
  ["devin", { tool: "run_subagent", arguments: { title: "List files", task: CHILD_TASK, profile: "subagent_explore" }, mode: "bypass" }],
])

/** The harnesses whose requests name their tools; Devin's Windsurf wire doesn't. */
const READABLE = new Set(["claude", "codex", "grok", "opencode"])

const Tool = z.object({ name: z.string().optional(), function: z.object({ name: z.string() }).loose().optional(), tools: z.array(z.unknown()).optional() }).loose()
const Body = z.object({ tools: z.array(z.unknown()).optional(), input: z.unknown().optional() }).loose()

/** Each JSON value in `heard`: one body, or the frames Codex's websocket sends one after another. */
function frames(heard: string): unknown[] {
  const values: unknown[] = []
  let rest = heard.trim()
  while (rest) {
    try {
      values.push(JSON.parse(rest))
      break
    } catch (error) {
      const at = Number(/after JSON at position (\d+)/.exec(error instanceof Error ? error.message : "")?.[1])
      if (!at) return values
      values.push(JSON.parse(rest.slice(0, at)))
      rest = rest.slice(at).trim()
    }
  }
  return values
}

/** The tools a request offers, inside namespaces and Codex's `additional_tools` too; undefined for one that names no tools. */
function offered(heard: string): Set<string> | undefined {
  const bodies = frames(heard).flatMap((frame) => {
    const parsed = Body.safeParse(frame)
    return parsed.success ? [parsed.data] : []
  })
  const extra = bodies.flatMap((body) => Array.isArray(body.input) ? body.input : []).flatMap((item) => {
    const listed = z.object({ type: z.literal("additional_tools"), tools: z.array(z.unknown()) }).loose().safeParse(item)
    return listed.success ? listed.data.tools : []
  })
  if (!extra.length && !bodies.some((body) => body.tools)) return undefined
  const names = new Set<string>()
  const walk = (tools: unknown[]) => {
    for (const each of tools) {
      const tool = Tool.safeParse(each).data
      if (!tool) continue
      if (tool.tools) walk(tool.tools)
      const name = tool.function?.name ?? tool.name
      if (name) names.add(name)
    }
  }
  walk([...bodies.flatMap((body) => body.tools ?? []), ...extra])
  return names
}

interface Run {
  /** What the model heard, each conversation request in order. */
  heard: string[]
  events: LiveDriverEvent[]
  nativeId?: string
}

const updates = (events: readonly LiveDriverEvent[]) => events.flatMap((event) => event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : [])

/** One turn: the model calls the spawn tool once, then answers every request after it with text. */
async function turn(harness: string, sandbox: Sandbox, driver: ProviderLiveDriver, role: RoutedThread["role"], resume?: string): Promise<Run> {
  const spawn = SPAWNS.get(harness)!
  const run: Run = { heard: [], events: [] }
  let called = false
  const reply = (heard: string): ScriptedReply => {
    run.heard.push(heard)
    if (called) return { text: "Done." }
    called = true
    return { call: { id: "call_spawn", name: spawn.tool, arguments: spawn.arguments } }
  }
  const model = harness === "devin" ? await scriptedWindsurf({ reply }) : await scriptedModel({ reply, answers: SCRIPTED_GETS })
  const env = { ...sandbox.env }
  await pointAt(harness, sandbox, model.url, env, `native-routing-${role}`)
  // The SDK's build finds its config folder without HOME, and with it the person's login: the folder is named outright.
  if (harness === "claude") Object.assign(env, { CLAUDE_CONFIG_DIR: join(sandbox.home, ".claude"), ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: `native-routing-${role}` })
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "CODEX_HOME"] as const)
    if (env[key] && !env[key].startsWith(sandbox.home)) throw new Error(`${harness}'s ${key} is outside its sealed home; nothing was started`)
  const id = randomUUID()
  let quiet = Date.now()
  const emit = (event: LiveDriverEvent) => {
    run.events.push(event)
    quiet = Date.now()
    if (event.type === "live-session" && event.session.nativeId) run.nativeId = event.session.nativeId
    if (event.type === "live-permission") {
      const option = event.request.options?.find((candidate) => /allow/i.test(`${candidate.kind} ${candidate.optionId}`)) ?? event.request.options?.[0]
      if (option) void Promise.resolve(driver.permission(id, event.request.id, { kind: "choice", optionId: option.optionId }, { assertCurrent() {}, report() {} })).catch(() => {})
    }
  }
  const status = () => run.events.findLast((event) => event.type === "live-session")?.session.status
  try {
    await driver.start(sandbox.project, admitted(harness, {
      conversationId: id, emit, resume,
      ...spawn.mode && { modeId: spawn.mode },
      mcpSnapshot: async () => ({ cwd: sandbox.project, generatedAt: Date.now(), servers: [], providers: [] }),
      nativeRouting: () => ({ role }),
    }, { env }))
    const signedIn = run.events.some((event) => event.type === "live-session" && event.session.executionContext?.identity.kind === "reported")
    if (signedIn) throw new Error(`${harness} started signed in to an account, not the stand-in; nothing was sent`)
    await driver.prompt(id, "Have a subagent list the files in this folder.", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
    // The turn, and the one a background child's report starts, have ended once nothing more is heard for a while.
    const deadline = Date.now() + 150_000
    while (Date.now() < deadline && !(status() !== "running" && status() !== "starting" && Date.now() - quiet > 4000)) await delay(250)
    if (Date.now() >= deadline) throw new Error(`${harness} as a ${role}: the turn didn't settle`)
    if (!run.heard.length) throw new Error(`${harness} as a ${role} never asked the stand-in: it reached another model`)
  } finally {
    await Promise.resolve(driver.close(id)).catch(() => {})
    await model.close()
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await writeFile(join(evidence, `${harness}-${role}${resume ? "-resumed" : ""}.json`), sandbox.scrub(JSON.stringify({ heard: run.heard, events: run.events }, null, 1)).replaceAll(homedir(), "~"))
    }
  }
  return run
}

const observedChildren = (run: Run) => run.events.filter((event) => event.type === "live-agent")

async function check(harness: string, driver: ProviderLiveDriver): Promise<string> {
  const { tool } = SPAWNS.get(harness)!
  const lines: string[] = []
  await sandboxed("mako-native-routing", harness, async (sandbox) => {
    const apex = await turn(harness, sandbox, driver, "apex")
    const apexTools = offered(apex.heard[0] ?? "")
    if (!apexTools && READABLE.has(harness)) throw new Error(`${harness}'s first request named no tools this check reads`)
    if (apexTools && harness !== "claude") assert.ok(!apexTools.has(tool), `${harness} as an Apex still offers ${tool}`)
    assert.deepEqual(observedChildren(apex), [], `${harness} as an Apex: no subagent reaches the roster`)
    if (harness === "devin") assert.ok(apex.heard.slice(1).some((heard) => heard.includes(`Tool '${tool}' is not available`)), "Devin refuses the call itself: its tool is gone")
    if (harness === "claude") {
      assert.ok(apexTools?.has(tool), "Claude keeps Agent offered and decides each call")
      assert.ok(apex.heard.slice(1).some((heard) => heard.includes(ROUTED)), "Claude's model reads the deny that names agents_start")
      assert.ok(!apex.heard.some((heard) => heard.includes(NATIVE_CHILD_INSTRUCTIONS)), "no child started, so none heard the child paragraph")
    }
    lines.push(`Apex: ${harness === "claude" ? `${tool} offered, its call denied with the agents_start message` : apexTools ? `${tool} not offered` : `the call refused, ${tool} not available`}, ${apex.heard.length} model requests, no subagent observed`)

    if (harness === "codex") {
      assert.ok(apex.nativeId, "Codex named its thread")
      const resumed = await turn(harness, sandbox, driver, "apex", apex.nativeId)
      const tools = offered(resumed.heard[0] ?? "")
      assert.ok(tools && !tools.has(tool), `Codex resumed as an Apex offers ${tool} again`)
      assert.deepEqual(observedChildren(resumed), [], "Codex resumed as an Apex: no subagent observed")
      lines.push(`Apex resumed in a new app-server: ${tool} still not offered`)
    }

    const thread = await turn(harness, sandbox, driver, "thread")
    const threadTools = offered(thread.heard[0] ?? "")
    if (threadTools) assert.ok(threadTools.has(tool), `${harness} as an ordinary Thread lost ${tool}`)
    assert.ok(observedChildren(thread).length > 0, `${harness} as an ordinary Thread: its subagent is observed`)
    assert.ok(updates(thread.events).some((update) => update.kind === "tool" && update.name === tool), `${harness}: the spawn reached the transcript`)
    if (harness === "claude") {
      assert.ok(thread.heard.some((heard) => heard.includes(NATIVE_CHILD_INSTRUCTIONS)), "Claude's child starts with Mako's paragraph for native children")
      assert.ok(!thread.heard.some((heard) => heard.includes(ROUTED)), "an ordinary Thread's background-default agent isn't denied")
    }
    lines.push(`thread: ${threadTools ? `${tool} offered` : "tools not readable on this wire"}, child ran and was observed (${observedChildren(thread).length} roster events)${harness === "claude" ? ", child heard the native-child paragraph" : ""}`)
  })
  return lines.join("; ")
}

const drivers = sealedDrivers([installClaude, installCodex, installOpenCode, installGrok, installDevin])
const harnesses = args.length ? args : [...SPAWNS.keys()]
let failed = false
for (const harness of harnesses) {
  const driver = drivers.get(harness)
  if (!driver || !SPAWNS.has(harness)) throw new Error(`${harness} has no native routing check here; checked: ${[...SPAWNS.keys()].join(", ")}`)
  if (!driver.available(process.cwd())) {
    console.log(`${harness}: skipped, not installed`)
    continue
  }
  try {
    console.log(`${harness}: ${await check(harness, driver)}`)
  } catch (error) {
    failed = true
    console.log(`${harness}: FAILED ${error instanceof Error ? error.message : String(error)}`)
  }
}
process.exit(failed ? 1 : 0)
