import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { chmod } from "node:fs/promises"
import { packageLoads } from "@mako/lazy"
import { z } from "zod"
import { saidLiveForm, type LiveForm } from "@mako/protocol/live-form"
import type { HostEvent } from "../contracts/host-events-boot.js"
import type { TerminalEvent } from "../contracts/terminal.js"
import { CORRELATION_HEADER, CorrelationIdSchema, LIVE_FORM_HEADER, RuntimeCallSchema, decodeRuntimeArgs, runtimeFailure, type RuntimeInfo } from "../contracts/runtime.js"
import { encodeRuntimeEvent, payloadFor, runtimeEventLine, runtimeSuccessBody, type EncodedValue, type RuntimeEvent, type RuntimeEventChannel } from "../contracts/runtime-value.js"
import { HOST_CLOSED_CODE, HOST_RECONNECTING_MESSAGE, HOST_RESTARTING_CODE } from "../contracts/host-connection.js"
import { historyChangedNotice } from "./gateway.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { filePolicyHeaders } from "../base/file-policy.js"
import type { SecretKeyHandover } from "../base/host-secrets.js"
import { HostJobs, type JobDemand } from "../base/host-jobs.js"
import { DESKTOP_PATH } from "../contracts/desktop-channel.js"
import { CONTROL_VIDEO_BATCH_TYPE, PREVIEW_MEDIA_TYPE, encodePreviewMedia, type ControlPreview } from "@mako/control-runtime/contracts"

/** How the host runs one call: the encoded value of `channel(...args)`, on behalf of `client`. */
export type HostInvoke = (channel: string, args: unknown[], client?: string, history?: boolean, correlationId?: string) => Promise<EncodedValue>

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

const SecretKeyOfferSchema = z.object({ key: z.base64() }).strict()

async function readSecretKeyOffer(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 1024) throw new Error("A data key offer is at most 1 KiB")
    chunks.push(buffer)
  }
  return Buffer.from(SecretKeyOfferSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))).key, "base64")
}

/**
 * Host transport shared by desktop and browser gateways on a private Unix socket.
 * `/secret-key` and `/desktop` are the desktop app's alone: browser gateways
 * forward only `/rpc`, `/events` and `/file/`, and the cloud gateway calls the
 * host in-process.
 */
export async function startWebHost(
  socket: string,
  invoke: HostInvoke,
  file: (request: Request, client?: string) => Promise<Response>,
  disconnected?: (client: string) => void,
  /** What `/health` and each subscriber's first packet say about this host, read as each is sent. */
  runtime?: RuntimeInfo | (() => RuntimeInfo),
  preview?: (args: unknown[], client: string) => Promise<ControlPreview | null>,
  secretKey?: SecretKeyHandover,
  desktop?: (request: IncomingMessage, response: ServerResponse) => void,
  /** The host's scheduler, which keeps open streams alive. */
  jobs: HostJobs = new HostJobs(),
  /** Set on while any client is subscribed to `/events`, observers included: a window, an agent view, the CLI, another host. */
  subscribed: JobDemand = jobs.demand("a client is subscribed"),
  /** Every event for all clients, as encoded once for them: a cloud machine's runtime sends them on as its Thread's. */
  outlet?: (channel: RuntimeEventChannel, event: RuntimeEvent) => void,
  /** A preview's live video for one viewer (`mako:control-video`), as the bytes of a `ControlVideoBatch`. */
  video?: (args: unknown[], client: string) => Promise<Uint8Array>
) {
  const info = () => (runtime instanceof Function ? runtime() : runtime)
  /** Each subscriber, and the live form it reads (`x-mako-live`, `live-form.ts`): one that says none reads form 1. */
  const streams = new Map<ServerResponse, { client: string; observer: boolean; history: boolean; eventLimit: number; live: LiveForm }>()
  // A cloud machine's Thread hears every event through the outlet, so the work done for subscribers runs for it too.
  const subscribersChanged = () => subscribed.set(streams.size > 0 || outlet !== undefined)
  subscribersChanged()
  const releases = new Map<string, ReturnType<typeof setTimeout>>()
  const pending = new Set<ServerResponse>()
  const media = new Map<ServerResponse, string>()
  const videoReads = new Map<ServerResponse, string>()
  /** Desktops waiting to be asked for the data key; held for this host's life when it never needs one. */
  const keyWaiters = new Set<ServerResponse>()
  const secretKeyRoute = async (request: IncomingMessage, response: ServerResponse, handover: SecretKeyHandover) => {
    if (request.method === "GET") {
      const wanted = await handover.wanted()
      if (!wanted && new URL(request.url ?? "/", "http://localhost").searchParams.get("wait") === "1") {
        keyWaiters.add(response)
        response.once("close", () => keyWaiters.delete(response))
        return
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ wanted }))
      return
    }
    if (request.method !== "POST") {
      response.writeHead(405).end()
      return
    }
    let key: Buffer
    try {
      key = await readSecretKeyOffer(request)
    } catch {
      response.writeHead(400).end("A data key offer is {\"key\": base64}")
      return
    }
    try {
      await handover.offer(key)
      hostLog("secrets", "data key handed over")
      response.writeHead(204).end()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      hostWarn("secrets", "data key refused", { reason })
      response.writeHead(409).end(reason)
    } finally {
      key.fill(0)
    }
  }
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
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(info()))
      return
    }
    if (request.method === "GET" && request.url === "/packages") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(packageLoads()))
      return
    }
    if (request.url?.split("?")[0] === "/secret-key") {
      if (!secretKey) { response.writeHead(404).end(); return }
      void secretKeyRoute(request, response, secretKey).catch(() => {
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
      return
    }
    if (request.url === DESKTOP_PATH) {
      if (!desktop) response.writeHead(404).end()
      else if (request.method !== "POST") response.writeHead(405).end()
      else desktop(request, response)
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
          // What a file may do is decided here by its type, for every answer; one its owner says nothing about keeping is never kept.
          response.writeHead(result.status, {
            "cache-control": "no-store",
            ...Object.fromEntries(result.headers),
            ...filePolicyHeaders(result.headers.get("content-type") ?? undefined),
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
      response.write(JSON.stringify({ channel: "ready", runtime: info() }) + "\n")
      clearTimeout(releases.get(clientId))
      releases.delete(clientId)
      const requestedLimit = Number(request.headers["x-mako-event-limit"])
      const eventLimit = Number.isSafeInteger(requestedLimit) && requestedLimit >= 64 * 1024 && requestedLimit <= 32 * 1024 * 1024
        ? requestedLimit : 512 * 1024
      streams.set(response, { client: clientId, observer: request.headers["x-mako-observer"] === "1",
        history: request.headers["x-mako-history"] === "1", eventLimit,
        live: saidLiveForm(request.headers[LIVE_FORM_HEADER]?.toString()) })
      subscribersChanged()
      response.once("close", () => {
        streams.delete(response)
        subscribersChanged()
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
    // An older client sends none; minting one here still ties the host's lines for this call together.
    const correlationId = CorrelationIdSchema.safeParse(request.headers[CORRELATION_HEADER]).data ?? randomUUID()
    response.setHeader(CORRELATION_HEADER, correlationId)
    void readRequest(request)
      .then(async (call) => {
        const { channel, attempt } = call
        const args = decodeRuntimeArgs(call.args)
        if (channel === "mako:control-preview" && request.headers.accept === PREVIEW_MEDIA_TYPE) {
          if (!preview) throw new Error("Preview delivery requires a newer Mako host. Existing agents have not been restarted.")
          if (media.size >= 16 || [...media.values()].filter(owner => owner === clientId).length >= 2)
            throw new Error("Preview delivery is busy; wait for the current frame before requesting another")
          media.set(response, clientId)
          const deadline = setTimeout(() => response.destroy(), 5000)
          deadline.unref()
          const release = () => { clearTimeout(deadline); media.delete(response) }
          response.once("finish", release)
          response.once("close", release)
          const value = await preview(args, clientId)
          if (response.destroyed || response.headersSent) return
          const packet = encodePreviewMedia(value)
          response.writeHead(200, { "content-type": PREVIEW_MEDIA_TYPE,
            "content-length": packet.header.byteLength + packet.bytes.byteLength,
            "x-content-type-options": "nosniff", vary: "Accept" })
          response.write(packet.header)
          response.end(packet.bytes)
          return
        }
        if (channel === "mako:control-video" && request.headers.accept === CONTROL_VIDEO_BATCH_TYPE) {
          if (!video) throw new Error("Preview video requires a newer Mako host. Existing agents have not been restarted.")
          // Each read waits up to a second for packets: a window's two viewers, the panel and the chat's card, each hold one.
          if (videoReads.size >= 32 || [...videoReads.values()].filter(owner => owner === clientId).length >= 8)
            throw new Error("Preview video is busy; wait for the current read before starting another")
          videoReads.set(response, clientId)
          const release = () => videoReads.delete(response)
          response.once("finish", release)
          response.once("close", release)
          const batch = await video(args, clientId)
          if (response.destroyed || response.headersSent) return
          response.writeHead(200, { "content-type": CONTROL_VIDEO_BATCH_TYPE, "content-length": batch.byteLength,
            "x-content-type-options": "nosniff", vary: "Accept" })
          response.end(batch)
          return
        }
        // A replayed mutation is answered by its id; the line is the receipt
        // that a dropped call was settled rather than repeated.
        if (attempt !== undefined && attempt > 1) hostLog("rpc", "replayed call", { channel, client: clientId, attempt, correlationId })
        const value = await invoke(
          channel,
          args,
          clientId,
          request.headers["x-mako-history"] === "1",
          correlationId
        )
        // close() may already have answered this call with the farewell.
        if (response.destroyed || response.headersSent) return
        response.writeHead(200, { "content-type": "application/json" }).end(runtimeSuccessBody(value))
      })
      .catch((error) => {
        if (!response.destroyed && !response.headersSent)
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(runtimeFailure(error)))
      })
  })
  // The desktop's `/desktop` request stays open for the host's life; nothing on this private socket needs a deadline.
  server.requestTimeout = 0
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socket, resolve)
  })
  await chmod(socket, 0o600)
  const stopHeartbeat = jobs.every("keep event streams alive", 15_000, () => {
    for (const stream of streams.keys()) stream.write("\n")
  }, { needs: [subscribed] })
  /** A live batch too large for a history-paging subscriber, as the notice that its history changed. */
  const invalidated = (event: RuntimeEvent) => {
    const notice = historyChangedNotice(event)
    return notice ? runtimeEventLine("event", notice) : null
  }
  const send = (channel: RuntimeEventChannel, event: RuntimeEvent, client?: string) => {
    if (!client) outlet?.(channel, event)
    // Each subscriber gets the event in the newest live form it reads, each line encoded once.
    const lines = new Map<string, { line: string; bytes: number }>()
    const lineOf = (payload: string) => {
      let held = lines.get(payload)
      if (!held) {
        const line = runtimeEventLine(channel, { ...event, payload })
        lines.set(payload, (held = { line, bytes: Buffer.byteLength(line) }))
      }
      return held
    }
    let invalidation: string | null | undefined
    const notice = () => (invalidation === undefined ? (invalidation = invalidated(event)) : invalidation)
    for (const [stream, owner] of streams) {
      if (client && client !== owner.client) continue
      if (stream.writableLength > 8 * 1024 * 1024) {
        stream.destroy(new Error("Web client stopped consuming host events"))
        continue
      }
      const payload = payloadFor(event, owner.live)
      // Heard in a form this subscriber doesn't read: it reads the conversation again instead.
      if (payload === undefined) {
        const line = notice()
        if (line) stream.write(line)
        continue
      }
      const { line, bytes } = lineOf(payload)
      if (owner.history && channel === "event" && bytes > owner.eventLimit && notice()) {
        stream.write(notice()!)
        continue
      }
      stream.write(line)
    }
  }
  return {
    clients: () => [...new Set([...streams.values()].filter((entry) => !entry.observer).map((entry) => entry.client))],
    event: (event: HostEvent, client?: string) => send("event", encodeRuntimeEvent(event), client),
    /** Another host's conversation event, as that host encoded it. */
    conversationEvent: (event: RuntimeEvent) => send("event", event),
    terminal: (event: TerminalEvent, client?: string) => send("terminal", encodeRuntimeEvent(event), client),
    /**
     * Leave without resetting anyone. Every call still waiting gets an explicit
     * "restarting" reply on a connection marked to close, so a client can tell a
     * planned restart from a crash and decide whether the call is safe to repeat.
     * Idle keep-alive connections close now; anything else is swept shortly after.
     */
    close() {
      closed = true
      stopHeartbeat()
      for (const stream of streams.keys()) stream.end()
      streams.clear()
      subscribersChanged()
      for (const timer of releases.values()) clearTimeout(timer)
      releases.clear()
      for (const response of pending) farewell(response)
      pending.clear()
      for (const response of keyWaiters) response.destroy()
      keyWaiters.clear()
      server.close()
      server.closeIdleConnections()
      const sweep = setTimeout(() => server.closeAllConnections(), 250)
      sweep.unref()
    },
  }
}
