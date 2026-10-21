import { randomUUID } from "node:crypto"
import { type ClientSessionOverSockets, clientSessionOverSockets, subprotocols, threadStream, type Actor } from "@mako/protocol"
import { hostCallInput, hostReplyValue, toHostOperation } from "@mako/host/contracts/host-operations"
import { invokeRuntime, subscribeRuntime } from "@mako/host/transport/connection"
import { appDataFolder, runtimeDataRoot, runtimeLocation } from "@mako/host/transport/service"
import { z } from "zod"

/**
 * Where a client's calls go: a host on this computer, through its socket, or a cloud Thread, through the gateway to
 * whichever runtime runs it. Either way the calls are the host's own (`mako:live-start`, `mako:live-prompt`, …) with
 * the same arguments and answers, and the events are the host's events, so everything above this is one client.
 */
export interface HostTransport {
  /** Where it reaches, for what it prints. */
  readonly where: string
  /** One host call, its answer decoded: what the host answered, as JSON. */
  call(channel: string, args: readonly unknown[]): Promise<HostAnswer>
  /** The host's events as they come; the returned function stops them. */
  events(listener: (event: HostEvent) => void): () => void
  close(): void
}

/** A host call's answer as JSON, nothing when it answered nothing. */
export type HostAnswer = z.infer<ReturnType<typeof z.json>> | undefined

/** A host event as the client reads it: its type, and the rest of it unread until a reader parses it. */
export const HostEventSchema = z.looseObject({ type: z.string() })
export type HostEvent = z.infer<typeof HostEventSchema>

/**
 * The host this computer's Mako runs, or the profile's (`MAKO_PROFILE`), as every client finds it: by the socket its
 * data root names. `socket` reaches another.
 */
export function localHost(options: { socket?: string; client?: string } = {}): HostTransport {
  const socket = options.socket ?? runtimeLocation(runtimeDataRoot(appDataFolder(), process.env)).socket
  // A host knows each client by a UUID: its own tabs, drafts and previews, apart from every window's.
  const client = options.client ?? randomUUID()
  const stops = new Set<() => void>()
  return {
    where: socket,
    call: async (channel, args) => z.json().optional().parse(await invokeRuntime(socket, client, channel, args)),
    events(listener) {
      let ended = false
      const unsubscribe = subscribeRuntime(socket, client, (packet) => {
        if (ended || !("payload" in packet)) return
        const event = HostEventSchema.safeParse(JSON.parse(packet.payload))
        if (event.success) listener(event.data)
      }, () => undefined)
      const stop = () => {
        ended = true
        unsubscribe()
        stops.delete(stop)
      }
      stops.add(stop)
      return stop
    },
    close() {
      for (const stop of [...stops]) stop()
    },
  }
}

/**
 * A cloud Thread through the gateway, as a device of its account: `token` gives a connection token, asked for each
 * connection so one that renews is always current. Calls that reach a paused machine wait while it wakes.
 */
export function cloudThread(options: { gateway: string; threadId: string; deviceId: string; token: () => Promise<string> }): HostTransport {
  const ws = options.gateway.replace(/^http/, "ws")
  const session: ClientSessionOverSockets = clientSessionOverSockets(async (endpoint) => {
    const path =
      endpoint.kind === "thread"
        ? `/v1/threads/${encodeURIComponent(endpoint.threadId)}/connect`
        : endpoint.kind === "runtime"
          ? `/v1/runtimes/${encodeURIComponent(endpoint.runtimeId)}/clients`
          : `/v1/accounts/${encodeURIComponent(endpoint.accountId)}/connect`
    return new WebSocket(`${ws}${path}`, subprotocols(await options.token()))
  })
  const actor: Actor = { kind: "client", client: "script", deviceId: options.deviceId }
  const target = { kind: "thread" as const, threadId: options.threadId }
  return {
    where: `${options.gateway} · ${options.threadId}`,
    async call(channel, args) {
      const id = randomUUID()
      const correlationId = randomUUID()
      const input = hostCallInput(args, false)
      // A call the gateway couldn't settle (its machine still waking) is asked again under its id, which joins the first.
      for (let attempt = 1; ; attempt++) {
        const reply = await session.call(toHostOperation(channel, input, { id, target, actor, correlationId, attempt }))
        if (reply.ok) {
          const value = hostReplyValue(reply)
          return value === undefined ? undefined : z.json().parse(JSON.parse(value))
        }
        if (reply.problem.outcome !== "unknown" || attempt >= 8) throw new Error(`${channel}: ${reply.problem.title}${reply.problem.detail ? `: ${reply.problem.detail}` : ""}`)
      }
    },
    events(listener) {
      const stream = session.subscribe({ stream: threadStream(options.threadId), after: 0 })
      let ended = false
      void (async () => {
        while (!ended) {
          const next = await stream.next().catch(() => undefined)
          if (!next || ended) return
          const event = HostEventSchema.safeParse(safeJson(next.event.text))
          if (event.success) listener(event.data)
        }
      })()
      return () => {
        ended = true
        stream.close()
      }
    },
    close: () => session.close(),
  }
}

function safeJson(text: string): HostAnswer {
  try {
    return z.json().parse(JSON.parse(text))
  } catch {
    return undefined
  }
}
