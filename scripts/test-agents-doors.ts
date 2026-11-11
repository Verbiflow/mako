import assert from "node:assert/strict"
import "./test-agent-list-results.ts"
import { execFile } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { promisify } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { HostJobs } from "@mako/host/base/host-jobs"
import { unwatchedWork } from "@mako/host/base/event-loop"
import { AGENT_TOOLS, ORCHESTRATION_INSTRUCTIONS } from "@mako/host/contracts/agent-tools"
import { REPORT_FOLLOW_UP_INSTRUCTIONS } from "@mako/host/contracts/report-actions"
import { hostCallSchema } from "@mako/host/contracts/host-call-inputs"
import { hostCallReplay } from "@mako/host/contracts/host-call-policy"
import { decodeRuntimeValue } from "@mako/host/contracts/runtime-value"
import { AgentAnswerSchema, declareAgentMethods, registerAgentTools, type AgentAnswer } from "@mako/host/conversations/agent-tools"
import { HostMethods } from "@mako/host/transport/methods"
import { startWebHost } from "@mako/host/transport/server"
import { z } from "zod"
import { AgentsWorld } from "./lib/agents-world.ts"

/**
 * One operation set, every door a projection (`npm run test:agents-doors`):
 * the in-Thread `mako` server, `mako mcp` on stdio and `mako agents <verb>`,
 * each against one host's socket. Every MCP door lists every tool with the
 * schema generated from its host call; the same input gives the same answer
 * through each door, a repeated key and a refusal included; and no
 * `agents_*` tool is registered by hand anywhere.
 */
const repo = resolve(import.meta.dirname, "..")
const cli = join(repo, "packages/client/dist/cli.js")
const root = mkdtempSync(join(tmpdir(), "mako-agents-doors-"))
const run = promisify(execFile)

function handRegistered(): string[] {
  const found: string[] = []
  const projection = join(repo, "packages/host/src/conversations/agent-tools.ts")
  const visit = (folder: string) => {
    for (const name of readdirSync(folder)) {
      if (name === "node_modules" || name === "dist") continue
      const path = join(folder, name)
      if (statSync(path).isDirectory()) visit(path)
      else if (/\.(ts|tsx|mts|mjs|js)$/.test(name) && path !== projection && /registerTool\(\s*["'`]agents_/.test(readFileSync(path, "utf8"))) found.push(relative(repo, path))
    }
  }
  for (const folder of ["packages", "src", "electron", "scripts"]) visit(join(repo, folder))
  return found
}

/** The fields a door's callers fill, by name: the generated input less what the door fills, and those it requires. */
function generatedFields(tool: (typeof AGENT_TOOLS)[number]) {
  const input = hostCallSchema(tool.channel).def.items[1]
  assert.ok(input instanceof z.ZodObject)
  const generated = z.toJSONSchema(input, { io: "input" })
  const asked = (name: string) => !tool.filled.some((field) => field === name)
  return { names: Object.keys(generated.properties ?? {}).filter(asked).sort(), required: (generated.required ?? []).filter(asked).sort() }
}

const ToolResultSchema = z.object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })), isError: z.boolean().optional() })
const StartedSchema = AgentAnswerSchema.extend({ child: z.string(), name: z.string(), conversation: z.string(), deduped: z.literal(true).optional() })
const ReadSchema = AgentAnswerSchema.extend({ text: z.string() })
const ListedSchema = AgentAnswerSchema.extend({ children: z.array(z.looseObject({ name: z.string(), idleFor: z.number().optional() })) })

async function call(client: Client, name: string, args: Parameters<Client["callTool"]>[0]["arguments"]): Promise<AgentAnswer> {
  const result = ToolResultSchema.parse(await client.callTool({ name, arguments: args }))
  const text = result.content[0]!.text
  if (!result.isError) return AgentAnswerSchema.parse(JSON.parse(text))
  const [first, ...rest] = text.split("\n")
  const refused = AgentAnswerSchema.parse(JSON.parse(rest.join("\n")))
  assert.equal(first, `refused: ${refused.refused}`, "an error result is a refusal, named first")
  return refused
}

const world = new AgentsWorld({ root: join(root, "host"), script: async (turn) => {
  if (!turn.text.includes("You're fin:")) return "ok"
  await turn.world.hold(turn.conversation)
  return "Done: the sidebar is reviewed."
} })
const methods = new HostMethods({ fixtureDesk: false, route: async () => ({ handled: false }), presentHistory: (value) => value, breadcrumb: () => {}, declaring: async () => {}, work: unwatchedWork })
declareAgentMethods(methods, () => world.agents)
const socket = join(root, "host.sock")
const jobs = new HostJobs()
const host = await startWebHost(socket, (channel, args, client, history, correlationId) => methods.invoke(channel, args, client, history, correlationId), async () => new Response(null, { status: 404 }), undefined, undefined, undefined, undefined, undefined, jobs)
const clients: Client[] = []
try {
  assert.deepEqual(handRegistered(), [], "every agents_* tool comes from the projection")
  for (const tool of AGENT_TOOLS) assert.equal(hostCallReplay(tool.channel), tool.replay, `${tool.channel} replays as its definition says`)

  const apex = await world.apex("codex")
  const session = apex.caller.kind === "agent" ? apex.caller.session : ""
  const cwd = world.root

  const inThread = new McpServer({ name: "mako", version: "1.0.0" }, { instructions: ORCHESTRATION_INSTRUCTIONS })
  registerAgentTools(inThread, {
    invoke: async (channel, args) => AgentAnswerSchema.parse(decodeRuntimeValue(await methods.invoke(channel, args))),
    caller: () => apex.caller,
    filled: () => ({ cwd }),
  })
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await inThread.connect(serverSide)
  const thread = new Client({ name: "in-thread", version: "1.0.0" })
  await thread.connect(clientSide)
  clients.push(thread)

  const stdio = new Client({ name: "mako-mcp", version: "1.0.0" })
  await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--socket", socket, "--cwd", cwd], env: { ...getDefaultEnvironment(), MAKO_SESSION_ID: session }, stderr: "pipe" }))
  clients.push(stdio)

  const doors = { "in-thread": thread, "mako mcp": stdio }
  const listed: Record<string, Awaited<ReturnType<Client["listTools"]>>["tools"]> = {}
  for (const [door, client] of Object.entries(doors)) {
    assert.ok(client.getInstructions()?.includes(REPORT_FOLLOW_UP_INSTRUCTIONS), `${door} carries the common actionable-report directive`)
    listed[door] = (await client.listTools()).tools
    assert.deepEqual(listed[door]!.map((tool) => tool.name).filter((name) => name.startsWith("agents_")).sort(), AGENT_TOOLS.map((tool) => tool.mcp.name).sort(), `${door} lists every tool`)
    for (const tool of AGENT_TOOLS) {
      const schema = listed[door]!.find((listedTool) => listedTool.name === tool.mcp.name)!.inputSchema
      const fields = generatedFields(tool)
      assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), fields.names, `${door}'s ${tool.mcp.name} takes its host call's fields`)
      assert.deepEqual([...(schema.required ?? [])].sort(), fields.required, `${door}'s ${tool.mcp.name} requires what its host call requires`)
    }
  }
  // The in-memory door keeps the undefined fields the wire drops.
  const agentsOnly = (tools: (typeof listed)[string]) => tools.filter((tool) => tool.name.startsWith("agents_"))
  assert.deepEqual(agentsOnly(listed["mako mcp"]!), JSON.parse(JSON.stringify(agentsOnly(listed["in-thread"]!))), "both MCP doors list the same tools, schemas and words")

  const command = async (...args: string[]) => {
    const { stdout } = await run(process.execPath, [cli, "agents", ...args, "--socket", socket, "--cwd", cwd, "--json"], { env: { ...process.env, MAKO_SESSION_ID: session } }).catch((error: { stdout?: string; code?: number }) => {
      if (error.code === 1 && error.stdout) return { stdout: error.stdout }
      throw error
    })
    return AgentAnswerSchema.parse(JSON.parse(stdout))
  }
  const briefFile = join(root, "brief.md")
  writeFileSync(briefFile, "Review the sidebar.\n")
  const brief = { objective: "Review the sidebar." }

  const first = StartedSchema.parse(await call(thread, "agents_start", { brief, harness: "claude", name: "sidebar", clientKey: "same-key" }))
  const repeated = StartedSchema.parse(await call(stdio, "agents_start", { brief, harness: "claude", name: "sidebar", clientKey: "same-key" }))
  const identity = ({ child, name, conversation }: z.infer<typeof StartedSchema>) => ({ child, name, conversation })
  assert.deepEqual(identity(repeated), identity(first), "mako mcp answers the same key with the same child")
  assert.equal(repeated.deduped, true)
  assert.deepEqual(await command("start", "claude", "--brief-file", briefFile, "--name", "sidebar", "--key", "same-key"), repeated, "and so does mako agents start, word for word")

  const refusal = await call(thread, "agents_start", { brief, place: "cloud", clientKey: "cloud" })
  assert.equal(refusal.refused, "place-unavailable")
  assert.deepEqual(await call(stdio, "agents_start", { brief, place: "cloud", clientKey: "cloud" }), refusal, "a refusal reads the same through every door")

  world.release(first.conversation)
  await world.settle()
  // A strip's `idleFor` reads the clock as each door answers, so it can tick between them: the rest is the same list.
  const lists = [await call(thread, "agents_list", {}), await call(stdio, "agents_list", {}), await command("list")].map((list) => ListedSchema.parse(list))
  assert.ok(lists[0]!.children.every((strip) => Number.isInteger(strip.idleFor)), "a finished Fin's strip says how long it's been idle")
  const unclocked = (list: z.infer<typeof ListedSchema>) => ({ ...list, children: list.children.map((strip) => Object.fromEntries(Object.entries(strip).filter(([key]) => key !== "idleFor"))) })
  assert.deepEqual(unclocked(lists[1]!), unclocked(lists[0]!))
  assert.deepEqual(unclocked(lists[2]!), unclocked(lists[0]!), "the same list through all three")
  const reads = [await call(thread, "agents_read", { child: "sidebar" }), await call(stdio, "agents_read", { child: "sidebar" }), await command("read", "sidebar")]
  assert.match(ReadSchema.parse(reads[0]).text, /the sidebar is reviewed/)
  assert.deepEqual(reads[1], reads[0])
  assert.deepEqual(reads[2], reads[0])
  const question = await world.agents.report(world.caller(first.conversation), { status: "done", summary: "The review needs a decision.", question: "Route the review?", clientKey: "retained-question" })
  assert.ok(!("refused" in question), JSON.stringify(question))
  await world.agents.report(world.caller(first.conversation), { status: "progress", summary: "Additional review evidence.", clientKey: "quiet-progress" })
  const exact = await call(thread, "agents_read", { child: "sidebar", report: question.id })
  assert.match(ReadSchema.parse(exact).text, /The review needs a decision/)
  assert.deepEqual(await call(stdio, "agents_read", { child: "sidebar", report: question.id }), exact, "stdio preserves exact report selection after narration")
  assert.deepEqual(await command("read", "sidebar", "--report", question.id), exact, "the CLI preserves the same selector")
  const decision = { to: "sidebar", ask: question.id, answer: "Park", clientKey: "answer-retained" }
  const answered = await call(thread, "agents_answer", decision)
  assert.equal(answered.ask, question.id, "the generated tool accepts and returns the exact ask identity")
  const repeatedAnswer = await call(stdio, "agents_answer", decision)
  assert.equal(repeatedAnswer.ask, question.id)
  assert.equal(repeatedAnswer.deduped, true)
  const target = { ref: "fixture:sidebar-review", version: "head-1" }
  const action = await world.agents.report(world.caller(first.conversation), { status: "done", summary: "Action-only review handoff.", action: "Dispatch exact sidebar review.", followUp: target, clientKey: "action-only" })
  assert.ok(!("refused" in action), JSON.stringify(action))
  const disposition = { kind: "defer", reason: "Review slot pending.", resume: "Exact review slot assigned." }
  const settlement = { to: "sidebar", report: action.id, version: 1, target, disposition, clientKey: "same-action-disposition" }
  const deferred = await call(thread, "agents_settle", settlement)
  assert.equal(deferred.refused, undefined)
  const duplicateDisposition = await call(stdio, "agents_settle", settlement)
  assert.equal(duplicateDisposition.deduped, true)
  assert.deepEqual(await command("settle", "sidebar", "--report", action.id, "--version", "1", "--target", JSON.stringify(target), "--disposition", JSON.stringify(disposition), "--key", "same-action-disposition"), duplicateDisposition, "CLI/stdio/in-Thread resolve the exact same durable operation")
  const pendingAction = z.object({ actions: z.object({ items: z.array(z.object({ report: z.string(), version: z.number() })) }) }).parse(await call(thread, "agents_read", { child: "sidebar" }))
  assert.deepEqual(pendingAction.actions.items, [{ report: action.id, version: 2 }], "defer remains pending across all doors")
  const reclaimed = await command("settle", "sidebar", "--report", action.id, "--version", "2", "--target", JSON.stringify(target), "--disposition", JSON.stringify({ kind: "reclaim", reason: "Apex keeps the decision." }), "--key", "cli-reclaim")
  assert.equal(reclaimed.refused, undefined)
  const own = world.store.journalPlacement(apex.conversation)!.thread
  assert.deepEqual(await command("read", own, "--actions"), await call(thread, "agents_read", { child: own, view: "actions" }), "CLI custody view grants only the caller's own records")
  assert.deepEqual(await call(stdio, "agents_read", { child: own, view: "actions" }), await call(thread, "agents_read", { child: own, view: "actions" }))
  const dismissed = await command("settle", "sidebar", "--report", action.id, "--version", "3", "--target", JSON.stringify(target), "--disposition", JSON.stringify({ kind: "resolve", evidence: "fixture:verified-exact-target-outcome" }), "--key", "close-deferred-action")
  assert.equal(dismissed.refused, undefined)
  assert.equal((await call(thread, "agents_read", { child: "sidebar" })).actions, undefined, "silent exact disposition clears no unrelated question")
  const unknown = [await call(thread, "agents_stop", { child: "nobody" }), await command("stop", "nobody")]
  assert.equal(unknown[0]!.refused, "unknown-child")
  assert.deepEqual(unknown[1], unknown[0], "mako agents exits 1 with the same refusal")
  for (let number = 1; number <= 4; number++) {
    await world.agents.report(world.caller(first.conversation), { status: "progress", summary: `PR reference ${number}.`, artifacts: [{ kind: "pull-request", ref: `https://github.com/example/list-details/pull/${number}` }], clientKey: `pr-reference-${number}` })
  }
  const fullFacts = await world.agents.list(apex.caller, {})
  assert.ok("children" in fullFacts)
  const originalPulls = fullFacts.children.find(child => child.child === first.child)!.openPRs
  assert.equal(originalPulls?.length, 4)
  assert.deepEqual(await call(thread, "agents_list", {}), await call(thread, "agents_list", { presentation: "full" }), "the model door defaults to complete PR facts")
  const summarized = z.object({ children: z.array(z.looseObject({ child: z.string(), pulls: z.object({ reported: z.number(), read: z.object({ child: z.string(), view: z.literal("pulls"), snapshot: z.string() }) }) })) }).parse(await call(thread, "agents_list", { presentation: "summary" }))
  const reference = summarized.children.find(child => child.child === first.child)!.pulls.read
  assert.equal(summarized.children[0].pulls.reported, 4, "historical references stay explicitly unknown")
  const recovered: unknown[] = []
  let offset: number | undefined = 0
  while (offset !== undefined) {
    const page = ReadSchema.extend({ pulls: z.object({ next: z.number().optional() }) }).parse(await call(stdio, "agents_read", { ...reference, offset, limit: 2 }))
    recovered.push(...z.array(z.json()).parse(JSON.parse(page.text)))
    offset = page.pulls.next
  }
  assert.deepEqual(recovered, originalPulls, "a summary from one door recovers every fact through the real engine/read authorization at another door")
  const unchanged = await world.agents.list(apex.caller, {})
  assert.ok("children" in unchanged)
  assert.deepEqual(unchanged.children.find(child => child.child === first.child)!.openPRs, originalPulls, "the UI/engine still has full facts")
  console.log("agents doors: ok")
} finally {
  for (const client of clients) await client.close().catch(() => undefined)
  await host.close()
  jobs.stop()
  await world.close()
  rmSync(root, { recursive: true, force: true })
}
