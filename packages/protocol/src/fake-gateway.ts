import { z } from "zod"
import {
  ActorSchema,
  type Operation,
  type Problem,
  type Reply,
  problem,
  problemType,
} from "./envelope.js"
import {
  type EventFrame,
  type StreamId,
  SubscribeSchema,
  threadStream,
} from "./events.js"
import {
  type ClientSession,
  type GatewayUnderTest,
  Inbox,
  type RuntimeLink,
  type Subscription,
} from "./gateway.js"
import { CorrelationIdSchema } from "./ids.js"
import {
  type MediaDelivery,
  type MediaStreamId,
  MediaStreamIdSchema,
  type MediaWatch,
  decodeMediaMessage,
  mediaStreamOf,
} from "./media.js"
import { Payload } from "./payload.js"
import type { GatewayFrame, RuntimeFrame } from "./runtime-frames.js"
import { MEDIA_VERSION, PROTOCOL_VERSION, SUPPORTED_VERSIONS, negotiate } from "./version.js"
import {
  WireError,
  decodeEventFrame,
  decodeGatewayFrame,
  decodeOperation,
  decodeReply,
  decodeRuntimeFrame,
  encodeEventFrame,
  encodeGatewayFrame,
  encodeOperation,
  encodeReply,
  encodeRuntimeFrame,
} from "./wire.js"

const NIL_ID = "00000000-0000-0000-0000-000000000000"

/** One line per thing the gateway did, for tests and for reading a request's path by its correlation ID. */
export type GatewayLogLine = {
  event: "operation" | "enrolled" | "refused" | "disconnected"
  correlationId?: string
  operationId?: string
  op?: string
  /** `thread:<id>` or `runtime:<id>`. */
  target?: string
  attempt?: number
  /** `ok`, or the problem type. */
  outcome?: string
  /** Where the answer came from: the runtime, the gateway itself, or the first attempt's answer. */
  answeredBy?: "runtime" | "gateway" | "earlier-attempt"
  ms?: number
  runtimeId?: string
}

export type FakeGatewayOptions = {
  now?: () => Date
  heartbeatMs?: number
  /** When a renewed link's token runs out, in seconds since 1970, or undefined to refuse it. Every token is good for five minutes by default. */
  renew?: (token: string) => number | undefined
  log?: (line: GatewayLogLine) => void
}

type Thread = {
  stream: StreamId
  owner: string | undefined
  /** 0 until the Thread is first assigned. */
  generation: number
  log: EventFrame[]
  /** `${generation}:${localSeq}` → seq, so a resent event is acknowledged without being recorded again. */
  recorded: Map<string, number>
  readers: Set<Inbox<EventFrame>>
  /** Operations taken while nobody ran the Thread (`whenAsleep: "defer"`), in order, for when someone does. */
  deferred: Operation[]
}

type Connection = {
  runtimeId: string | undefined
  /** The link version agreed at enrolment. */
  version: number | undefined
  correlationId: string
  closed: boolean
  inbox: Inbox<GatewayFrame>
  deliver(frame: GatewayFrame): void
  close(): void
}

type Running = {
  runtimeId: string
  correlationId: string
  reply: Promise<Reply>
  settle(reply: Reply, final: boolean): void
}

/**
 * An in-memory gateway with the semantics the real one must have, for runtimes and clients to test
 * against without a network. It passes the conformance suite, which is how it stays honest.
 *
 * An operation id is answered once: a repeat gets the runtime's answer to the first attempt, or
 * waits for it while it runs. Only a failure on the way (the runtime gone, nobody running the
 * Thread) isn't kept, so a repeat after one is forwarded again to whoever runs it now.
 *
 * Everything crosses as wire text, as it would over a socket, and the gateway reads envelopes
 * alone: inputs, values and events reach their consumers as their producers encoded them.
 */
/** The fake, plus what its tests read of it: each Thread's runtime's last word on whether it's working. */
export type FakeGateway = GatewayUnderTest & {
  activity(threadId: string): { busy: boolean; work: string[]; at: Date } | undefined
  /** The operations waiting for the Thread's runtime (`whenAsleep: "defer"`). */
  deferred(threadId: string): string[]
}

export function createFakeGateway(
  options: FakeGatewayOptions = {}
): FakeGateway {
  const now = options.now ?? (() => new Date())
  const heartbeatMs = options.heartbeatMs ?? 15_000
  const log = options.log ?? (() => {})
  const threads = new Map<string, Thread>()
  const runtimes = new Map<string, Connection>()
  const connections = new Set<Connection>()
  const answers = new Map<string, Reply>()
  const running = new Map<string, Running>()
  const admissions = new Map<string, number>()
  const activity = new Map<string, { busy: boolean; work: string[]; at: Date }>()
  /** Streams being watched, each by one client, served by the runtime that ran its Thread when it was asked. */
  const watches = new Map<MediaStreamId, { threadId: string; runtime: Connection; inbox: Inbox<MediaDelivery> }>()

  const endWatch = (stream: MediaStreamId, reason?: Problem) => {
    const watch = watches.get(stream)
    if (!watch) return
    watches.delete(stream)
    watch.inbox.push(reason ? { kind: "ended", problem: reason } : { kind: "ended" })
    watch.inbox.close()
  }
  const endWatchesOf = (runtime: Connection, reason: Problem, threadId?: string) => {
    for (const [stream, watch] of watches)
      if (watch.runtime === runtime && (threadId === undefined || watch.threadId === threadId)) endWatch(stream, reason)
  }
  /** A runtime's media message, as the hosted gateway routes it: by its header alone, to the stream's one viewer. */
  const media = (connection: Connection, message: Uint8Array) => {
    let stream: MediaStreamId
    try {
      stream = mediaStreamOf(message)
    } catch (error) {
      if (!(error instanceof WireError)) throw error
      return refuse(connection, problem("bad-request", "Not a media message", connection.correlationId, "not-applied", { status: 400, detail: error.message }))
    }
    const watch = watches.get(stream)
    if (!watch || watch.runtime !== connection) return connection.deliver({ type: "media-unwatch", stream })
    watch.inbox.push({ kind: "data", data: decodeMediaMessage(message).data })
  }

  const thread = (threadId: string): Thread => {
    let found = threads.get(threadId)
    if (!found) {
      found = {
        stream: threadStream(threadId),
        owner: undefined,
        generation: 0,
        log: [],
        recorded: new Map(),
        readers: new Set(),
        deferred: [],
      }
      threads.set(threadId, found)
    }
    return found
  }

  const append = (
    target: Thread,
    event: Payload,
    generation: number | undefined,
    correlationId: string | undefined
  ): EventFrame => {
    const frame: EventFrame = {
      v: PROTOCOL_VERSION,
      stream: target.stream,
      seq: target.log.length + 1,
      at: now().toISOString(),
      event,
    }
    if (generation !== undefined) frame.generation = generation
    if (correlationId !== undefined) frame.correlationId = correlationId
    target.log.push(frame)
    for (const reader of target.readers) reader.push(frame)
    return frame
  }

  const failure = (id: string, reason: Problem): Reply => ({
    v: PROTOCOL_VERSION,
    id,
    ok: false,
    problem: reason,
  })

  const disconnect = (connection: Connection) => {
    connections.delete(connection)
    connection.inbox.close()
    if (
      !connection.runtimeId ||
      runtimes.get(connection.runtimeId) !== connection
    )
      return
    runtimes.delete(connection.runtimeId)
    log({ event: "disconnected", runtimeId: connection.runtimeId })
    endWatchesOf(connection, problem("unavailable", "The Thread's runtime left", connection.correlationId, "not-applied", { status: 503 }))
    for (const [id, waiting] of running)
      if (waiting.runtimeId === connection.runtimeId)
        waiting.settle(
          failure(
            id,
            problem(
              "owner-unavailable",
              "The runtime disconnected before answering",
              waiting.correlationId,
              "unknown",
              { status: 503 }
            )
          ),
          false
        )
  }

  const refuse = (connection: Connection, reason: Problem) => {
    log({
      event: "refused",
      correlationId: reason.correlationId,
      outcome: problemType(reason),
    })
    connection.deliver({ type: "refused", problem: reason })
    connection.close()
  }

  const enroll = (
    connection: Connection,
    frame: Extract<RuntimeFrame, { type: "enroll" }>
  ) => {
    if (connection.runtimeId)
      return refuse(
        connection,
        problem(
          "bad-request",
          "This connection already enrolled",
          connection.correlationId,
          "not-applied",
          { status: 400 }
        )
      )
    const version = negotiate(SUPPORTED_VERSIONS, frame.versions)
    if (version === null)
      return refuse(
        connection,
        problem(
          "unsupported-version",
          "No protocol version in common",
          connection.correlationId,
          "not-applied",
          {
            status: 426,
            detail: `The runtime speaks ${frame.versions.min} to ${frame.versions.max}; this gateway speaks ${SUPPORTED_VERSIONS.min} to ${SUPPORTED_VERSIONS.max}`,
          }
        )
      )
    runtimes.get(frame.runtimeId)?.close()
    connection.runtimeId = frame.runtimeId
    connection.version = version
    runtimes.set(frame.runtimeId, connection)
    log({
      event: "enrolled",
      runtimeId: frame.runtimeId,
      correlationId: connection.correlationId,
    })
    connection.deliver({ type: "enrolled", version, heartbeatMs })
    const current = new Set<string>()
    for (const claim of frame.threads) {
      const known = threads.get(claim.threadId)
      if (
        known &&
        known.owner === frame.runtimeId &&
        known.generation === claim.generation
      )
        current.add(claim.threadId)
      else
        connection.deliver({
          type: "fence",
          threadId: claim.threadId,
          generation: known?.generation ?? claim.generation + 1,
        })
    }
    for (const [threadId, owned] of threads)
      if (owned.owner === frame.runtimeId && !current.has(threadId))
        connection.deliver({
          type: "assign",
          threadId,
          generation: owned.generation,
        })
    for (const owned of threads.values()) if (owned.owner === frame.runtimeId) deliverDeferred(owned)
  }

  /** What waited for the Thread's runtime goes to it now, in the order it came. */
  const deliverDeferred = (target: Thread) => {
    const waiting = target.deferred.splice(0)
    for (const operation of waiting) void route(operation)
  }

  const record = (
    connection: Connection,
    frame: Extract<RuntimeFrame, { type: "event" }>
  ) => {
    const target = threads.get(frame.threadId)
    if (
      !target ||
      target.owner !== connection.runtimeId ||
      target.generation !== frame.generation
    )
      return connection.deliver({
        type: "rejected",
        threadId: frame.threadId,
        generation: frame.generation,
        localSeq: frame.localSeq,
        problem: problem(
          "fenced",
          "This runtime doesn't run the Thread under that generation",
          frame.correlationId ?? connection.correlationId,
          "not-applied",
          {
            status: 409,
            generation: target?.generation ?? 0,
          }
        ),
      })
    const key = `${frame.generation}:${frame.localSeq}`
    let seq = target.recorded.get(key)
    if (seq === undefined) {
      seq = append(
        target,
        frame.event,
        frame.generation,
        frame.correlationId
      ).seq
      target.recorded.set(key, seq)
    }
    connection.deliver({
      type: "ack",
      threadId: frame.threadId,
      generation: frame.generation,
      localSeq: frame.localSeq,
      seq,
    })
  }

  const receive = (connection: Connection, text: string) => {
    let frame: RuntimeFrame
    try {
      frame = decodeRuntimeFrame(text)
    } catch (error) {
      if (!(error instanceof WireError)) throw error
      return refuse(
        connection,
        problem(
          "bad-request",
          "Not a runtime frame",
          connection.correlationId,
          "not-applied",
          { status: 400, detail: error.message }
        )
      )
    }
    // In memory there is no connection to keep open, so a ping needs no answer, before enrolling or after.
    if (frame.type === "ping") return
    if (frame.type === "enroll") return enroll(connection, frame)
    if (!connection.runtimeId)
      return refuse(
        connection,
        problem(
          "unauthorized",
          "Enroll before sending anything else",
          connection.correlationId,
          "not-applied",
          { status: 401 }
        )
      )
    if (frame.type === "renew") {
      const expiresAt = (
        options.renew ??
        (() => Math.floor(now().getTime() / 1000) + 300)
      )(frame.token)
      if (expiresAt === undefined)
        return refuse(
          connection,
          problem(
            "unauthorized",
            "That token doesn't renew this link",
            connection.correlationId,
            "not-applied",
            { status: 401 }
          )
        )
      return connection.deliver({ type: "renewed", expiresAt })
    }
    if (frame.type === "event") return record(connection, frame)
    if (frame.type === "activity") {
      // As an event is: only from the Thread's owner, under its generation.
      const target = threads.get(frame.threadId)
      if (target?.owner !== connection.runtimeId || target.generation !== frame.generation) return
      activity.set(frame.threadId, { busy: frame.busy, work: frame.work, at: now() })
      return
    }
    if (frame.type === "reply") {
      const waiting = running.get(frame.reply.id)
      if (!waiting || waiting.runtimeId !== connection.runtimeId) return
      waiting.settle(frame.reply, true)
    }
    if (frame.type === "media-end" && watches.get(frame.stream)?.runtime === connection) endWatch(frame.stream, frame.problem)
  }

  const forward = (
    owner: Connection,
    runtimeId: string,
    operation: Operation,
    generation: number | undefined,
    seq: number | undefined
  ): Promise<Reply> => {
    let resolve: (reply: Reply) => void = () => {}
    const reply = new Promise<Reply>((settled) => {
      resolve = settled
    })
    running.set(operation.id, {
      runtimeId,
      correlationId: operation.correlationId,
      reply,
      settle: (answer, final) => {
        running.delete(operation.id)
        const numbered =
          answer.ok && seq !== undefined ? { ...answer, seq } : answer
        if (final) answers.set(operation.id, numbered)
        resolve(numbered)
      },
    })
    // What the gateway reads of an envelope stays with it, as the hosted gateway's does.
    const { whenAsleep: _asleep, ahead: _ahead, repeatable: _repeatable, passive: _passive, ...delivered } = operation
    owner.deliver(
      generation === undefined
        ? { type: "operation", operation: delivered }
        : { type: "operation", generation, operation: delivered }
    )
    return reply
  }

  const route = (operation: Operation): Promise<Reply> | Reply => {
    const answered = answers.get(operation.id)
    if (answered) return answered
    const inFlight = running.get(operation.id)
    if (inFlight) return inFlight.reply
    const nobody = (title: string) =>
      failure(
        operation.id,
        problem(
          "owner-unavailable",
          title,
          operation.correlationId,
          "not-applied",
          { status: 503 }
        )
      )
    if (operation.target.kind === "runtime") {
      const owner = runtimes.get(operation.target.runtimeId)
      if (!owner?.runtimeId) return nobody("That runtime isn't connected")
      return forward(owner, owner.runtimeId, operation, undefined, undefined)
    }
    const target = thread(operation.target.threadId)
    const owner = target.owner ? runtimes.get(target.owner) : undefined
    const kept = target.deferred.find((waiting) => waiting.id === operation.id)
    if (kept || (!owner?.runtimeId && operation.whenAsleep === "defer")) {
      if (!kept) target.deferred.push(operation)
      return { v: PROTOCOL_VERSION, id: operation.id, ok: true, deferred: true }
    }
    if (!owner?.runtimeId) return nobody("No runtime is running this Thread")
    let seq = admissions.get(operation.id)
    if (seq === undefined) {
      seq = append(
        target,
        Payload.of({
          type: "operation-admitted",
          operationId: operation.id,
          op: operation.op,
          actor: operation.actor,
        }),
        undefined,
        operation.correlationId
      ).seq
      admissions.set(operation.id, seq)
    }
    return forward(owner, owner.runtimeId, operation, target.generation, seq)
  }

  const admit = async (operation: Operation): Promise<Reply> => {
    const started = Date.now()
    const earlier = answers.has(operation.id) || running.has(operation.id)
    const routed = route(operation)
    const forwarded = routed instanceof Promise
    const reply = await routed
    log({
      event: "operation",
      correlationId: operation.correlationId,
      operationId: operation.id,
      op: operation.op,
      target:
        operation.target.kind === "thread"
          ? `thread:${operation.target.threadId}`
          : `runtime:${operation.target.runtimeId}`,
      attempt: operation.attempt,
      outcome: reply.ok ? "ok" : problemType(reply.problem),
      answeredBy: earlier
        ? "earlier-attempt"
        : forwarded
          ? "runtime"
          : "gateway",
      ms: Date.now() - started,
    })
    return reply
  }

  return {
    async connectRuntime(): Promise<RuntimeLink> {
      const inbox = new Inbox<GatewayFrame>()
      const connection: Connection = {
        runtimeId: undefined,
        version: undefined,
        correlationId: crypto.randomUUID(),
        closed: false,
        inbox,
        deliver: (frame) => {
          if (!connection.closed)
            inbox.push(decodeGatewayFrame(encodeGatewayFrame(frame)))
        },
        close: () => {
          if (connection.closed) return
          connection.closed = true
          disconnect(connection)
        },
      }
      connections.add(connection)
      const send = (text: string) => {
        if (!connection.closed) queueMicrotask(() => receive(connection, text))
      }
      return {
        send: (frame) => send(encodeRuntimeFrame(frame)),
        sendUnchecked: send,
        sendMedia: (message) => {
          if (connection.closed) return
          // Before enrolment, or at a version without media, a binary message is no frame at all.
          if ((connection.version ?? 0) < MEDIA_VERSION)
            return queueMicrotask(() => refuse(connection, problem("bad-request", "Frames are text", connection.correlationId, "not-applied", { status: 400 })))
          const copy = message.slice()
          queueMicrotask(() => media(connection, copy))
        },
        next: (timeoutMs) => inbox.next(timeoutMs),
        frames: () => inbox,
        close: () => connection.close(),
        get closed() {
          return connection.closed
        },
      }
    },

    async connectClient(actor): Promise<ClientSession> {
      ActorSchema.parse(actor)
      const answer = (reply: Reply) => decodeReply(encodeReply(reply))
      return {
        async call(sent) {
          const text = encodeOperation(sent)
          let operation: Operation
          try {
            operation = decodeOperation(text)
          } catch (error) {
            if (!(error instanceof WireError)) throw error
            const { id, correlationId } = echoed(text)
            return answer(
              failure(
                id,
                problem(
                  "bad-request",
                  "Not a valid operation",
                  correlationId,
                  "not-applied",
                  { status: 400, detail: error.message }
                )
              )
            )
          }
          return answer(await admit(operation))
        },
        subscribe(request): Subscription {
          const { stream, after } = SubscribeSchema.parse(request)
          const reader = new Inbox<EventFrame>()
          const target = stream.startsWith("thread:")
            ? thread(stream.slice("thread:".length))
            : undefined
          for (const frame of target?.log.slice(after) ?? []) reader.push(frame)
          target?.readers.add(reader)
          const next = async (timeoutMs?: number) =>
            decodeEventFrame(encodeEventFrame(await reader.next(timeoutMs)))
          return {
            next,
            close: () => {
              target?.readers.delete(reader)
              reader.close()
            },
          }
        },
        watch({ threadId, stream, request }): MediaWatch {
          MediaStreamIdSchema.parse(stream)
          const inbox = new Inbox<MediaDelivery>()
          const ending = (type: "unavailable" | "unsupported-version" | "conflict", title: string, status: number) =>
            problem(type, title, crypto.randomUUID(), "not-applied", { status })
          const ended = (reason: Problem) => {
            inbox.push({ kind: "ended", problem: reason })
            inbox.close()
          }
          const watching = () => watches.get(stream)?.inbox === inbox
          const ask = (asked: Payload) => {
            const watch = watches.get(stream)
            if (watch?.inbox === inbox) watch.runtime.deliver({ type: "media-watch", threadId, stream, request: asked })
          }
          const target = threads.get(threadId)
          const owner = target?.owner ? runtimes.get(target.owner) : undefined
          if (watches.has(stream)) ended(ending("conflict", "Another viewer watches a stream of that name", 409))
          else if (!owner) ended(ending("unavailable", "Nothing runs this Thread now", 503))
          else if ((owner.version ?? 0) < MEDIA_VERSION) ended(ending("unsupported-version", "This Thread's runtime is too old for media", 501))
          else {
            watches.set(stream, { threadId, runtime: owner, inbox })
            ask(request)
          }
          return {
            next: (timeoutMs) => inbox.next(timeoutMs),
            update: ask,
            ack: (received) => {
              const watch = watches.get(stream)
              if (watch?.inbox === inbox) watch.runtime.deliver({ type: "media-ack", stream, received })
            },
            close: () => {
              const watch = watches.get(stream)
              inbox.close()
              if (!watching() || !watch) return
              watches.delete(stream)
              watch.runtime.deliver({ type: "media-unwatch", stream })
            },
          }
        },
      }
    },

    async assign(threadId, runtimeId) {
      const target = thread(threadId)
      const previous = target.owner ? runtimes.get(target.owner) : undefined
      target.generation += 1
      target.owner = runtimeId
      previous?.deliver({
        type: "fence",
        threadId,
        generation: target.generation,
      })
      if (previous) endWatchesOf(previous, problem("unavailable", "The Thread moved to another runtime", crypto.randomUUID(), "not-applied", { status: 503 }), threadId)
      runtimes
        .get(runtimeId)
        ?.deliver({ type: "assign", threadId, generation: target.generation })
      if (runtimes.get(runtimeId)) deliverDeferred(target)
      return target.generation
    },

    async close() {
      for (const connection of connections) connection.close()
    },

    activity: (threadId) => activity.get(threadId),
    deferred: (threadId) => thread(threadId).deferred.map((operation) => operation.id),
  }
}

/** The id and correlation ID a refusal echoes, from an operation it couldn't read, where its envelope has them. */
function echoed(text: string) {
  const end = text.indexOf("\n")
  let head: unknown
  try {
    head = JSON.parse(end === -1 ? text : text.slice(0, end))
  } catch {
    // Not JSON: there is nothing to echo.
  }
  return {
    id: z.object({ id: z.uuid() }).safeParse(head).data?.id ?? NIL_ID,
    correlationId:
      z.object({ correlationId: CorrelationIdSchema }).safeParse(head).data
        ?.correlationId ?? crypto.randomUUID(),
  }
}
