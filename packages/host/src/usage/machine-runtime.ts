import { randomUUID } from "node:crypto"
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
  problem,
  problemType,
  runtimeLinkOverSocket,
  type GatewayFrame,
  type LocalSeqStore,
  type MediaHandler,
  type Problem,
  type ServedRuntime,
} from "@mako/protocol"
import { z } from "zod"
import { followHostLog, hostLog, hostWarn, type HostLogLine } from "../base/host-log.js"
import { cpuBetween, describeCpu, describeThreads, sampleCpu, type CpuSample } from "./process-cpu.js"
import { HostProfiler } from "./host-profile.js"
import type { CloudSignIn, CloudSignInInstall } from "../contracts/cloud-sign-ins.js"
import { AgentMessageSchema, MACHINE_AGENT_PROTOCOL, type AgentMessage, type HostMessage, type MachineRuntimeState } from "../contracts/machine-agent.js"
import { encodeRuntimeEvent, runtimeEventLine, type RuntimeEvent, type RuntimeEventChannel } from "../contracts/runtime-value.js"
import { runtimeEventRouting } from "../contracts/runtime.js"
import { type HostInvoke, serveHostThroughGateway } from "../transport/index.js"
import { CloudLink, type CloudLinkEnding, type CloudLinkState } from "./cloud-link.js"
import { ACTIVITY_HEARTBEAT_MS } from "@mako/protocol"
import type { LifecycleWork } from "../contracts/app-lifecycle.js"
/** The gateway a machine works through: where, as which machine, with which credential. */
export type MachineGatewayLink = { gatewayUrl: string; machine: string; credential: string }

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
  /** Makes the folder the agent prepared the one every caller's tabs open in. */
  openWorkspace(path: string): Promise<void>
  /** What a start does first in a folder, done ahead: a project base's, before its snapshot. */
  prepareFolder(path: string): Promise<void>
  /** What `harness`'s start runs first, run ahead as the machine boots; undefined for a harness without it. */
  prefetchStart(harness: string): Promise<{ answered: boolean; stopped: boolean; ms: number; readMiB: number; readMs: number } | undefined>
  /** What `harness`'s start asks its service first, asked once its sign-in is installed; undefined for a harness without it. */
  prefetchSignedIn(harness: string): Promise<{ ms: number } | undefined>
  /** What the host is working on, as its lifecycle lists it: what the machine reports, so its Thread keeps it running. */
  work(): LifecycleWork[]
  /** The live streams its Threads' clients watch, such as a preview's video, once the host's core has loaded. */
  media(): MediaHandler | undefined
  /** The gateway the machine works through, as its agent linked it: what keeps its records and recipes in step. Null once silenced. */
  linked?(link: MachineGatewayLink | null): Promise<void>
  /** Every process's CPU time so far (`/proc`); undefined off Linux. Tests give their own. */
  sampleCpu?: () => Promise<CpuSample | undefined>
  /** Whether to profile the host's own JavaScript while a launch runs (`MAKO_LAUNCH_PROFILE=1`); off unless asked. */
  profileHost?: boolean
  now?: () => number
}

/** A stream's frames come as often as its acks; they change nothing the agent hears about. */
const MEDIA_FRAMES: ReadonlySet<GatewayFrame["type"]> = new Set(["media-watch", "media-ack", "media-unwatch"])

/**
 * Host-wide readings about this machine's own harnesses and accounts. No client of a cloud Thread reads them (the
 * desktop follows its conversations' batches), and they come every few minutes whether or not anything works, so
 * they don't go into the Thread's stream.
 */
const MACHINE_ONLY_EVENTS: ReadonlySet<string> = new Set(["account-usage", "harness-profile", "runtime-updates"])

/** A clock that moved this much more than the timer that read it was asleep: the machine was paused, or copied. */
const RESUMED_GAP_MS = 3_000
const TICK_MS = 1_000
const REPORT_MS = 200
/** The longest a link waits on the workspace opening: past it, the machine answers from its home instead of not at all. */
const LINK_WAIT_MS = 30_000
/** Scopes a start's timeline shows every line of; of any other scope, only warnings and errors. */
const TIMELINE_SCOPES = new Set(["machine", "packages", "loop"])
/** A field longer than this is cut on its way to the agent, whose log keeps a few hundred lines. */
const TIMELINE_FIELD_CHARS = 300

/** Whether a line belongs on a start's timeline (`npm run timeline`): each launch phase as it ends, never as it starts. */
function onTimeline(line: HostLogLine): boolean {
  if (line.level !== "info") return true
  if (line.scope === "provider-startup") return line.fields?.state !== "started"
  return TIMELINE_SCOPES.has(line.scope)
}

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
  #unfollow: (() => void) | undefined
  /** One install at a time; sign-ins that arrive during one are installed after it, the newest only. */
  #installing: Promise<void> | undefined
  /** The harness the machine was asked to run a start ahead for, and the installs its signed-in stage last ran after. */
  #ahead: string | undefined
  /** Each harness launch running, by its CPU sample at its start and whether it profiles the host. */
  readonly #launches = new Map<string, { cpu: Promise<CpuSample | undefined>; profiling: Promise<boolean> }>()
  readonly #profiler = new HostProfiler()
  #warmedAfter: readonly CloudSignInInstall[] | undefined
  #nextSignIns: SignIns | undefined
  /** The workspace opened or opening, so the agent saying it again doesn't open it again. */
  #workspace: string | undefined
  /** While it opens, a link waits, so the Thread's first call runs in the workspace rather than the home folder. */
  #opening: Promise<void> | undefined
  #heldLink: Link | undefined
  /** What this machine last told its Thread of its work, on which link and for which Threads, and when. */
  #activity: { served: ServedRuntime; claims: string; busy: boolean; at: number } | undefined
  /** A watch that comes before the core has loaded ends; its viewer asks again when the agent next acts. */
  readonly #media: MediaHandler = {
    watch: (stream, threadId, request, sender) => {
      const media = this.#options.media()
      if (media) return media.watch(stream, threadId, request, sender)
      sender.end(problem("unavailable", "The machine's host is still starting", randomUUID(), "not-applied", { status: 503 }))
    },
    acked: (stream, received) => this.#options.media()?.acked(stream, received),
    unwatched: (stream) => this.#options.media()?.unwatched(stream),
  }

  constructor(options: MachineRuntimeOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#numbers = new FileNumbers(join(options.dataRoot, "cloud", "machine-numbers.json"))
    this.#state = { link: "none", since: this.#iso(), enrolls: 0, threads: [], events: { emitted: 0, invalidated: 0, dropped: 0 }, resumes: 0, signIns: [] }
    this.#lastTick = this.#now()
  }

  start(): void {
    this.#unfollow = followHostLog((line) => {
      this.#launchCpu(line)
      this.#toTimeline(line)
    })
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
    this.#unfollow?.()
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
    // Named on the event as the host emits it, so a stream's batches are never parsed to find out.
    if (event.type !== undefined && MACHINE_ONLY_EVENTS.has(event.type)) return
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
        if (this.#opening) {
          this.#heldLink = message
          return
        }
        return this.#linkTo(message)
      case "unlink":
        this.#heldLink = undefined
        return this.#unlink(message.reason)
      case "wake":
        hostLog("machine", "the agent says the machine woke; connecting again now")
        return this.#cloud?.reconnect()
      case "inspect":
        return this.#publish()
      case "sign-ins":
        return this.#install(message)
      case "workspace":
        return this.#openWorkspace(message.path)
      case "prepare":
        return void this.#prepare(message.path)
      case "prefetch":
        return void this.#prefetch(message.harness)
    }
  }

  async #prefetch(harness: string): Promise<void> {
    this.#ahead = harness
    this.#warmSignedIn()
    const outcome = await this.#options.prefetchStart(harness).catch((error: Error) => {
      hostWarn("machine", "a start wasn't run ahead", { harness, error: error.message })
      return undefined
    })
    if (outcome) hostLog("machine", "a start was run ahead", { harness, ms: outcome.ms, answered: outcome.answered, stopped: outcome.stopped, readMiB: outcome.readMiB, readMs: outcome.readMs })
  }

  /**
   * The signed-in stage of the start run ahead, once both are known: the harness it was asked for and its sign-in
   * installed, whichever comes first. Again after a later install, which may be another account.
   */
  #warmSignedIn(): void {
    const harness = this.#ahead
    const installs = this.#state.signIns
    if (!harness || installs === this.#warmedAfter || !installs.some((install) => install.harness === harness && install.status === "installed")) return
    this.#warmedAfter = installs
    void this.#options.prefetchSignedIn(harness).then((outcome) => {
      if (outcome) hostLog("machine", "a start's sign-in stage was run ahead", { harness, ms: outcome.ms })
    }, (error: Error) => hostWarn("machine", "a start's sign-in stage wasn't run ahead", { harness, error: error.message }))
  }

  /**
   * What used the machine's CPU while each harness launch ran, said once it ends: a start that's slow on a copy and
   * quick on an idle one is slow for what ran beside it, which no phase of its own names.
   */
  #launchCpu(line: HostLogLine): void {
    const fields = line.fields
    if (line.scope !== "provider-startup" || fields?.phase !== "launch") return
    const key = `${String(fields.provider)}:${String(fields.attempt)}`
    const sample = this.#options.sampleCpu ?? sampleCpu
    if (fields.state === "started") {
      // The host's own share taken apart by file, for one launch at a time.
      const profiling = this.#options.profileHost ? this.#profiler.start().catch(() => false) : Promise.resolve(false)
      this.#launches.set(key, { cpu: sample().catch(() => undefined), profiling })
      return
    }
    const launch = this.#launches.get(key)
    this.#launches.delete(key)
    if (!launch) return
    void Promise.all([launch.cpu, sample().catch(() => undefined), launch.profiling.then((on) => (on ? this.#profiler.stop() : undefined))]).then(([start, end, host]) => {
      if (!start || !end) return
      hostLog("machine", "cpu while a harness started", {
        harness: String(fields.provider),
        conversation: String(fields.conversation).slice(0, 8),
        cpu: describeCpu(cpuBetween(start, end)),
        threads: describeThreads(cpuBetween(start, end)) || undefined,
        host: host?.length ? host.map((entry) => `${entry.file} ${entry.seconds.toFixed(2)} s`).join(", ") : undefined,
      })
    })
  }

  /** A line of the host's for the agent's log, when it's one a start's timeline shows and the channel can take it. */
  #toTimeline(line: HostLogLine): void {
    // A broken channel's own warning would come back here.
    if (this.#stopped || !this.#options.agent.writable || !onTimeline(line)) return
    const fields: Record<string, string | number | boolean | null> = {}
    for (const [key, value] of Object.entries(line.fields ?? {})) {
      if (value === undefined) continue
      const text = String(value)
      fields[key] = text.length > TIMELINE_FIELD_CHARS ? `${text.slice(0, TIMELINE_FIELD_CHARS)}…` : value
    }
    this.#send({ type: "log", at: new Date(this.#now()).toISOString(), level: line.level, scope: line.scope, message: line.message, fields })
  }

  async #prepare(path: string): Promise<void> {
    const began = performance.now()
    const ok = await this.#options.prepareFolder(path).then(() => true, (error: Error) => {
      hostWarn("machine", "the folder wasn't prepared; its start does it", { path, error: error.message })
      return false
    })
    const ms = Math.round(performance.now() - began)
    if (ok) hostLog("machine", "folder prepared", { path, ms })
    this.#send({ type: "prepared", path, ms, ok })
  }

  #openWorkspace(path: string): void {
    if (this.#workspace === path) return
    this.#workspace = path
    const settled = (status: "opened" | "failed", reason?: string) => {
      if (this.#workspace !== path) return
      if (status === "failed") this.#workspace = undefined
      const workspace: NonNullable<MachineRuntimeState["workspace"]> = { path, status, at: this.#iso() }
      if (reason) workspace.reason = reason
      this.#state.workspace = workspace
      if (status === "opened") hostLog("machine", "workspace opened", { path })
      else hostWarn("machine", "the workspace didn't open", { path, reason })
      this.#publish()
    }
    const opened = this.#options.openWorkspace(path).then(() => settled("opened"), (error: Error) => settled("failed", error.message))
    let timer: NodeJS.Timeout | undefined
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        hostWarn("machine", "the workspace is still opening; linking without waiting", { path, waitedMs: LINK_WAIT_MS })
        resolve()
      }, LINK_WAIT_MS)
      timer.unref()
    })
    const opening = Promise.race([opened, waited]).finally(() => {
      clearTimeout(timer)
      if (this.#opening !== opening) return
      this.#opening = undefined
      const held = this.#heldLink
      this.#heldLink = undefined
      if (held) this.#linkTo(held)
    })
    this.#opening = opening
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
        this.#warmSignedIn()
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
    // Its records and its project's recipe are kept where its Thread's are, under the same credential.
    void this.#options.linked?.({ gatewayUrl: link.gatewayUrl, machine: link.machine, credential: link.credential }).catch((error: Error) => hostWarn("machine", "the gateway's link wasn't taken", { error: error.message }))
  }

  #attach(link: Link, threads: RuntimeThreads, socket: WebSocket, end: (ending: CloudLinkEnding) => void) {
    const runtimeLink = runtimeLinkOverSocket(socket)
    let closed = false
    const onFrame = (frame: GatewayFrame) => {
      if (frame.type === "assign" || frame.type === "fence") {
        hostLog("machine", frame.type === "assign" ? "runs a Thread" : "fenced from a Thread", { threadId: frame.threadId, generation: frame.generation })
        // After the outbox has taken it, so the state says what it now runs.
        queueMicrotask(() => this.#publish())
      } else if (frame.type !== "operation" && !MEDIA_FRAMES.has(frame.type)) this.#changed()
    }
    serveHostThroughGateway(runtimeLink, { runtimeId: link.runtimeId, build: this.#options.build, threads, invoke: this.#options.invoke, media: this.#media, onFrame }).then(
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
    void this.#options.linked?.(null).catch(() => undefined)
  }

  /**
   * Tells the Thread whether this machine is working: what keeps it running. Busy is anything the lifecycle lists
   * that isn't only waiting on a person (a question or an approval survives a pause). Said when it changes, when the
   * link or the Threads it runs change, and while busy every `ACTIVITY_HEARTBEAT_MS`, so a turn that streams nothing
   * still keeps its machine. A gateway that hears no heartbeat takes the machine as idle.
   */
  #reportActivity(now: number): void {
    const served = this.#served
    if (!served) return
    const claims = served.claims().map((claim) => `${claim.threadId}:${claim.generation}`).join(",")
    if (!claims) return
    const working = this.#options.work().filter((item) => item.status !== "waiting")
    const busy = working.length > 0
    const last = this.#activity
    const due = !last || last.served !== served || last.claims !== claims || last.busy !== busy || (busy && now - last.at >= ACTIVITY_HEARTBEAT_MS)
    if (!due) return
    const work = working.map((item) => `${item.provider || "Mako"} ${item.status}: ${item.title}`)
    if (!served.activity(busy, work)) return
    if (last?.busy !== busy) hostLog("machine", busy ? "working" : "idle", { work: work.join("; ") || "none" })
    this.#activity = { served, claims, busy, at: now }
  }

  #watchClock(): void {
    const now = this.#now()
    this.#reportActivity(now)
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

  /** The host loaded what every start loads (`warm` in the agent's protocol), in `ms`. */
  warmed(ms: number, loaded: string[]): void {
    hostLog("machine", "warm: what every start loads is loaded", { ms, loaded: loaded.join(",") })
    this.#send({ type: "warm", ms, loaded })
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
