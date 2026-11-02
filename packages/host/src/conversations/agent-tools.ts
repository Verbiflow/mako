import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { MethodTable } from "../base/methods.js"
import type { AgentCaller, AgentRefused } from "../contracts/agents.js"
import {
  AGENT_TOOLS,
  type AgentOperations,
  type AgentToolDefinition,
  type AgentToolFilled,
  type AgentsLinkInput,
  type AgentsListInput,
  type AgentsReadInput,
  type AgentsReportInput,
  type AgentsSendInput,
  type AgentsStartInput,
  type AgentsStopInput,
  type AgentsWaitInput,
} from "../contracts/agent-tools.js"
import { hostCallSchema } from "../contracts/host-call-inputs.js"

const UNAVAILABLE: AgentRefused = { refused: "unavailable", why: "Children need the Thread store, which didn't open on this host." }

/** `mako:agents-<verb>`: every door's one way in, each the engine's operation of the same name. */
export function declareAgentMethods(methods: MethodTable, agents: () => AgentOperations | undefined): void {
  methods.handle("mako:agents-start", (caller: AgentCaller, input: AgentsStartInput) => agents()?.start(caller, input) ?? UNAVAILABLE)
  methods.handle("mako:agents-link", (caller: AgentCaller, input: AgentsLinkInput) => agents()?.link(caller, input) ?? UNAVAILABLE)
  methods.handle("mako:agents-list", (caller: AgentCaller, input: AgentsListInput) => agents()?.list(caller, input) ?? UNAVAILABLE)
  methods.handle("mako:agents-read", (caller: AgentCaller, input: AgentsReadInput) => agents()?.read(caller, input) ?? UNAVAILABLE)
  methods.handle("mako:agents-report", (caller: AgentCaller, input: AgentsReportInput) => agents()?.report(caller, input) ?? UNAVAILABLE)
  methods.handle("mako:agents-send", (caller: AgentCaller, input: AgentsSendInput) => agents()?.send(caller, input) ?? UNAVAILABLE)
  methods.handle("mako:agents-stop", (caller: AgentCaller, input: AgentsStopInput) => agents()?.stop(caller, input) ?? UNAVAILABLE)
  methods.handle("mako:agents-wait", (caller: AgentCaller, input: AgentsWaitInput) => agents()?.wait(caller, input) ?? UNAVAILABLE)
}

/**
 * The MCP input schema of an operation: its host call's generated schema for
 * the input, as JSON Schema, less what the door fills in, each field
 * described for the model.
 */
export function agentToolSchema(tool: AgentToolDefinition): z.ZodType {
  const input = hostCallSchema(tool.channel).def.items[1]
  if (!(input instanceof z.ZodObject)) throw new Error(`${tool.channel}'s input isn't an object`)
  const generated = z.toJSONSchema(input, { io: "input" })
  const asked = (field: string) => !tool.filled.some((filled) => filled === field)
  const properties = Object.entries(generated.properties ?? {}).flatMap(([field, schema]): [string, z.core.JSONSchema._JSONSchema][] => {
    if (!asked(field)) return []
    const description = tool.mcp.fields[field]
    return [[field, description && schema !== true && schema !== false ? { ...schema, description } : schema]]
  })
  return z.fromJSONSchema({ ...generated, properties: Object.fromEntries(properties), required: generated.required?.filter(asked) })
}

/** An operation's answer as a door relays it: the JSON the host sent, a refusal named by `refused`. */
export const AgentAnswerSchema = z.looseObject({ refused: z.string().optional() })
export type AgentAnswer = z.infer<typeof AgentAnswerSchema>

/** What a door says back: the operation's answer as JSON; a refusal's first line names it, so an agent reads why before the fields. */
export function agentToolText(answer: AgentAnswer): string {
  const json = JSON.stringify(answer, null, 2)
  return answer.refused === undefined ? json : `refused: ${answer.refused}\n${json}`
}

/** A model's arguments to a tool, as the MCP schema let them through. */
const ToolArgumentsSchema = z.record(z.string(), z.json())

export interface AgentToolDoor {
  /** Calls the host as a client would (`HostMethods.invoke`), its answer parsed (`AgentAnswerSchema`). */
  invoke(channel: AgentToolDefinition["channel"], args: unknown[]): Promise<AgentAnswer>
  /** Who calls: in a Thread, its Session from the grant its server was opened with. */
  caller(): AgentCaller
  /** What the door fills in (`AgentToolDefinition.filled`), such as the folder the caller works in. */
  filled(): AgentToolFilled
}

/** Every operation on a `mako` server, projected from `AGENT_TOOLS`: the only place any server registers them. */
export function registerAgentTools(server: McpServer, door: AgentToolDoor): void {
  for (const tool of AGENT_TOOLS) {
    server.registerTool(
      tool.mcp.name,
      { description: tool.mcp.description, inputSchema: agentToolSchema(tool), annotations: tool.mcp.annotations },
      async (input) => {
        try {
          const known = door.filled()
          const filled = Object.fromEntries(tool.filled.map((field) => [field, known[field]]))
          const answer = await door.invoke(tool.channel, [door.caller(), { ...filled, ...ToolArgumentsSchema.parse(input) }])
          return { ...(answer.refused !== undefined && { isError: true }), content: [{ type: "text" as const, text: agentToolText(answer) }] }
        } catch (error) {
          return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }
        }
      }
    )
  }
}
