import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { DelegateInputSchema } from "./contracts/conversation-control.js"
import type { LiveConversations } from "./live-conversations.js"
import type { ConversationTools } from "./providers/live-driver.js"

interface Scope {
  conversationId: string
  bindingId: string
  expiresAt: number
  revoked: boolean
}
const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}
function result(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

function toolkit(owner: LiveConversations, scope: Scope): McpServer {
  const server = new McpServer({ name: "mako-conversations", version: "1.0.0" })
  const authorize = (action: "read" | "delegate" = "read") => {
    if (scope.revoked || scope.expiresAt < Date.now())
      throw new Error(
        "This Mako conversation grant is no longer active. Resume the task in Mako."
      )
    owner.authorizeAgent(scope.conversationId, scope.bindingId, action)
  }
  server.registerTool(
    "mako_conversation_capabilities",
    {
      description:
        "List available providers for app-owned child tasks in this conversation.",
      inputSchema: {},
      annotations: readAnnotations,
    },
    () => {
      authorize()
      return result(
        JSON.stringify({
          providers: owner.availableProviders(),
          maxActiveChildren: 4,
        })
      )
    }
  )
  server.registerTool(
    "mako_delegate_task",
    {
      description:
        "Delegate an explicitly authorized bounded subtask to another coding provider. Use only when the user has requested delegation or parallel agents. The child receives only task text. Reuse the same UUID id for retries. Its result is delivered to this parent conversation. Provider defaults apply; no approval bypass is enabled by this tool.",
      inputSchema: DelegateInputSchema,
      annotations: writeAnnotations,
    },
    async (input) => {
      authorize("delegate")
      await owner.delegate(scope.conversationId, input)
      return result(
        JSON.stringify(
          owner
            .childTasks(scope.conversationId)
            .find((child) => child.id === input.id)
        )
      )
    }
  )
  server.registerTool(
    "mako_task_status",
    {
      description:
        "Read this conversation's delegated tasks and delivery status. This does not acknowledge or change a result.",
      inputSchema: {},
      annotations: readAnnotations,
    },
    () => {
      authorize()
      return result(JSON.stringify(owner.childTasks(scope.conversationId)))
    }
  )
  server.registerTool(
    "mako_task_cancel",
    {
      description:
        "Cancel one of this conversation's delegated child tasks and dismiss any queued result. The child cannot be revived by late output.",
      inputSchema: { id: z.string().uuid() },
      annotations: writeAnnotations,
    },
    (input) => {
      authorize()
      owner.cancelChild(scope.conversationId, input.id)
      return result("Child task canceled")
    }
  )
  return server
}

async function readMessage(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 128 * 1024)
      throw new Error("Request exceeds the control message limit")
    chunks.push(buffer)
  }
  return JSONRPCMessageSchema.parse(
    JSON.parse(Buffer.concat(chunks).toString("utf8"))
  )
}

/** Loopback only. Credentials are ephemeral and scoped to a currently executing provider binding. */
export async function startConversationMcp(owner: LiveConversations) {
  const scopes = new Map<string, Scope>()
  const server = createServer((request, response) => {
    void (async () => {
      const token = request.headers.authorization?.replace(/^Bearer /, "")
      const scope = token ? scopes.get(token) : undefined
      if (!scope || scope.revoked || scope.expiresAt < Date.now()) {
        response.writeHead(401).end()
        return
      }
      if (request.url !== "/mcp" || request.method !== "POST") {
        response.writeHead(405).end()
        return
      }
      if (request.headers.origin) {
        response.writeHead(403).end()
        return
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      const mcp = toolkit(owner, scope)
      response.once("close", () => {
        void mcp.close()
      })
      await mcp.connect(transport)
      await transport.handleRequest(
        request,
        response,
        await readMessage(request)
      )
    })().catch(() => {
      if (!response.headersSent) response.writeHead(400)
      response.end()
    })
  })
  server.requestTimeout = 15_000
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || Object.prototype.toString.call(address) === "[object String]")
    throw new Error("No control listener")
  const parsed = z.object({ port: z.number() }).parse(address)
  const url = `http://127.0.0.1:${parsed.port}/mcp`
  return {
    mint(bindingId: string, conversationId: string): ConversationTools {
      for (const [token, scope] of scopes)
        if (scope.expiresAt < Date.now()) scopes.delete(token)
      const token = randomBytes(32).toString("base64url")
      scopes.set(token, {
        bindingId,
        conversationId,
        expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
        revoked: false,
      })
      return { url, token }
    },
    revoke(bindingId: string, conversationId: string): void {
      for (const [token, scope] of scopes)
        if (
          scope.bindingId === bindingId &&
          scope.conversationId === conversationId
        ) {
          scope.revoked = true
          scopes.delete(token)
        }
    },
    close() {
      scopes.clear()
      server.closeAllConnections()
      server.close()
    },
  }
}
