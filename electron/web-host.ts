import { RuntimeDisconnectedError } from "./contracts/host-connection.js"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { once } from "node:events"
import { chmod } from "node:fs/promises"
import { z } from "zod"
import type { HostEvent, TerminalEvent } from "./shared.js"
import { RuntimeCallSchema, type RuntimeInfo, type RuntimeReplySchema } from "./contracts/runtime.js"
import { HOST_CLOSED_CODE, HOST_RECONNECTING_MESSAGE, HOST_RESTARTING_CODE } from "./contracts/host-connection.js"
import { hostLog } from "./host-log.js"

/** Sent to every call still waiting when the host closes, so no client is left to infer a reset. */
const FAREWELL = JSON.stringify({ ok: false, error: HOST_RECONNECTING_MESSAGE, code: HOST_RESTARTING_CODE })
/** Sent to a call that arrives on a lingering connection after the close began; it never ran. */
const REFUSAL = JSON.stringify({ ok: false, error: HOST_RECONNECTING_MESSAGE, code: HOST_CLOSED_CODE })

async function readRequest(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 32 * 1024 * 1024)
      throw new Error("Mako web request exceeds 32 MB")
    chunks.push(buffer)
  }
  return RuntimeCallSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
}

/** Host transport shared by desktop and browser gateways on a private Unix socket. */
export async function startWebHost(
  socket: string,
  invoke: (channel: string, args: unknown[], client?: string) => Promise<string>,
  file: (request: Request, client?: string) => Promise<Response>,
  disconnected?: (client: string) => void,
  runtime?: RuntimeInfo
) {
  const streams = new Map<ServerResponse, { client: string; observer: boolean }>()
  const releases = new Map<string, ReturnType<typeof setTimeout>>()
  const pending = new Set<ServerResponse>()
  let closed = false
  const farewell = (response: ServerResponse, body = FAREWELL) => {
    if (response.destroyed || response.headersSent) return
    response
      .writeHead(200, { "content-type": "application/json", connection: "close" })
      .end(body)
  }
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store")
    if (closed) {
      // A keep-alive connection can still deliver a request after close() began.
      if (request.method === "POST" && request.url === "/rpc") farewell(response, REFUSAL)
      else response.writeHead(503, { connection: "close" }).end()
      return
    }
    if (request.method === "GET" && request.url === "/health" && runtime) {
      if (process.env.MAKO_RUNTIME_TRACE === "1") console.info("[mako-runtime] health requested")
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(runtime))
      return
    }
    const client = z.string().uuid().optional().safeParse(request.headers["x-mako-window"] ?? new URL(request.url ?? "/", "http://localhost").searchParams.get("client") ?? undefined)
    if (!client.success) { response.writeHead(400).end("Invalid workspace client"); return }
    const clientId = client.data ? `web:${client.data}` : "web"
    if (request.method === "GET" && request.url?.startsWith("/file/")) {
      const abort = new AbortController()
      response.once("close", () => abort.abort())
      const headers = new Headers()
      if (request.headers.range) headers.set("range", request.headers.range)
      const url = `mako-file://${request.url.slice("/file/".length)}`
      void Promise.resolve()
        .then(() => file(new Request(url, { headers, signal: abort.signal }), clientId))
        .then(async (result) => {
          response.writeHead(result.status, {
            ...Object.fromEntries(result.headers),
            "content-security-policy": "sandbox; default-src 'none'",
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
          })
          if (result.body)
            for await (const chunk of result.body) {
              if (!response.write(chunk))
                await once(response, "drain", { signal: abort.signal })
            }
          response.end()
        })
        .catch(() => {
          if (!response.headersSent) response.writeHead(404)
          response.end()
        })
      return
    }
    if (request.method !== "POST") {
      response.writeHead(405).end()
      return
    }
    if (request.url === "/events") {
      // A stream's connection is never worth reusing once it ends.
      response.writeHead(200, { "content-type": "application/x-ndjson", connection: "close" })
      response.write(JSON.stringify({ channel: "ready", runtime }) + "\n")
      clearTimeout(releases.get(clientId))
      releases.delete(clientId)
      streams.set(response, { client: clientId, observer: request.headers["x-mako-observer"] === "1" })
      response.once("close", () => {
        streams.delete(response)
        if (!closed && client.data && ![...streams.values()].some((entry) => entry.client === clientId)) {
          const timer = setTimeout(() => { releases.delete(clientId); disconnected?.(clientId) }, 5_000)
          timer.unref()
          releases.set(clientId, timer)
        }
      })
      return
    }
    if (request.url !== "/rpc") {
      response.writeHead(404).end()
      return
    }
    pending.add(response)
    response.once("finish", () => pending.delete(response))
    response.once("close", () => pending.delete(response))
    void readRequest(request)
      .then(async ({ channel, args, attempt }) => {
        // A replayed mutation is answered by its id; the line is the receipt
        // that a dropped call was settled rather than repeated.
        if (attempt !== undefined && attempt > 1) hostLog("rpc", "replayed call", { channel, client: clientId, attempt })
        const encoded = await invoke(
          channel,
          args.map((arg) => (arg.kind === "absent" ? undefined : arg.value)),
          clientId
        )
        // close() may already have answered this call with the farewell.
        if (response.destroyed || response.headersSent) return
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(encoded)
      })
      .catch((error) => {
        const reply: z.input<typeof RuntimeReplySchema> = {
          ok: false, error: error instanceof Error ? error.message : "Mako host request failed",
        }
        if (error instanceof RuntimeDisconnectedError) {
          reply.code = error.conversationId ? "owner-unavailable" : error.unconfirmed ? HOST_RESTARTING_CODE : HOST_CLOSED_CODE
          reply.unconfirmed = error.unconfirmed
          reply.conversationId = error.conversationId
        }
        if (!response.destroyed && !response.headersSent)
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply))
      })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socket, resolve)
  })
  await chmod(socket, 0o600)
  const heartbeat = setInterval(() => {
    for (const stream of streams.keys()) stream.write("\n")
  }, 15_000)
  heartbeat.unref()
  const send = (
    channel: "event" | "terminal",
    payload: HostEvent | TerminalEvent | z.infer<ReturnType<typeof z.json>>,
    client?: string
  ) => {
    const line = JSON.stringify({ channel, payload }) + "\n"
    for (const [stream, owner] of streams) {
      if (client && client !== owner.client) continue
      if (stream.writableLength > 8 * 1024 * 1024)
        stream.destroy(new Error("Web client stopped consuming host events"))
      else stream.write(line)
    }
  }
  return {
    clients: () => [...new Set([...streams.values()].filter((entry) => !entry.observer).map((entry) => entry.client))],
    event: (event: HostEvent, client?: string) => send("event", event, client),
    conversationEvent: (event: z.infer<ReturnType<typeof z.json>>) => send("event", event),
    terminal: (event: TerminalEvent) => send("terminal", event),
    /**
     * Leave without resetting anyone. Every call still waiting gets an explicit
     * "restarting" reply on a connection marked to close, so a client can tell a
     * planned restart from a crash and decide whether the call is safe to repeat.
     * Idle keep-alive connections close now; anything else is swept shortly after.
     */
    close() {
      closed = true
      clearInterval(heartbeat)
      for (const stream of streams.keys()) stream.end()
      streams.clear()
      for (const timer of releases.values()) clearTimeout(timer)
      releases.clear()
      for (const response of pending) farewell(response)
      pending.clear()
      server.close()
      server.closeIdleConnections()
      const sweep = setTimeout(() => server.closeAllConnections(), 250)
      sweep.unref()
    },
  }
}
