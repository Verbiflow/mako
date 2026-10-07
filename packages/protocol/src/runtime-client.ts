import {
  type Operation,
  type Problem,
  type Reply,
  problem,
} from "./envelope.js"
import type { RuntimeLink } from "./gateway.js"
import type { GatewayFrame } from "./runtime-frames.js"
import { PROTOCOL_VERSION, SUPPORTED_VERSIONS } from "./version.js"

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
  /** The Threads this runtime believes it runs, after a restart. */
  threads?: Array<{ threadId: string; generation: number }>
  handle: OperationHandler
  /** Sees every frame after enrolment, before the runtime acts on it. */
  onFrame?: (frame: GatewayFrame) => void
}

export type ServedRuntime = {
  version: number
  /** The generation this runtime runs a Thread under, or undefined once it's fenced. */
  generation(threadId: string): number | undefined
  /** Settles when the link closes. */
  done: Promise<void>
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
  const threads = options.threads ?? []
  link.send({
    type: "enroll",
    runtimeId: options.runtimeId,
    versions: options.versions ?? SUPPORTED_VERSIONS,
    build: options.build,
    threads,
  })
  const first = await link.next()
  if (first.type !== "enrolled") {
    link.close()
    if (first.type === "refused") throw new RuntimeRefusedError(first.problem)
    throw new Error(`The gateway answered enrolment with ${first.type}`)
  }
  const generations = new Map(
    threads.map((claim) => [claim.threadId, claim.generation])
  )
  const heartbeat = setInterval(
    () => link.send({ type: "heartbeat" }),
    first.heartbeatMs
  )
  heartbeat.unref?.()

  const answer = async (
    operation: Operation,
    generation: number | undefined
  ) => {
    let reply: Reply
    const current =
      operation.target.kind === "thread"
        ? generations.get(operation.target.threadId)
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

  const done = (async () => {
    for await (const frame of link.frames()) {
      options.onFrame?.(frame)
      if (frame.type === "assign")
        generations.set(frame.threadId, frame.generation)
      else if (frame.type === "fence") {
        const held = generations.get(frame.threadId)
        if (held !== undefined && held < frame.generation)
          generations.delete(frame.threadId)
      } else if (frame.type === "operation")
        void answer(frame.operation, frame.generation)
    }
  })().finally(() => clearInterval(heartbeat))

  return {
    version: first.version,
    generation: (threadId) => generations.get(threadId),
    done,
    close: () => link.close(),
  }
}

function refusal(operation: Operation, reason: Problem): Reply {
  return { v: PROTOCOL_VERSION, id: operation.id, ok: false, problem: reason }
}
