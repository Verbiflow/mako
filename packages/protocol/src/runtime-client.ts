import {
  type Operation,
  type Problem,
  type Reply,
  problem,
} from "./envelope.js"
import { type ConnectionCredential, renewal } from "./credential.js"
import type { RuntimeLink } from "./gateway.js"
import { type MediaHandler, type MediaSender, type MediaStreamId, encodeMediaMessage } from "./media.js"
import type { Payload } from "./payload.js"
import type { GatewayFrame, RuntimeFrame } from "./runtime-frames.js"
import { RuntimeThreads, type ThreadClaim } from "./runtime-outbox.js"
import { ACTIVITY_VERSION, MEDIA_VERSION, PROTOCOL_VERSION, SUPPORTED_VERSIONS } from "./version.js"

export class RuntimeRefusedError extends Error {
  readonly problem: Problem
  constructor(refusal: Problem) {
    super(refusal.detail ?? refusal.title)
    this.name = "RuntimeRefusedError"
    this.problem = refusal
  }
}

export type OperationHandler = (
  operation: Operation,
  generation: number | undefined
) => Promise<Reply>

export type RuntimeOptions = {
  runtimeId: string
  /** The runtime's own build, for the gateway's logs. */
  build: string
  versions?: { min: number; max: number }
  /**
   * The Threads this runtime believes it runs. A `RuntimeThreads` outlives the link: it's claimed at enrolment,
   * kept current by the gateway's assignments and fences, and resends the events still owed on this link.
   */
  threads?: ThreadClaim[] | RuntimeThreads
  handle: OperationHandler
  /** Sees every frame after enrolment, before the runtime acts on it. */
  onFrame?: (frame: GatewayFrame) => void
  /** Renews the link's token in the link before it's due; a machine's credential doesn't need it. */
  credential?: ConnectionCredential
  /** Serves the live streams clients watch (`media.ts`); without it, every watch ends at once. */
  media?: MediaHandler
}

export type ServedRuntime = {
  version: number
  /** The generation this runtime runs a Thread under, or undefined once it's fenced. */
  generation(threadId: string): number | undefined
  /** Every Thread it runs, and under which generation: what it claims when it enrols again on a new link. */
  claims(): ThreadClaim[]
  /** Sends one of the Thread's events, kept until acknowledged; undefined when the runtime doesn't run the Thread. */
  emit(threadId: string, event: Payload, correlationId?: string): number | undefined
  /**
   * Says whether it's working, for every Thread it runs, on a gateway that speaks version 2 or later (false on an
   * older one, which never hears it). Not kept: a link that drops loses it, and the runtime says it again on the next.
   */
  activity(busy: boolean, work: string[]): boolean
  /** Settles when the link closes. */
  done: Promise<void>
  /** Why the link ended: the gateway's refusal, or undefined when the connection just closed. */
  ended: Promise<Problem | undefined>
  close(): void
}

/**
 * Enrols on `link` and answers operations until it closes. Operations run concurrently and each
 * gets exactly one reply; a handler that throws is answered as `internal` with an unknown
 * outcome, since it may have done part of its work.
 */
export async function serveRuntime(
  link: RuntimeLink,
  options: RuntimeOptions
): Promise<ServedRuntime> {
  const threads = options.threads instanceof RuntimeThreads ? options.threads : new RuntimeThreads({ claims: options.threads ?? [] })
  link.send({
    type: "enroll",
    runtimeId: options.runtimeId,
    versions: options.versions ?? SUPPORTED_VERSIONS,
    build: options.build,
    threads: threads.claims(),
  })
  const first = await link.next()
  if (first.type !== "enrolled") {
    link.close()
    if (first.type === "refused") throw new RuntimeRefusedError(first.problem)
    throw new Error(`The gateway answered enrolment with ${first.type}`)
  }
  const heartbeat = setInterval(
    () => link.send({ type: "ping" }),
    first.heartbeatMs
  )
  heartbeat.unref?.()
  const renewing =
    options.credential &&
    renewal(options.credential, (token) => {
      if (!link.closed) link.send({ type: "renew", token })
    })
  const send = (frame: RuntimeFrame) => link.send(frame)
  threads.attach(send)

  const answer = async (
    operation: Operation,
    generation: number | undefined
  ) => {
    let reply: Reply
    const current =
      operation.target.kind === "thread"
        ? threads.generation(operation.target.threadId)
        : undefined
    if (operation.target.kind === "thread" && current !== generation)
      reply = refusal(
        operation,
        problem(
          "fenced",
          "This runtime doesn't run the Thread under that generation",
          operation.correlationId,
          "not-applied",
          { status: 409, generation: current ?? 0 }
        )
      )
    else
      try {
        reply = await options.handle(operation, generation)
      } catch (error) {
        reply = refusal(
          operation,
          problem(
            "internal",
            "The runtime failed while running the operation",
            operation.correlationId,
            "unknown",
            {
              status: 500,
              detail: error instanceof Error ? error.message : String(error),
            }
          )
        )
      }
    if (!link.closed) link.send({ type: "reply", reply })
  }

  /** The streams this link serves, each until its viewer leaves, the runtime ends it, or the link closes. */
  const streams = new Map<MediaStreamId, MediaSender & { threadId: string }>()
  const endStream = (stream: MediaStreamId, reason?: Problem) => {
    if (!link.closed) link.send(reason ? { type: "media-end", stream, problem: reason } : { type: "media-end", stream })
  }
  const watched = (frame: Extract<GatewayFrame, { type: "media-watch" }>) => {
    const handler = options.media
    if (!handler || first.version < MEDIA_VERSION)
      return endStream(frame.stream, problem("unsupported-version", "This runtime serves no media", crypto.randomUUID(), "not-applied", { status: 501 }))
    if (threads.generation(frame.threadId) === undefined)
      return endStream(frame.stream, problem("fenced", "This runtime doesn't run the Thread", crypto.randomUUID(), "not-applied", { status: 409 }))
    let sender = streams.get(frame.stream)
    if (sender && sender.threadId !== frame.threadId) {
      streams.delete(frame.stream)
      handler.unwatched(frame.stream)
      sender = undefined
    }
    if (!sender) {
      const { stream, threadId } = frame
      const open = () => streams.get(stream) === sender && !link.closed
      sender = {
        threadId,
        send: (data) => {
          if (!open()) return false
          link.sendMedia(encodeMediaMessage(stream, data))
          return true
        },
        end: (reason) => {
          if (!open()) return
          streams.delete(stream)
          endStream(stream, reason)
        },
      }
      streams.set(stream, sender)
    }
    handler.watch(frame.stream, frame.threadId, frame.request, sender)
  }

  let ending: Problem | undefined
  const done = (async () => {
    for await (const frame of link.frames()) {
      options.onFrame?.(frame)
      if (frame.type === "refused") ending = frame.problem
      else if (frame.type === "renewed") renewing?.renewed()
      else if (frame.type === "operation")
        void answer(frame.operation, frame.generation)
      else if (frame.type === "media-watch") watched(frame)
      else if (frame.type === "media-ack") {
        if (streams.has(frame.stream)) options.media?.acked(frame.stream, frame.received)
      } else if (frame.type === "media-unwatch") {
        if (streams.delete(frame.stream)) options.media?.unwatched(frame.stream)
      } else {
        threads.receive(frame)
        // A Thread taken from this runtime takes its streams with it.
        if (frame.type === "fence")
          for (const [stream, sender] of streams)
            if (sender.threadId === frame.threadId && threads.generation(frame.threadId) === undefined) {
              streams.delete(stream)
              options.media?.unwatched(stream)
            }
      }
    }
  })().finally(() => {
    threads.detach(send)
    clearInterval(heartbeat)
    renewing?.stop()
    const left = [...streams.keys()]
    streams.clear()
    for (const stream of left) options.media?.unwatched(stream)
  })

  return {
    version: first.version,
    generation: (threadId) => threads.generation(threadId),
    claims: () => threads.claims(),
    emit: (threadId, event, correlationId) => threads.emit(threadId, event, correlationId),
    activity: (busy, work) => {
      if (first.version < ACTIVITY_VERSION || link.closed) return false
      for (const { threadId, generation } of threads.claims()) link.send({ type: "activity", threadId, generation, busy, work: work.slice(0, 20).map((item) => item.slice(0, 120)) })
      return true
    },
    done,
    ended: done.then(() => ending),
    close: () => link.close(),
  }
}

function refusal(operation: Operation, reason: Problem): Reply {
  return { v: PROTOCOL_VERSION, id: operation.id, ok: false, problem: reason }
}
