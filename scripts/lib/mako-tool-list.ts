import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { AGENT_TOOL_ROLES, type AgentToolRole } from "@mako/host/contracts/agent-tools"
import { registerAgentTools } from "@mako/host/conversations/agent-tools"
import { registerThreadHistoryTools } from "@mako/host/conversations/thread-history"
import { registerThreadTools } from "@mako/host/conversations/thread-move-tool"
import { registerPullRequestTools } from "@mako/host/git/pull-request-tools"
import { registerShowTool } from "@mako/host/media/show-tool"
import { startConversationMcp, type MakoTools } from "@mako/host/tools/conversation-mcp"
import { registerEnvironmentTools } from "@mako/host/workspaces/environment-tools"
import { registerWorkspaceTools } from "@mako/host/workspaces/tools"

/**
 * What an agent's `mako` server lists, built in memory as the host builds it (`startConversationMcp`'s in-process
 * server, every registrar the host hands it): tools/list and the server instructions, for a Thread of each role. The
 * registrars' services are never called by a listing, so each is a stub that answers nothing; the grant's conversation
 * is named after the role it plays, and the agents registrar reads its role from that name. Simulator tools are left
 * out: they're offered only on a Mac whose iOS simulators are set up.
 */
export async function makoToolList(role: AgentToolRole): Promise<{ instructions: string; tools: Tool[] }> {
  const never = (): never => { throw new Error("A listing calls no tool") }
  // SAFETY: a listing only registers tools; nothing reads a service until a tool is called, and this stub throws if one is.
  const stub: never = new Proxy(never, { get: (_target, key) => (key === "then" ? undefined : stub), apply: never }) as never
  const roleOf = (conversation: string | undefined) => AGENT_TOOL_ROLES.find((each) => each === conversation)
  const registrars: MakoTools[] = [
    (server, conversationId) => registerWorkspaceTools(server, stub, conversationId),
    (server, conversationId) => registerEnvironmentTools(server, stub, conversationId),
    (server, conversationId) => registerPullRequestTools(server, stub, conversationId, () => false),
    (server, conversationId) => registerThreadHistoryTools(server, stub, conversationId),
    (server, conversationId) => registerShowTool(server, stub, conversationId),
    (server, _conversationId, conversation) => registerAgentTools(server, stub, roleOf(conversation)),
    (server) => registerThreadTools(server, stub),
  ]
  const servers = await startConversationMcp({ authorizeAgent: () => {} }, async () => null, registrars)
  try {
    const grant = servers.mint("binding", role)
    const server: McpServer | undefined = await grant.makoServer?.()
    if (!server) throw new Error("No in-process mako server")
    const [serverEnd, clientEnd] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "tool-budget", version: "0" })
    await Promise.all([server.connect(serverEnd), client.connect(clientEnd)])
    const { tools } = await client.listTools()
    const instructions = client.getInstructions() ?? ""
    await client.close()
    await server.close()
    return { instructions, tools }
  } finally {
    servers.close()
  }
}
