import { ReportActionTargetSchema, ReportDispositionSchema } from "@mako/host/contracts/report-actions"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import { parseArgs } from "node:util"
import { heavy } from "@mako/host/base/heavy-packages"
import type { AgentCaller } from "@mako/host/contracts/agents"
import { AGENT_TOOLS, ORCHESTRATION_INSTRUCTIONS, SESSION_VARIABLE, WAIT_LIMIT_MS, type AgentToolDefinition } from "@mako/host/contracts/agent-tools"
import { AgentAnswerSchema, agentToolText, registerAgentTools, type AgentToolDoor } from "@mako/host/conversations/agent-tools"
import { registerThreadTools, ThreadMoveAnswerSchema } from "@mako/host/conversations/thread-move-tool"
import { z } from "zod"
import { localHost, type HostTransport } from "./transport.js"

export const AGENTS_HELP = `  mako agents start <harness> --brief-file <f> [--model <id>] [--reasoning <level>] [--fast|--standard] [--rule <n>] [--access <tier>]
                    [--worktree --branch <b> | --base <b>] [--title <words>] [--name <n>] [--key <k>]
                    [--wait [--timeout <ms>]] [--wake decisions|finish|never] [--thread <ref|id|fin>]…
  mako agents move <fin|all> <harness> [--model <id>] [--reasoning <level>] [--fast|--standard] [--key <k>]
  mako agents list [--tree | --crew | --apexes | --threads [words]]
  mako agents read <fin> [--transcript | --actions] [--report <id>] [--after-ask <id>] [--after-action <id>]
  mako agents report <status> <summary> [--question <q>] [--action <words> --follow-up <target-json>] [--supersedes <id>]… [--key <k>]
  mako agents settle <fin> --report <id> --version <n> --target <json> --disposition <json> [--key <k>]
  mako agents wait [fin…] [--timeout <ms>]
  mako agents send <fin> [words…] [--forward] [--thread <ref|id|fin>]… [--key <k>]
  mako agents stop <fin|all> [--reason <words>]
  mako agents link <harness> <session> [--pid <n>]
  mako mcp [--cwd <folder>]   the same operations, and thread_move, as an MCP server on stdio

  A brief file ending .json is a brief ({objective, doneWhen, boundaries, output}); any other is its objective.
  The caller is the Session ${SESSION_VARIABLE} names, as in a Mako Thread's shell: an Apex, and each Thread it starts
  one of its Fins, named by its name, fin:<name> or its Thread ID. --key repeats a start, report or message.
  --wait holds for the Fin's result (at most ${WAIT_LIMIT_MS / 1000} s); past that, the result starts the caller's next turn.
  send --forward passes on the person's message the caller's turn answers; any words go beneath it.`

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
  fast: { type: "boolean" },
  standard: { type: "boolean" },
  rule: { type: "string" },
  access: { type: "string" },
  worktree: { type: "boolean" },
  branch: { type: "string" },
  base: { type: "string" },
  title: { type: "string" },
  name: { type: "string" },
  key: { type: "string" },
  tree: { type: "boolean" },
  crew: { type: "boolean" },
  apexes: { type: "boolean" },
  transcript: { type: "boolean" },
  actions: { type: "boolean" },
  report: { type: "string" },
  "after-ask": { type: "string" },
  "after-action": { type: "string" },
  action: { type: "string" },
  "follow-up": { type: "string" },
  version: { type: "string" },
  target: { type: "string" },
  disposition: { type: "string" },
  supersedes: { type: "string", multiple: true },
  question: { type: "string" },
  wait: { type: "boolean" },
  wake: { type: "string" },
  timeout: { type: "string" },
  reason: { type: "string" },
  pid: { type: "string" },
  forward: { type: "boolean" },
  threads: { type: "boolean" },
  thread: { type: "string", multiple: true },
} as const
type Parsed = ReturnType<typeof parseArgs<{ args: string[]; allowPositionals: true; options: typeof OPTIONS }>>

/** The Threads a start or a message attaches, one `--thread` each. */
function attached({ thread }: Parsed["values"]): { context?: { thread: string }[] } {
  return thread?.length ? { context: thread.map((ref) => ({ thread: ref })) } : {}
}

/** One `mako agents <verb>`: its input from the arguments, the same host call the in-Thread tool makes. */
async function input(verb: string, { values, positionals }: Parsed, cwd: string): Promise<{ tool: AgentToolDefinition; input: object }> {
  const [first, second, ...more] = positionals
  switch (verb) {
    case "start": {
      if (!first || !values["brief-file"]) throw new Error("agents start needs a harness and --brief-file")
      if ((values.branch || values.base) && !values.worktree) throw new Error("--branch and --base name its worktree: add --worktree")
      if (values.branch && values.base) throw new Error("--branch or --base, not both")
      if (values.timeout && !values.wait) throw new Error("--timeout is how long --wait holds: add --wait")
      if (values.fast && values.standard) throw new Error("--fast or --standard, not both")
      return {
        tool: tool("start"),
        input: {
          harness: first,
          brief: await brief(values["brief-file"]),
          cwd,
          clientKey: values.key ?? randomUUID(),
          ...(values.model && { model: values.model }),
          ...(values.reasoning && { reasoning: values.reasoning }),
          ...((values.fast || values.standard) && { fast: Boolean(values.fast) }),
          ...(values.rule && { rule: Number(values.rule) }),
          ...(values.access && { access: values.access }),
          ...(values.worktree && { workspace: { ...(values.branch && { branch: values.branch }), ...(values.base && { base: values.base }) } }),
          ...(values.title && { title: values.title }),
          ...(values.name && { name: values.name }),
          ...(values.wait && { mode: "wait" }),
          ...(values.wake && { wake: values.wake }),
          ...(values.timeout && { timeoutMs: Number(values.timeout) }),
          ...attached(values),
        },
      }
    }
    case "move": {
      if (!first || !second) throw new Error("agents move needs a Fin, or all, and a harness")
      if (values.fast && values.standard) throw new Error("--fast or --standard, not both")
      return {
        tool: tool("move"),
        input: {
          ...(first === "all" ? { all: true } : { child: first }),
          harness: second,
          clientKey: values.key ?? randomUUID(),
          ...(values.model && { model: values.model }),
          ...(values.reasoning && { reasoning: values.reasoning }),
          ...((values.fast || values.standard) && { fast: Boolean(values.fast) }),
        },
      }
    }
    case "list":
      return { tool: tool("list"), input: values.threads ? { scope: "threads", ...(positionals.length && { query: positionals.join(" ") }) } : values.apexes ? { scope: "apexes" } : values.crew ? { scope: "crew" } : values.tree ? { scope: "tree" } : {} }
    case "read":
      if (!first) throw new Error("agents read needs a Fin")
      return { tool: tool("read"), input: { child: first, ...(values.transcript && { view: "transcript" }), ...(values.actions && { view: "actions" }), ...(values.report !== undefined && { report: values.report }), ...(values["after-ask"] !== undefined && { afterAsk: values["after-ask"] }), ...(values["after-action"] !== undefined && { afterAction: values["after-action"] }) } }
    case "report":
      if (!first || !second) throw new Error("agents report needs a status and a summary")
      return {
        tool: tool("report"),
        input: { status: first, summary: [second, ...more].join(" "), clientKey: values.key ?? randomUUID(), ...(values.question && { question: values.question }), ...(values.action && { action: values.action }), ...(values["follow-up"] !== undefined && { followUp: ReportActionTargetSchema.parse(JSON.parse(values["follow-up"])) }), ...(values.supersedes?.length && { supersedes: values.supersedes }) },
      }
    case "settle":
      if (!first || !values.report || !values.version || !values.target || !values.disposition)
        throw new Error("agents settle needs a Fin, --report, --version, --target JSON and --disposition JSON")
      return { tool: tool("settle"), input: { to: first, report: values.report, version: Number(values.version), target: ReportActionTargetSchema.parse(JSON.parse(values.target)), disposition: ReportDispositionSchema.parse(JSON.parse(values.disposition)), clientKey: values.key ?? randomUUID() } }
    case "wait":
      return {
        tool: tool("wait"),
        input: { ...(positionals.length && { children: positionals }), ...(values.timeout && { timeoutMs: Number(values.timeout) }) },
      }
    case "send": {
      const words = [second, ...more].filter(Boolean).join(" ")
      if (!first || (!words && !values.forward)) throw new Error("agents send needs a Fin and words, or --forward")
      return {
        tool: tool("send"),
        input: { to: first, clientKey: values.key ?? randomUUID(), ...(values.forward && { forward: true }), ...(words && { text: words }), ...attached(values) },
      }
    }
    case "stop":
      if (!first) throw new Error("agents stop needs a Fin, or all")
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
    if (!verb) throw new Error("agents needs a command: start, move, list, read, report, settle, wait, send, stop or link")
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
  registerThreadTools(server, { invoke: async (channel, args) => ThreadMoveAnswerSchema.parse(await transport.call(channel, args)), caller })
  const ended = new Promise<void>((resolve) => process.stdin.once("end", resolve))
  await server.connect(new StdioServerTransport())
  await ended
  await server.close()
}
