import { createHash, randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, rmSync } from "node:fs"
import { connect, createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import {
  AbsolutePathSchema,
  ActivityMarkSchema,
  MakoWriteSchema,
  ReportedCallSchema,
  SessionRefSchema,
  ThreadIdSchema,
  type ActivityMark,
  type MakoWrite,
  type ReportedCall,
} from "@mako/protocol"
import { acquireHostLock, type HostLock } from "../base/host-lock.js"
import { nodePlatform } from "../base/platform.js"
import type { LostVersion } from "../contracts/thread-changes.js"
import type { BackfillResult } from "./backfill.js"
import { JOURNAL_FORMAT, type FileChoice, type MoveRecord } from "./journal-store.js"

/*
 * One record of changes per device. Every Mako on this device (the installed
 * app, a dev profile) watches the same checkouts, so one of them, the owner,
 * keeps the journal and runs the watching; the others follow. A follower
 * sends the owner what only it knows (its agents' turns and calls, what they
 * reported, Mako's own writes) and reads the journal straight from the file.
 *
 * - Who owns it: whoever holds the kernel's lock in the journal's folder,
 *   which the kernel drops when the owner exits, however it exits.
 * - Nothing is lost when the owner changes: a follower numbers what it sends
 *   and keeps it until the owner says it's applied; it sends again whatever
 *   wasn't, after the turns and calls still open, to whoever owns it next.
 * - Hosts share a journal only when they read and write it alike: the folder
 *   is named for the format, so another build keeps its own and never starts
 *   this one over.
 */

/** Bumped when a message changes. */
const WIRE_VERSION = 1

/** The journal format and the messages, as one name: the shared journal's folder. */
export const SHARED_FORMAT = createHash("sha256").update(`${JOURNAL_FORMAT}\nwire ${WIRE_VERSION}`).digest("hex").slice(0, 16)

/** The device's shared journal folder in a user root (`HostEnvironment.userRoot`). */
export function sharedJournalFolder(userRoot: string): string {
  return join(userRoot, "attribution", SHARED_FORMAT)
}

/** Where the owner listens: a socket beside the lock, or one the kernel names where a path would be too long. */
export function ownerAddress(folder: string, platform: NodeJS.Platform = nodePlatform()): string {
  const id = createHash("sha256").update(resolve(folder)).digest("hex").slice(0, 24)
  if (platform === "win32") return `\\\\.\\pipe\\mako-attribution-${id}`
  if (platform !== "darwin") return `\0mako-attribution-${id}`
  const path = join(folder, "owner.sock")
  // A socket's path is at most 104 bytes on macOS.
  return Buffer.byteLength(path) <= 100 ? path : join(tmpdir(), `mako-attribution-${id}.sock`)
}

/** Where a follower Thread's session runs, so the owner reads it as that Thread's. */
export const PlacedSessionSchema = z.object({ path: AbsolutePathSchema, thread: ThreadIdSchema, session: SessionRefSchema }).strict()
export type PlacedSession = z.infer<typeof PlacedSessionSchema>

export type LostTarget = { thread: string } | { path: string }

/** Every write a host makes into the journal, wherever the journal is. */
export interface JournalWrites {
  activity(mark: ActivityMark): void
  reported(call: ReportedCall): void
  makoStart(id: string, write: MakoWrite, at: number): void
  makoEnd(id: string, at: number): void
  makoWrote(write: MakoWrite, startedAt: number, endedAt: number): void
  moved(move: MoveRecord): void
  /** The person picked a file for a spelling in a Thread's answers. */
  chose(choice: FileChoice): void
  /** A follower's Threads' sessions; the owner's own are in its catalog. */
  sessions(sessions: readonly PlacedSession[]): void
  track(root: string): Promise<void>
  settled(): Promise<void>
  readBack(checkout?: string, budgetMs?: number): Promise<BackfillResult | undefined>
  lost(target: LostTarget): Promise<LostVersion[]>
  restore(root: string, entry: number): Promise<{ path: string }>
}

/** The journal open in this process: its writes, and closing it. */
export interface OwnedJournal {
  writes: JournalWrites
  close(): Promise<void>
}

const MoveRecordSchema = z.object({
  at: z.number().int().nonnegative(),
  thread: ThreadIdSchema,
  kind: z.enum(["move", "put-back", "bring"]),
  files: z.number().int().nonnegative(),
  guessed: z.number().int().nonnegative(),
  offered: z.number().int().nonnegative(),
}).strict()
const Instant = z.number().int().nonnegative()
const FileChoiceSchema = z.object({ thread: ThreadIdSchema, spelling: z.string().min(1).max(4_096), path: AbsolutePathSchema, at: Instant }).strict()
const WriteId = z.string().min(1).max(100)

const OneWaySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("activity"), mark: ActivityMarkSchema }),
  z.object({ kind: z.literal("reported"), call: ReportedCallSchema }),
  z.object({ kind: z.literal("mako-start"), id: WriteId, write: MakoWriteSchema, at: Instant }),
  z.object({ kind: z.literal("mako-end"), id: WriteId, at: Instant }),
  z.object({ kind: z.literal("mako-wrote"), write: MakoWriteSchema, startedAt: Instant, endedAt: Instant }),
  z.object({ kind: z.literal("moved"), move: MoveRecordSchema }),
  z.object({ kind: z.literal("chose"), choice: FileChoiceSchema }),
  z.object({ kind: z.literal("sessions"), sessions: z.array(PlacedSessionSchema).max(50_000) }),
])
type OneWay = z.infer<typeof OneWaySchema>

const LostTargetSchema = z.union([z.object({ thread: ThreadIdSchema }).strict(), z.object({ path: AbsolutePathSchema }).strict()])
const RequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("track"), root: AbsolutePathSchema }),
  z.object({ kind: z.literal("settled") }),
  z.object({ kind: z.literal("read-back"), checkout: AbsolutePathSchema.optional(), budgetMs: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("lost"), target: LostTargetSchema }),
  z.object({ kind: z.literal("restore"), root: z.string().min(1).max(200), entry: z.number().int().positive() }),
])
type Request = z.infer<typeof RequestSchema>

const BackfillResultSchema = z.object({ sessions: z.number(), calls: z.number(), entries: z.number(), lines: z.number(), ms: z.number(), partial: z.boolean() })
const LostVersionSchema = z.object({
  root: z.string(), entry: z.number(), path: z.string(), at: z.number(), size: z.number().optional(), thread: z.string().optional(),
  by: z.enum(["thread", "person", "mako", "unknown"]),
})
/** A request's answer, by the request's kind. */
const ReplySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("track") }),
  z.object({ kind: z.literal("settled") }),
  z.object({ kind: z.literal("read-back"), result: BackfillResultSchema.nullable() }),
  z.object({ kind: z.literal("lost"), versions: z.array(LostVersionSchema) }),
  z.object({ kind: z.literal("restore"), path: z.string() }),
])
type Reply = z.infer<typeof ReplySchema>

function answer<K extends Reply["kind"]>(reply: Reply, kind: K): Extract<Reply, { kind: K }> {
  if (!isReply(reply, kind)) throw new Error(`The record of changes answered ${kind} with ${reply.kind}.`)
  return reply
}
const isReply = <K extends Reply["kind"]>(reply: Reply, kind: K): reply is Extract<Reply, { kind: K }> => reply.kind === kind

const HostSchema = z.object({ pid: z.number().int().positive(), dataRoot: z.string().min(1), label: z.string().min(1).max(200) }).strict()
export type JournalHost = z.infer<typeof HostSchema>

const ToOwnerSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), format: z.string(), host: HostSchema }),
  z.object({ t: z.literal("send"), n: z.number().int().positive(), m: OneWaySchema }),
  z.object({ t: z.literal("call"), id: z.number().int().positive(), m: RequestSchema }),
])
type ToOwner = z.infer<typeof ToOwnerSchema>

const ToFollowerSchema = z.union([
  z.object({ t: z.literal("welcome"), format: z.string(), host: HostSchema }),
  z.object({ t: z.literal("refuse"), format: z.string(), why: z.string() }),
  z.object({ t: z.literal("ack"), n: z.number().int().nonnegative() }),
  z.object({ t: z.literal("reply"), id: z.number().int().positive(), ok: z.literal(true), value: ReplySchema }),
  z.object({ t: z.literal("reply"), id: z.number().int().positive(), ok: z.literal(false), error: z.string() }),
])
type ToFollower = z.infer<typeof ToFollowerSchema>

/** A line longer than this is no message of ours: a reported call's text is capped at 2 MB. */
const MAX_LINE = 16 * 1024 * 1024
/** Turns and calls a host keeps open at most, to send to the next owner. */
const MAX_OPEN = 10_000
/** Messages a follower keeps for the owner at most while none answers; past them the oldest go. */
const MAX_UNSENT = 50_000
/** A follower's session counts as running in that follower this long after its last mark. */
const LIVE_MS = 10 * 60_000

/** How long each request waits for an owner, and what it settles for when none answers. */
const PATIENCE = {
  track: { ms: 60_000, retry: true },
  settled: { ms: 15_000, retry: true },
  "read-back": { ms: 60_000, retry: true },
  lost: { ms: 30_000, retry: true },
  // Writes a file: never sent twice.
  restore: { ms: 30_000, retry: false },
} as const satisfies Record<Request["kind"], { ms: number; retry: boolean }>

export type JournalRole =
  | { kind: "starting" }
  | { kind: "owner" }
  | { kind: "follower"; owner: JournalHost }
  | { kind: "private"; why: string }

/** A host following this one, as the owner knows it. */
export interface Follower {
  host: JournalHost
  /** Its Threads' sessions, by record path. */
  placed: ReadonlyMap<string, { thread: string; session: string }>
  /** Records of sessions it runs, with when it last said so. */
  live: ReadonlyMap<string, number>
}

export interface SharingStatus {
  role: JournalRole["kind"]
  folder: string
  owner?: JournalHost
  followers: JournalHost[]
  /** Messages a follower holds that the owner hasn't applied yet. */
  unsent: number
}

export interface SharedJournalOptions {
  folder: string
  host: JournalHost
  /** Open the shared journal here: this host owns it now. */
  own(): Promise<OwnedJournal>
  /** Another host owns it: read it from the file. Called again after each change of owner. */
  follow(owner: JournalHost): void
  /** Keep a journal of this host's own instead, because sharing can't work (`why`). */
  alone(why: string): Promise<OwnedJournal>
  log(message: string, facts?: Readonly<Record<string, string | number | boolean>>): void
  /** Waits between attempts, and how long a held lock may go unanswered before this host keeps its own. */
  timing?: { retryMs?: number; maxRetryMs?: number; unansweredMs?: number }
  /** For tests: the format this host speaks. */
  format?: string
}

type HeldLock = Extract<HostLock, { kind: "held" }>

interface Call {
  id: number
  request: Request
  resolve(reply: Reply): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  /** The connection it was last sent on. */
  sentOn?: Socket
}

interface Connection {
  socket: Socket
  host?: JournalHost
  welcomed: boolean
  placed: Map<string, { thread: string; session: string }>
  live: Map<string, number>
  /** The last message applied, to acknowledge. */
  applied: number
  ackQueued: boolean
}

/** Newline-separated JSON from a socket, one parsed message per line; a line past `MAX_LINE` ends the connection. */
function readLines(socket: Socket, line: (text: string) => void): void {
  let buffered = ""
  socket.setEncoding("utf8")
  socket.on("data", (chunk: string) => {
    buffered += chunk
    let end = buffered.indexOf("\n")
    while (end >= 0) {
      const text = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      if (text) line(text)
      end = buffered.indexOf("\n")
    }
    if (buffered.length > MAX_LINE) socket.destroy(new Error("a message past the size limit"))
  })
}

const send = (socket: Socket, message: ToOwner | ToFollower) => {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
}

const openKey = (mark: ActivityMark) => `${mark.session}\u0000${mark.kind}\u0000${mark.id}`

function tryConnect(address: string): Promise<Socket | null> {
  return new Promise((settle) => {
    const socket = connect(address)
    const failed = () => {
      socket.destroy()
      settle(null)
    }
    socket.once("error", failed)
    socket.once("connect", () => {
      socket.off("error", failed)
      settle(socket)
    })
  })
}

/**
 * This host's side of the device's one journal: it owns it, follows the
 * owner, or keeps its own; `writes` reaches the journal whichever it is.
 */
export class SharedJournal {
  private readonly options: SharedJournalOptions
  private readonly format: string
  private readonly address: string
  private current: JournalRole = { kind: "starting" }
  private owned?: OwnedJournal
  private lock?: HeldLock
  private server?: Server
  private readonly connections = new Set<Connection>()
  /** The owner, while following. */
  private link?: Socket
  private sent = 0
  /** What the owner hasn't applied yet, oldest first. */
  private unsent: { n: number; m: OneWay }[] = []
  /** Turns, calls and background work started and not ended, to tell the next owner. */
  private readonly open = new Map<string, ActivityMark>()
  /** Writes of Mako's own begun and not ended. */
  private readonly writing = new Map<string, OneWay & { kind: "mako-start" }>()
  private lastSessions?: PlacedSession[]
  private readonly calls = new Map<number, Call>()
  private nextCall = 0
  private electing?: Promise<void>
  private closed = false
  private readonly listeners = new Set<(role: JournalRole) => void>()

  readonly writes: JournalWrites

  private constructor(options: SharedJournalOptions) {
    this.options = options
    this.format = options.format ?? SHARED_FORMAT
    this.address = ownerAddress(options.folder)
    const oneWay = (message: OneWay) => this.oneWay(message)
    this.writes = {
      activity: (mark) => {
        if (mark.edge === "start") {
          this.open.set(openKey(mark), mark)
          if (this.open.size > MAX_OPEN) this.open.delete(this.open.keys().next().value!)
        } else this.open.delete(openKey(mark))
        oneWay({ kind: "activity", mark })
      },
      reported: (call) => oneWay({ kind: "reported", call }),
      makoStart: (id, write, at) => {
        const message = { kind: "mako-start" as const, id, write, at }
        this.writing.set(id, message)
        oneWay(message)
      },
      makoEnd: (id, at) => {
        this.writing.delete(id)
        oneWay({ kind: "mako-end", id, at })
      },
      makoWrote: (write, startedAt, endedAt) => oneWay({ kind: "mako-wrote", write, startedAt, endedAt }),
      moved: (move) => oneWay({ kind: "moved", move }),
      chose: (choice) => oneWay({ kind: "chose", choice }),
      sessions: (sessions) => {
        this.lastSessions = [...sessions]
        oneWay({ kind: "sessions", sessions: [...sessions] })
      },
      track: async (root) => {
        answer(await this.request({ kind: "track", root }), "track")
      },
      settled: async () => {
        answer(await this.request({ kind: "settled" }), "settled")
      },
      readBack: async (checkout, budgetMs) => answer(await this.request({ kind: "read-back", checkout, budgetMs }), "read-back").result ?? undefined,
      lost: async (target) => answer(await this.request({ kind: "lost", target }), "lost").versions,
      restore: async (root, entry) => ({ path: answer(await this.request({ kind: "restore", root, entry }), "restore").path }),
    }
  }

  /** Find the owner or become it; resolves once this host owns, follows or keeps its own journal. */
  static async open(options: SharedJournalOptions): Promise<SharedJournal> {
    mkdirSync(options.folder, { recursive: true, mode: 0o700 })
    const shared = new SharedJournal(options)
    await shared.elect()
    return shared
  }

  role(): JournalRole {
    return this.current
  }

  onRole(listener: (role: JournalRole) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The hosts following this one, while it owns the journal. */
  followers(): Follower[] {
    const now = Date.now()
    return [...this.connections].flatMap((connection) => {
      if (!connection.host || !connection.welcomed) return []
      for (const [record, at] of connection.live) if (now - at > LIVE_MS) connection.live.delete(record)
      return [{ host: connection.host, placed: connection.placed, live: connection.live }]
    })
  }

  status(): SharingStatus {
    const role = this.current
    return {
      role: role.kind,
      folder: this.options.folder,
      ...(role.kind === "follower" && { owner: role.owner }),
      followers: this.followers().map((follower) => follower.host),
      unsent: this.unsent.length,
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const call of this.calls.values()) {
      clearTimeout(call.timer)
      call.reject(new Error("Mako is closing."))
    }
    this.calls.clear()
    this.link?.destroy()
    const server = this.server
    const closing = server && new Promise<void>((done) => server.close(() => done()))
    const owned = this.owned
    this.owned = undefined
    await owned?.close()
    for (const connection of this.connections) connection.socket.destroy()
    await closing
    // The journal is closed before the lock goes, so the next owner never opens it while this one still writes.
    await this.lock?.release()
    if (onFileSystem(this.address)) rmSync(this.address, { force: true })
  }

  private setRole(role: JournalRole): void {
    this.current = role
    for (const listener of this.listeners) listener(role)
  }

  private elect(): Promise<void> {
    this.electing ??= this.electOnce().finally(() => {
      this.electing = undefined
    })
    return this.electing
  }

  private async electOnce(): Promise<void> {
    const retry = this.options.timing?.retryMs ?? 25
    const maxRetry = this.options.timing?.maxRetryMs ?? 1_000
    const unanswered = this.options.timing?.unansweredMs ?? 30_000
    const began = Date.now()
    for (let attempt = 0; !this.closed; attempt++) {
      const socket = await tryConnect(this.address)
      if (socket) {
        const outcome = await this.follow(socket)
        if (outcome === "following" || this.closed) return
        if (outcome !== "lost") return this.keepOwn(outcome.why)
        continue
      }
      const lock = await acquireHostLock(this.options.folder, { purpose: "owner" }).catch((error: Error) => error)
      if (lock instanceof Error) return this.keepOwn(`the lock couldn't be taken: ${lock.message}`)
      if (lock.kind === "held") return this.own(lock)
      if (Date.now() - began > unanswered) return this.keepOwn(`another Mako (pid ${lock.holder ?? "unknown"}) holds it but doesn't answer`)
      await new Promise((done) => setTimeout(done, Math.min(maxRetry, retry * 2 ** Math.min(attempt, 6))))
    }
  }

  // The owner's side.

  private async own(lock: HeldLock): Promise<void> {
    this.lock = lock
    this.link = undefined
    // Listening first: followers wait for the welcome while the journal opens, rather than race for the lock.
    await this.listen().catch((error: Error) => this.options.log("followers can't reach this owner", { error: error.message }))
    const owned = await this.options.own()
    if (this.closed) {
      await owned.close()
      return
    }
    this.owned = owned
    // What this host had sent a previous owner that never applied it, after what's still open.
    this.replay((message) => this.apply(owned.writes, message))
    this.setRole({ kind: "owner" })
    this.options.log("owns the record of changes", { folder: this.options.folder })
    for (const connection of this.connections) if (connection.host && !connection.welcomed) this.welcome(connection)
    for (const call of this.calls.values()) this.run(call)
  }

  private listen(): Promise<void> {
    if (onFileSystem(this.address)) rmSync(this.address, { force: true })
    const server = createServer((socket) => this.accept(socket))
    this.server = server
    return new Promise((done, fail) => {
      server.once("error", fail)
      server.listen(this.address, () => {
        server.off("error", fail)
        server.on("error", (error) => this.options.log("the owner's socket failed", { error: error.message }))
        if (onFileSystem(this.address)) chmodSync(this.address, 0o600)
        done()
      })
    })
  }

  private accept(socket: Socket): void {
    const connection: Connection = { socket, welcomed: false, placed: new Map(), live: new Map(), applied: 0, ackQueued: false }
    this.connections.add(connection)
    socket.on("error", () => undefined)
    socket.on("close", () => {
      this.connections.delete(connection)
      if (connection.host) this.options.log("a follower left", { pid: connection.host.pid, label: connection.host.label })
    })
    readLines(socket, (text) => {
      const parsed = parseLine(ToOwnerSchema, text)
      if (!parsed.success) {
        this.options.log("a follower sent what isn't a message; dropping it", { error: parsed.error.issues[0]?.message ?? "" })
        socket.destroy()
        return
      }
      this.received(connection, parsed.data)
    })
  }

  private received(connection: Connection, message: ToOwner): void {
    if (message.t === "hello") {
      if (message.format !== this.format) {
        send(connection.socket, { t: "refuse", format: this.format, why: `it reads the journal as ${message.format}, this owner as ${this.format}` })
        connection.socket.end()
        return
      }
      connection.host = message.host
      if (this.owned) this.welcome(connection)
      return
    }
    // A follower writes only once welcomed, so its messages reach an open journal.
    const owned = this.owned
    if (!connection.welcomed || !owned) return
    if (message.t === "send") {
      if (message.n <= connection.applied) return
      if (message.m.kind === "activity" && message.m.mark.record) connection.live.set(message.m.mark.record, Date.now())
      if (message.m.kind === "sessions") connection.placed = new Map(message.m.sessions.map((session) => [session.path, { thread: session.thread, session: session.session }]))
      else this.apply(owned.writes, message.m)
      connection.applied = message.n
      if (!connection.ackQueued) {
        connection.ackQueued = true
        setImmediate(() => {
          connection.ackQueued = false
          send(connection.socket, { t: "ack", n: connection.applied })
        })
      }
      return
    }
    const id = message.id
    this.perform(owned.writes, message.m).then(
      (value) => send(connection.socket, { t: "reply", id, ok: true, value }),
      (error: Error) => send(connection.socket, { t: "reply", id, ok: false, error: error.message }),
    )
  }

  private welcome(connection: Connection): void {
    connection.welcomed = true
    send(connection.socket, { t: "welcome", format: this.format, host: this.options.host })
    this.options.log("a follower joined", { pid: connection.host!.pid, label: connection.host!.label })
  }

  /** One message into the journal; one the journal refuses is logged and counted as applied, so it isn't sent again forever. */
  private apply(writes: JournalWrites, message: OneWay): void {
    try {
      this.applyOne(writes, message)
    } catch (error) {
      this.options.log("the record of changes refused a message", { kind: message.kind, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private applyOne(writes: JournalWrites, message: OneWay): void {
    switch (message.kind) {
      case "activity": return writes.activity(message.mark)
      case "reported": return writes.reported(message.call)
      case "mako-start": return writes.makoStart(message.id, message.write, message.at)
      case "mako-end": return writes.makoEnd(message.id, message.at)
      case "mako-wrote": return writes.makoWrote(message.write, message.startedAt, message.endedAt)
      case "moved": return writes.moved(message.move)
      case "chose": return writes.chose(message.choice)
      case "sessions": return writes.sessions(message.sessions)
    }
  }

  private async perform(writes: JournalWrites, request: Request): Promise<Reply> {
    switch (request.kind) {
      case "track":
        await writes.track(request.root)
        return { kind: "track" }
      case "settled":
        await writes.settled()
        return { kind: "settled" }
      case "read-back": return { kind: "read-back", result: (await writes.readBack(request.checkout, request.budgetMs)) ?? null }
      case "lost": return { kind: "lost", versions: await writes.lost(request.target) }
      case "restore": return { kind: "restore", path: (await writes.restore(request.root, request.entry)).path }
    }
  }

  // The follower's side.

  private follow(socket: Socket): Promise<"following" | "lost" | { why: string }> {
    return new Promise((settle) => {
      let welcomed = false
      socket.on("error", () => undefined)
      socket.on("close", () => {
        if (!welcomed) return settle("lost")
        if (this.link !== socket) return
        this.link = undefined
        if (this.closed) return
        this.setRole({ kind: "starting" })
        this.options.log("the owner of the record of changes left; finding the next", { unsent: this.unsent.length })
        void this.elect()
      })
      readLines(socket, (text) => {
        const parsed = parseLine(ToFollowerSchema, text)
        if (!parsed.success) {
          this.options.log("the owner sent what isn't a message; leaving it", { error: parsed.error.issues[0]?.message ?? "" })
          socket.destroy()
          return
        }
        const message = parsed.data
        if (message.t === "refuse") {
          welcomed = true
          socket.destroy()
          settle({ why: `the owner refused this Mako: ${message.why}` })
        } else if (message.t === "welcome") {
          welcomed = true
          try {
            this.options.follow(message.host)
          } catch (error) {
            socket.destroy()
            settle({ why: `the shared journal couldn't be read: ${error instanceof Error ? error.message : String(error)}` })
            return
          }
          this.link = socket
          this.replay((oneWay) => this.transmit(socket, oneWay, false))
          this.setRole({ kind: "follower", owner: message.host })
          this.options.log("follows the owner of the record of changes", { pid: message.host.pid, label: message.host.label })
          for (const call of this.calls.values()) this.run(call)
          settle("following")
        } else if (message.t === "ack") {
          while (this.unsent.length && this.unsent[0]!.n <= message.n) this.unsent.shift()
        } else this.replied(message)
      })
      send(socket, { t: "hello", format: this.format, host: this.options.host })
    })
  }

  /** What a new owner needs to hear first: what's still open, then whatever the last owner didn't apply. */
  private replay(deliver: (message: OneWay) => void): void {
    const backlog = this.unsent
    this.unsent = []
    if (this.lastSessions) deliver({ kind: "sessions", sessions: this.lastSessions })
    for (const mark of this.open.values()) deliver({ kind: "activity", mark })
    for (const write of this.writing.values()) deliver(write)
    for (const { m } of backlog) {
      // Already sent above, as they stand now.
      if (m.kind === "sessions" || (m.kind === "activity" && m.mark.edge === "start" && this.open.has(openKey(m.mark))) || (m.kind === "mako-start" && this.writing.has(m.id))) continue
      deliver(m)
    }
  }

  private transmit(socket: Socket | undefined, message: OneWay, keepOnly: boolean): void {
    // The owner drops a link that sends what isn't a message, and this host would send it again on the next: check it here.
    const checked = OneWaySchema.safeParse(message)
    if (!checked.success) {
      this.options.log("a write isn't one the owner would take; dropping it", { kind: message.kind, error: checked.error.issues[0]?.message ?? "" })
      return
    }
    this.unsent.push({ n: ++this.sent, m: message })
    if (this.unsent.length > MAX_UNSENT) {
      this.unsent.splice(0, this.unsent.length - MAX_UNSENT)
      this.options.log("no owner took the record of changes for a long while; the oldest unsent messages went", { kept: MAX_UNSENT })
    }
    if (socket && !keepOnly) send(socket, { t: "send", n: this.sent, m: message })
  }

  private oneWay(message: OneWay): void {
    if (this.current.kind === "owner" || this.current.kind === "private") {
      if (this.owned) this.apply(this.owned.writes, message)
      return
    }
    this.transmit(this.link, message, !this.link)
  }

  private request(request: Request): Promise<Reply> {
    const patience = PATIENCE[request.kind]
    return new Promise((resolveCall, rejectCall) => {
      const id = ++this.nextCall
      const timer = setTimeout(() => {
        this.calls.delete(id)
        if (request.kind === "settled") {
          this.options.log("the record of changes didn't answer in time; going on with what it holds", { waitedMs: patience.ms })
          resolveCall({ kind: "settled" })
        } else rejectCall(new Error("Mako's record of changes didn't answer in time. Try again in a moment."))
      }, patience.ms)
      timer.unref?.()
      const call: Call = { id, request, timer, resolve: resolveCall, reject: rejectCall }
      this.calls.set(id, call)
      this.run(call)
    })
  }

  /** Send or perform a request as this host's role allows now; one in flight on a link that went is sent again only if that's safe. */
  private run(call: Call): void {
    const done = (outcome: () => void) => {
      if (!this.calls.delete(call.id)) return
      clearTimeout(call.timer)
      outcome()
    }
    if (call.sentOn && call.sentOn === this.link) return
    if (call.sentOn && !PATIENCE[call.request.kind].retry)
      return done(() => call.reject(new Error("Mako's record of changes changed hands while this ran. Check the file, then try again.")))
    if (this.owned && (this.current.kind === "owner" || this.current.kind === "private")) {
      this.perform(this.owned.writes, call.request).then((reply) => done(() => call.resolve(reply)), (error: Error) => done(() => call.reject(error)))
      return
    }
    if (!this.link) return
    const checked = RequestSchema.safeParse(call.request)
    if (!checked.success) return done(() => call.reject(new Error(`Not a request the record of changes takes: ${checked.error.issues[0]?.message ?? ""}`)))
    call.sentOn = this.link
    send(this.link, { t: "call", id: call.id, m: call.request })
  }

  private replied(message: Extract<ToFollower, { t: "reply" }>): void {
    const call = this.calls.get(message.id)
    if (!call) return
    this.calls.delete(message.id)
    clearTimeout(call.timer)
    if (message.ok) call.resolve(message.value)
    else call.reject(new Error(message.error))
  }

  private async keepOwn(why: string): Promise<void> {
    this.link = undefined
    this.options.log("keeps a record of changes of its own", { why })
    const owned = await this.options.alone(why)
    if (this.closed) {
      await owned.close()
      return
    }
    this.owned = owned
    this.replay((message) => this.apply(owned.writes, message))
    this.setRole({ kind: "private", why })
    for (const call of this.calls.values()) this.run(call)
  }
}

const onFileSystem = (address: string) => !address.startsWith("\0") && !address.startsWith("\\\\.\\pipe\\")

/** A line as one of `schema`'s messages; a line that isn't JSON fails like any other. */
function parseLine<T>(schema: z.ZodType<T>, text: string): z.ZodSafeParseResult<T> {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return schema.safeParse(json)
}

/** A write id unique across hosts. */
export const writeId = (): string => randomUUID()
