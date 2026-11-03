import { randomUUID } from "node:crypto"
import { z } from "zod"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { AFTER_START, AGENT_TOOLS, type AgentsAnswered, type AgentsCrew, type AgentsListResult, type AgentsSent, type AgentsStarted, type AgentsWaitResult, type AgentToolDefinition } from "@mako/host/contracts/agent-tools"
import type { JsonValue } from "@mako/host/contracts/json"
import { registerAgentTools, type AgentAnswer } from "@mako/host/conversations/agent-tools"
import { startConversationMcp } from "@mako/host/tools/conversation-mcp"
import { FIN_NAME, ToolArgs, type Call } from "./cases.ts"

/**
 * Mako's own `mako` server for the eval: the conversation server a Thread's
 * agent reaches, with every `agents_*` tool as `registerAgentTools` projects
 * it from `AGENT_TOOLS` (so the shapes can't drift), answered by a door that
 * records each call and starts nothing. A start answers as a running child
 * would; a list, the children started so far.
 */
export interface StubMako {
  /** The grant one launch's agent gets (`ConversationTools`). */
  grant(conversation: string): { token: string; computerUrl: string; makoUrl?: string }
  /** The `agents_*` calls so far, by bare tool name. */
  calls(conversation: string): Call[]
  /** What an agent reads first: the server's instructions and its `agents_*` tools. */
  describe(): Promise<{ instructions: string; tools: { name: string; description: string; inputSchema: JsonValue }[] }>
  close(): Promise<void>
}

const toolOf = (channel: AgentToolDefinition["channel"]) => AGENT_TOOLS.find((tool) => tool.channel === channel)!.mcp.name

/** What the stub answers a call, given the children it started for the same conversation. */
const Named = z.object({ name: z.string().optional() }).catch({})
const Scoped = z.object({ scope: z.string().optional() }).catch({})
const Sent = z.object({ to: z.string().optional() }).catch({})

/** An Apex's Fins a case starts with, as the stub lists them. */
export function startedAlready(names: readonly string[]): AgentsStarted[] {
  return names.map((name, index) => ({ child: randomUUID(), name, state: "working", tree: { running: index + 1, started: index + 1, of: { running: 8, started: 32 } }, next: AFTER_START }))
}

export function stubAnswer(tool: string, args: ToolArgs, started: AgentsStarted[]): AgentAnswer {
  const tree = { running: started.length, started: started.length, of: { running: 8, started: 32 } }
  if (tool === "agents_start") {
    const name = Named.parse(args).name ?? `child-${started.length + 1}`
    const child: AgentsStarted = { child: randomUUID(), name, state: "working", tree: { ...tree, running: tree.running + 1, started: tree.started + 1 }, next: AFTER_START }
    started.push(child)
    return { ...child }
  }
  if (tool === "agents_list" && Scoped.parse(args).scope === "crew") {
    const crew: AgentsCrew = {
      you: FIN_NAME,
      apex: { title: "acme-app router", harness: "Codex", working: true, step: "Read src/router.ts" },
      crew: [{ name: "router", harness: "Claude", state: { kind: "working", step: "Edit src/utils.ts" }, topic: "Port the handlers in src/handlers to the new router.", branch: "router-port" }],
    }
    return { ...crew }
  }
  if (tool === "agents_list") {
    const listed: AgentsListResult = {
      children: started.map((child) => ({ child: child.child ?? child.name, name: child.name, harness: "codex", origin: "started", state: { kind: "working" }, startedAt: Date.now() - 60_000 })),
      tree,
    }
    return { ...listed }
  }
  if (tool === "agents_send") {
    const to = Sent.parse(args).to ?? "child"
    const sent: AgentsSent = { child: randomUUID(), name: to.replace(/^child:/, ""), request: randomUUID(), delivery: "turn" }
    return { ...sent }
  }
  if (tool === "agents_answer") {
    const answer = z.object({ to: z.string().optional(), person: z.boolean().optional(), allow: z.boolean().optional() }).catch({}).parse(args)
    const answered: AgentsAnswered = { child: randomUUID(), name: (answer.to ?? "child").replace(/^fin:/, ""), answered: answer.person ? "person" : answer.allow === undefined ? "question" : "approval" }
    return { ...answered }
  }
  if (tool === "agents_wait") {
    const waited: AgentsWaitResult = { reports: [], cursor: 0, timedOut: true }
    return { ...waited }
  }
  return { ok: true }
}

export async function startStubMako(): Promise<StubMako> {
  const calls = new Map<string, Call[]>()
  const started = new Map<string, AgentsStarted[]>()
  const servers = await startConversationMcp(
    { authorizeAgent() {} },
    async () => { throw new Error("The eval's computer server answers nothing") },
    [(server, conversationId) => registerAgentTools(server, {
      invoke: async (channel, [, input]) => {
        const conversation = conversationId()
        const tool = toolOf(channel)
        const args = ToolArgs.parse(input)
        calls.set(conversation, [...calls.get(conversation) ?? [], { tool, args }])
        const children = started.get(conversation) ?? []
        started.set(conversation, children)
        return stubAnswer(tool, args, children)
      },
      caller: () => ({ kind: "agent", session: conversationId() }),
      filled: () => ({}),
    })],
  )
  const grants = new Map<string, ReturnType<typeof servers.mint>>()
  return {
    grant(conversation) {
      const grant = servers.mint(`eval-${conversation}`, conversation)
      grants.set(conversation, grant)
      return grant
    },
    calls: (conversation) => calls.get(conversation) ?? [],
    async describe() {
      const conversation = `describe-${randomUUID()}`
      const grant = servers.mint(`eval-${conversation}`, conversation)
      const client = new Client({ name: "eval-orch-tools", version: "1.0.0" })
      await client.connect(new StreamableHTTPClientTransport(new URL(grant.makoUrl!), { requestInit: { headers: { authorization: `Bearer ${grant.token}` } } }))
      try {
        const listed = await client.listTools()
        return {
          instructions: client.getInstructions() ?? "",
          tools: listed.tools.filter((tool) => tool.name.startsWith("agents_")).map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: z.json().parse(tool.inputSchema) })),
        }
      } finally {
        await client.close()
        servers.revoke(`eval-${conversation}`, conversation)
      }
    },
    async close() {
      for (const [conversation] of grants) servers.revoke(`eval-${conversation}`, conversation)
      servers.close()
    },
  }
}
