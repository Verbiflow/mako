import { existsSync, readFileSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { Socket } from "node:net"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import {
  MAX_EVENT_BYTES,
  Payload,
  RuntimeRefusedError,
  RuntimeThreads,
  problemType,
  runtimeLinkOverSocket,
  type GatewayFrame,
  type LocalSeqStore,
  type Problem,
  type ServedRuntime,
} from "@mako/protocol"
import { z } from "zod"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { CloudSignIn, CloudSignInInstall } from "../contracts/cloud-sign-ins.js"
import { AgentMessageSchema, MACHINE_AGENT_PROTOCOL, type AgentMessage, type HostMessage, type MachineRuntimeState } from "../contracts/machine-agent.js"
import { encodeRuntimeEvent, runtimeEventLine, type RuntimeEvent, type RuntimeEventChannel } from "../contracts/runtime-value.js"
import { runtimeEventRouting } from "../contracts/runtime.js"
import { type HostInvoke, serveHostThroughGateway } from "../transport/index.js"
import { CloudLink, type CloudLinkEnding, type CloudLinkState } from "./cloud-link.js"

type Link = Extract<AgentMessage, { type: "link" }>
type SignIns = Extract<AgentMessage, { type: "sign-ins" }>

export type MachineRuntimeOptions = {
  /** The agent's end: a socket carrying a JSON message per line each way. */
  agent: NodeJS.ReadWriteStream
  invoke: HostInvoke
  version: string
  build: string
  /** Where the numbers reserved for each Thread's events are kept, so a restarted host never reuses one. */
  dataRoot: string
  /** Writes the sign-ins the agent gave where each harness reads them, secret files kept in `secrets`. */
  installSignIns(signIns: readonly CloudSignIn[], secrets: string): Promise<CloudSignInInstall[]>
  now?: () => number
}

/** A clock that moved this much more than the timer that read it was asleep: the machine was paused, or copied. */
const RESUMED_GAP_MS = 3_000
const TICK_MS = 1_000
const REPORT_MS = 200
const LiveBatchIdentity = z.object({ batch: z.object({ id: z.string(), revision: z.number(), epoch: z.string().optional() }) })

/**
 * The host on a cloud machine, served to its Thread's object as the machine's runtime (`m-<16 hex>.g<generation>`).
 * The agent says which runtime to be and with which credential; the host connects, answers the Thread's operations
 * through the same dispatcher as its socket, and sends every event its clients would see as the Thread's events,
 * numbered and kept until the Thread has them on disk. A new link from the agent replaces the old; an unlink silences
 * it until the next.
 *
 * Waking is fast on purpose: a connection from before a pause is dead, so a clock that jumped, or the agent saying
 * so, reconnects at once rather than at the next missed ping.
 */
export class MachineRuntime {
  readonly #options: MachineRuntimeOptions
  readonly #now: () => number
  readonly #numbers: FileNumbers
  #link: Link | undefined
  #threads: RuntimeThreads | undefined
  #cloud: CloudLink | undefined
  #served: ServedRuntime | undefined
  #state: MachineRuntimeState
  #report: NodeJS.Timeout | undefined
  #tick: NodeJS.Timeout | undefined
  #lastTick: number
  #stopped = false
  /** One install at a time; sign-ins that arrive during one are installed after it, the newest only. */
  #installing: Promise<void> | undefined
  #nextSignIns: SignIns | undefined

  constructor(options: MachineRuntimeOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#numbers = new FileNumbers(join(options.dataRoot, "cloud", "machine-numbers.json"))
    this.#state = { link: "none", since: this.#iso(), enrolls: 0, threads: [], events: { emitted: 0, invalidated: 0, dropped: 0 }, resumes: 0, signIns: [] }
    this.#lastTick = this.#now()
  }

  start(): void {
    const lines = createInterface({ input: this.#options.agent, crlfDelay: Infinity })
    lines.on("line", (line) => this.#fromAgent(line))
    lines.on("close", () => {
      // The agent went: it starts the host again with a fresh channel, so this one has nothing left to do.
      if (!this.#stopped) hostWarn("machine", "the agent's channel closed")
    })
    this.#options.agent.on("error", (error: Error) => hostWarn("machine", "the agent's channel failed", { error: error.message }))
    this.#send({ type: "hello", protocol: MACHINE_AGENT_PROTOCOL, pid: process.pid, version: this.#options.version, build: this.#options.build })
    this.#tick = setInterval(() => this.#watchClock(), TICK_MS)
    this.#tick.unref()
  }

  stop(): void {
    this.#stopped = true
    clearInterval(this.#tick)
    clearTimeout(this.#report)
    this.#cloud?.stop()
    this.#cloud = undefined
  }

  /**
   * One of the host's events, as every client of its socket gets it, for the Threads this runtime runs. A live
   * batch too large to send becomes the notice that its history changed, which readers answer by reading it.
   */
  event(channel: RuntimeEventChannel, event: RuntimeEvent): void {
    const threads = this.#threads
    if (!threads) return
    const claims = threads.claims()
    if (!claims.length) return
    let text = runtimeEventLine(channel, event).slice(0, -1)
    if (text.length * 3 > MAX_EVENT_BYTES && Buffer.byteLength(text) > MAX_EVENT_BYTES) {
      const notice = invalidated(event)
      if (!notice) {
        this.#state.events.dropped += 1
        hostWarn("machine", "an event too large for the Thread wasn't sent", { type: runtimeEventRouting(event).type, bytes: Buffer.byteLength(text) })
        return this.#changed()
      }
      this.#state.events.invalidated += 1
      text = runtimeEventLine(channel, notice).slice(0, -1)
    }
    const payload = Payload.encoded(text)
    for (const { threadId } of claims) threads.emit(threadId, payload)
    this.#state.events.emitted += 1
    this.#changed()
  }

  #fromAgent(line: string): void {
    if (!line.trim()) return
    let message: AgentMessage
    try {
      message = AgentMessageSchema.parse(JSON.parse(line))
    } catch (error) {
      hostWarn("machine", "the agent sent something that isn't a message", { error: error instanceof Error ? error.message : String(error) })
      return
    }
    switch (message.type) {
      case "link":
        return this.#linkTo(message)
      case "unlink":
        return this.#unlink(message.reason)
      case "wake":
        hostLog("machine", "the agent says the machine woke; connecting again now")
        return this.#cloud?.reconnect()
      case "inspect":
        return this.#publish()
      case "sign-ins":
        return this.#install(message)
    }
  }

  #install(message: SignIns): void {
    this.#nextSignIns = message
    if (this.#installing) return
    const next = async () => {
      while (this.#nextSignIns) {
        const { signIns, secrets } = this.#nextSignIns
        this.#nextSignIns = undefined
        const installed = await this.#options.installSignIns(signIns, secrets).catch((error: Error): CloudSignInInstall[] =>
          signIns.map((signIn) => ({ harness: signIn.harness, status: "failed", at: this.#iso(), reason: error.message })),
        )
        this.#state.signIns = installed
        const failed = installed.filter((install) => install.status === "failed")
        hostLog("machine", "sign-ins installed", { installed: installed.length - failed.length, failed: failed.map((install) => install.harness).join(",") || "none" })
        this.#publish()
      }
    }
    this.#installing = next().finally(() => (this.#installing = undefined))
  }

  #linkTo(link: Link): void {
    const current = this.#link
    if (current && current.runtimeId === link.runtimeId && current.credential === link.credential && current.gatewayUrl === link.gatewayUrl && this.#cloud) return this.#cloud.wake()
    this.#cloud?.stop()
    // Another runtime's events are another generation's: nothing the old one owed would be recorded.
    if (current?.runtimeId !== link.runtimeId) {
      this.#threads = new RuntimeThreads({
        numbers: this.#numbers,
        log: (message, fields) => hostLog("machine", message, fields),
        onLost: (threadId, count) => hostWarn("machine", "a Thread's events waited too long and were given up", { threadId, count }),
      })
      this.#state.enrolls = 0
      delete this.#state.lastEnrolledAt
      delete this.#state.lastEnding
    }
    this.#link = link
    delete this.#state.unlinked
    this.#state.runtimeId = link.runtimeId
    this.#state.machine = link.machine
    this.#state.generation = link.generation
    hostLog("machine", "linking", { runtimeId: link.runtimeId, gateway: new URL(link.gatewayUrl).host })
    const url = new URL(`/v1/runtimes/${encodeURIComponent(link.runtimeId)}/connect`, link.gatewayUrl)
    const threads = this.#threads!
    const cloud = new CloudLink({
      name: "machine runtime",
      url,
      token: async () => {
        if (this.#link !== link) throw new Error("This credential was replaced")
        return link.credential
      },
      refused: () => {},
      attach: (socket, end) => this.#attach(link, threads, socket, end),
      removed: () => this.#unlink("the gateway refused this runtime"),
      onState: (state) => this.#setLink(state),
      signedIn: () => this.#link === link,
      log: (message, fields) => hostLog("machine", message, fields),
    })
    this.#cloud = cloud
    this.#setLink("connecting")
    cloud.start()
  }

  #attach(link: Link, threads: RuntimeThreads, socket: WebSocket, end: (ending: CloudLinkEnding) => void) {
    const runtimeLink = runtimeLinkOverSocket(socket)
    let closed = false
    const onFrame = (frame: GatewayFrame) => {
      if (frame.type === "assign" || frame.type === "fence") {
        hostLog("machine", frame.type === "assign" ? "runs a Thread" : "fenced from a Thread", { threadId: frame.threadId, generation: frame.generation })
        // After the outbox has taken it, so the state says what it now runs.
        queueMicrotask(() => this.#publish())
      } else if (frame.type !== "operation") this.#changed()
    }
    serveHostThroughGateway(runtimeLink, { runtimeId: link.runtimeId, build: this.#options.build, threads, invoke: this.#options.invoke, onFrame }).then(
      (served) => {
        if (closed) return served.close()
        this.#served = served
        this.#state.enrolls += 1
        this.#state.lastEnrolledAt = this.#iso()
        hostLog("machine", "enrolled", { runtimeId: link.runtimeId, claims: threads.claims().length, enrolls: this.#state.enrolls })
        this.#changed()
        void served.ended.then((problem) => {
          if (this.#served === served) this.#served = undefined
          this.#state.lastEnding = problem ? describe(problem) : "the connection closed"
          this.#changed()
          end(endingOf(problem))
        })
      },
      (error: Error) => {
        this.#state.lastEnding = error instanceof RuntimeRefusedError ? describe(error.problem) : error.message
        hostWarn("machine", "enrolment failed", { runtimeId: link.runtimeId, ending: this.#state.lastEnding })
        this.#changed()
        end(error instanceof RuntimeRefusedError ? endingOf(error.problem) : "lost")
      }
    )
    return {
      close: () => {
        closed = true
        runtimeLink.close()
      },
    }
  }

  #unlink(reason: string): void {
    hostWarn("machine", "silenced", { reason, runtimeId: this.#link?.runtimeId })
    this.#cloud?.stop()
    this.#cloud = undefined
    this.#served = undefined
    this.#link = undefined
    this.#threads = undefined
    this.#state.unlinked = reason
    this.#setLink("silent")
  }

  #watchClock(): void {
    const now = this.#now()
    const gapMs = now - this.#lastTick - TICK_MS
    this.#lastTick = now
    if (gapMs < RESUMED_GAP_MS) return
    this.#state.resumes += 1
    this.#state.lastResume = { at: this.#iso(), gapMs }
    hostLog("machine", "the clock jumped; the machine was paused or copied", { gapMs })
    // The agent checks which: a copy is silenced, a machine that woke is told to connect.
    this.#send({ type: "resumed", gapMs })
    this.#changed()
  }

  #setLink(link: CloudLinkState | "none" | "silent"): void {
    if (this.#state.link === link) return
    this.#state.link = link
    this.#state.since = this.#iso()
    this.#publish()
  }

  #changed(): void {
    if (this.#report) return
    this.#report = setTimeout(() => this.#publish(), REPORT_MS)
    this.#report.unref()
  }

  #publish(): void {
    clearTimeout(this.#report)
    this.#report = undefined
    this.#state.threads = this.#threads?.stats() ?? []
    this.#send({ type: "state", state: this.#state })
  }

  #send(message: HostMessage): void {
    if (this.#stopped && message.type !== "state") return
    this.#options.agent.write(`${JSON.stringify(message)}\n`)
  }

  #iso(): string {
    return new Date(this.#now()).toISOString()
  }
}

/** The agent's channel, if this host was started by a machine's agent. */
export function machineAgentChannel(fd: number): Socket {
  return new Socket({ fd, readable: true, writable: true })
}

/** How a refusal ends the link: a credential the gateway no longer takes is fetched again, anything else reconnects. */
function endingOf(problem: Problem | undefined): CloudLinkEnding {
  return problem && problemType(problem) === "unauthorized" ? "expired" : "lost"
}

function describe(reason: Problem): string {
  return reason.detail ? `${problemType(reason)}: ${reason.detail}` : `${problemType(reason)}: ${reason.title}`
}

function invalidated(event: RuntimeEvent): RuntimeEvent | null {
  if (runtimeEventRouting(event).type !== "live-batch") return null
  const live = LiveBatchIdentity.safeParse(JSON.parse(event.payload))
  if (!live.success) return null
  return encodeRuntimeEvent({ type: "live-batch", batch: { ...live.data.batch, updates: [], historyChanged: true } })
}

/** The numbers reserved for each Thread's events, in one small file written as each block is reserved. */
class FileNumbers implements LocalSeqStore {
  readonly #path: string
  readonly #reserved = new Map<string, number>()
  /** Where a Thread never reserved for starts: 0, or the clock when the file couldn't be read. */
  readonly #floor: number
  #writing: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.#path = path
    let floor = 0
    if (existsSync(path)) {
      try {
        const stored = z.record(z.string(), z.number().int().nonnegative()).parse(JSON.parse(readFileSync(path, "utf8")))
        for (const [key, value] of Object.entries(stored)) this.#reserved.set(key, value)
      } catch (error) {
        // Numbering from 1 again could reuse a number already sent, which the Thread would take for a repeat.
        floor = Math.floor(Date.now() / 1_000) * 1_000
        hostWarn("machine", "the reserved numbers couldn't be read; numbering from the clock", { error: String(error), floor })
      }
    }
    this.#floor = floor
  }

  reserved(threadId: string, generation: number): number {
    return this.#reserved.get(`${threadId}:${generation}`) ?? this.#floor
  }

  reserve(threadId: string, generation: number, upTo: number): Promise<void> {
    this.#reserved.set(`${threadId}:${generation}`, upTo)
    // Only the newest few: a machine runs one Thread, under a generation or two in its life.
    while (this.#reserved.size > 32) this.#reserved.delete(this.#reserved.keys().next().value!)
    const text = JSON.stringify(Object.fromEntries(this.#reserved))
    const write = this.#writing.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
      await writeFile(`${this.#path}.tmp`, text, { mode: 0o600 })
      await rename(`${this.#path}.tmp`, this.#path)
    })
    this.#writing = write.catch(() => {})
    return write
  }
}
