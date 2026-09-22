import { request } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import { LineAssembler } from "@mako/sessions"
import { RuntimeCallSchema, RuntimeInfoSchema, RuntimePacketSchema, RuntimeReplySchema, type RuntimeCall } from "./contracts/runtime.js"
import { HOST_CALL_UNCONFIRMED_MESSAGE, HOST_CLOSED_CODE, HOST_RECONNECTING_MESSAGE, HOST_RESTARTING_CODE } from "./contracts/host-connection.js"
import type { z } from "zod"

/**
 * The host stopped answering while a call was out. `unconfirmed` is true when
 * the request may have reached the host before the connection dropped; a
 * connection that was refused outright never dispatched anything.
 */
export class RuntimeDisconnectedError extends Error {
  readonly code = "host-disconnected"
  readonly unconfirmed: boolean
  constructor(unconfirmed: boolean) {
    super(unconfirmed ? HOST_CALL_UNCONFIRMED_MESSAGE : HOST_RECONNECTING_MESSAGE)
    this.name = "RuntimeDisconnectedError"
    this.unconfirmed = unconfirmed
  }
}

// No socket, a socket nobody accepts on, or a plain file where the socket was: nothing listens.
const REFUSED = new Set(["ECONNREFUSED", "ENOENT", "ENOTSOCK"])
const DROPPED = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED"])
function socketCode(error: Error): string | undefined {
  if ("code" in error) return String(error.code)
  // Node reports a connection closed before any response as a bare "socket hang up".
  return error.message === "socket hang up" ? "ECONNRESET" : undefined
}

/** Nothing is listening on the socket: no host owns it and one may be started. */
function refused(error: Error): boolean {
  const code = socketCode(error)
  return code !== undefined && REFUSED.has(code)
}

/**
 * The typed disconnect a failed request stands for, or `null` when it failed
 * for a reason other than the host leaving: a refusal never dispatched
 * anything, a dropped socket may have.
 */
function disconnection(error: Error): RuntimeDisconnectedError | null {
  if (error instanceof RuntimeDisconnectedError) return error
  const code = socketCode(error)
  if (code && REFUSED.has(code)) return new RuntimeDisconnectedError(false)
  if (code && DROPPED.has(code)) return new RuntimeDisconnectedError(true)
  return null
}

interface RuntimeRequest<Schema extends z.ZodType> {
  socket: string
  path: string
  schema: Schema
  body?: RuntimeCall
  client?: string
  timeoutMs?: number
}

export async function runtimeRequest<Schema extends z.ZodType>({ socket, path, schema, body, client, timeoutMs = 45_000 }: RuntimeRequest<Schema>): Promise<z.output<Schema>> {
  return new Promise((resolve, reject) => {
    const headers = new Map([["content-type", "application/json"]])
    if (client) headers.set("x-mako-window", client)
    const req = request({ socketPath: socket, path, method: body === undefined ? "GET" : "POST", headers: Object.fromEntries(headers) }, (response) => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 32 * 1024 * 1024) response.destroy(new Error("Mako host response exceeded its limit"))
        else chunks.push(chunk)
      })
      response.on("error", reject)
      response.on("end", () => {
        try {
          // A host whose close() has begun answers anything but an RPC with 503 on a closing connection.
          if (response.statusCode === 503) throw new RuntimeDisconnectedError(false)
          if (response.statusCode !== 200) throw new Error(`Mako host returned ${response.statusCode}`)
          resolve(schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))))
        } catch (error) { reject(error) }
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Mako host request timed out")))
    req.on("error", reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

export type RuntimeInfo = z.output<typeof RuntimeInfoSchema>

/**
 * What a health probe found. `absent`: nothing listens, a host may be started.
 * `closing`: a host still owns the socket but is on its way out, or answered a
 * connection it was already tearing down; treating it as absent races its
 * lock and treating it as a failure aborts work that only needed to wait.
 */
export type RuntimeProbe =
  | { state: "absent" }
  | { state: "closing" }
  | { state: "ready"; info: RuntimeInfo }

export async function probeRuntime(socket: string, options: { timeoutMs?: number } = {}): Promise<RuntimeProbe> {
  try {
    return { state: "ready", info: await runtimeRequest({ socket, path: "/health", schema: RuntimeInfoSchema, timeoutMs: options.timeoutMs ?? 10_000 }) }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    if (refused(error)) return { state: "absent" }
    if (disconnection(error)) return { state: "closing" }
    throw error
  }
}

/**
 * Probe until the host has either left or answered. A host that is closing
 * holds its socket for well under a second; a caller that saw `closing` and
 * acted on it would start a second host into the old one's lock or give up
 * on an install that only needed to wait. Still `closing` at the deadline is
 * returned as such so the caller can refuse explicitly.
 */
export async function settleRuntime(socket: string, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<RuntimeProbe> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000)
  for (;;) {
    const probe = await probeRuntime(socket)
    if (probe.state !== "closing" || Date.now() >= deadline) return probe
    await delay(options.intervalMs ?? 100)
  }
}

/**
 * The host's identity, or `null` when nothing listens. A host that is closing
 * is neither: it throws the same typed disconnect a call would, so no caller
 * mistakes a departing host for a free socket.
 */
export async function runtimeInfo(socket: string): Promise<RuntimeInfo | null> {
  const probe = await probeRuntime(socket)
  if (probe.state === "ready") return probe.info
  if (probe.state === "absent") return null
  throw new RuntimeDisconnectedError(false)
}

export async function invokeRuntime(socket: string, client: string, channel: string, args: unknown[], attempt = 1, options?: { timeoutMs: number }) {
  const encoded = JSON.stringify({
    channel,
    args: args.map((value) => value === undefined ? { kind: "absent" } : { kind: "value", value }),
    attempt: attempt > 1 ? attempt : undefined,
  })
  const body = RuntimeCallSchema.parse(JSON.parse(encoded))
  let reply: z.output<typeof RuntimeReplySchema>
  try {
    reply = await runtimeRequest({ socket, path: "/rpc", schema: RuntimeReplySchema, body, client, timeoutMs: options?.timeoutMs ?? 5 * 60_000 })
  } catch (error) {
    throw error instanceof Error ? (disconnection(error) ?? error) : error
  }
  if (!reply.ok) {
    if (reply.code === HOST_RESTARTING_CODE) throw new RuntimeDisconnectedError(true)
    if (reply.code === HOST_CLOSED_CODE) throw new RuntimeDisconnectedError(false)
    throw new Error(reply.error)
  }
  return reply.value
}

export function subscribeRuntime(socket: string, client: string, receive: (packet: z.infer<typeof RuntimePacketSchema>) => void, disconnected: () => void, options: { observer?: boolean } = {}) {
  let closed = false
  let ended = false
  const end = () => { if (!ended && !closed) { ended = true; disconnected() } }
  const headers = new Map([["x-mako-window", client]])
  if (options.observer) headers.set("x-mako-observer", "1")
  const req = request({ socketPath: socket, path: "/events", method: "POST", headers: Object.fromEntries(headers) }, (response) => {
    const lines = new LineAssembler(32 * 1024 * 1024)
    if (response.statusCode !== 200) { response.destroy(); end(); return }
    response.on("data", (chunk: Buffer) => {
      const complete = lines.push(chunk)
      if (!complete) { response.destroy(); end(); return }
      for (const line of complete) {
        if (!line.trim()) continue
        try { receive(RuntimePacketSchema.parse(JSON.parse(line))) }
        catch { response.destroy(); end(); return }
      }
    })
    response.on("error", end)
    response.on("end", end)
    response.on("close", end)
  })
  req.on("error", end)
  req.end()
  return () => { closed = true; req.destroy() }
}

export function runtimeFile(socket: string, input: Request): Promise<Response> {
  const url = new URL(input.url)
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: `/file/${url.hostname}${url.pathname}${url.search}`, headers: input.headers.has("range") ? { range: input.headers.get("range") ?? "" } : {} }, (response) => {
      const headers = new Headers()
      for (const [key, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value)
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          response.on("data", (chunk: Buffer) => { controller.enqueue(chunk); response.pause() })
          response.on("end", () => controller.close())
          response.on("error", (error) => controller.error(error))
        },
        pull() { response.resume() },
        cancel() { response.destroy(); req.destroy() },
      })
      resolve(new Response(body, { status: response.statusCode ?? 502, headers }))
    })
    req.on("error", reject)
    input.signal.addEventListener("abort", () => req.destroy(), { once: true })
    req.end()
  })
}
