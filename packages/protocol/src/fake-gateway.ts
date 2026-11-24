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
import type { Progress } from "./borrow.js"
import type { Advertisement, GatewayFrame, RuntimeFrame } from "./runtime-frames.js"
import { type SshClient, SshIncoming, SshOutgoing, SshRefusedError, type SshStream } from "./ssh.js"
import type { SessionsReport } from "./thread-listing.js"
import {
  type HeldTreeNotice,
  type KeptTreeEdge,
  type LastTreeNotice,
  TREE_NOTICE_DEAD_LETTERS,
  type TreeEdge,
  type TreeEdgeAnswer,
  TreeEdgeAnswerSchema,
  type TreeEdgeAsk,
  TreeEdgeAskSchema,
  TreeEdgeSchema,
  type TreeNotice,
  type TreeNoticeAnswer,
  TreeNoticeAnswerSchema,
  type TreeNoticeDelivery,
  TreeNoticeDeliverySchema,
  type TreeNoticeFrom,
  TreeNoticeFromSchema,
  TreeNoticeSchema,
  admitTreeNotice,
  decideTreeEdge,
  apexSessionOfStart,
  takesTreeNotices,
  treeNoticeAck,
  treeNoticeAckWord,
  treeNoticeBytes,
  treeNoticeDisposal,
  treeNoticeFits,
  treeNoticeOperation,
  treeEdgeOfNotice,
  treeNoticeRateOpen,
} from "./tree-notices.js"
import { COMPACT_LIVE_VERSION, LEND_LINK_VERSION, MEDIA_VERSION, NUMBERED_LIVE_VERSION, PROTOCOL_VERSION, SESSIONS_VERSION, SSH_VERSION, SUPPORTED_VERSIONS, negotiate, type VersionRange } from "./version.js"
import { LINGER_MS, LiveTail, frameFor, logFor, streamNoticeText } from "./live-tail.js"
import { type LiveForm, WHOLE_LIVE_FORM, readersForm, readsLiveForm } from "./live-form.js"
import {
  WireError,
  decodeEventFrame,
  decodeGatewayClientFrame,
  decodeGatewayFrame,
  decodeOperation,
  decodeReply,
  decodeRuntimeFrame,
  encodeEventFrame,
  encodeGatewayClientFrame,
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
  /** The link versions this gateway speaks (`SUPPORTED_VERSIONS` unless given): an older gateway's, to hold a runtime to it. */
  versions?: VersionRange
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

/** A cloud Fin's machine as the account made it for the Fin's start, which is all a notice it posts is stamped from. */
export type FakeFinMachine = {
  /** The Fin's start. */
  op: string
  /** Its cloud Thread, the machine it runs on, and the generation it runs under. */
  thread: string
  machine: string
  generation: number
  /**
   * The Fin's Thread as its Apex knows it. Left out, the first child a notice of the machine's names is its Fin. Either
   * way its notices name that one child and no other, ever; nothing keeps another machine from naming the same one.
   */
  child?: string
  /** The Apex it was started for: the only Thread and Session its notices go to, whatever they say. */
  apex: { thread: string; session: string }
}

/** Who posts a notice, as its credential says: one of the account's devices, or a cloud Fin's machine. */
export type FakeNoticeSender = { kind: "device"; device: string } | { kind: "machine"; machine: string }

/** A notice put aside (`treeNoticeDisposal`): which it was, who sent it and why it went, and nothing of its report. */
export type FakeDeadNotice = { id: string; child: string; from: TreeNoticeFrom; why: "conflict" | "unknown-child" }

/** What the account holds for one Apex's Session (`tree-notices.ts`). */
type Mailbox = {
  /** The last number given: numbers only rise, so `held` stays in the order it was admitted. */
  head: number
  /** Each under its sender's `scope`, the start that made its Fin: a machine's own, or a device's record's (`treeEdgeOfNotice`). */
  held: Array<HeldTreeNotice & { from: TreeNoticeFrom; scope: string }>
  /** What was put aside, newest last, at most `TREE_NOTICE_DEAD_LETTERS`: a record each, its body dropped. */
  dead: FakeDeadNotice[]
  /** Raised when the Session changes owner: a delivery under way to the owner before is left, whatever it answers. */
  run: number
  delivering: boolean
  /** Something that sends held notices again happened while they were being delivered: they go once more after. */
  again: boolean
}

type Connection = {
  runtimeId: string | undefined
  /** The link version agreed at enrolment. */
  version: number | undefined
  /** Whether this link's last `advertise` said it takes notices from the account (`TREE_NOTICES_CAPABILITY`). */
  takesNotices: boolean
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
  /** Every advertisement a device's runtime sent (`advertise`), oldest first. */
  advertisements(runtimeId: string): Advertisement[]
  /** Every heartbeat a device's runtime sent for a session it serves (`lease-beat`), oldest first. */
  beats(runtimeId: string): Array<{ lease: string; progress?: Progress }>
  /** Sends a runtime what it lends (`source-ask`, `lent`, `lent-ended`), as the account's broker does; false while it isn't connected. */
  lend(runtimeId: string, frame: Extract<GatewayFrame, { type: "source-ask" | "lent" | "lent-ended" }>): boolean
  /** The operations waiting for the Thread's runtime (`whenAsleep: "defer"`). */
  deferred(threadId: string): string[]
  /** Makes a cloud Fin's machine known, as its start does: a notice posted as that machine is stamped with these. */
  finMachine(fin: FakeFinMachine): void
  /** That machine's Fin's place is over: a notice it posts from now is `gone`. */
  finMachineOver(machine: string): void
  /** An Apex's Session's Thread was archived: what's held for the Session is dropped, and a notice for it is `gone`, its Fins' records standing so that it is. */
  archiveTree(session: string): void
  /** Makes a Fin's record known, as its Apex's device's ask does (`askTreeEdge`), with nobody asked who owns its Apex's Session. */
  treeEdge(edge: TreeEdge): void
  /**
   * An ask posted to `TREE_EDGES_PATH` (`body` its JSON text) by a device, as its credential names it: a record kept
   * or ended, only for the device whose runtime (`d-<device>`) owns the record's Apex's Session as the runtimes'
   * reports say (`decideTreeEdge`). A record ended with notices still held under it stands until they're taken.
   */
  askTreeEdge(device: string, body: string): Promise<TreeEdgeAnswer>
  /** The records kept, oldest first, each as the account keeps it. */
  treeEdges(): KeptTreeEdge[]
  /**
   * A Session's records lapsed, as the account's do `TREE_EDGE_LEASE_MS` after it last knew the Session's owner was
   * there (`treeEdgesStandUntil`): each goes once nothing admitted under it is still held.
   */
  lapseTreeEdges(session: string): void
  /**
   * A notice posted (a device to `TREE_NOTICES_PATH`, a machine to `machineNoticesPath`; `body` its JSON text), by a
   * sender as its credential names it and never as the body does: admitted or refused at once, and delivered to the
   * owner of its Apex's Session when there is one to take it. A device's is admitted only under a record that names
   * it, the notice's child and the notice's Apex (`treeEdgeOfNotice`), and is held under that record's start.
   */
  postNotice(sender: FakeNoticeSender, body: string): Promise<TreeNoticeAnswer>
  /** What's held for an Apex's Session, as it would be delivered, in the order it was admitted. */
  heldNotices(session: string): TreeNoticeDelivery[]
  /** What was put aside for an Apex's Session (its owner answered `conflict`, or `unknown-child` for an hour), oldest first. */
  deadNotices(session: string): FakeDeadNotice[]
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
  const speaks = options.versions ?? SUPPORTED_VERSIONS
  const advertised = new Map<string, Advertisement[]>()
  const beaten = new Map<string, Array<{ lease: string; progress?: Progress }>>()
  /**
   * Who owns each Session, as its owners' reports say under the one-owner rule: a higher generation takes it, the same
   * one only from the same runtime. A Session nobody reports has no owner, and what's held for it waits for one.
   */
  const sessionOwners = new Map<string, { runtime: string; generation: number }>()
  /** By Apex's Session: the notices held for it. */
  const mailboxes = new Map<string, Mailbox>()
  const finMachines = new Map<string, FakeFinMachine & { over: boolean }>()
  const archivedTrees = new Set<string>()
  /** By start: the records of Fins off their Apexes' hosts, oldest first (`TreeEdgeSchema`). */
  const treeEdges = new Map<string, KeptTreeEdge>()
  /** By sender's scope: when it posted in the last minute, every post counted. */
  const noticePosts = new Map<string, number[]>()
  /** By sender's scope: the last notice admitted from it, which tells that one posted again from a new one once it's been taken. */
  const lastNotices = new Map<string, LastTreeNotice>()
  /**
   * By session stream: who watches it, and its numbering and last few updates (`LiveTail`), as a gateway keeps them. A
   * stream nobody watches lingers `LINGER_MS` (`idleSince`), its runtime still sending, so a watcher back from a dropped
   * link finds what it missed.
   */
  const sessionStreams = new Map<string, { watchers: Map<Inbox<EventFrame>, LiveForm>; tail: LiveTail; idleSince?: number; form: LiveForm }>()
  /** The watchers whose connection said it reads `ephemeral` frames (`EPHEMERAL_PARAM`). */
  const ephemeralReaders = new WeakSet<Inbox<EventFrame>>()
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

  const mailbox = (session: string): Mailbox => {
    let found = mailboxes.get(session)
    if (!found) {
      found = { head: 0, held: [], dead: [], run: 0, delivering: false, again: false }
      mailboxes.set(session, found)
    }
    return found
  }
  const deliveryOf = (held: Pick<Mailbox["held"][number], "notice" | "from">): TreeNoticeDelivery => TreeNoticeDeliverySchema.parse({ ...held.notice, from: held.from })
  /** A record its Apex's device ended goes once nothing admitted under it is held: asked as it's ended, and as anything held is let go. */
  const endTreeEdges = () => {
    for (const [op, kept] of treeEdges) {
      if (kept.ending && ![...mailboxes.values()].some((box) => box.held.some((held) => held.scope === op))) treeEdges.delete(op)
    }
  }
  /**
   * Sends a Session's held notices to its owner: one at a time, in order, each waiting for the last one's answer. It
   * stops at the first the owner doesn't answer (it's off, or its link never said it takes notices), and passes over a
   * Fin's other notices once the owner said it doesn't know that Fin, so one Fin's reports stay in order and don't hold
   * up another's. Nothing here waits on a clock: what's kept goes again when this is next asked, and one the owner
   * hasn't known the Fin of for an hour is put aside then.
   */
  const deliverNotices = (session: string) => {
    const box = mailboxes.get(session)
    if (!box?.held.length) return
    if (box.delivering) {
      box.again = true
      return
    }
    box.delivering = true
    void deliverHeld(session, box, box.run)
  }
  const deliverHeld = async (session: string, box: Mailbox, run: number) => {
    do {
      box.again = false
      const unknown = new Set<string>()
      let after = 0
      for (;;) {
        const next = box.held.find((held) => held.seq > after && !unknown.has(held.scope))
        const owner = runtimes.get(sessionOwners.get(session)?.runtime ?? "")
        if (!next || !owner?.runtimeId || !owner.takesNotices) break
        after = next.seq
        const sent = next.notice
        const reply = await route(treeNoticeOperation(deliveryOf(next), {
          id: crypto.randomUUID(),
          target: { kind: "runtime", runtimeId: owner.runtimeId },
          actor: { kind: "runtime", runtimeId: `gateway:${next.notice.parent.thread}` },
          correlationId: crypto.randomUUID(),
        }))
        // The Session changed owner meanwhile: its new owner is being sent what's held, this one included.
        if (box.run !== run) return
        const ack = treeNoticeAck(reply)
        if (!ack) break
        const disposal = treeNoticeDisposal(ack, nowMs() - next.from.at)
        if (disposal === "keep") {
          unknown.add(next.scope)
          continue
        }
        if (!box.held.includes(next)) continue
        // Its Fin stood otherwise while this was on its way: it goes once more, as it's held now.
        if (disposal === "delete" && next.notice !== sent) {
          after = next.seq - 1
          continue
        }
        box.held.splice(box.held.indexOf(next), 1)
        endTreeEdges()
        if (disposal === "dead-letter") box.dead = [...box.dead, { id: next.notice.id, child: next.notice.child, from: next.from, why: treeNoticeAckWord(ack) === "conflict" ? "conflict" as const : "unknown-child" as const }].slice(-TREE_NOTICE_DEAD_LETTERS)
      }
    } while (box.again)
    box.delivering = false
  }
  /** A Session has another owner now: what's held for it goes to that one, whatever was under way to the one before. */
  const noticesMoved = (session: string) => {
    const box = mailboxes.get(session)
    if (!box) return
    box.run += 1
    box.delivering = false
    deliverNotices(session)
  }
  /** A runtime's report of its Sessions, read for who owns each (`sessionOwners`). */
  const ownSessions = (runtimeId: string, report: SessionsReport) => {
    const moved: string[] = []
    for (const row of [...(report.owned ?? []), ...report.listed]) {
      const known = sessionOwners.get(row.session)
      if (known && (row.generation < known.generation || (row.generation === known.generation && known.runtime !== runtimeId))) continue
      if (known?.runtime !== runtimeId) moved.push(row.session)
      sessionOwners.set(row.session, { runtime: runtimeId, generation: row.generation })
    }
    const named = report.owned && new Set(report.owned.map((row) => row.session))
    for (const [session, known] of sessionOwners) {
      if (known.runtime !== runtimeId) continue
      if (report.gone.some((row) => row.session === session && row.generation >= known.generation) || (named && !named.has(session))) sessionOwners.delete(session)
    }
    for (const session of moved) noticesMoved(session)
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
    const version = negotiate(speaks, frame.versions)
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
            detail: `The runtime speaks ${frame.versions.min} to ${frame.versions.max}; this gateway speaks ${speaks.min} to ${speaks.max}`,
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
    // A Thread's passing state: from its owner under its generation, to the readers that read it, now; never in its log.
    if (frame.type === "passing") {
      const target = threads.get(frame.threadId)
      if (target?.owner !== connection.runtimeId || target.generation !== frame.generation) return
      for (const reader of target.readers.keys())
        if (ephemeralReaders.has(reader))
          reader.push({ v: PROTOCOL_VERSION, stream: target.stream, seq: 0, at: now().toISOString(), ...(frame.correlationId && { correlationId: frame.correlationId }), event: frame.event, ephemeral: true })
      return
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
      ownSessions(connection.runtimeId, frame.report)
      return
    }
    if (frame.type === "lease-beat") {
      beaten.set(connection.runtimeId, [...(beaten.get(connection.runtimeId) ?? []), frame.progress ? { lease: frame.lease, progress: frame.progress } : { lease: frame.lease }])
      return
    }
    if (frame.type === "advertise") {
      const { type: _type, ...advertisement } = frame
      advertised.set(connection.runtimeId, [...(advertised.get(connection.runtimeId) ?? []), advertisement])
      // An owner that takes notices is here: what was held for its Sessions while it was off goes now.
      connection.takesNotices = takesTreeNotices(advertisement.capabilities)
      if (connection.takesNotices)
        for (const [session, owner] of sessionOwners) if (owner.runtime === connection.runtimeId) deliverNotices(session)
      return
    }
    if (frame.type === "live") {
      sweepStreams()
      const stream = sessionStream(connection.runtimeId, frame.conversation)
      const record = sessionStreams.get(stream)
      if (!record) return
      // Passing state: to the watchers that read it, now, and into no tail, so it takes no number and pushes nothing out.
      if (frame.ephemeral) {
        for (const reader of record.watchers.keys())
          if (ephemeralReaders.has(reader))
            reader.push({ v: PROTOCOL_VERSION, stream, seq: 0, at: now().toISOString(), ...(frame.correlationId && { correlationId: frame.correlationId }), event: frame.event, ephemeral: true })
        return
      }
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
        takesNotices: false,
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
          if (connection.ephemeral) ephemeralReaders.add(reader)
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
          // Each frame crosses the wire's own encoding, as a socket's would: passing state as an `ephemeral` frame.
          const next = async (timeoutMs?: number): Promise<EventFrame> => {
            const frame = await reader.next(timeoutMs)
            if (!frame.ephemeral) return decodeEventFrame(encodeEventFrame(frame))
            const { seq: _seq, ephemeral: _ephemeral, generation: _generation, ...passing } = frame
            const crossed = decodeGatewayClientFrame(encodeGatewayClientFrame({ type: "ephemeral", event: passing }))
            if (crossed.type !== "ephemeral") throw new Error("An ephemeral frame crossed as another")
            return { ...crossed.event, seq: 0, ephemeral: true }
          }
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
    advertisements: (runtimeId) => advertised.get(runtimeId) ?? [],
    beats: (runtimeId) => beaten.get(runtimeId) ?? [],
    lend: (runtimeId, frame) => {
      const runtime = runtimes.get(runtimeId)
      if (!runtime || runtime.closed || (runtime.version ?? 0) < LEND_LINK_VERSION) return false
      runtime.deliver(frame)
      return true
    },
    deferred: (threadId) => thread(threadId).deferred.map((operation) => operation.id),

    finMachine: (fin) => {
      finMachines.set(fin.machine, { ...fin, over: false })
    },
    finMachineOver: (machine) => {
      const fin = finMachines.get(machine)
      if (fin) fin.over = true
    },
    archiveTree: (session) => {
      archivedTrees.add(session)
      const box = mailboxes.get(session)
      if (!box) return
      box.held = []
      box.run += 1
      box.delivering = false
      endTreeEdges()
    },
    treeEdge: (edge) => {
      treeEdges.set(edge.op, { edge: TreeEdgeSchema.parse(edge), ending: false })
    },
    async askTreeEdge(device, body) {
      const answer = (said: TreeEdgeAnswer) => TreeEdgeAnswerSchema.parse(JSON.parse(JSON.stringify(said)))
      const ask = readEdgeAsk(body)
      if (!ask) return answer({ ok: false, reason: "invalid" })
      const op = ask.ask === "keep" ? ask.edge.op : ask.op
      const kept = treeEdges.get(op)
      // Who owns a Session is the runtimes' own reports, and a device's runtime is `d-<device>`: never the ask's word.
      const decided = decideTreeEdge(ask, kept, (session) => sessionOwners.get(session)?.runtime === `d-${device}`)
      if (!decided.ok) return answer(decided)
      if (decided.does === "keep" && ask.ask === "keep") {
        // One that was ending stands again where it stood: a record's place among the others is when it was first kept.
        if (kept) kept.ending = false
        else treeEdges.set(op, { edge: ask.edge, ending: false })
      }
      if (decided.does === "end" && kept) {
        kept.ending = true
        endTreeEdges()
      }
      return answer({ ok: true })
    },
    treeEdges: () => [...treeEdges.values()].map((kept) => ({ ...kept })),
    lapseTreeEdges: (session) => {
      for (const kept of treeEdges.values()) if (kept.edge.apex.session === session) kept.ending = true
      endTreeEdges()
    },
    async postNotice(sender, body) {
      const answer = (said: TreeNoticeAnswer) => TreeNoticeAnswerSchema.parse(JSON.parse(JSON.stringify(said)))
      const refused = (reason: Extract<TreeNoticeAnswer, { admitted: false }>["reason"]) => answer({ admitted: false, reason })
      const fin = sender.kind === "machine" ? finMachines.get(sender.machine) : undefined
      // Who it's from is the credential's word: a device, or the machine as it was made, and nothing the body says.
      const stamp = (op: string | undefined, seq: number, at: number) => TreeNoticeFromSchema.safeParse({
        ...(op !== undefined && { op }),
        place: sender.kind === "device" ? { kind: "device", device: sender.device } : { kind: "cloud", thread: fin?.thread, machine: fin?.machine, generation: fin?.generation },
        seq,
        at,
      }).data
      if (!stamp(fin?.op, 1, 0)) return refused("forbidden")
      // Measured as it came, before it's read.
      if (!treeNoticeFits(body)) return refused("too-large")
      const notice = readNotice(body)
      if (!notice) return refused("invalid")
      // A machine reports to the Apex it was started for, and its start's op names that Apex's Session: where its
      // notices go is never the body's to say. The one child it names is its Fin: its first, where its start named none.
      if (fin && (fin.apex.thread !== notice.parent.thread || fin.apex.session !== notice.parent.session || apexSessionOfStart(fin.op) !== fin.apex.session)) return refused("forbidden")
      if (fin && (fin.child ?? notice.child) !== notice.child) return refused("forbidden")
      // A device's credential names no start, child or Apex: the account knows a Fin on one only by the record its
      // Apex's device keeps. One that names this device, this child and this Apex admits the notice, and no other does.
      const edge = sender.kind === "device" ? treeEdgeOfNotice([...treeEdges.values()].map((kept) => kept.edge), sender.device, notice) : undefined
      // What's kept of a sender is under the start that made its Fin, so one Fin's notice is never another's by its ID
      // alone, and it's held for that start's Apex's Session: a machine's own start, a device's record's.
      const under = fin ? { op: fin.op, session: fin.apex.session } : edge && { op: edge.op, session: edge.apex.session }
      if (!under) return refused("forbidden")
      const session = under.session
      if (fin?.over || archivedTrees.has(session)) return refused("gone")
      if (fin) fin.child = notice.child
      const scope = under.op
      const at = nowMs()
      const posts = (noticePosts.get(scope) ?? []).filter((each) => each > at - 60_000)
      noticePosts.set(scope, [...posts, at])
      if (!treeNoticeRateOpen(posts, at)) return refused("rate")
      const box = mailbox(session)
      const last = lastNotices.get(scope)
      const bytes = treeNoticeBytes(body)
      const own = box.held.filter((each) => each.scope === scope)
      // The rule reads how many other Fins hold notices here, never what they hold (`treeNoticeFinRoom`).
      const others = new Set(box.held.flatMap((each) => (each.scope === scope ? [] : [each.scope]))).size
      const admitted = admitTreeNotice({ own, others, head: box.head, ...(last && { last }) }, notice, bytes)
      if (!admitted.admitted) return answer(admitted)
      const mark = notice.standing && { owner: notice.standing.owner, seq: notice.standing.seq }
      if (admitted.does === "restand") {
        const held = own.find((each) => each.seq === admitted.seq)
        if (held) {
          held.notice = notice
          held.bytes = bytes
        }
        if (last?.id === notice.id && mark) lastNotices.set(scope, { ...last, said: mark })
      }
      // A newer standing on a notice its owner already took: sent on once if the owner is there, and kept nowhere.
      if (admitted.does === "forward") {
        const owner = runtimes.get(sessionOwners.get(session)?.runtime ?? "")
        const from = stamp(scope, admitted.seq, at)
        if (owner?.runtimeId && owner.takesNotices && from && last && mark) {
          lastNotices.set(scope, { ...last, said: mark })
          void route(treeNoticeOperation(TreeNoticeDeliverySchema.parse({ ...notice, from }), { id: crypto.randomUUID(), target: { kind: "runtime", runtimeId: owner.runtimeId }, actor: { kind: "runtime", runtimeId: `gateway:${notice.parent.thread}` }, correlationId: crypto.randomUUID() }))
        }
      }
      if (admitted.does !== "hold") return answer(admitted)
      const from = stamp(scope, admitted.seq, at)
      if (!from) return refused("forbidden")
      lastNotices.set(scope, { id: notice.id, seq: admitted.seq, ...(mark && { said: mark }) })
      box.head = admitted.seq
      box.held.push({ seq: admitted.seq, bytes, notice, from, scope })
      deliverNotices(session)
      return answer(admitted)
    },
    heldNotices: (session) => (mailboxes.get(session)?.held ?? []).map(deliveryOf),
    deadNotices: (session) => [...(mailboxes.get(session)?.dead ?? [])],
  }
}

/** A posted body as the notice it is, or undefined when it isn't JSON or isn't one. */
function readNotice(body: string): TreeNotice | undefined {
  try {
    return TreeNoticeSchema.safeParse(JSON.parse(body)).data
  } catch {
    // Not JSON: no notice.
    return undefined
  }
}

/** A posted body as the ask of the account's records it is, or undefined when it isn't JSON or isn't one. */
function readEdgeAsk(body: string): TreeEdgeAsk | undefined {
  try {
    return TreeEdgeAskSchema.safeParse(JSON.parse(body)).data
  } catch {
    // Not JSON: no ask.
    return undefined
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
