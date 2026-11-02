import assert from "node:assert/strict"
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
import { AGENT_TOOLS } from "@mako/host/contracts/agent-tools"
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

  const inThread = new McpServer({ name: "mako", version: "1.0.0" })
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
    listed[door] = (await client.listTools()).tools
    assert.deepEqual(listed[door]!.map((tool) => tool.name).sort(), AGENT_TOOLS.map((tool) => tool.mcp.name).sort(), `${door} lists every tool`)
    for (const tool of AGENT_TOOLS) {
      const schema = listed[door]!.find((listedTool) => listedTool.name === tool.mcp.name)!.inputSchema
      const fields = generatedFields(tool)
      assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), fields.names, `${door}'s ${tool.mcp.name} takes its host call's fields`)
      assert.deepEqual([...(schema.required ?? [])].sort(), fields.required, `${door}'s ${tool.mcp.name} requires what its host call requires`)
    }
  }
  // The in-memory door keeps the undefined fields the wire drops.
  assert.deepEqual(listed["mako mcp"], JSON.parse(JSON.stringify(listed["in-thread"])), "both MCP doors list the same tools, schemas and words")

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
  const lists = [await call(thread, "agents_list", {}), await call(stdio, "agents_list", {}), await command("list")]
  assert.deepEqual(lists[1], lists[0])
  assert.deepEqual(lists[2], lists[0], "the same list through all three")
  const reads = [await call(thread, "agents_read", { child: "sidebar" }), await call(stdio, "agents_read", { child: "sidebar" }), await command("read", "sidebar")]
  assert.match(ReadSchema.parse(reads[0]).text, /the sidebar is reviewed/)
  assert.deepEqual(reads[1], reads[0])
  assert.deepEqual(reads[2], reads[0])
  const unknown = [await call(thread, "agents_stop", { child: "nobody" }), await command("stop", "nobody")]
  assert.equal(unknown[0]!.refused, "unknown-child")
  assert.deepEqual(unknown[1], unknown[0], "mako agents exits 1 with the same refusal")
  console.log("agents doors: ok")
} finally {
  for (const client of clients) await client.close().catch(() => undefined)
  await host.close()
  jobs.stop()
  await world.close()
  rmSync(root, { recursive: true, force: true })
}
