import { randomUUID } from "node:crypto"
import { closeSync, openSync } from "node:fs"
import { mkdir, open, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ThreadRef } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import { identifyTool } from "@mako/sessions/tool-identity"
import type { HostJobs, JobDemand } from "../base/host-jobs.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { markedProcesses, processesHolding, processFolders } from "../base/marked-processes.js"
import { processIdentityMatches, processStartedAt } from "../base/process-liveness.js"
import { errorMessage } from "../base/error-message.js"
import { backgroundAgentEntry, type BackgroundAgentEnd, type BackgroundAgentReading, type BackgroundAgentRecord } from "../contracts/background-agents.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import type { NativeAgent } from "../contracts/native-agents.js"
import { spawnDetachedProvider } from "../harnesses/index.js"
import type { ThreadCatalog, ThreadStore } from "../threads/index.js"
import type { PreparedNativeCommand } from "./native-runs.js"

/** The environment variable naming the Session whose agent started a process (`applyThreadEnvironment`). */
export const SESSION_VARIABLE = "MAKO_SESSION_ID"
/** The variable naming where a run Mako started writes its exit status. */
const EXIT_VARIABLE = "MAKO_AGENT_EXIT"
/** `sh -c` runs the agent and writes its exit status, so a run that ended while no host watched still says how. */
const EXIT_WRAPPER = `"$@"; status=$?; printf '%s' "$status" > "$${EXIT_VARIABLE}.part" && mv "$${EXIT_VARIABLE}.part" "$${EXIT_VARIABLE}"; exit "$status"`
/** At most one tail read per agent this often: a Session can write many times a second. */
export const READ_EVERY_MS = 500
/** Tail reads a second across every agent this host follows: each is a page the catalog's reader decodes. */
const TAIL_READS_PER_SECOND = 24

/** How often one agent's tail is read while `following` agents run: every half second, slower past the shared budget. */
export function tailReadEvery(following: number): number {
  return Math.max(READ_EVERY_MS, Math.ceil((following / TAIL_READS_PER_SECOND) * 1_000))
}
/** How often the processes of the runs on this device are checked, while there are any. */
const LIVENESS_MS = 2_000
/** Entries a tail read takes: enough to reach the last step past a run of text. */
const TAIL_ENTRIES = 24
/** Entries a page reads when counting a Session's calls from its start. */
const COUNT_PAGE = 500
const STEP_CHARS = 160
const SUMMARY_CHARS = 280
/** A run Mako started without naming its Session is matched to a new Session this long after it started. */
const MATCH_MS = 120_000
/** A Session newer than this, unplaced, is looked for among the processes a conversation started. */
const DISCOVER_MS = 10 * 60_000
/** How far a process's start can be from its Session's, to be the process that wrote it. */
const DISCOVER_START_MS = 60_000
/** A stopped run gets this long before its process group is killed. */
const STOP_GRACE_MS = 5_000
const NONE: readonly NativeAgent[] = []

export interface BackgroundAgentStart {
  harness: string
  prompt: string
  cwd: string
  title?: string
  model?: string
}

export interface BackgroundAgentLink {
  harness: string
  /** Its harness's ID for its Session. */
  session: string
  /** Its process, while it runs; none for one that has ended. */
  pid?: number
  title?: string
}

export interface BackgroundAgentsDeps {
  store(): ThreadStore | undefined
  catalog: Pick<ThreadCatalog, "nativePath" | "ref" | "page" | "activity" | "subscribe" | "announce">
  jobs: HostJobs
  /** Where the runs Mako starts keep their output and exit status. */
  root: string
  /** A headless run's command, built as a native reply's is (`prepareNativeCommand`) with the settings it starts with in `cwd`. */
  prepare(harness: string, prompt: string, cwd: string, model: string | undefined): Promise<PreparedNativeCommand>
  /** Whether `harness` has a CLI a conversation's shell can run, so a Session of it can be one started there. */
  runs(harness: string): boolean
  /** Whether this native session is a conversation's own (one Mako runs, or the Session of one): never a background agent. */
  conversationOwns(ref: Pick<ThreadRef, "harness" | "nativeId" | "sessionId">): boolean
  /** A conversation's background agents changed; `progressOnly` when only a step or a count did. */
  changed(conversation: string, progressOnly: boolean): void
  now?(): number
}

interface Followed {
  record: BackgroundAgentRecord
  reading: BackgroundAgentReading
  entry: NativeAgent
  /** Entries of its Session counted into `reading.toolUses`, from its start. */
  counted: number
  lastRead: number
  timer?: NodeJS.Timeout
  inFlight: boolean
  again: boolean
  /** Its process's identity was checked against its start this host's life: after that, a signal says it runs. */
  checked: boolean
  /** A run Mako started without naming its Session: what matches it to the Session its harness writes. */
  unmatched?: { prompt: string; cwd: string }
}

/**
 * A conversation's background agents (`contracts/background-agents.ts`): a
 * harness's own headless run that works for the conversation past its turn.
 * Mako starts one (`agent_start`), finds one the conversation's shell
 * started by the Session its environment names (`SESSION_VARIABLE`), or
 * takes one the conversation names (`agent_link`). The Thread store keeps
 * each, so every host on the device and every surface shows it under its
 * parent and never as a Thread.
 *
 * Each is followed the same way whatever its harness or how it began:
 * through its own Session as the catalog lists it (the step its tail shows,
 * the calls it made, what its process probe says) and through its process,
 * whose end is written to the store once, with how it went. A run that ended
 * while no host watched says so when the next host reads it: the exit
 * status its wrapper wrote, else what its Session last shows. Nothing reads
 * a run's output as it goes: the catalog already watches every Session.
 */
export class BackgroundAgents {
  private readonly deps: BackgroundAgentsDeps
  private readonly followed = new Map<string, Followed>()
  private readonly byNative = new Map<string, string>()
  private readonly byPath = new Map<string, string>()
  private readonly rosters = new Map<string, readonly NativeAgent[]>()
  private readonly demand: JobDemand
  private readonly abort = new AbortController()
  private readonly cancelJob: () => void
  private readonly unsubscribe: () => void
  private readonly discovering = new Set<string>()
  private discoveries: Promise<void> = Promise.resolve()
  private seen: unknown
  private stopped = false

  constructor(deps: BackgroundAgentsDeps) {
    this.deps = deps
    this.demand = deps.jobs.demand("background agents run on this device")
    this.cancelJob = deps.jobs.every("follow background agents", LIVENESS_MS, () => this.check(), { firstAfterMs: 0, needs: [this.demand] })
    this.unsubscribe = deps.catalog.subscribe((event) => this.catalogEvent(event))
    this.sync()
  }

  /** The conversation's background agents as roster entries, the same array until one of them changes. */
  roster(conversation: string): readonly NativeAgent[] {
    this.sync()
    const session = this.sessionOf(conversation)
    if (!session) return NONE
    const held = this.rosters.get(session)
    if (held) return held
    const agents = this.recordsOf(session).flatMap((record) => this.followed.get(record.id)?.entry ?? [])
    this.rosters.set(session, agents)
    return agents
  }

  /** The conversation's Session, which its background agents are kept under. */
  private sessionOf(conversation: string): string | undefined {
    return this.deps.store()?.journalPlacement(conversation)?.session
  }

  private requireSession(conversation: string): string {
    const session = this.sessionOf(conversation)
    if (!session) throw new Error("This conversation isn't in the Thread store yet.")
    return session
  }

  private recordsOf(session: string): readonly BackgroundAgentRecord[] {
    return this.deps.store()?.backgroundAgents().of(session) ?? []
  }

  /** Starts a headless run of `input.harness` for the conversation, detached from the host. */
  async start(conversation: string, input: BackgroundAgentStart): Promise<BackgroundAgentRecord> {
    const store = this.requireStore()
    const parent = this.requireSession(conversation)
    const id = randomUUID()
    const runDir = join(this.deps.root, id)
    await mkdir(runDir, { recursive: true, mode: 0o700 })
    const command = await this.deps.prepare(input.harness, input.prompt, input.cwd, input.model)
    let pid: number | undefined
    try {
      const output = openSync(join(runDir, "output.log"), "a", 0o600)
      const errors = openSync(join(runDir, "errors.log"), "a", 0o600)
      try {
        const child = spawnDetachedProvider("/bin/sh", ["-c", EXIT_WRAPPER, "mako-agent", command.executable, ...command.args], {
          cwd: input.cwd,
          env: { ...command.env, [EXIT_VARIABLE]: join(runDir, "exit"), [SESSION_VARIABLE]: undefined },
          stdout: output,
          stderr: errors,
        })
        child.once("error", (error) => hostWarn("agents", "a background agent's process failed", { agent: id, error: error.message }))
        pid = child.pid
      } finally {
        closeSync(output)
        closeSync(errors)
      }
    } finally {
      command.hold?.release()
    }
    if (pid === undefined) throw new Error(`${input.harness} did not start`)
    const record = store.keepBackgroundAgent({
      id,
      parent,
      harness: input.harness,
      ...(command.session && { nativeId: command.session }),
      title: agentTitle(input.title, input.prompt),
      detail: input.prompt.slice(0, 8192),
      ...(input.model && { model: input.model }),
      origin: "started",
      device: store.deviceId,
      process: { pid },
      runDir,
      startedAt: this.now(),
    })
    if (record.id !== id) throw new Error("Its harness named a session another background agent already is.")
    hostLog("agents", "background agent started", { agent: id, harness: input.harness, dropped: command.dropped.join(",") || undefined })
    const followed = this.follow(record)
    if (!record.nativeId) followed.unmatched = { prompt: input.prompt, cwd: input.cwd }
    followed.checked = true
    followed.reading = { ...followed.reading, alive: true }
    this.refresh(followed, false)
    void processStartedAt(pid, this.abort.signal).then(
      (startedAt) => this.keep(followed, { ...followed.record, process: { pid, startedAt } }),
      () => undefined
    )
    return record
  }

  /** Takes a run the conversation names as one of its background agents: its Session, and its process while it runs. */
  async link(conversation: string, input: BackgroundAgentLink): Promise<BackgroundAgentRecord> {
    const store = this.requireStore()
    const parent = this.requireSession(conversation)
    const kept = store.backgroundAgents().at(input.harness, input.session)
    if (kept) {
      if (kept.parent !== parent) throw new Error("That session already works for another conversation.")
      return kept
    }
    const path = this.deps.catalog.nativePath({ harness: input.harness, nativeId: input.session })
    const ref = path ? this.deps.catalog.ref(path) : undefined
    if (!path || !ref) throw new Error(`No ${input.harness} session with that ID is on this device.`)
    if (this.deps.conversationOwns(ref)) throw new Error("That session is a conversation of its own.")
    let process: BackgroundAgentRecord["process"]
    if (input.pid !== undefined) {
      const startedAt = await processStartedAt(input.pid, this.abort.signal).catch(() => undefined)
      if (startedAt === undefined) throw new Error(`No process ${input.pid} runs on this device; leave pid out for a run that has ended.`)
      process = { pid: input.pid, startedAt }
    }
    return this.adopt(parent, ref, "linked", process, input.title)
  }

  /** Stops one of the conversation's background agents that runs on this device: its whole process group. */
  async stop(conversation: string, agent: string): Promise<boolean> {
    this.sync()
    const followed = this.followed.get(agent)
    const store = this.deps.store()
    if (!followed || !store || followed.record.ended || !followed.record.process || followed.record.device !== store.deviceId) return false
    const session = this.sessionOf(conversation)
    if (!session || !this.recordsOf(session).some((record) => record.id === agent)) return false
    const { pid } = followed.record.process
    this.end(followed, { at: this.now(), kind: "stopped", ...(followed.reading.toolUses && { toolUses: followed.reading.toolUses }) })
    signalGroup(pid, "SIGTERM")
    setTimeout(() => signalGroup(pid, "SIGKILL"), STOP_GRACE_MS).unref()
    hostLog("agents", "background agent stopped", { agent })
    return true
  }

  /** One line per agent, for the conversation's own agent to read. */
  describe(conversation: string): string {
    const agents = this.roster(conversation)
    if (!agents.length) return "This conversation has no background agents."
    return agents.map((agent) => {
      const detached = agent.detached!
      const parts = [`${detached.id} ${agent.provider} "${agent.title}": ${stateWords(agent)}`]
      if (detached.session) parts.push(`session ${detached.session}`)
      if (agent.usage?.toolUses) parts.push(`${agent.usage.toolUses} tool calls`)
      return parts.join(", ")
    }).join("\n")
  }

  dispose(): void {
    this.stopped = true
    this.abort.abort()
    this.cancelJob()
    this.unsubscribe()
    for (const followed of this.followed.values()) clearTimeout(followed.timer)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private requireStore(): ThreadStore {
    const store = this.deps.store()
    if (!store) throw new Error("Background agents need the Thread store, which didn't open.")
    return store
  }

  /** Follows what the store keeps: a record another host wrote, or changed, is taken in here. */
  private sync(): void {
    const store = this.deps.store()
    if (!store || this.stopped) return
    const agents = store.backgroundAgents()
    if (agents === this.seen) return
    this.seen = agents
    const kept = new Set<string>()
    for (const record of agents.all) {
      kept.add(record.id)
      const followed = this.followed.get(record.id)
      if (!followed) this.follow(record)
      else if (JSON.stringify(followed.record) !== JSON.stringify(record)) {
        followed.record = record
        this.index(followed)
        this.refresh(followed, false)
      }
    }
    for (const [id, followed] of this.followed) if (!kept.has(id)) {
      clearTimeout(followed.timer)
      this.followed.delete(id)
      this.rosters.delete(followed.record.parent)
    }
    this.rosters.clear()
    this.wantChecks()
  }

  private follow(record: BackgroundAgentRecord): Followed {
    const reading: BackgroundAgentReading = {}
    const followed: Followed = { record, reading, entry: backgroundAgentEntry(record, reading, this.now()), counted: 0, lastRead: 0, inFlight: false, again: false, checked: false }
    this.followed.set(record.id, followed)
    this.index(followed)
    this.rosters.delete(record.parent)
    this.wantChecks()
    if (followed.reading.session && !record.ended) void this.read(followed)
    return followed
  }

  private index(followed: Followed): void {
    const { record } = followed
    if (!record.nativeId) return
    this.byNative.set(nativeKey(record.harness, record.nativeId), record.id)
    if (followed.reading.session) return
    const path = this.deps.catalog.nativePath({ harness: record.harness, nativeId: record.nativeId })
    if (!path) return
    const ref = this.deps.catalog.ref(path)
    this.byPath.set(path, record.id)
    followed.reading = { ...followed.reading, session: sessionOf(path, ref), ...activityOf(this.deps.catalog.activity()[path]) }
  }

  private keep(followed: Followed, record: BackgroundAgentRecord): void {
    const store = this.deps.store()
    if (!store || this.stopped) return
    try {
      followed.record = store.keepBackgroundAgent(record)
    } catch (error) {
      hostWarn("agents", "a background agent could not be kept", { agent: record.id, error: errorMessage({ error }) })
      return
    }
    this.index(followed)
    this.refresh(followed, false)
  }

  /** Writes how the run ended, once. */
  private end(followed: Followed, ended: BackgroundAgentEnd): void {
    if (followed.record.ended) return
    this.keep(followed, { ...followed.record, ended })
    this.wantChecks()
  }

  /** Recomputes its entry, and tells its conversation when the entry changed. */
  private refresh(followed: Followed, progressOnly: boolean): void {
    const entry = backgroundAgentEntry(followed.record, followed.reading, this.now())
    if (JSON.stringify(entry) === JSON.stringify(followed.entry)) return
    const kindChanged = entry.state.kind !== followed.entry.state.kind || entry.stoppable !== followed.entry.stoppable
    followed.entry = entry
    this.rosters.delete(followed.record.parent)
    for (const conversation of this.deps.store()?.conversationsOf(followed.record.parent) ?? [])
      this.deps.changed(conversation, progressOnly && !kindChanged)
  }

  /** The agents with no end yet, which share the tail reads. */
  private running(): number {
    let count = 0
    for (const followed of this.followed.values()) if (!followed.record.ended) count += 1
    return count
  }

  /** The process check runs only while a run on this device has no end. */
  private wantChecks(): void {
    const device = this.deps.store()?.deviceId
    let wanted = false
    for (const followed of this.followed.values())
      if (!followed.record.ended && followed.record.process && followed.record.device === device) wanted = true
    this.demand.set(wanted)
  }

  private async check(): Promise<void> {
    this.sync()
    const device = this.deps.store()?.deviceId
    for (const followed of this.followed.values()) {
      const { record } = followed
      if (record.ended || !record.process || record.device !== device) continue
      const alive = await this.alive(followed).catch(() => true)
      if (alive !== followed.reading.alive) {
        followed.reading = { ...followed.reading, alive }
        this.refresh(followed, false)
      }
      if (!alive) await this.settle(followed)
      else if (followed.unmatched && this.now() - record.startedAt > MATCH_MS) followed.unmatched = undefined
    }
  }

  private async alive(followed: Followed): Promise<boolean> {
    const process = followed.record.process!
    if (followed.checked) return signalable(process.pid)
    const alive = await processIdentityMatches({ pid: process.pid, startedAt: process.startedAt, exact: process.startedAt !== undefined, signal: this.abort.signal })
    followed.checked = true
    return alive
  }

  /** Its process has gone: how it went, from the status its wrapper wrote, else from what its Session last shows. */
  private async settle(followed: Followed): Promise<void> {
    const { record } = followed
    const status = record.runDir ? await readFile(join(record.runDir, "exit"), "utf8").then((text) => Number(text.trim()), () => undefined) : undefined
    await this.read(followed)
    const last = await this.lastEntries(followed)
    const summary = finalSummary(last)
    const toolUses = followed.reading.toolUses
    const at = this.now()
    const counted = toolUses ? { toolUses } : {}
    if (status === 0) return this.end(followed, { at, kind: "done", ...(summary && { detail: summary }), ...counted })
    if (status !== undefined && Number.isFinite(status)) {
      const error = record.runDir ? await lastLine(join(record.runDir, "errors.log")) : undefined
      return this.end(followed, { at, kind: "failed", detail: `It exited with code ${status}${error ? `: ${error}` : "."}`, ...counted })
    }
    if (summary && last.at(-1)?.type === "text") return this.end(followed, { at, kind: "done", detail: summary, ...counted })
    this.end(followed, { at, kind: "unknown", detail: "Its process ended without saying how it went.", ...counted })
  }

  private async lastEntries(followed: Followed): Promise<readonly Entry[]> {
    const path = followed.reading.session?.path
    if (!path) return []
    const page = await this.deps.catalog.page(path, undefined, TAIL_ENTRIES).catch(() => null)
    return page?.entries ?? []
  }

  private catalogEvent(event: HostEvent): void {
    if (this.stopped) return
    if (event.type === "thread-activity") {
      const id = this.byPath.get(event.path)
      const followed = id ? this.followed.get(id) : undefined
      if (!followed) return
      const activity = activityOf(event.activity ?? undefined).activity
      if (activity === followed.reading.activity) return
      followed.reading = { ...followed.reading, activity }
      this.refresh(followed, false)
      return
    }
    if (event.type === "thread-ref") return this.refChanged(event.ref)
    if (event.type === "threads") {
      for (const followed of this.followed.values()) if (!followed.reading.session) this.index(followed)
      for (const ref of event.threads) this.refChanged(ref)
    }
  }

  private refChanged(ref: ThreadRef): void {
    const id = this.byNative.get(nativeKey(ref.harness, ref.nativeId)) ?? this.byPath.get(ref.path)
    const followed = id ? this.followed.get(id) : undefined
    if (followed) {
      if (followed.reading.session?.path !== ref.path) {
        this.byPath.set(ref.path, followed.record.id)
        followed.reading = { ...followed.reading, session: sessionOf(ref.path, ref) }
      }
      this.schedule(followed)
      return
    }
    if (ref.agentOf || ref.childOf || !this.deps.runs(ref.harness)) return
    const started = Date.parse(ref.startedAt ?? "")
    if (!Number.isFinite(started) || this.now() - started > DISCOVER_MS) return
    if (this.matchStarted(ref, started)) return
    this.discover(ref, started)
  }

  /** A run Mako started without naming its Session is the new Session of its harness, folder, time and prompt. */
  private matchStarted(ref: ThreadRef, started: number): boolean {
    for (const followed of this.followed.values()) {
      const { unmatched, record } = followed
      if (!unmatched || record.harness !== ref.harness || ref.cwd !== unmatched.cwd || started < record.startedAt - 5_000) continue
      const title = (ref.title ?? "").trim().slice(0, 40)
      if (title && !unmatched.prompt.trim().startsWith(title)) continue
      followed.unmatched = undefined
      this.byPath.set(ref.path, record.id)
      followed.reading = { ...followed.reading, session: sessionOf(ref.path, ref) }
      this.keep(followed, { ...record, nativeId: ref.nativeId })
      this.deps.catalog.announce(ref.path)
      this.schedule(followed)
      return true
    }
    return false
  }

  /** A new Session a conversation's shell started: the marked process that holds it, or that started with it in its folder. */
  private discover(ref: ThreadRef, started: number): void {
    const key = nativeKey(ref.harness, ref.nativeId)
    if (this.discovering.has(key)) return
    this.discovering.add(key)
    this.discoveries = this.discoveries.then(async () => {
      if (this.stopped || this.deps.conversationOwns(ref)) return
      const marked = await markedProcesses(SESSION_VARIABLE, this.abort.signal)
      if (!marked.length) return
      const pids = marked.map((process) => process.pid)
      const holding = await processesHolding(ref.path, pids, this.abort.signal)
      let found = marked.find((process) => holding.has(process.pid))
      let startedAt: number | undefined
      if (!found) {
        const folders = await processFolders(pids, this.abort.signal)
        let best: number | undefined
        for (const process of marked) {
          if (folders.get(process.pid) !== ref.cwd) continue
          const at = await processStartedAt(process.pid, this.abort.signal).catch(() => undefined)
          if (at === undefined || Math.abs(at - started) > DISCOVER_START_MS || (best !== undefined && at < best)) continue
          best = at
          found = process
        }
        startedAt = best
      }
      if (!found) return
      startedAt ??= await processStartedAt(found.pid, this.abort.signal).catch(() => undefined)
      if (!this.deps.store()?.conversationsOf(found.value).length) return
      await this.adopt(found.value, ref, "discovered", { pid: found.pid, ...(startedAt !== undefined && { startedAt }) })
    }).catch((error) => {
      if (!this.stopped) hostWarn("agents", "a new session's process could not be read", { harness: ref.harness, error: errorMessage({ error }) })
    }).finally(() => this.discovering.delete(key))
  }

  /** Keeps a Session as one of `parent`'s background agents, and drops it from every list of Threads. */
  private async adopt(parent: string, ref: ThreadRef, origin: "linked" | "discovered", process: BackgroundAgentRecord["process"], title?: string): Promise<BackgroundAgentRecord> {
    const store = this.requireStore()
    const started = Date.parse(ref.startedAt ?? "")
    const record = store.keepBackgroundAgent({
      id: randomUUID(),
      parent,
      harness: ref.harness,
      nativeId: ref.nativeId,
      title: agentTitle(title ?? ref.title, ref.title ?? ref.harness),
      origin,
      device: store.deviceId,
      ...(process && { process }),
      startedAt: Number.isFinite(started) ? started : this.now(),
    })
    hostLog("agents", "background agent taken in", { agent: record.id, harness: ref.harness, origin })
    this.sync()
    const followed = this.followed.get(record.id) ?? this.follow(record)
    this.byPath.set(ref.path, record.id)
    followed.reading = { ...followed.reading, session: sessionOf(ref.path, ref), ...activityOf(this.deps.catalog.activity()[ref.path]) }
    this.deps.catalog.announce(ref.path)
    if (process) {
      followed.checked = true
      followed.reading = { ...followed.reading, alive: true }
      this.read(followed)
    } else await this.settle(followed)
    this.refresh(followed, false)
    return followed.record
  }

  /** A tail read soon, at most one a second for each agent. */
  private schedule(followed: Followed): void {
    if (followed.inFlight) {
      followed.again = true
      return
    }
    if (followed.timer) return
    const wait = followed.lastRead + tailReadEvery(this.running()) - this.now()
    if (wait <= 0) {
      void this.read(followed)
      return
    }
    followed.timer = setTimeout(() => {
      followed.timer = undefined
      void this.read(followed)
    }, wait)
    followed.timer.unref()
  }

  /** Reads its Session's tail: the step it shows and the calls made since the last read. */
  private async read(followed: Followed): Promise<void> {
    const path = followed.reading.session?.path
    if (!path || this.stopped) return
    followed.inFlight = true
    followed.lastRead = this.now()
    try {
      const page = await this.deps.catalog.page(path, undefined, TAIL_ENTRIES)
      if (!page) return
      let toolUses = followed.reading.toolUses ?? 0
      if (page.start > followed.counted) toolUses += await this.countBefore(path, followed.counted, page.start)
      const from = Math.max(followed.counted, page.start)
      for (const entry of page.entries.slice(from - page.start)) if (entry.type === "tool") toolUses += 1
      followed.counted = Math.max(followed.counted, page.start + page.entries.length)
      const step = lastStep(page.entries, followed.record.harness)
      const updatedAt = Date.parse(page.ref.updatedAt ?? "")
      followed.reading = {
        ...followed.reading,
        session: { path, ...(Number.isFinite(updatedAt) && { updatedAt }), ...(page.ref.title && { title: page.ref.title }) },
        ...(step && { step }),
        ...(toolUses && { toolUses }),
      }
      this.refresh(followed, true)
    } catch (error) {
      if (!this.stopped) hostWarn("agents", "a background agent's session could not be read", { agent: followed.record.id, error: errorMessage({ error }) })
    } finally {
      followed.inFlight = false
      if (followed.again) {
        followed.again = false
        this.schedule(followed)
      }
    }
  }

  /** Calls among entries `[from, to)`, read a page at a time: once for each agent, when the host first reads it. */
  private async countBefore(path: string, from: number, to: number): Promise<number> {
    let count = 0
    let before = to
    while (before > from && !this.stopped) {
      const page = await this.deps.catalog.page(path, before, Math.min(COUNT_PAGE, before - from))
      if (!page || !page.entries.length) break
      for (const [index, entry] of page.entries.entries()) if (page.start + index >= from && entry.type === "tool") count += 1
      before = page.start
    }
    return count
  }
}

function nativeKey(harness: string, nativeId: string): string {
  return `${harness}\n${nativeId}`
}

function sessionOf(path: string, ref: ThreadRef | undefined): NonNullable<BackgroundAgentReading["session"]> {
  const updatedAt = Date.parse(ref?.updatedAt ?? "")
  return { path, ...(Number.isFinite(updatedAt) && { updatedAt }), ...(ref?.title && { title: ref.title }) }
}

function activityOf(activity: { status: "active" | "needs-input" | "open" } | undefined): Pick<BackgroundAgentReading, "activity"> {
  return { activity: activity?.status }
}

function agentTitle(title: string | undefined, fallback: string): string {
  const line = (title?.trim() || fallback).split("\n").find((part) => part.trim())?.trim() ?? "Background agent"
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

function clip(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

/** What its Session last shows it doing, worded as the transcript's tool rows are (`identifyTool`). */
export function lastStep(entries: readonly Entry[], harness: string): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.type === "tool") {
      const identity = identifyTool({ harness, name: entry.name, input: entry.input, acpKind: entry.toolKind, title: entry.title })
      return clip(identity.target ? `${identity.label} ${identity.target}` : identity.label, STEP_CHARS)
    }
    if (entry.type === "thinking") return "Thinking"
    if (entry.type === "text" && entry.text.trim()) return clip(entry.text.replace(/^[#>*\-\s]+/, ""), STEP_CHARS)
    if (entry.type === "user") return undefined
  }
  return undefined
}

/** The start of its last reply, which a finished run shows as how it went. */
function finalSummary(entries: readonly Entry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.type === "text" && entry.text.trim()) return clip(entry.text.replace(/^[#>*\-\s]+/, ""), SUMMARY_CHARS)
    if (entry.type === "user") return undefined
  }
  return undefined
}

async function lastLine(file: string): Promise<string | undefined> {
  const handle = await open(file, "r").catch(() => undefined)
  if (!handle) return undefined
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, 4_096)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const line = buffer.toString("utf8").split("\n").map((part) => part.trim()).filter(Boolean).at(-1)
    return line ? clip(line, 400) : undefined
  } finally {
    await handle.close()
  }
}

function signalable(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

/** Its process group when it leads one (a run Mako started), else the process alone. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
    return
  } catch {
    // Not a group leader: a run its own shell started.
  }
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone.
  }
}

function stateWords(agent: NativeAgent): string {
  const { state } = agent
  if (state.kind === "working") return state.activity ? `working (${state.activity})` : "working"
  if (state.kind === "waiting") return `waiting: ${state.reason}`
  if (state.kind === "completed") return state.summary ? `done: ${state.summary}` : "done"
  if (state.kind === "failed") return `failed: ${state.error}`
  if (state.kind === "canceled") return "stopped"
  return `unknown: ${state.reason}`
}
