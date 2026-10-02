import { createControlMcpServer, type ControlAgentOperation } from "@mako/control-runtime/mcp"
import type { JsonValue } from "@mako/control"
import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type { LiveConversations } from "./live-conversations.js"
import type { ConversationTools } from "./providers/live-driver.js"
import { registerWorkspaceTools, type WorkspaceTools } from "./workspace-tools.js"
import { registerEnvironmentTools, type EnvironmentTools } from "./environment-tools.js"

type ConversationOwner = Pick<LiveConversations, "authorizeAgent">

interface Scope {
  conversationId: string
  bindingId: string
  expiresAt: number
  revoked: boolean
  /** Calls under way, by path and JSON-RPC id: each server's client numbers its own requests. */
  controlRequests: Map<string, AbortController>
}

/** What an agent reads about the `mako` server before calling any of its tools. */
const MAKO_INSTRUCTIONS = [
  "Mako's tools for the Thread this Session belongs to. Each acts on this Thread only.",
  "workspace_*: where this Session edits (the project folder or the Thread's own worktree and branch), moving onto its own branch, merging it and removing its worktree.",
  "app_*: this Thread's own running copy of the project's app, on its own ports, from the project's recipe. Use them to run and check your work instead of starting servers by hand. In plan mode, app_status, app_logs and app_probe still read the app; if app_start is refused, the user can press Run app.",
  "recipe_*: the recipe every Thread of the project runs its app from. recipe_guide explains how to set one up or repair it; recipe_save replaces it. When your change alters how the project installs, starts or is checked, update the recipe in the same turn.",
  "port_holder: who holds a port, before you assume it's free or stop anything.",
].join("\n")

type Route = "computer" | "mako"

/** By path alone: OpenCode adds its own query (`?codemode=false`) to every server's address. */
function routeOf(url: string | undefined): Route | undefined {
  const path = url?.split("?", 1)[0]
  if (path === "/computer") return "computer"
  if (path === "/mako") return "mako"
  return undefined
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

/**
 * Mako's servers for a running agent, over MCP: `/computer` for browser and
 * computer use, and `/mako` for the Thread's worktree, app and recipe.
 * Loopback only, and handed to each agent in its launch, never written to an
 * agent app's own settings. Credentials are ephemeral and scoped to a
 * currently executing provider binding; one grant opens both.
 */
export async function startConversationMcp(
  owner: ConversationOwner,
  control: (bindingId: string, operation: ControlAgentOperation, signal: AbortSignal) => Promise<JsonValue>,
  workspace?: WorkspaceTools,
  environment?: EnvironmentTools
) {
  const scopes = new Map<string, Scope>()
  const serveMako = Boolean(workspace || environment)
  const server = createServer((request, response) => {
    void (async () => {
      const token = request.headers.authorization?.replace(/^Bearer /, "")
      const scope = token ? scopes.get(token) : undefined
      if (!scope || scope.revoked || scope.expiresAt < Date.now()) {
        response.writeHead(401).end()
        return
      }
      const route = routeOf(request.url)
      if (!route || (route === "mako" && !serveMako) || request.method !== "POST") {
        response.writeHead(405).end()
        return
      }
      if (request.headers.origin) {
        response.writeHead(403).end()
        return
      }
      const message = await readMessage(request, 1024 * 1024)
      // HTTP requests use separate stateless MCP transports. Cancellation must
      // find the original call by its grant and JSON-RPC id, not a new server.
      if ("method" in message && message.method === "notifications/cancelled") {
        const cancellation = z.object({ requestId: z.union([z.string(), z.number()]) }).parse(message.params)
        scope.controlRequests.get(`${route}:${cancellation.requestId}`)?.abort()
        response.writeHead(202).end()
        return
      }
      const controlRequestId = "method" in message && message.method === "tools/call" && "id" in message ? `${route}:${message.id}` : undefined
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
      const authorized = () => {
        if (scope.revoked || scope.expiresAt < Date.now()) throw new Error("This task grant has expired")
        owner.authorizeAgent(scope.conversationId, scope.bindingId)
        return scope.conversationId
      }
      const mcp = route === "computer"
        ? createControlMcpServer((operation, signal) => {
            authorized()
            return control(scope.bindingId, operation, AbortSignal.any([signal, disconnected.signal]))
          })
        : new McpServer({ name: "mako", version: "1.0.0" }, { instructions: MAKO_INSTRUCTIONS })
      if (route === "mako" && workspace) registerWorkspaceTools(mcp, workspace, authorized)
      if (route === "mako" && environment) registerEnvironmentTools(mcp, environment, authorized)
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
  const computerUrl = `http://127.0.0.1:${parsed.port}/computer`
  const makoUrl = serveMako ? `http://127.0.0.1:${parsed.port}/mako` : undefined
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
      const tools: ConversationTools = { token, computerUrl }
      if (makoUrl) tools.makoUrl = makoUrl
      return tools
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
