import { createControlMcpServer, type ControlAgentOperation } from "@mako/control-runtime/mcp"
import type { JsonValue } from "@mako/control"
import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { DelegateInputSchema } from "./contracts/conversation-control.js"
import type { LiveConversations } from "./live-conversations.js"
import type { ConversationTools } from "./providers/live-driver.js"

type ConversationOwner = Pick<LiveConversations, "authorizeAgent" | "availableProviders" | "delegate" | "childTasks" | "cancelChild">

interface Scope {
  conversationId: string
  bindingId: string
  expiresAt: number
  revoked: boolean
  controlRequests: Map<string | number, AbortController>
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

function toolkit(owner: ConversationOwner, scope: Scope): McpServer {
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

async function readMessage(request: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes)
      throw new Error("Request exceeds the control message limit")
    chunks.push(buffer)
  }
  return JSONRPCMessageSchema.parse(
    JSON.parse(Buffer.concat(chunks).toString("utf8"))
  )
}

/** Loopback only. Credentials are ephemeral and scoped to a currently executing provider binding. */
export async function startConversationMcp(
  owner: ConversationOwner,
  control?: (bindingId: string, operation: ControlAgentOperation, signal: AbortSignal) => Promise<JsonValue>
) {
  const scopes = new Map<string, Scope>()
  const server = createServer((request, response) => {
    void (async () => {
      const token = request.headers.authorization?.replace(/^Bearer /, "")
      const scope = token ? scopes.get(token) : undefined
      if (!scope || scope.revoked || scope.expiresAt < Date.now()) {
        response.writeHead(401).end()
        return
      }
      if ((request.url !== "/mcp" && !(control && request.url === "/control")) || request.method !== "POST") {
        response.writeHead(405).end()
        return
      }
      if (request.headers.origin) {
        response.writeHead(403).end()
        return
      }
      const message = await readMessage(request, request.url === "/control" ? 1024 * 1024 : 128 * 1024)
      // HTTP requests use separate stateless MCP transports. Cancellation must
      // find the original call by its grant and JSON-RPC id, not a new server.
      if (request.url === "/control" && "method" in message && message.method === "notifications/cancelled") {
        const cancellation = z.object({ requestId: z.union([z.string(), z.number()]) }).parse(message.params)
        scope.controlRequests.get(cancellation.requestId)?.abort()
        response.writeHead(202).end()
        return
      }
      const controlRequestId = request.url === "/control" && "method" in message && message.method === "tools/call" && "id" in message ? message.id : undefined
      if (controlRequestId !== undefined && scope.controlRequests.has(controlRequestId)) {
        response.writeHead(409).end("This control request is already running; it was not replayed")
        return
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      const disconnected = new AbortController()
      if (controlRequestId !== undefined) scope.controlRequests.set(controlRequestId, disconnected)
      const mcp = request.url === "/control" && control
        ? createControlMcpServer((operation, signal) => {
            if (scope.revoked || scope.expiresAt < Date.now()) throw new Error("This task grant has expired")
            owner.authorizeAgent(scope.conversationId, scope.bindingId, "read")
            return control(scope.bindingId, operation, AbortSignal.any([signal, disconnected.signal]))
          })
        : toolkit(owner, scope)
      response.once("close", () => {
        if (controlRequestId !== undefined) scope.controlRequests.delete(controlRequestId)
        if (!response.writableFinished) disconnected.abort()
        void mcp.close()
      })
      await mcp.connect(transport)
      await transport.handleRequest(
        request,
        response,
        message
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
        if (scope.expiresAt < Date.now()) {
          for (const pending of scope.controlRequests.values()) pending.abort()
          scopes.delete(token)
        }
      const token = randomBytes(32).toString("base64url")
      scopes.set(token, {
        bindingId,
        conversationId,
        expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
        revoked: false,
        controlRequests: new Map(),
      })
      const grant: ConversationTools = { url, token }
      if (control) grant.controlUrl = `http://127.0.0.1:${parsed.port}/control`
      return grant
    },
    revoke(bindingId: string, conversationId: string): void {
      for (const [token, scope] of scopes)
        if (
          scope.bindingId === bindingId &&
          scope.conversationId === conversationId
        ) {
          scope.revoked = true
          for (const pending of scope.controlRequests.values()) pending.abort()
          scopes.delete(token)
        }
    },
    close() {
      for (const scope of scopes.values())
        for (const pending of scope.controlRequests.values()) pending.abort()
      scopes.clear()
      server.closeAllConnections()
      server.close()
    },
  }
}
