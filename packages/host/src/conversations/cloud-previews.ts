import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { request as httpsRequest } from "node:https"
import type { AddressInfo, Socket } from "node:net"
import type { WebSocketServer } from "ws"
import { heavy } from "../base/heavy-packages.js"
import { hostLog, hostWarn } from "../base/host-log.js"

/**
 * A cloud Thread's app, served on this Mac as a local Thread's is: each of its ports at `<thread>.cloud.localhost:<port
 * here>`, a name only this Mac answers and whose cookies are its own. Every request goes to the gateway's preview of
 * that port (`/v1/threads/<id>/ports/<port>/…`) as this Mac's device, its body and answer passed through unread, a
 * WebSocket's upgrade included (a dev server's reload). Opening it is what wakes a paused machine; nothing is kept here.
 */
export type CloudPreviewsOptions = {
  /** The gateway's address, while this Mac is signed in to a cloud. */
  gateway(): URL | undefined
  /** A connection token, asked for each request, so a renewed one is used at once. */
  token(): Promise<string | undefined>
}

/** Headers about one hop of a request, never passed on to the next; the gateway's host is the target's own. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"])

type Preview = { threadId: string; port: number; server: Server; sockets: WebSocketServer; address: { host: string; port: number } }

export class CloudPreviews {
  readonly #options: CloudPreviewsOptions
  /** By `<thread>:<port>`, each its own local port, opened on first use. */
  readonly #open = new Map<string, Promise<Preview>>()

  constructor(options: CloudPreviewsOptions) {
    this.#options = options
  }

  /** Where this Mac serves the Thread's port: a host and port for a window's link. Opened once; the same after. */
  async address(threadId: string, port: number): Promise<{ host: string; port: number }> {
    const key = `${threadId}:${port}`
    let opening = this.#open.get(key)
    if (!opening) {
      opening = this.#serve(threadId, port)
      this.#open.set(key, opening)
      opening.catch(() => this.#open.delete(key))
    }
    return (await opening).address
  }

  /** Closes a Thread's previews, or all of them. */
  async close(threadId?: string): Promise<void> {
    const closing: Array<Promise<void>> = []
    for (const [key, opening] of this.#open) {
      if (threadId !== undefined && !key.startsWith(`${threadId}:`)) continue
      this.#open.delete(key)
      closing.push(opening.then((preview) => new Promise<void>((resolve) => {
        preview.sockets.close()
        preview.server.close(() => resolve())
        preview.server.closeAllConnections()
      })).catch(() => undefined))
    }
    await Promise.all(closing)
  }

  async #serve(threadId: string, port: number): Promise<Preview> {
    const { WebSocketServer } = await heavy.ws.load("a cloud Thread's preview")
    const sockets = new WebSocketServer({ noServer: true })
    const server = createServer((request, response) => void this.#forward(threadId, port, request, response))
    server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => void this.#upgrade(threadId, port, sockets, request, socket, head))
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })
    // SAFETY: a server listening on a TCP port answers `address()` with its AddressInfo, never a pipe's name or null.
    const local = server.address() as AddressInfo
    hostLog("cloud-previews", "a cloud Thread's port is served here", { threadId, port, local: local.port })
    return { threadId, port, server, sockets, address: { host: `${threadId}.cloud.localhost`, port: local.port } }
  }

  /** The gateway's URL for a path of the Thread's port, or undefined while signed out. */
  #target(threadId: string, port: number, path: string | undefined): URL | undefined {
    const gateway = this.#options.gateway()
    return gateway ? new URL(`/v1/threads/${threadId}/ports/${port}${path ?? "/"}`, gateway) : undefined
  }

  async #forward(threadId: string, port: number, incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    const target = this.#target(threadId, port, incoming.url)
    const token = await this.#options.token().catch(() => undefined)
    if (!target || !token) {
      outgoing.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("This Mac isn't signed in to Mako Cloud, so the cloud Thread's app can't be reached.")
      return
    }
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value
    headers.authorization = `Bearer ${token}`
    const send = target.protocol === "https:" ? httpsRequest : httpRequest
    const upstream = send(target, { method: incoming.method, headers }, (answer) => {
      const passed: Record<string, string | string[]> = {}
      for (const [name, value] of Object.entries(answer.headers)) if (value !== undefined && !HOP_BY_HOP.has(name)) passed[name] = value
      outgoing.writeHead(answer.statusCode ?? 502, passed)
      answer.pipe(outgoing)
    })
    upstream.on("error", (error) => {
      hostWarn("cloud-previews", "a preview request didn't reach the gateway", { threadId, port, error: error.message })
      if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
      outgoing.end("The cloud Thread's app couldn't be reached.")
    })
    incoming.pipe(upstream)
  }

  async #upgrade(threadId: string, port: number, sockets: WebSocketServer, incoming: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const target = this.#target(threadId, port, incoming.url)
    const token = await this.#options.token().catch(() => undefined)
    if (!target || !token) return void socket.destroy()
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:"
    const protocols = incoming.headers["sec-websocket-protocol"]?.split(",").map((value) => value.trim()).filter(Boolean)
    const { WebSocket } = await heavy.ws.load("a cloud Thread's preview")
    const upstream = new WebSocket(target, protocols, { headers: { authorization: `Bearer ${token}` } })
    upstream.once("error", (error) => {
      hostWarn("cloud-previews", "a preview's WebSocket didn't reach the gateway", { threadId, port, error: error.message })
      socket.destroy()
    })
    upstream.once("open", () => {
      sockets.handleUpgrade(incoming, socket, head, (local) => {
        local.on("message", (data, binary) => upstream.send(data, { binary }))
        upstream.on("message", (data, binary) => local.send(data, { binary }))
        local.on("close", (code, reason) => upstream.close(sendable(code), reason))
        upstream.on("close", (code, reason) => local.close(sendable(code), reason))
        local.on("error", () => upstream.terminate())
        upstream.on("error", () => local.terminate())
      })
    })
  }
}

/** A close code one end may send on: what the other said, or a normal close for one only a library reports (1005, 1006). */
function sendable(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) || (code >= 1001 && code <= 1014 && code !== 1005 && code !== 1006) ? code : 1000
}
