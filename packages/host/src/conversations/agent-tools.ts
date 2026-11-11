import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { machineCall, NOT_THE_PERSON } from "../base/host-client.js"
import type { MethodTable } from "../base/methods.js"
import type { AgentCaller, AgentRefused, AgentsCancelInput, AgentsNoticeInput, AgentsPlaceInput } from "../contracts/agents.js"
import {
  AGENT_TOOLS,
  type AgentOperations,
  type AgentToolDefinition,
  type AgentToolFilled,
  type AgentsAnswerInput,
  type AgentsLinkInput,
  type AgentsListInput,
  type AgentsMoveInput,
  type AgentsReadInput,
  type AgentsReportInput,
  type AgentsSettleInput,
  type AgentsSendInput,
  type AgentsStartInput,
  type AgentsStopInput,
  type AgentsWaitInput,
  type PlacementOperations,
} from "../contracts/agent-tools.js"
import { hostCallSchema } from "../contracts/host-call-inputs.js"
import { AgentListResults } from "./agent-list-results.js"

const UNAVAILABLE: AgentRefused = { refused: "unavailable", why: "Children need the Thread store, which didn't open on this host." }

const MACHINE_AS_PERSON: AgentRefused = { refused: "access", why: NOT_THE_PERSON }

/**
 * `mako:agents-<verb>`: every door's one way in, each the engine's operation of the same name. A machine runtime's call
 * that names the person as its caller is refused before the engine hears it (`machineCall`).
 */
export function declareAgentMethods(methods: MethodTable, agents: () => (AgentOperations & PlacementOperations) | undefined): void {
  const listResults = new AgentListResults()
  const machineAsPerson = (caller: AgentCaller) => caller.kind === "person" && machineCall()
  // Between hosts, for Fins placed across the person's devices: no door shows these to an agent.
  methods.handle("mako:agents-capabilities", () => agents()?.capabilities() ?? UNAVAILABLE)
  methods.handle("mako:agents-place", (input: AgentsPlaceInput) => agents()?.place(input) ?? UNAVAILABLE)
  methods.handle("mako:agents-notice", (input: AgentsNoticeInput) => agents()?.notice(input) ?? UNAVAILABLE)
  methods.handle("mako:agents-cancel", (input: AgentsCancelInput) => agents()?.cancel(input) ?? UNAVAILABLE)
  methods.handle("mako:agents-start", (caller: AgentCaller, input: AgentsStartInput) => machineAsPerson(caller) ? MACHINE_AS_PERSON : agents()?.start(caller, input) ?? UNAVAILABLE)
  methods.handle("mako:agents-move", (caller: AgentCaller, input: AgentsMoveInput) => machineAsPerson(caller) ? MACHINE_AS_PERSON : agents()?.move(caller, input) ?? UNAVAILABLE)
  methods.handle("mako:agents-link", (caller: AgentCaller, input: AgentsLinkInput) => machineAsPerson(caller) ? MACHINE_AS_PERSON : agents()?.link(caller, input) ?? UNAVAILABLE)
  methods.handle("mako:agents-list", async (caller: AgentCaller, input: AgentsListInput) => {
    if (machineAsPerson(caller)) return MACHINE_AS_PERSON
    const result = await agents()?.list(caller, input) ?? UNAVAILABLE
    return input.presentation === "summary" ? listResults.summarize(caller, result) : result
  })
  methods.handle("mako:agents-read", async (caller: AgentCaller, input: AgentsReadInput) => {
    if (machineAsPerson(caller)) return MACHINE_AS_PERSON
    const service = agents()
    if (!service) return UNAVAILABLE
    if (input.view === "pulls" && input.afterAction !== undefined) return { refused: "conflict", why: "afterAction applies to report follow-up pages, not PR snapshots." } satisfies AgentRefused
    if (input.view === "pulls") return listResults.read(caller, await service.read(caller, { child: input.child, view: "report", maxChars: 200 }), input)
    if (input.snapshot !== undefined || input.offset !== undefined || input.limit !== undefined)
      return { refused: "conflict", why: "snapshot, offset and limit apply only to view pulls." } satisfies AgentRefused
    return service.read(caller, input)
  })
  methods.handle("mako:agents-report", (caller: AgentCaller, input: AgentsReportInput) => machineAsPerson(caller) ? MACHINE_AS_PERSON : agents()?.report(caller, input) ?? UNAVAILABLE)
  methods.handle("mako:agents-send", (caller: AgentCaller, input: AgentsSendInput) => machineAsPerson(caller) ? MACHINE_AS_PERSON : agents()?.send(caller, input) ?? UNAVAILABLE)
  methods.handle("mako:agents-settle", (caller: AgentCaller, input: AgentsSettleInput) => machineAsPerson(caller) ? MACHINE_AS_PERSON : agents()?.settle(caller, input) ?? UNAVAILABLE)
  methods.handle("mako:agents-answer", (caller: AgentCaller, input: AgentsAnswerInput) => machineAsPerson(caller) ? MACHINE_AS_PERSON : agents()?.answer(caller, input) ?? UNAVAILABLE)
  methods.handle("mako:agents-stop", (caller: AgentCaller, input: AgentsStopInput) => machineAsPerson(caller) ? MACHINE_AS_PERSON : agents()?.stop(caller, input) ?? UNAVAILABLE)
  methods.handle("mako:agents-wait", (caller: AgentCaller, input: AgentsWaitInput) => machineAsPerson(caller) ? MACHINE_AS_PERSON : agents()?.wait(caller, input) ?? UNAVAILABLE)
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

/**
 * What a door says back: the operation's answer as JSON on one line, every field kept (indentation was a third of a
 * list's tokens); a refusal's first line names it, so an agent reads why before the fields.
 */
export function agentToolText(answer: AgentAnswer): string {
  const json = JSON.stringify(answer)
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
