import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { isAbsolute } from "node:path"
import { z } from "zod"
import type { BackgroundAgents } from "./background-agents.js"

export interface BackgroundAgentToolsDeps {
  agents(): BackgroundAgents | undefined
  /** The conversation's folder, where an agent starts unless told otherwise. */
  cwd(conversation: string): string | undefined
  /** The harnesses a background agent can run on here. */
  harnesses(): readonly string[]
}

const START = [
  "Start another agent in the background, on a harness's own CLI (claude, cursor, codex, …), to work for this conversation past this turn.",
  "Use it instead of running an agent CLI from the shell with nohup: it runs detached from you and from Mako, shows under this conversation in the person's Agents menu with its harness, state and steps, and its transcript opens from there.",
  "Returns its id at once; agent_list says how it goes, agent_stop stops it.",
].join(" ")
const LINK = "Show an agent CLI run this conversation started from its shell under this conversation, as agent_start's are: its harness and session ID, and its pid while it still runs (leave pid out for one that ended). Runs a shell started are usually found on their own."
const LIST = "This conversation's background agents: id, harness, title, state, its last step and its session."
const STOP = "Stop one of this conversation's background agents, by its id from agent_start or agent_list, with everything its process started."

async function reply(work: () => Promise<string> | string) {
  try {
    return { content: [{ type: "text" as const, text: await work() }] }
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }
  }
}

function service(deps: BackgroundAgentToolsDeps): BackgroundAgents {
  const agents = deps.agents()
  if (!agents) throw new Error("Background agents aren't available on this host.")
  return agents
}

/** `agent_start`, `agent_link`, `agent_list` and `agent_stop` on a conversation's `mako` server. */
export function registerBackgroundAgentTools(server: McpServer, deps: BackgroundAgentToolsDeps, conversationId: () => string): void {
  server.registerTool(
    "agent_start",
    {
      description: START,
      inputSchema: z.object({
        harness: z.string().min(1).max(64).describe("The CLI to run: claude, cursor, codex, grok, opencode or devin."),
        prompt: z.string().min(1).max(200_000).describe("Everything it needs to know: it sees none of this conversation."),
        title: z.string().max(120).optional().describe("A few words the person sees for it."),
        model: z.string().max(256).optional(),
        cwd: z.string().max(4096).optional().describe("An absolute folder to run in; this conversation's by default."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (input) => reply(async () => {
      const conversation = conversationId()
      const harnesses = deps.harnesses()
      if (!harnesses.includes(input.harness)) throw new Error(`${input.harness} can't run a background agent here; these can: ${harnesses.join(", ")}.`)
      const cwd = input.cwd ?? deps.cwd(conversation)
      if (!cwd || !isAbsolute(cwd)) throw new Error("Name an absolute folder for it to run in.")
      const record = await service(deps).start(conversation, { harness: input.harness, prompt: input.prompt, cwd, title: input.title, model: input.model })
      return `Started ${record.id} on ${record.harness}${record.nativeId ? `, session ${record.nativeId}` : ""}. It shows under this conversation in the Agents menu; agent_list says how it goes.`
    })
  )
  server.registerTool(
    "agent_link",
    {
      description: LINK,
      inputSchema: z.object({
        harness: z.string().min(1).max(64),
        session: z.string().min(1).max(512).describe("Its harness's ID for its session."),
        pid: z.number().int().positive().optional().describe("Its process, while it runs."),
        title: z.string().max(120).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => reply(async () => {
      const record = await service(deps).link(conversationId(), input)
      return `${record.id} shows under this conversation${record.ended ? `, ended (${record.ended.kind})` : ""}.`
    })
  )
  server.registerTool(
    "agent_list",
    {
      description: LIST,
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => reply(() => service(deps).describe(conversationId()))
  )
  server.registerTool(
    "agent_stop",
    {
      description: STOP,
      inputSchema: z.object({ agent: z.string().min(1).max(64) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (input) => reply(async () => (await service(deps).stop(conversationId(), input.agent))
      ? `Stopped ${input.agent}.`
      : `${input.agent} isn't running on this device, or isn't this conversation's.`)
  )
}
