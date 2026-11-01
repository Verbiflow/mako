import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import { parseArgs } from "node:util"
import { heavy } from "@mako/host/base/heavy-packages"
import type { AgentCaller } from "@mako/host/contracts/agents"
import { AGENT_TOOLS, ORCHESTRATION_INSTRUCTIONS, SESSION_VARIABLE, type AgentToolDefinition } from "@mako/host/contracts/agent-tools"
import { AgentAnswerSchema, agentToolText, registerAgentTools, type AgentToolDoor } from "@mako/host/conversations/agent-tools"
import { z } from "zod"
import { localHost, type HostTransport } from "./transport.js"

export const AGENTS_HELP = `  mako agents start <harness> --brief-file <f> [--model <id>] [--reasoning <level>] [--access <tier>]
                    [--worktree --branch <b> | --base <b>] [--title <words>] [--name <n>] [--key <k>]
  mako agents list [--tree]
  mako agents read <child> [--transcript]
  mako agents report <status> <summary> [--question <q>] [--key <k>]
  mako agents wait [child…] [--timeout <ms>]
  mako agents stop <child|all> [--reason <words>]
  mako agents link <harness> <session> [--pid <n>]
  mako mcp [--cwd <folder>]   the same operations as an MCP server on stdio

  A brief file ending .json is a brief ({objective, doneWhen, boundaries, output}); any other is its objective.
  The caller is the Session ${SESSION_VARIABLE} names, as in a Mako Thread's shell. --key repeats a start or report.`

const BriefSchema = z.object({ objective: z.string(), doneWhen: z.array(z.string()).optional(), boundaries: z.array(z.string()).optional(), output: z.string().optional() }).strict()

/** Who a command speaks for: the Session `MAKO_SESSION_ID` names, which labels the call (the socket is the person's either way). */
function caller(): AgentCaller {
  const session = process.env[SESSION_VARIABLE]
  return session ? { kind: "agent", session } : { kind: "person" }
}

function door(transport: HostTransport, cwd: string): AgentToolDoor {
  return { invoke: async (channel, args) => AgentAnswerSchema.parse(await transport.call(channel, args)), caller, filled: () => ({ cwd }) }
}

async function brief(path: string) {
  const text = await readFile(path, "utf8")
  return extname(path) === ".json" ? BriefSchema.parse(JSON.parse(text)) : { objective: text.trim() }
}

function tool(verb: AgentToolDefinition["verb"]): AgentToolDefinition {
  const found = AGENT_TOOLS.find((definition) => definition.verb === verb)
  if (!found) throw new Error(`No agents operation ${verb}`)
  return found
}

const OPTIONS = {
  cwd: { type: "string" },
  socket: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  "brief-file": { type: "string" },
  model: { type: "string" },
  reasoning: { type: "string" },
  access: { type: "string" },
  worktree: { type: "boolean" },
  branch: { type: "string" },
  base: { type: "string" },
  title: { type: "string" },
  name: { type: "string" },
  key: { type: "string" },
  tree: { type: "boolean" },
  transcript: { type: "boolean" },
  question: { type: "string" },
  timeout: { type: "string" },
  reason: { type: "string" },
  pid: { type: "string" },
} as const
type Parsed = ReturnType<typeof parseArgs<{ args: string[]; allowPositionals: true; options: typeof OPTIONS }>>

/** One `mako agents <verb>`: its input from the arguments, the same host call the in-Thread tool makes. */
async function input(verb: string, { values, positionals }: Parsed, cwd: string): Promise<{ tool: AgentToolDefinition; input: object }> {
  const [first, second, ...more] = positionals
  switch (verb) {
    case "start": {
      if (!first || !values["brief-file"]) throw new Error("agents start needs a harness and --brief-file")
      if ((values.branch || values.base) && !values.worktree) throw new Error("--branch and --base name its worktree: add --worktree")
      if (values.branch && values.base) throw new Error("--branch or --base, not both")
      return {
        tool: tool("start"),
        input: {
          harness: first,
          brief: await brief(values["brief-file"]),
          cwd,
          clientKey: values.key ?? randomUUID(),
          ...(values.model && { model: values.model }),
          ...(values.reasoning && { reasoning: values.reasoning }),
          ...(values.access && { access: values.access }),
          ...(values.worktree && { workspace: { ...(values.branch && { branch: values.branch }), ...(values.base && { base: values.base }) } }),
          ...(values.title && { title: values.title }),
          ...(values.name && { name: values.name }),
        },
      }
    }
    case "list":
      return { tool: tool("list"), input: values.tree ? { scope: "tree" } : {} }
    case "read":
      if (!first) throw new Error("agents read needs a child")
      return { tool: tool("read"), input: { child: first, ...(values.transcript && { view: "transcript" }) } }
    case "report":
      if (!first || !second) throw new Error("agents report needs a status and a summary")
      return {
        tool: tool("report"),
        input: { status: first, summary: [second, ...more].join(" "), clientKey: values.key ?? randomUUID(), ...(values.question && { question: values.question }) },
      }
    case "wait":
      return {
        tool: tool("wait"),
        input: { ...(positionals.length && { children: positionals }), ...(values.timeout && { timeoutMs: Number(values.timeout) }) },
      }
    case "stop":
      if (!first) throw new Error("agents stop needs a child, or all")
      return { tool: tool("stop"), input: { child: first, ...(values.reason && { reason: values.reason }) } }
    case "link":
      if (!first || !second) throw new Error("agents link needs a harness and a session")
      return { tool: tool("link"), input: { harness: first, session: second, ...(values.pid && { pid: Number(values.pid) }) } }
    default:
      throw new Error(`no agents command ${verb}; mako --help lists them`)
  }
}

/**
 * `mako agents <verb>` and `mako mcp`, on this computer's host: parsed apart
 * from the conversation commands, whose options they don't share. A refusal
 * exits 1, as an answer that isn't the one asked for.
 */
export async function agentsMain(argv: string[]): Promise<void> {
  const parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS })
  const [command, verb, ...rest] = parsed.positionals
  if (parsed.values.help) return void process.stdout.write(`${AGENTS_HELP}\n`)
  const transport = localHost(parsed.values.socket ? { socket: parsed.values.socket } : {})
  const cwd = parsed.values.cwd ?? process.cwd()
  try {
    if (command === "mcp") return await serveAgentsMcp(transport, cwd)
    if (!verb) throw new Error("agents needs a command: start, list, read, report, wait, stop or link")
    const call = await input(verb, { ...parsed, positionals: rest }, cwd)
    const result = await door(transport, cwd).invoke(call.tool.channel, [caller(), call.input])
    process.stdout.write(`${parsed.values.json ? JSON.stringify(result) : agentToolText(result)}\n`)
    if (result.refused !== undefined) process.exitCode = 1
  } finally {
    transport.close()
  }
}

/** Every agents operation as an MCP server on stdio, until its client closes stdin. */
async function serveAgentsMcp(transport: HostTransport, cwd: string): Promise<void> {
  const { McpServer, StdioServerTransport } = await heavy.mcpStdio.load("mako mcp")
  const server = new McpServer({ name: "mako", version: "1.0.0" }, { instructions: ORCHESTRATION_INSTRUCTIONS })
  registerAgentTools(server, door(transport, cwd))
  const ended = new Promise<void>((resolve) => process.stdin.once("end", resolve))
  await server.connect(new StdioServerTransport())
  await ended
  await server.close()
}
