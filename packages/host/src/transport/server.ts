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
import { ROSTER_LIVE_FORM, saidWindowForm, type WindowLiveForm } from "@mako/protocol/live-form"
import type { HostEvent } from "../contracts/host-events-boot.js"
import type { TerminalEvent } from "../contracts/terminal.js"
import { CORRELATION_HEADER, CorrelationIdSchema, LIVE_FORM_HEADER, RuntimeCallSchema, decodeRuntimeArgs, runtimeEventRouting, runtimeFailure, type RuntimeInfo } from "../contracts/runtime.js"
import { encodeRuntimeEvent, payloadFor, runtimeEventLine, runtimeSuccessBody, type EncodedValue, type RuntimeEvent, type RuntimeEventChannel } from "../contracts/runtime-value.js"
import { HOST_CLOSED_CODE, HOST_RECONNECTING_MESSAGE, HOST_RESTARTING_CODE } from "../contracts/host-connection.js"
import { historyChangedNotice } from "./gateway.js"
import { isPipePath } from "./pipe.js"
import { requireProof } from "../base/pipe-handshake.js"
import { restrictPipe } from "../base/pipe-restriction.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { topic } from "../base/topic.js"
import { failedCallWords } from "./failed-calls.js"
import { filePolicyHeaders } from "../base/file-policy.js"
import type { SecretKeyHandover } from "../base/host-secrets.js"
import { HostJobs, type JobDemand } from "../base/host-jobs.js"
import { DESKTOP_PATH } from "../contracts/desktop-channel.js"
import { CONTROL_VIDEO_BATCH_TYPE, PREVIEW_MEDIA_TYPE, encodePreviewMedia, type ControlPreview } from "@mako/control-runtime/contracts"

/** Each call as it arrives, its arguments decoded and before its method runs: when the host heard a send. */
export const hostCalls = topic<{ channel: string; args: readonly unknown[] }>("mako:host-call")

/** Each call as its answer, or its refusal, is written back: when the host was done with it (`npm run bench:actions`). */
export const hostAnswers = topic<{ channel: string; args: readonly unknown[]; refused?: true }>("mako:host-answer")

/** Each event line as it is written to a subscriber's stream: when a batch left the host for a window. */
export const streamWrites = topic<{ client: string; type: string | undefined; conversation: string | undefined; line: string }>("mako:stream-write")

/** How the host runs one call: the encoded value of `channel(...args)`, on behalf of `client`. */
export type HostInvoke = (channel: string, args: unknown[], client?: string, history?: boolean, correlationId?: string) => Promise<EncodedValue>

/**
 * What an event stream may hold unsent before its live batches wait. A burst passes this with the reader reading as
 * fast as it can: 8 MB is under a second of a busy host's traffic. What it misses, it reads again (`fallBehind`).
 */
const STREAM_BEHIND_BYTES = 8 * 1024 * 1024
/**
 * What it may hold at all: what's queued and the notices it has missed together, the write about to go included. Live
 * batches add only a notice, so only a reader that has stopped reading gets here.
 */
const STREAM_LOST_BYTES = 64 * 1024 * 1024
/**
 * What a window's stream may hold unsent and still be told what waits ahead of a batch (`windowEvent`). A window that
 * reads as it's written holds nothing; one that doesn't hears the batches alone, at their own pace, until it has caught
 * up, so what's said ahead never adds to what a slow reader makes the host hold.
 */
const AHEAD_HOLD_BYTES = 64 * 1024
const WorkspaceClientSchema = z.string().uuid().optional()

/** One client's subscription to `/events`. */
type EventStream = {
  id: string
  /** Only the newest non-observer stream may own this window's sampling demand; older streams never regain it. */
  current: boolean
  client: string
  observer: boolean
  history: boolean
  eventLimit: number
  live: WindowLiveForm
  openedAt: number
  /**
   * Its window said nobody can see it (`windowShown`): it's told nothing that exists only to be painted (`sendWindows`)
   * until it says it shows again. A stream that never says is shown, as every window before this was.
   */
  hidden?: boolean
  /**
   * Past `STREAM_BEHIND_BYTES`, until it catches up: the notice to read each conversation again, at the latest revision
   * it missed. Never the batch itself: a stream's memory is only what `heldBy` counts.
   */
  missed?: Map<string, string>
  missedBytes: number
  /** Why the host let it go, and what it held. */
  ending?: { why: string; queuedBytes: number }
}

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
 * Host transport shared by desktop and browser gateways on a private Unix socket, or on Windows a named pipe.
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
  video?: (args: unknown[], client: string) => Promise<Uint8Array>,
  /**
   * On Windows, the secret drawn with this start's pipe (`pipe.ts`): every connection proves it knows it, and is
   * answered with this host's proof, before HTTP crosses it.
   */
  pipeSecret?: string
) {
  const info = () => (runtime instanceof Function ? runtime() : runtime)
  // On a profile's pipe (Windows), what tells its clients this is its host and not a program holding its name.
  /** Each subscriber, and the live form it reads (`x-mako-live`, `live-form.ts`): one that says none reads form 1. */
  const streams = new Map<ServerResponse, EventStream>()
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
    const client = WorkspaceClientSchema.safeParse(request.headers["x-mako-window"] ?? new URL(request.url ?? "/", "http://localhost").searchParams.get("client") ?? undefined)
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
      const observer = request.headers["x-mako-observer"] === "1"
      if (!observer) for (const previous of streams.values()) if (previous.client === clientId) previous.current = false
      const stream: EventStream = { id: randomUUID(), current: !observer, client: clientId, observer,
        history: request.headers["x-mako-history"] === "1", eventLimit,
        live: saidWindowForm(request.headers[LIVE_FORM_HEADER]?.toString()), openedAt: Date.now(), missedBytes: 0 }
      streams.set(response, stream)
      subscribersChanged()
      response.once("close", () => {
        streams.delete(response)
        // After the host's close it's the host leaving, which every client hears; any other end is a window re-attaching.
        const said = { client: clientId, observer: stream.observer, livedMs: Date.now() - stream.openedAt,
          why: stream.ending?.why ?? (closed ? "the host closed" : "the client left"),
          queuedBytes: stream.ending?.queuedBytes ?? response.writableLength, ...stream.missed && { missedConversations: stream.missed.size } }
        if (stream.ending) hostWarn("stream", "a client's event stream ended", said)
        else hostLog("stream", "a client's event stream ended", said)
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
    // Whether the call reached its method, which says its own failure (`FailedCalls`); one refused before it is said here.
    let reached = false
    let called = "unread"
    let taken: readonly unknown[] = []
    void readRequest(request)
      .then(async (call) => {
        const { channel, attempt } = call
        called = channel
        const args = decodeRuntimeArgs(call.args)
        taken = args
        if (hostCalls.heard) hostCalls.publish({ channel, args })
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
        reached = true
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
        if (hostAnswers.heard) hostAnswers.publish({ channel, args })
      })
      .catch((error) => {
        if (reached && hostAnswers.heard) hostAnswers.publish({ channel: called, args: taken, refused: true })
        if (!reached) hostWarn("rpc", "a call was refused before its method", { channel: called, client: clientId, correlationId, ...failedCallWords({ error }) })
        if (!response.destroyed && !response.headersSent)
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(runtimeFailure(error)))
      })
  })
  // The desktop's `/desktop` request stays open for the host's life; nothing on this private socket needs a deadline.
  server.requestTimeout = 0
  if (pipeSecret) requireProof(server, () => pipeSecret)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socket, resolve)
  })
  // A pipe has no mode: its DACL is narrowed to its owner once it listens, and its handshake keeps its clients safe.
  if (!isPipePath(socket)) await chmod(socket, 0o600)
  else if (pipeSecret) void restrictPipe([socket], "the host's pipe")
  const stopHeartbeat = jobs.every("keep event streams alive", 15_000, () => {
    for (const stream of streams.keys()) stream.write("\n")
  }, { needs: [subscribed] })
  /** A live batch too large for a history-paging subscriber, as the notice that its history changed. */
  const invalidated = (event: RuntimeEvent) => {
    const notice = historyChangedNotice(event)
    return notice ? runtimeEventLine("event", notice) : null
  }
  /**
   * `stream` holds more than it should: its live batches wait, and once it has taken what it holds it hears, for each
   * conversation it missed, the notice to read that conversation again, at its latest revision. So a burst costs each
   * conversation one read, in place of the stream and a whole window's boot. Everything else still goes, in order.
   */
  const fallBehind = (response: ServerResponse, stream: EventStream) => {
    const missed = new Map<string, string>()
    const since = Date.now()
    stream.missed = missed
    hostWarn("stream", "a client's stream fell behind", { client: stream.client, queuedBytes: response.writableLength })
    response.once("drain", () => {
      const missedBytes = stream.missedBytes
      stream.missed = undefined
      stream.missedBytes = 0
      for (const notice of missed.values()) response.write(notice)
      hostLog("stream", "a client's stream caught up", { client: stream.client, behindMs: Date.now() - since, conversations: missed.size, missedBytes })
    })
  }
  /** Whether `stream` can hold `bytes` more; one that can't is let go, so it never holds past `STREAM_LOST_BYTES`. */
  const holds = (response: ServerResponse, stream: EventStream, bytes: number) => {
    const queuedBytes = response.writableLength + stream.missedBytes
    if (queuedBytes + bytes <= STREAM_LOST_BYTES) return true
    stream.ending = { why: "it stopped reading", queuedBytes }
    response.destroy(new Error("Web client stopped consuming host events"))
    return false
  }
  const send = (channel: RuntimeEventChannel, event: RuntimeEvent, client?: string) => {
    if (!client) outlet?.(channel, event)
    // Each subscriber gets the event in the newest live form it reads, each line encoded once.
    const lines = new Map<string, { line: string; bytes: number }>()
    const lineOf = (payload: string) => {
      let held = lines.get(payload)
      if (!held) {
        // Named field by field: a copy of the event would write out every form it has (`encodeRuntimeEvent`).
        const line = runtimeEventLine(channel, { type: event.type, conversation: event.conversation, payload })
        lines.set(payload, (held = { line, bytes: Buffer.byteLength(line) }))
      }
      return held
    }
    let invalidation: string | null | undefined
    const notice = () => (invalidation === undefined ? (invalidation = invalidated(event)) : invalidation)
    for (const [stream, owner] of streams) {
      if (client && client !== owner.client) continue
      if (stream.destroyed) continue
      if (stream.writableLength > STREAM_BEHIND_BYTES && !owner.missed) fallBehind(stream, owner)
      if (owner.missed) {
        const { type, conversation } = runtimeEventRouting(event)
        const line = type === "live-batch" && conversation ? notice() : null
        if (line && conversation) {
          const grown = Buffer.byteLength(line) - Buffer.byteLength(owner.missed.get(conversation) ?? "")
          if (!holds(stream, owner, grown)) continue
          owner.missed.set(conversation, line)
          owner.missedBytes += grown
          continue
        }
      }
      const payload = payloadFor(event, owner.live)
      // Heard in a form this subscriber doesn't read: it reads the conversation again instead.
      if (payload === undefined) {
        const line = notice()
        if (line && holds(stream, owner, Buffer.byteLength(line))) stream.write(line)
        continue
      }
      const { line, bytes } = lineOf(payload)
      if (owner.history && channel === "event" && bytes > owner.eventLimit && notice()) {
        if (holds(stream, owner, Buffer.byteLength(notice()!))) stream.write(notice()!)
        continue
      }
      if (!holds(stream, owner, bytes)) continue
      stream.write(line)
      if (streamWrites.heard) {
        const { type, conversation } = runtimeEventRouting(event)
        streamWrites.publish({ client: owner.client, type, conversation, line })
      }
    }
  }
  /**
   * An event only this host's own windows hear (a stream that says the window's live form, `ROSTER_LIVE_FORM`, which
   * nothing else says), and only while they keep up: each one stands alone and is said again, so it's never queued
   * behind what a window hasn't read.
   */
  const sendWindows = (event: Extract<HostEvent, { type: "live-ahead" }>) => {
    let line: string | undefined
    for (const [stream, owner] of streams) {
      if (owner.live < ROSTER_LIVE_FORM || owner.hidden || stream.destroyed || owner.missed || stream.writableLength > AHEAD_HOLD_BYTES) continue
      line ??= runtimeEventLine("event", { type: event.type, conversation: event.ahead.id, payload: JSON.stringify(event) })
      stream.write(line)
      if (streamWrites.heard) streamWrites.publish({ client: owner.client, type: event.type, conversation: event.ahead.id, line })
    }
  }
  return {
    windowEvent: sendWindows,
    clients: () => [...new Set([...streams.values()].filter((entry) => !entry.observer).map((entry) => entry.client))],
    /** The newest real window stream for this client, replaced even when a reload reuses its client ID. */
    windowStream: (client: string): string | undefined => {
      // Anonymous readers share "web"; they cannot own one another's persistent demand.
      if (client === "web") return undefined
      let id: string | undefined
      for (const stream of streams.values()) if (stream.client === client && stream.current && !stream.observer) id = stream.id
      return id
    },
    /**
     * A window saying whether anyone can see it, for its newest stream alone: a stream opened after this is shown
     * until its window says otherwise. False when this client has no window stream to mark.
     */
    windowShown: (client: string, shown: boolean): boolean => {
      // Anonymous readers share "web": one of them hidden says nothing of the others.
      if (client === "web") return false
      let found: EventStream | undefined
      for (const stream of streams.values()) if (stream.client === client && stream.current && !stream.observer) found = stream
      if (!found) return false
      found.hidden = !shown
      return true
    },
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
