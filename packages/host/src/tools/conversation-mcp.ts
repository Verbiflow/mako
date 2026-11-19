import type { ControlAgentOperation } from "@mako/control-runtime/mcp"
import type { JsonValue } from "@mako/control"
import type { ToolSteps } from "../contracts/tool-steps.js"
import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { configuredListenPort } from "../base/listen-port.js"
import { heavy } from "../base/heavy-packages.js"
import { MAKO_SERVER_INSTRUCTIONS } from "../contracts/primer.js"
import { INSTRUCTIONS_PARAM } from "../contracts/mcp-reach.js"
import { hostLog } from "../base/host-log.js"

/** Whose agents call: it throws unless `bindingId` is the conversation's binding that is running now. */
export interface AgentOwner {
  authorizeAgent(conversationId: string, bindingId: string): void
}

/** Adds tools to the `mako` server; `conversationId` throws once the agent's grant no longer holds. */
export type MakoTools = (server: McpServer, conversationId: () => string) => void

/** A running agent's grant to Mako's servers, both opened with `token`; `makoUrl` when the host serves `mako`. */
export interface ToolGrant {
  token: string
  computerUrl: string
  makoUrl?: string
  /**
   * The same `mako` server built in this process, for an SDK that runs a
   * server instance beside its agent (Claude's `type: "sdk"`). Each call is
   * held to the grant as an HTTP call is.
   */
  makoServer?: () => Promise<McpServer>
}

/** `conversationId` for a scope's calls, throwing once its grant no longer holds. */
function scopeAuthorizer(owner: AgentOwner, scope: Scope): () => string {
  return () => {
    if (scope.revoked) throw new Error("This task grant is no longer active")
    owner.authorizeAgent(scope.conversationId, scope.bindingId)
    return scope.conversationId
  }
}

interface Scope {
  conversationId: string
  bindingId: string
  revoked: boolean
  /** Calls under way, by path and JSON-RPC id: each server's client numbers its own requests. */
  controlRequests: Map<string, AbortController>
}

/** What an agent reads about the `mako` server before calling any of its tools (`contracts/primer.ts`). */
export const MAKO_INSTRUCTIONS = MAKO_SERVER_INSTRUCTIONS

/**
 * The `mako` server's options for a request to `url`. `?instructions=0`
 * (`withoutInstructions`) serves it with none, for a harness that hears
 * them as Mako's `server` block instead: Codex repeats a server's
 * instructions on every one of its tools a lookup returns.
 */
export function makoServerOptions(url: string | undefined): { instructions?: string } {
  const query = url?.split("?", 2)[1]
  return new URLSearchParams(query).get(INSTRUCTIONS_PARAM) === "0" ? {} : { instructions: MAKO_INSTRUCTIONS }
}

type Route = "computer" | "mako"

/**
 * A harness's command hook posting one tool call (`/calls/<pre|post|before>`):
 * what it prints back, decided for the grant's conversation and its provider
 * binding. A hook that gets no answer goes on, so a failure here never stops a
 * call. The answer may wait: the harness holds the tool until it comes, as a
 * turn's checkpoint holds its first write (`WriteHolds`).
 */
export type CallGate = (conversationId: string, event: CallGateEvent, body: JsonValue, binding: string) => JsonValue | Promise<JsonValue>

/** `pre` and `post` hook a call before and after it runs; `before` is a harness that reads a note before the call as well as a deny. */
export type CallGateEvent = "pre" | "post" | "before"

function gatePath(url: string | undefined): CallGateEvent | undefined {
  const path = url?.split("?", 1)[0]
  return path === "/calls/pre" ? "pre" : path === "/calls/post" ? "post" : path === "/calls/before" ? "before" : undefined
}

/** By path alone: OpenCode adds its own query (`?codemode=false`) to every server's address. */
function routeOf(url: string | undefined): Route | undefined {
  const path = url?.split("?", 1)[0]
  if (path === "/computer") return "computer"
  if (path === "/mako") return "mako"
  return undefined
}

async function readBody(request: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes)
      throw new Error("Request exceeds the control message limit")
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * Mako's servers for a running agent, over MCP: `/computer` for browser and
 * computer use, and `/mako` for the Thread's worktree, pull request, app and recipe.
 * Loopback only, and handed to each agent in its launch, never written to an
 * agent app's own settings. Credentials are ephemeral and scoped to a
 * currently executing provider binding; one grant opens both. A provider can stay resident for days, including
 * between turns: its grant ends with explicit binding revocation or server closure, not elapsed wall time. Each
 * operation still checks the current binding and running turn through `authorizeAgent`.
 */
export async function startConversationMcp(
  owner: AgentOwner,
  control: (bindingId: string, operation: ControlAgentOperation, signal: AbortSignal, steps?: (steps: ToolSteps) => void) => Promise<JsonValue>,
  makoTools: readonly MakoTools[] = [],
  gate?: CallGate,
  /** Hears a conversation's running js call's steps as they change, and `null` once it answered. */
  stepsOf?: (conversationId: string, steps: ToolSteps | null) => void
) {
  const scopes = new Map<string, Scope>()
  const retire = (token: string, scope: Scope, reason: "revoked" | "server-closed") => {
    scope.revoked = true
    for (const pending of scope.controlRequests.values()) pending.abort()
    scopes.delete(token)
    hostLog("agent-tools", "retired a task grant", { conversation: scope.conversationId, binding: scope.bindingId, reason })
  }
  const serveMako = makoTools.length > 0
  const server = createServer((request, response) => {
    void (async () => {
      const token = request.headers.authorization?.replace(/^Bearer /, "")
      const scope = token ? scopes.get(token) : undefined
      if (!token || !scope || scope.revoked) {
        response.writeHead(401).end()
        return
      }
      const authorized = scopeAuthorizer(owner, scope)
      const gated = gatePath(request.url)
      if (gated) {
        if (!gate || request.method !== "POST" || request.headers.origin) {
          response.writeHead(405).end()
          return
        }
        const body = z.json().parse(JSON.parse(await readBody(request, 1024 * 1024)))
        authorized()
        const answer = await gate(scope.conversationId, gated, body, scope.bindingId)
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer))
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
      const [{ McpServer, StreamableHTTPServerTransport, createControlMcpServer }, { JSONRPCMessageSchema }] =
        await Promise.all([heavy.mcpServer.load("agent MCP request"), heavy.mcpTypes.load("agent MCP request")])
      const message = JSONRPCMessageSchema.parse(JSON.parse(await readBody(request, 1024 * 1024)))
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
      const mcp = route === "computer"
        ? createControlMcpServer(async (operation, signal) => {
            authorized()
            const stepped = stepsOf && operation.method === "js" ? stepsOf : undefined
            try {
              return await control(scope.bindingId, operation, AbortSignal.any([signal, disconnected.signal]),
                stepped && ((steps) => stepped(scope.conversationId, steps)))
            } finally {
              stepped?.(scope.conversationId, null)
            }
          })
        : new McpServer({ name: "mako", version: "1.0.0" }, makoServerOptions(request.url))
      if (route === "mako") for (const register of makoTools) register(mcp, authorized)
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
    server.listen(configuredListenPort("MAKO_CONVERSATION_MCP_PORT"), "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || Object.prototype.toString.call(address) === "[object String]")
    throw new Error("No control listener")
  const parsed = z.object({ port: z.number() }).parse(address)
  const computerUrl = `http://127.0.0.1:${parsed.port}/computer`
  const makoUrl = serveMako ? `http://127.0.0.1:${parsed.port}/mako` : undefined
  return {
    mint(bindingId: string, conversationId: string): ToolGrant {
      const token = randomBytes(32).toString("base64url")
      const scope: Scope = {
        bindingId,
        conversationId,
        revoked: false,
        controlRequests: new Map(),
      }
      scopes.set(token, scope)
      hostLog("agent-tools", "issued a task grant", { conversation: conversationId, binding: bindingId })
      const grant: ToolGrant = { token, computerUrl }
      if (makoUrl) {
        grant.makoUrl = makoUrl
        grant.makoServer = async () => {
          const { McpServer } = await heavy.mcpServer.load("an agent's in-process mako server")
          const mako = new McpServer({ name: "mako", version: "1.0.0" }, { instructions: MAKO_INSTRUCTIONS })
          const authorized = scopeAuthorizer(owner, scope)
          for (const register of makoTools) register(mako, authorized)
          return mako
        }
      }
      return grant
    },
    revoke(bindingId: string, conversationId: string): void {
      for (const [token, scope] of scopes)
        if (
          scope.bindingId === bindingId &&
          scope.conversationId === conversationId
        ) {
          retire(token, scope, "revoked")
        }
    },
    /**
     * Loads what the first request would, so a machine's first session doesn't wait on it: on a copy that request took
     * 190-200 ms (the MCP SDK and the control runtime loaded and built), each after it 2-5 ms (2026-10-21). Builds the
     * servers a request builds, answering nothing, and closes them.
     */
    async warm(): Promise<void> {
      const [{ McpServer, createControlMcpServer }] = await Promise.all([heavy.mcpServer.load("Mako's MCP servers, warmed"), heavy.mcpTypes.load("Mako's MCP servers, warmed")])
      const unused = (): never => { throw new Error("A warmed server answers nothing") }
      const servers = [createControlMcpServer(async () => unused())]
      if (serveMako) {
        const mako = new McpServer({ name: "mako", version: "1.0.0" }, { instructions: MAKO_INSTRUCTIONS })
        for (const register of makoTools) register(mako, unused)
        servers.push(mako)
      }
      await Promise.all(servers.map((each) => each.close()))
    },
    close() {
      for (const [token, scope] of scopes) retire(token, scope, "server-closed")
      server.closeAllConnections()
      server.close()
    },
  }
}

/** The servers' listener, minting and revoking each agent's grant. */
export type ConversationMcp = Awaited<ReturnType<typeof startConversationMcp>>
