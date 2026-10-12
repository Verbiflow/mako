import { request } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import { LineAssembler } from "@mako/sessions/daemon-wire"
import { CORRELATION_HEADER, RuntimeEventHeadSchema, RuntimeFailureSchema, RuntimeInfoSchema, RuntimeReadySchema, encodeRuntimeCall, runtimeFailureError, type RuntimeFailure, type RuntimePacket, type RuntimeValue } from "../contracts/runtime.js"
import { decodeRuntimeValue, runtimeSuccessValue, splitRuntimeEventLine, type EncodedValue } from "../contracts/runtime-value.js"
import { RuntimeDisconnectedError } from "../contracts/host-connection.js"
import type { z } from "zod"
import { hostCallReplay } from "../contracts/host-call-policy.js"
import { requestRuntimePreview } from "./preview.js"

import { readRuntimeResponse, RuntimeResponseLimitError, type RuntimeTransfer } from "./response.js"


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

interface RuntimeRequest<Reply> {
  socket: string
  path: string
  /** Reads a complete 200 body; what it throws is an unreadable reply. */
  read: (body: string) => Reply
  /** For `/rpc`: the call, encoded once by `encodeRuntimeCall`. */
  call?: { channel: string; body: string }
  client?: string
  timeoutMs?: number
  onTransfer?: (transfer: RuntimeTransfer) => void
  history?: boolean
  correlationId?: string
}

/** A body that is JSON of `schema`'s shape. */
export function jsonBody<Schema extends z.ZodType>(schema: Schema): (body: string) => z.output<Schema> {
  return (body) => schema.parse(JSON.parse(body))
}

export async function runtimeRequest<Reply>({
  socket,
  path,
  read,
  call,
  client,
  timeoutMs = 45_000,
  onTransfer,
  history = false,
  correlationId,
}: RuntimeRequest<Reply>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers = new Map([["content-type", "application/json"]])
    if (client) headers.set("x-mako-window", client)
    if (history) headers.set("x-mako-history", "1")
    if (correlationId) headers.set(CORRELATION_HEADER, correlationId)
    let receivedReply = false
    const req = request(
      {
        socketPath: socket,
        path,
        method: call === undefined ? "GET" : "POST",
        headers: Object.fromEntries(headers),
      },
      (response) => {
        receivedReply = true
        const invalidReply = (error: Error) => {
          // A rejected history/read response says nothing about host liveness
          // or action delivery. Keep the real reason (including size limits).
          if (call && hostCallReplay(call.channel) === "read")
            reject(new Error(error instanceof RuntimeResponseLimitError
              ? "The host response is too large to load in this version of Mako."
              : `Mako could not read the host response: ${error.message}`, { cause: error }))
          else reject(path === "/rpc" ? new RuntimeDisconnectedError(true) : error)
        }
        void readRuntimeResponse(response).then((transfer) => {
          try {
            // A host whose close() has begun answers anything but an RPC with 503 on a closing connection.
            if (response.statusCode === 503)
              throw new RuntimeDisconnectedError(false)
            if (response.statusCode !== 200)
              throw new Error(`Mako host returned ${response.statusCode}`)
            const value = read(transfer.body)
            try {
              onTransfer?.({
                encoding: transfer.encoding,
                wireBytes: transfer.wireBytes,
                decodedBytes: transfer.decodedBytes,
              })
            } catch {
              /* Diagnostics cannot change an RPC's outcome. */
            }
            resolve(value)
          } catch (error) {
            if (response.statusCode === 200)
              invalidReply(
                error instanceof Error ? error : new Error("Invalid host reply")
              )
            else reject(error)
          }
        }, invalidReply)
      }
    )
    req.setTimeout(timeoutMs, () =>
      req.destroy(
        path === "/rpc"
          ? new RuntimeDisconnectedError(true)
          : new Error("Mako host request timed out")
      )
    )
    req.on("error", (error) =>
      reject(
        path === "/rpc" && receivedReply
          ? new RuntimeDisconnectedError(true)
          : error
      )
    )
    req.end(call?.body)
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
    return { state: "ready", info: await runtimeRequest({ socket, path: "/health", read: jsonBody(RuntimeInfoSchema), timeoutMs: options.timeoutMs ?? 10_000 }) }
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

export type RuntimeCallOptions = {
  timeoutMs?: number
  onTransfer?: (transfer: RuntimeTransfer) => void
  history?: boolean
  /** The same for every attempt of one call, so its replay is found beside the first try. */
  correlationId?: string
}

/**
 * A call's reply, its value cut out of the body undecoded. A success's body is exactly what
 * `runtimeSuccessBody` writes; anything else is a failure, which is small and decoded here.
 */
function encodedReply(body: string): { ok: true; value: EncodedValue } | RuntimeFailure {
  const value = runtimeSuccessValue(body)
  return value === null ? RuntimeFailureSchema.parse(JSON.parse(body)) : { ok: true, value }
}

async function callRuntime<Value>(socket: string, client: string, channel: string, args: readonly unknown[],
  attempt: number, options: RuntimeCallOptions | undefined, value: (encoded: EncodedValue) => Value): Promise<Value> {
  const body = encodeRuntimeCall(channel, args, attempt)
  let reply: { ok: true; value: Value } | RuntimeFailure
  try {
    reply = await runtimeRequest({
      socket,
      path: "/rpc",
      // Decoding the value here makes a value that isn't JSON an unreadable reply, like any other.
      read: (text) => {
        const encoded = encodedReply(text)
        return encoded.ok ? { ok: true as const, value: value(encoded.value) } : encoded
      },
      call: { channel, body },
      client,
      timeoutMs: options?.timeoutMs ?? 5 * 60_000,
      onTransfer: options?.onTransfer,
      history: options?.history ?? false,
      correlationId: options?.correlationId,
    })
  } catch (error) {
    throw error instanceof Error ? (disconnection(error) ?? error) : error
  }
  if (!reply.ok) throw runtimeFailureError(reply)
  return reply.value
}

/** A host call's value, decoded once. */
export function invokeRuntime(socket: string, client: string, channel: string, args: readonly unknown[],
  attempt = 1, options?: RuntimeCallOptions): Promise<RuntimeValue> {
  return callRuntime(socket, client, channel, args, attempt, options, decodeRuntimeValue)
}

/**
 * A host call's value as the host encoded it, for a caller that forwards it rather than reads it,
 * such as the desktop's main process, whose window decodes it.
 */
export function invokeRuntimeEncoded(socket: string, client: string, channel: string, args: readonly unknown[],
  attempt = 1, options?: RuntimeCallOptions): Promise<EncodedValue> {
  return callRuntime(socket, client, channel, args, attempt, options, (encoded) => encoded)
}

export function invokeRuntimePreview(socket: string, client: string, args: readonly unknown[],
  onTransfer?: (transfer: RuntimeTransfer) => void) {
  return requestRuntimePreview(socket, client, encodeRuntimeCall("mako:control-preview", args), onTransfer).catch(error => {
    throw error instanceof Error ? (disconnection(error) ?? error) : error
  })
}

/** A line on `/events`, its event's payload left for whoever the event is for. */
function readRuntimePacket(line: string): RuntimePacket {
  const event = splitRuntimeEventLine(line)
  if (!event) return RuntimeReadySchema.parse(JSON.parse(line))
  return { ...RuntimeEventHeadSchema.parse(JSON.parse(event.head)), payload: event.payload }
}

export function subscribeRuntime(socket: string, client: string, receive: (packet: RuntimePacket) => void, disconnected: () => void, options: { observer?: boolean; history?: boolean; eventLimit?: number } = {}) {
  let closed = false
  let ended = false
  const end = () => { if (!ended && !closed) { ended = true; disconnected() } }
  const headers = new Map([["x-mako-window", client]])
  if (options.observer) headers.set("x-mako-observer", "1")
  if (options.history) headers.set("x-mako-history", "1")
  if (options.eventLimit) headers.set("x-mako-event-limit", String(options.eventLimit))
  const req = request({ socketPath: socket, path: "/events", method: "POST", headers: Object.fromEntries(headers) }, (response) => {
    const lines = new LineAssembler(32 * 1024 * 1024)
    if (response.statusCode !== 200) { response.destroy(); end(); return }
    response.on("data", (chunk: Buffer) => {
      const complete = lines.push(chunk)
      if (!complete) { response.destroy(); end(); return }
      for (const line of complete) {
        if (!line.trim()) continue
        try { receive(readRuntimePacket(line)) }
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
