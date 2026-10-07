import { z } from "zod"
import {
  ActorSchema,
  type Operation,
  OperationSchema,
  type Problem,
  type Reply,
  problem,
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
import { CorrelationIdSchema, type Json } from "./ids.js"
import {
  type GatewayFrame,
  type RuntimeFrame,
  RuntimeFrameSchema,
} from "./runtime-frames.js"
import { PROTOCOL_VERSION, SUPPORTED_VERSIONS, negotiate } from "./version.js"

const NIL_ID = "00000000-0000-0000-0000-000000000000"

type Thread = {
  stream: StreamId
  owner: string | undefined
  /** 0 until the Thread is first assigned. */
  generation: number
  log: EventFrame[]
  /** `${generation}:${localSeq}` → seq, so a resent event is acknowledged without being recorded again. */
  recorded: Map<string, number>
  readers: Set<Inbox<EventFrame>>
}

type Connection = {
  runtimeId: string | undefined
  correlationId: string
  closed: boolean
  inbox: Inbox<GatewayFrame>
  deliver(frame: GatewayFrame): void
  close(): void
}

type Pending = {
  runtimeId: string
  correlationId: string
  resolve(reply: Reply): void
}

/**
 * An in-memory gateway with the semantics the real one must have, for runtimes and clients to test
 * against without a network. It passes the conformance suite, which is how it stays honest.
 */
export function createFakeGateway(
  options: { now?: () => Date; heartbeatMs?: number } = {}
): GatewayUnderTest {
  const now = options.now ?? (() => new Date())
  const heartbeatMs = options.heartbeatMs ?? 15_000
  const threads = new Map<string, Thread>()
  const runtimes = new Map<string, Connection>()
  const connections = new Set<Connection>()
  const admitted = new Map<string, Promise<Reply>>()
  const pending = new Map<string, Pending>()

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
      }
      threads.set(threadId, found)
    }
    return found
  }

  const append = (
    target: Thread,
    event: Json,
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
    if (
      !connection.runtimeId ||
      runtimes.get(connection.runtimeId) !== connection
    )
      return
    runtimes.delete(connection.runtimeId)
    for (const [id, waiting] of pending)
      if (waiting.runtimeId === connection.runtimeId) {
        pending.delete(id)
        waiting.resolve(
          failure(
            id,
            problem(
              "owner-unavailable",
              "The Thread's runtime disconnected before answering",
              waiting.correlationId,
              "unknown",
              { status: 503 }
            )
          )
        )
      }
  }

  const refuse = (connection: Connection, reason: Problem) => {
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
    runtimes.set(frame.runtimeId, connection)
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

  const receive = (connection: Connection, value: Json) => {
    const parsed = RuntimeFrameSchema.safeParse(value)
    if (!parsed.success)
      return refuse(
        connection,
        problem(
          "bad-request",
          "Not a runtime frame",
          connection.correlationId,
          "not-applied",
          { status: 400, detail: z.prettifyError(parsed.error) }
        )
      )
    const frame = parsed.data
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
    if (frame.type === "event") return record(connection, frame)
    if (frame.type === "reply") {
      const waiting = pending.get(frame.reply.id)
      if (!waiting || waiting.runtimeId !== connection.runtimeId) return
      pending.delete(frame.reply.id)
      waiting.resolve(frame.reply)
    }
  }

  const admit = (operation: Operation): Promise<Reply> => {
    const correlationId = operation.correlationId
    if (!operation.threadId)
      return Promise.resolve(
        failure(
          operation.id,
          problem(
            "not-found",
            "The fake gateway routes only Thread operations",
            correlationId,
            "not-applied",
            { status: 404 }
          )
        )
      )
    const target = thread(operation.threadId)
    const owner = target.owner ? runtimes.get(target.owner) : undefined
    if (!owner?.runtimeId)
      return Promise.resolve(
        failure(
          operation.id,
          problem(
            "owner-unavailable",
            "No runtime is running this Thread",
            correlationId,
            "not-applied",
            { status: 503 }
          )
        )
      )
    const admission = append(
      target,
      {
        type: "operation-admitted",
        operationId: operation.id,
        op: operation.op,
        actor: operation.actor,
      },
      undefined,
      correlationId
    )
    const runtimeId = owner.runtimeId
    const reply = new Promise<Reply>((resolve) =>
      pending.set(operation.id, { runtimeId, correlationId, resolve })
    ).then((answer) => (answer.ok ? { ...answer, seq: admission.seq } : answer))
    admitted.set(operation.id, reply)
    owner.deliver({
      type: "operation",
      generation: target.generation,
      operation,
    })
    return reply
  }

  return {
    async connectRuntime(): Promise<RuntimeLink> {
      const inbox = new Inbox<GatewayFrame>()
      const connection: Connection = {
        runtimeId: undefined,
        correlationId: crypto.randomUUID(),
        closed: false,
        inbox,
        deliver: (frame) => {
          if (!connection.closed) inbox.push(frame)
        },
        close: () => {
          if (connection.closed) return
          connection.closed = true
          disconnect(connection)
        },
      }
      connections.add(connection)
      const send = (value: Json) => {
        if (!connection.closed) queueMicrotask(() => receive(connection, value))
      }
      return {
        send: (frame: RuntimeFrame) => send(frame),
        sendUnchecked: send,
        next: (timeoutMs) => inbox.next(timeoutMs),
        close: () => connection.close(),
        get closed() {
          return connection.closed
        },
      }
    },

    async connectClient(actor): Promise<ClientSession> {
      ActorSchema.parse(actor)
      return {
        async call(value) {
          const parsed = OperationSchema.safeParse(value)
          if (!parsed.success) {
            const id =
              z.object({ id: z.uuid() }).safeParse(value).data?.id ?? NIL_ID
            const correlationId =
              z.object({ correlationId: CorrelationIdSchema }).safeParse(value)
                .data?.correlationId ?? crypto.randomUUID()
            return failure(
              id,
              problem(
                "bad-request",
                "Not a valid operation",
                correlationId,
                "not-applied",
                { status: 400, detail: z.prettifyError(parsed.error) }
              )
            )
          }
          return admitted.get(parsed.data.id) ?? admit(parsed.data)
        },
        subscribe(request): Subscription {
          const { stream, after } = SubscribeSchema.parse(request)
          const reader = new Inbox<EventFrame>()
          const target = stream.startsWith("thread:")
            ? thread(stream.slice("thread:".length))
            : undefined
          for (const frame of target?.log.slice(after) ?? []) reader.push(frame)
          target?.readers.add(reader)
          return {
            next: (timeoutMs) => reader.next(timeoutMs),
            close: () => void target?.readers.delete(reader),
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
      runtimes
        .get(runtimeId)
        ?.deliver({ type: "assign", threadId, generation: target.generation })
      return target.generation
    },

    async close() {
      for (const connection of connections) connection.close()
    },
  }
}
