import { NATIVE_OVERRIDE } from "../contracts/native-calls.js"
import type { ControlAgentOperation } from "@mako/control-runtime/mcp"
import type { JsonValue } from "@mako/control"
import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"
import { z } from "zod"
import { SHOW_MEDIA_LINE } from "@mako/sessions/turn-media"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { configuredListenPort } from "../base/listen-port.js"
import { heavy } from "../base/heavy-packages.js"
import { ORCHESTRATION_INSTRUCTIONS } from "../contracts/agent-tools.js"

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
    if (scope.revoked || scope.expiresAt < Date.now()) throw new Error("This task grant has expired")
    owner.authorizeAgent(scope.conversationId, scope.bindingId)
    return scope.conversationId
  }
}

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
  "Mako's tools for the Thread this Session belongs to. Each acts on this Thread only. Their words:",
  "- main checkout: the project's own folder, the one the user works in.",
  "- worktree: a Git worktree Mako made for one Thread, on that Thread's own branch.",
  "- checkout: either of these; this Session edits in one.",
  "- project folder: a folder holding several repositories, such as `api` and `web`, that is a project of its own. Its worktree is a folder of the same shape: one worktree per repository, all on the Thread's branch. worktree_status lists the repositories by those names.",
  "- app: the project running from a checkout on this Thread's ports. Threads in the main checkout share its app; a worktree's app is its Thread's alone.",
  "- recipe: how every Thread of the project installs, starts and checks its app. Mako keeps one per project, for every branch.",
  "worktree_*: which checkout this Session edits in; moving it into this Thread's worktree, bringing ignored files from the main checkout, updating its branch from main, merging the branch and removing the worktree. In a project folder they act on every repository at once.",
  "pull_request_*: the pull request of the branch this Session edits on, through the user's GitHub login: its checks, reviews and failed logs; opening or updating it; merging it when the user asks, or on full access as the next step of its work. Each runs the same operation as the Git sidebar's button, so use them instead of `gh pr` commands. A project folder has one pull request per repository: pass repository to name one. Without it they act on the repository this Session's folder is inside, and from the project folder itself pull_request_status reports them all. Commit, push for other reasons, diff and log stay plain Git, run in the repository's own folder.",
  "app_*: this Thread's app. Use them to run and check your work instead of starting servers by hand. In plan mode, app_status, app_logs and app_probe still read the app; if app_start is refused, the user can press Run app.",
  "recipe_*: recipe_guide explains how to set up or repair the recipe; recipe_save saves a draft only this Thread runs, and recipe_publish proves it and publishes it to every Thread. When your change alters how the project installs, starts or is checked, update the recipe in the same turn.",
  "port_holder: who holds a port, before you assume it's free or stop anything.",
  "thread_move: moves this Thread itself to the cloud, as Move to the cloud does, when the person asks to continue it there or keep it going while their Mac is closed. That's this Thread going on elsewhere, not new work for a Fin.",
  `Mako refuses three routes around these tools: \`git worktree add\` and a new branch in the main checkout (use worktree_move, which takes a branch and a base), and \`gh pr merge\` (pull_request_merge). Other native routes, such as \`gh pr create\`, a dev server when the project has a recipe, an agent CLI, or another browser beside mako-computer, still run, with a one-line note naming the better Mako tool; weigh it and choose. ${NATIVE_OVERRIDE} before a refused command runs it anyway, but never a worktree: only when the Mako tool failed or can't do what was asked.`,
  `show: ${SHOW_MEDIA_LINE}`,
  "thread_history: this Thread's earlier turns, every session and harness of it, and the threads its messages referenced, read whole: list, read, search, and any tool output in full. Use it instead of guessing what was said or done before, and when a transcript points to it.",
  ORCHESTRATION_INSTRUCTIONS,
].join("\n")

type Route = "computer" | "mako"

/**
 * A harness's command hook posting one tool call (`/calls/<pre|post|before>`):
 * what it prints back, decided for the grant's conversation. A hook that gets
 * no answer goes on, so a failure here never stops a call.
 */
export type CallGate = (conversationId: string, event: CallGateEvent, body: JsonValue) => JsonValue

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
 * currently executing provider binding; one grant opens both.
 */
export async function startConversationMcp(
  owner: AgentOwner,
  control: (bindingId: string, operation: ControlAgentOperation, signal: AbortSignal) => Promise<JsonValue>,
  makoTools: readonly MakoTools[] = [],
  gate?: CallGate
) {
  const scopes = new Map<string, Scope>()
  const serveMako = makoTools.length > 0
  const server = createServer((request, response) => {
    void (async () => {
      const token = request.headers.authorization?.replace(/^Bearer /, "")
      const scope = token ? scopes.get(token) : undefined
      if (!scope || scope.revoked || scope.expiresAt < Date.now()) {
        response.writeHead(401).end()
        return
      }
      const gated = gatePath(request.url)
      if (gated) {
        if (!gate || request.method !== "POST" || request.headers.origin) {
          response.writeHead(405).end()
          return
        }
        const body = z.json().parse(JSON.parse(await readBody(request, 1024 * 1024)))
        owner.authorizeAgent(scope.conversationId, scope.bindingId)
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(gate(scope.conversationId, gated, body)))
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
      for (const [token, scope] of scopes)
        if (scope.expiresAt < Date.now()) {
          for (const pending of scope.controlRequests.values()) pending.abort()
          scopes.delete(token)
        }
      const token = randomBytes(32).toString("base64url")
      const scope: Scope = {
        bindingId,
        conversationId,
        expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
        revoked: false,
        controlRequests: new Map(),
      }
      scopes.set(token, scope)
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
          scope.revoked = true
          for (const pending of scope.controlRequests.values()) pending.abort()
          scopes.delete(token)
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
      for (const scope of scopes.values())
        for (const pending of scope.controlRequests.values()) pending.abort()
      scopes.clear()
      server.closeAllConnections()
      server.close()
    },
  }
}

/** The servers' listener, minting and revoking each agent's grant. */
export type ConversationMcp = Awaited<ReturnType<typeof startConversationMcp>>
