import { z } from "zod"
import { type ConnectionCredential, type Renewal, renewal } from "./credential.js"
import {
  type Actor,
  type Operation,
  type Problem,
  type Reply,
  problem,
} from "./envelope.js"
import type { EventFrame, StreamId, Subscribe } from "./events.js"
import {
  type ClientSession,
  type GatewayUnderTest,
  Inbox,
  type RuntimeLink,
  type Subscription,
} from "./gateway.js"
import { PING } from "./heartbeat.js"
import type { GatewayFrame } from "./runtime-frames.js"
import { PROTOCOL_VERSION } from "./version.js"
import {
  WireError,
  decodeGatewayClientFrame,
  decodeGatewayFrame,
  encodeClientFrame,
  encodeRuntimeFrame,
} from "./wire.js"

/** What every WebSocket offers: the browser's, Node's (24 and later) and workerd's. */
export interface MessageSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void
  ): void
  addEventListener(type: "close" | "error", listener: () => void): void
  addEventListener(type: "open", listener: () => void): void
}

const OPEN = 1

/** Every frame is text; a binary message isn't one (close code 1003, unsupported data). */
const TextMessageSchema = z.string()
/** Where a client's connection goes: one socket per Thread, runtime or account it talks to. */
export type ClientEndpoint =
  | { kind: "thread"; threadId: string }
  | { kind: "runtime"; runtimeId: string }
  | { kind: "account"; accountId: string }

export function endpointOfTarget(target: Operation["target"]): ClientEndpoint {
  return target.kind === "thread"
    ? { kind: "thread", threadId: target.threadId }
    : { kind: "runtime", runtimeId: target.runtimeId }
}

export function endpointOfStream(stream: StreamId): ClientEndpoint {
  const [kind, ...rest] = stream.split(":")
  const id = rest.join(":")
  return kind === "thread"
    ? { kind: "thread", threadId: id }
    : { kind: "account", accountId: id }
}

const endpointKey = (endpoint: ClientEndpoint) =>
  endpoint.kind === "thread"
    ? `thread:${endpoint.threadId}`
    : endpoint.kind === "runtime"
      ? `runtime:${endpoint.runtimeId}`
      : `account:${endpoint.accountId}`

/**
 * A runtime's link over a WebSocket: the frames it sends and the gateway's, as wire text. A frame
 * from the gateway that isn't one closes the link, since nothing after it can be trusted, and a
 * refusal ends it. Pongs aren't passed on.
 */
export function runtimeLinkOverSocket(socket: MessageSocket): RuntimeLink {
  const inbox = new Inbox<GatewayFrame>()
  let closed = false
  const end = () => {
    closed = true
    inbox.close()
  }
  socket.addEventListener("message", (event) => {
    const text = TextMessageSchema.safeParse(event.data)
    if (!text.success) {
      socket.close(1003, "frames are text")
      return end()
    }
    let frame: GatewayFrame
    try {
      frame = decodeGatewayFrame(text.data)
    } catch (error) {
      if (!(error instanceof WireError)) throw error
      socket.close(1002, "not a gateway frame")
      return end()
    }
    if (frame.type === "pong") return
    inbox.push(frame)
    // A refusal ends the link: nothing the gateway sends after it can be read, and the close follows.
    if (frame.type === "refused") end()
  })
  socket.addEventListener("close", end)
  socket.addEventListener("error", end)
  const send = (text: string) => {
    if (!closed && socket.readyState === OPEN) socket.send(text)
  }
  return {
    send: (frame) => send(encodeRuntimeFrame(frame)),
    sendUnchecked: send,
    next: (timeoutMs) => inbox.next(timeoutMs),
    frames: () => inbox,
    close: () => {
      if (closed) return
      socket.close(1000, "done")
      end()
    },
    get closed() {
      return closed
    },
  }
}

type Connection = {
  socket: Promise<MessageSocket>
  calls: Map<string, Array<(reply: Reply) => void>>
  correlations: Map<string, string>
  streams: Map<StreamId, Inbox<EventFrame>>
  heartbeat: ReturnType<typeof setInterval> | undefined
  renewal: Renewal | undefined
}

export type ClientSessionOverSockets = ClientSession & { close(): void }

export type ClientSessionOptions = {
  heartbeatMs?: number
  /** Renews each connection's token in the socket before it's due, so it's never torn down to renew. */
  credential?: ConnectionCredential
  /**
   * The gateway closed a connection and said why (`closing`): `unauthorized` to connect again with a fresh
   * credential, which the next call or subscription does; `forbidden` when the device was removed.
   */
  onClosing?: (endpoint: ClientEndpoint, reason: Problem) => void
}

/**
 * A client's session over WebSockets, one per endpoint, opened when first needed. A call whose
 * connection closes before its reply is answered `unavailable` with an unknown outcome, since the
 * gateway may have taken it; the caller repeats it under the same id, which the gateway answers once.
 * A subscription whose connection closes ends, and the reader resubscribes after its last number.
 * With a credential, each connection renews its token in the socket before it's due.
 */
export function clientSessionOverSockets(
  open: (endpoint: ClientEndpoint) => MessageSocket | Promise<MessageSocket>,
  options: ClientSessionOptions = {}
): ClientSessionOverSockets {
  const connections = new Map<string, Connection>()

  const connect = (endpoint: ClientEndpoint): Connection => {
    const key = endpointKey(endpoint)
    const found = connections.get(key)
    if (found) return found
    const connection: Connection = {
      socket: Promise.resolve(open(endpoint)).then(opened),
      calls: new Map(),
      correlations: new Map(),
      streams: new Map(),
      heartbeat: undefined,
      renewal: undefined,
    }
    connections.set(key, connection)
    const lost = () => {
      if (connections.get(key) !== connection) return
      connections.delete(key)
      clearInterval(connection.heartbeat)
      connection.renewal?.stop()
      for (const [id, waiting] of connection.calls) {
        const reply: Reply = {
          v: PROTOCOL_VERSION,
          id,
          ok: false,
          problem: problem(
            "unavailable",
            "The connection to the gateway closed before the reply",
            connection.correlations.get(id) ?? crypto.randomUUID(),
            "unknown",
            { status: 503 }
          ),
        }
        for (const resolve of waiting) resolve(reply)
      }
      for (const stream of connection.streams.values()) stream.close()
    }
    connection.socket.then(
      (socket) => {
        socket.addEventListener("close", lost)
        socket.addEventListener("error", lost)
        socket.addEventListener("message", (event) => {
          const text = TextMessageSchema.safeParse(event.data)
          if (!text.success) {
            socket.close(1003, "frames are text")
            return lost()
          }
          let frame
          try {
            frame = decodeGatewayClientFrame(text.data)
          } catch (error) {
            if (!(error instanceof WireError)) throw error
            socket.close(1002, "not a gateway frame")
            return lost()
          }
          if (frame.type === "reply") {
            const waiting = connection.calls.get(frame.reply.id) ?? []
            connection.calls.delete(frame.reply.id)
            connection.correlations.delete(frame.reply.id)
            for (const resolve of waiting) resolve(frame.reply)
          } else if (frame.type === "event")
            connection.streams.get(frame.event.stream)?.push(frame.event)
          else if (frame.type === "refused" && frame.stream) {
            connection.streams.get(frame.stream)?.close()
            connection.streams.delete(frame.stream)
          } else if (frame.type === "renewed") connection.renewal?.renewed()
          else if (frame.type === "closing") {
            // Ended now, not when the close arrives, which a proxy can hold back.
            lost()
            options.onClosing?.(endpoint, frame.problem)
          }
        })
        if (options.credential)
          connection.renewal = renewal(options.credential, (token) => {
            if (socket.readyState === OPEN)
              socket.send(encodeClientFrame({ type: "renew", token }))
          })
        if (options.heartbeatMs)
          connection.heartbeat = setInterval(() => {
            if (socket.readyState === OPEN) socket.send(PING)
          }, options.heartbeatMs)
      },
      () => lost()
    )
    return connection
  }

  return {
    async call(operation) {
      const connection = connect(endpointOfTarget(operation.target))
      const reply = new Promise<Reply>((resolve) => {
        const waiting = connection.calls.get(operation.id) ?? []
        waiting.push(resolve)
        connection.calls.set(operation.id, waiting)
        connection.correlations.set(operation.id, operation.correlationId)
      })
      const socket = await connection.socket.catch(() => undefined)
      socket?.send(encodeClientFrame({ type: "call", operation }))
      return reply
    },
    subscribe(request: Subscribe): Subscription {
      const connection = connect(endpointOfStream(request.stream))
      const inbox = new Inbox<EventFrame>()
      connection.streams.get(request.stream)?.close()
      connection.streams.set(request.stream, inbox)
      void connection.socket
        .then((socket) =>
          socket.send(
            encodeClientFrame({
              type: "subscribe",
              stream: request.stream,
              after: request.after,
            })
          )
        )
        .catch(() => inbox.close())
      return {
        next: (timeoutMs) => inbox.next(timeoutMs),
        close: () => {
          inbox.close()
          if (connection.streams.get(request.stream) !== inbox) return
          connection.streams.delete(request.stream)
          void connection.socket.then((socket) => {
            if (socket.readyState === OPEN)
              socket.send(
                encodeClientFrame({
                  type: "unsubscribe",
                  stream: request.stream,
                })
              )
          })
        },
      }
    },
    close() {
      for (const connection of connections.values()) {
        clearInterval(connection.heartbeat)
        connection.renewal?.stop()
        void connection.socket.then((socket) => socket.close(1000, "done"))
      }
    },
  }
}

/**
 * A gateway served over sockets, as the conformance suite drives it: how a runtime's socket and a
 * client's per-endpoint socket are opened, and how a Thread is assigned (an operator's call).
 */
export function gatewayOverSockets(options: {
  runtime(): MessageSocket | Promise<MessageSocket>
  client(
    actor: Actor,
    endpoint: ClientEndpoint
  ): MessageSocket | Promise<MessageSocket>
  assign(threadId: string, runtimeId: string): Promise<number>
  close?(): Promise<void>
}): GatewayUnderTest {
  const links: RuntimeLink[] = []
  const sessions: ClientSessionOverSockets[] = []
  return {
    async connectRuntime() {
      const link = runtimeLinkOverSocket(await opened(await options.runtime()))
      links.push(link)
      return link
    },
    async connectClient(actor) {
      const session = clientSessionOverSockets((endpoint) =>
        options.client(actor, endpoint)
      )
      sessions.push(session)
      return session
    },
    assign: (threadId, runtimeId) => options.assign(threadId, runtimeId),
    async close() {
      for (const link of links) link.close()
      for (const session of sessions) session.close()
      await options.close?.()
    },
  }
}

/** Resolves once the socket is open, or rejects if it closes first. */
function opened(socket: MessageSocket): Promise<MessageSocket> {
  if (socket.readyState === OPEN) return Promise.resolve(socket)
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(socket))
    socket.addEventListener("close", () =>
      reject(new Error("The connection closed before it opened"))
    )
    socket.addEventListener("error", () =>
      reject(new Error("The connection failed before it opened"))
    )
  })
}
