import { z } from "zod"
import {
  type Actor,
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
import { sessionStream, streamConversation } from "./socket.js"
import {
  type ClientConnection,
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
  encodeMediaMessage,
  mediaStreamOf,
} from "./media.js"
import { Payload } from "./payload.js"
import type { GatewayFrame, RuntimeFrame } from "./runtime-frames.js"
import { type SshClient, SshIncoming, SshOutgoing, SshRefusedError, type SshStream } from "./ssh.js"
import type { SessionsReport } from "./thread-listing.js"
import { COMPACT_LIVE_VERSION, MEDIA_VERSION, NUMBERED_LIVE_VERSION, PROTOCOL_VERSION, SESSIONS_VERSION, SSH_VERSION, SUPPORTED_VERSIONS, negotiate } from "./version.js"
import { LINGER_MS, LiveTail, frameFor, logFor, streamNoticeText } from "./live-tail.js"
import { type LiveForm, WHOLE_LIVE_FORM, readersForm, readsLiveForm } from "./live-form.js"
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
  event: "operation" | "enrolled" | "refused" | "disconnected" | "going-quiet" | "live-form"
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
  /**
   * A conversation's or a Thread's readers read another live form now, said to its runtime: which, the form, and why
   * (`readersForm`): how many read it, and how many of them read only form 1.
   */
  conversation?: string
  threadId?: string
  form?: LiveForm
  readers?: number
  whole?: number
}

export type FakeGatewayOptions = {
  now?: () => Date
  heartbeatMs?: number
  /** When a renewed link's token runs out, in seconds since 1970, or undefined to refuse it. Every token is good for five minutes by default. */
  renew?: (token: string) => number | undefined
  log?: (line: GatewayLogLine) => void
  /** How long a live stream nobody watches lingers (`LINGER_MS` unless given); 0 lets it go, and tells its runtime, at once. */
  lingerMs?: number
}

type Thread = {
  stream: StreamId
  owner: string | undefined
  /** 0 until the Thread is first assigned. */
  generation: number
  log: EventFrame[]
  /** By seq, the live form of each event written in one above 1. */
  forms: Map<number, LiveForm>
  /** `${generation}:${localSeq}` → seq, so a resent event is acknowledged without being recorded again. */
  recorded: Map<string, number>
  /** Each reader, and the live form it reads. */
  readers: Map<Inbox<EventFrame>, LiveForm>
  /** The form its runtime was last told every reader reads. */
  form: LiveForm
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
  /** A binary message to the runtime: an SSH client's bytes. */
  deliverMedia(message: Uint8Array): void
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
/** The fake, plus what its tests read of it: each Thread's runtime's last word on whether it's working, and on its conversations. */
export type FakeGateway = Omit<GatewayUnderTest, "connectClient"> & {
  /** A client of the gateway, which also opens SSH streams (`ssh.ts`). */
  connectClient(actor: Actor, connection?: ClientConnection): Promise<ClientSession & SshClient>
  activity(threadId: string): { busy: boolean; work: string[]; at: Date } | undefined
  /** Each report of its Sessions a runtime sent, in order, for a test of what it says and when. */
  reports(runtimeId: string): SessionsReport[]
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
  const reports = new Map<string, SessionsReport[]>()
  /**
   * By session stream: who watches it, and its numbering and last few updates (`LiveTail`), as a gateway keeps them. A
   * stream nobody watches lingers `LINGER_MS` (`idleSince`), its runtime still sending, so a watcher back from a dropped
   * link finds what it missed.
   */
  const sessionStreams = new Map<string, { watchers: Map<Inbox<EventFrame>, LiveForm>; tail: LiveTail; idleSince?: number; form: LiveForm }>()
  /** The highest number any session stream gave: a new stream's numbers start above it, and above the clock. */
  let liveHead = 0
  const nowMs = () => now().getTime()
  const lingerMs = options.lingerMs ?? LINGER_MS
  /** A stream nobody watched for `LINGER_MS` goes, and its runtime is told; true if any went. */
  const sweepStreams = () => {
    const gone: string[] = []
    for (const [stream, record] of sessionStreams)
      if (!record.watchers.size && record.idleSince !== undefined && nowMs() - record.idleSince >= lingerMs) {
        sessionStreams.delete(stream)
        gone.push(stream)
      }
    for (const runtimeId of new Set(gone.flatMap((stream) => streamConversation(stream)?.runtimeId ?? []))) watchFrame(runtimeId)
  }
  /** Tells a runtime every one of its conversations someone watches now; on a new link, only if any is. */
  const watchFrame = (runtimeId: string, enrolling = false) => {
    const runtime = runtimes.get(runtimeId)
    if (!runtime || (runtime.version ?? 0) < SESSIONS_VERSION) return
    const watched = [...sessionStreams].flatMap(([stream, record]) => {
      const target = streamConversation(stream)
      return target?.runtimeId === runtimeId ? [{ conversation: target.conversation, record }] : []
    })
    if (enrolling && !watched.length) return
    const conversations = watched.map(({ conversation }) => conversation)
    if ((runtime.version ?? 0) < NUMBERED_LIVE_VERSION) return runtime.deliver({ type: "watch", conversations })
    const after = Object.fromEntries(watched.flatMap(({ conversation, record }) => (record.tail.runtime === undefined ? [] : [[conversation, record.tail.runtime]])))
    const forms = Object.fromEntries(watched.flatMap(({ conversation, record }) => (record.form === WHOLE_LIVE_FORM ? [] : [[conversation, record.form]])))
    runtime.deliver({ type: "watch", conversations, ...(Object.keys(after).length && { after }), ...((runtime.version ?? 0) >= COMPACT_LIVE_VERSION && Object.keys(forms).length && { forms }) })
  }
  /**
   * A stream's watchers changed: whether the form every one of them reads is another than its runtime was told, which
   * its next `watch` says. A stream nobody watches keeps the form it had, as its runtime still sends for it while it lingers.
   */
  const reformStream = (stream: string, record: { watchers: Map<Inbox<EventFrame>, LiveForm>; form: LiveForm }): boolean => {
    if (!record.watchers.size) return false
    const said = readersForm(record.watchers.values())
    if (said.form === record.form) return false
    record.form = said.form
    const target = streamConversation(stream)!
    log({ event: "live-form", runtimeId: target.runtimeId, conversation: target.conversation, ...said })
    return true
  }
  /** A Thread's readers changed: when the form every one of them reads is another, its runtime is told (`live-form`). */
  const reformThread = (threadId: string, target: Thread) => {
    const said = readersForm(target.readers.values())
    if (said.form === target.form) return
    target.form = said.form
    log({ event: "live-form", threadId, ...said })
    const owner = target.owner ? runtimes.get(target.owner) : undefined
    if ((owner?.version ?? 0) >= COMPACT_LIVE_VERSION) owner!.deliver({ type: "live-form", threadId, form: said.form })
  }
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
  /**
   * SSH streams (`ssh.ts`), each one client's to the runtime that ran its Thread when it asked: what the client reads,
   * its sending, held until the runtime says `ssh-opened`, and how it hears that.
   */
  const sshes = new Map<MediaStreamId, { threadId: string; runtime: Connection; inbox: Inbox<MediaDelivery>; outgoing: SshOutgoing; open(): void; refuse(reason?: Problem): void }>()
  const endSsh = (stream: MediaStreamId, reason?: Problem) => {
    const ssh = sshes.get(stream)
    if (!ssh) return
    sshes.delete(stream)
    ssh.outgoing.close()
    ssh.refuse(reason)
    ssh.inbox.push(reason ? { kind: "ended", problem: reason } : { kind: "ended" })
    ssh.inbox.close()
  }
  const endSshesOf = (runtime: Connection, reason: Problem, threadId?: string) => {
    for (const [stream, ssh] of sshes)
      if (ssh.runtime === runtime && (threadId === undefined || ssh.threadId === threadId)) endSsh(stream, reason)
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
    const viewer = watches.get(stream) ?? sshes.get(stream)
    if (!viewer || viewer.runtime !== connection) return connection.deliver({ type: "media-unwatch", stream })
    viewer.inbox.push({ kind: "data", data: decodeMediaMessage(message).data })
  }

  const thread = (threadId: string): Thread => {
    let found = threads.get(threadId)
    if (!found) {
      found = {
        stream: threadStream(threadId),
        owner: undefined,
        generation: 0,
        log: [],
        forms: new Map(),
        recorded: new Map(),
        readers: new Map(),
        form: WHOLE_LIVE_FORM,
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
    correlationId: string | undefined,
    form: LiveForm = WHOLE_LIVE_FORM
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
    if (form !== WHOLE_LIVE_FORM) target.forms.set(frame.seq, form)
    for (const [reader, reads] of target.readers) reader.push(readsLiveForm(reads, form) ? frame : rereadFrame(target.stream, frame.seq))
    return frame
  }
  /** In place of an event a reader doesn't read the form of, under its number: the notice to read the conversation again. */
  const rereadFrame = (stream: StreamId, seq: number): EventFrame => ({ v: PROTOCOL_VERSION, stream, seq, at: now().toISOString(), event: Payload.encoded(streamNoticeText({ streamNotice: "reread", head: seq })) })

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
    const left = problem("unavailable", "The Thread's runtime left", connection.correlationId, "not-applied", { status: 503 })
    endWatchesOf(connection, left)
    endSshesOf(connection, left)
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
    // Whatever is watched of this runtime's conversations, said again on its new link: a new link starts with none.
    watchFrame(frame.runtimeId, true)
    // And the form each of its Threads' readers read, where that's above 1.
    if (version >= COMPACT_LIVE_VERSION)
      for (const [threadId, owned] of threads) if (owned.owner === frame.runtimeId && owned.form !== WHOLE_LIVE_FORM) connection.deliver({ type: "live-form", threadId, form: owned.form })
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
        frame.correlationId,
        frame.form
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
    // Link version 4's listing, keyed by cloud Thread: taken and dropped, as a gateway does.
    if (frame.type === "listing") return
    if (frame.type === "sessions") {
      reports.set(connection.runtimeId, [...(reports.get(connection.runtimeId) ?? []), frame.report])
      return
    }
    if (frame.type === "live") {
      sweepStreams()
      const stream = sessionStream(connection.runtimeId, frame.conversation)
      const record = sessionStreams.get(stream)
      if (!record) return
      const kept = record.tail.take(frame.event.text, now(), { ...(frame.n !== undefined && { n: frame.n }), ...(frame.correlationId && { correlationId: frame.correlationId }), ...(frame.form !== undefined && { form: frame.form }) })
      if (!kept) return
      liveHead = Math.max(liveHead, kept.seq)
      for (const [reader, reads] of record.watchers) {
        const sent = frameFor(kept, reads)
        reader.push({ v: PROTOCOL_VERSION, stream, seq: sent.seq, at: sent.at, ...(sent.correlationId && { correlationId: sent.correlationId }), event: sent === kept ? frame.event : Payload.encoded(sent.text) })
      }
      return
    }
    if (frame.type === "reply") {
      const waiting = running.get(frame.reply.id)
      if (!waiting || waiting.runtimeId !== connection.runtimeId) return
      waiting.settle(frame.reply, true)
    }
    if (frame.type === "media-end" && watches.get(frame.stream)?.runtime === connection) endWatch(frame.stream, frame.problem)
    if (frame.type === "media-end" && sshes.get(frame.stream)?.runtime === connection) endSsh(frame.stream, frame.problem)
    if (frame.type === "ssh-opened" && sshes.get(frame.stream)?.runtime === connection) sshes.get(frame.stream)?.open()
    if (frame.type === "media-ack" && sshes.get(frame.stream)?.runtime === connection) sshes.get(frame.stream)?.outgoing.acked(frame.received)
    // Going away on purpose: its link is let go now, as the gateway does, not when its heartbeats stop.
    if (frame.type === "going-quiet") {
      log({ event: "going-quiet", runtimeId: connection.runtimeId, correlationId: connection.correlationId })
      connection.close()
    }
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
    const { whenAsleep: _asleep, ahead: _ahead, repeatable: _repeatable, passive: _passive, whenUnstarted: _unstarted, ...delivered } = operation
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
      let mediaListener: ((message: Uint8Array) => void) | undefined
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
        deliverMedia: (message) => {
          if (connection.closed) return
          // In order behind the frames already delivered, as a socket keeps them.
          const copy = message.slice()
          if (mediaListener) queueMicrotask(() => mediaListener?.(copy))
          else connection.close()
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
        receiveMedia: (listener) => {
          mediaListener = listener
        },
        next: (timeoutMs) => inbox.next(timeoutMs),
        frames: () => inbox,
        close: () => connection.close(),
        get closed() {
          return connection.closed
        },
      }
    },

    async connectClient(actor, connection: ClientConnection = {}): Promise<ClientSession & SshClient> {
      ActorSchema.parse(actor)
      const reads = connection.live ?? WHOLE_LIVE_FORM
      const answer = (reply: Reply) => decodeReply(encodeReply(reply))
      const ownSshes = new Map<MediaStreamId, SshStream>()
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
          const backlog = target?.log.slice(after).map((frame) => ({ frame, seq: frame.seq, form: target.forms.get(frame.seq) })) ?? []
          for (const sent of logFor(backlog, reads)) reader.push(sent.event?.frame ?? rereadFrame(target!.stream, sent.seq))
          if (target) {
            target.readers.set(reader, reads)
            reformThread(stream.slice("thread:".length), target)
          }
          // A conversation's live updates: its runtime is told it's watched by the first watcher, and not once the last
          // has been gone `LINGER_MS`. The watcher hears the stream's head first, then what it missed after `after` from
          // the tail, or that it must read the conversation again.
          const watched = streamConversation(stream) ? stream : undefined
          if (watched) {
            sweepStreams()
            let record = sessionStreams.get(watched)
            const fresh = !record
            if (!record) {
              record = { watchers: new Map(), tail: new LiveTail(Math.max(liveHead + 1, nowMs())), form: WHOLE_LIVE_FORM }
              liveHead = record.tail.head
              sessionStreams.set(watched, record)
            }
            for (const opening of record.tail.opening(after, reads))
              reader.push({ v: PROTOCOL_VERSION, stream: watched, seq: opening.seq, at: opening.at ?? now().toISOString(), ...(opening.correlationId && { correlationId: opening.correlationId }), event: Payload.encoded(opening.text) })
            record.watchers.set(reader, reads)
            delete record.idleSince
            if (reformStream(watched, record) || fresh) watchFrame(streamConversation(watched)!.runtimeId)
          }
          const next = async (timeoutMs?: number) =>
            decodeEventFrame(encodeEventFrame(await reader.next(timeoutMs)))
          return {
            next,
            close: () => {
              if (target?.readers.delete(reader)) reformThread(stream.slice("thread:".length), target)
              reader.close()
              const record = watched ? sessionStreams.get(watched) : undefined
              if (record?.watchers.delete(reader)) {
                if (record.watchers.size) {
                  if (reformStream(watched!, record)) watchFrame(streamConversation(watched!)!.runtimeId)
                } else {
                  record.idleSince = nowMs()
                  if (lingerMs === 0) sweepStreams()
                }
              }
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
        ssh({ threadId, stream }): SshStream {
          MediaStreamIdSchema.parse(stream)
          ownSshes.get(stream)?.close()
          const inbox = new Inbox<MediaDelivery>()
          const mine = () => {
            const ssh = sshes.get(stream)
            return ssh?.inbox === inbox ? ssh : undefined
          }
          let open = () => {}
          let refuse = (_reason?: Problem) => {}
          const opened = new Promise<void>((resolve, reject) => {
            open = resolve
            refuse = (reason) => reject(new SshRefusedError(reason))
          })
          // Read by whoever waits for it; a stream nobody waited on ends without an unhandled rejection.
          opened.catch(() => undefined)
          const outgoing = new SshOutgoing((piece) => {
            const ssh = mine()
            if (!ssh) return false
            ssh.runtime.deliverMedia(encodeMediaMessage(stream, piece))
            return true
          })
          const taken = new SshIncoming((received) => mine()?.runtime.deliver({ type: "media-ack", stream, received }))
          const target = threads.get(threadId)
          const owner = target?.owner ? runtimes.get(target.owner) : undefined
          const ended = (type: "unavailable" | "unsupported-version" | "conflict", title: string, status: number) => {
            const reason = problem(type, title, crypto.randomUUID(), "not-applied", { status })
            refuse(reason)
            inbox.push({ kind: "ended", problem: reason })
            inbox.close()
          }
          if (watches.has(stream) || sshes.has(stream)) ended("conflict", "Another stream of that name is open on this Thread", 409)
          else if (!owner) ended("unavailable", "Nothing runs this Thread now", 503)
          else if ((owner.version ?? 0) < SSH_VERSION) ended("unsupported-version", "This Thread's runtime is too old for SSH", 501)
          else {
            sshes.set(stream, {
              threadId,
              runtime: owner,
              inbox,
              outgoing,
              open: () => {
                open()
                outgoing.release()
              },
              refuse,
            })
            owner.deliver({ type: "ssh-open", threadId, stream })
          }
          const made: SshStream = {
            opened,
            next: (timeoutMs) => inbox.next(timeoutMs),
            send: (data) => outgoing.write(data),
            drained: () => outgoing.drained(),
            took: (bytes) => taken.took(bytes),
            close: () => {
              if (ownSshes.get(stream) === made) ownSshes.delete(stream)
              const ssh = mine()
              inbox.close()
              outgoing.close()
              refuse()
              if (!ssh) return
              sshes.delete(stream)
              ssh.runtime.deliver({ type: "media-unwatch", stream })
            },
          }
          ownSshes.set(stream, made)
          return made
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
      if (previous) {
        const moved = problem("unavailable", "The Thread moved to another runtime", crypto.randomUUID(), "not-applied", { status: 503 })
        endWatchesOf(previous, moved, threadId)
        endSshesOf(previous, moved, threadId)
      }
      const owner = runtimes.get(runtimeId)
      owner?.deliver({ type: "assign", threadId, generation: target.generation })
      if (owner && (owner.version ?? 0) >= COMPACT_LIVE_VERSION && target.form !== WHOLE_LIVE_FORM) owner.deliver({ type: "live-form", threadId, form: target.form })
      if (runtimes.get(runtimeId)) deliverDeferred(target)
      return target.generation
    },

    async close() {
      for (const connection of connections) connection.close()
    },

    activity: (threadId) => activity.get(threadId),
    reports: (runtimeId) => reports.get(runtimeId) ?? [],
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
