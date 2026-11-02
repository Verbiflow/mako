import { open, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ThreadRef } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import { identifyTool } from "@mako/sessions/tool-identity"
import type { HostJobs, JobDemand } from "../base/host-jobs.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { markedProcesses, processesHolding, processFolders, type MarkedProcess } from "../base/marked-processes.js"
import { processIdentityMatches, processStartedAt } from "../base/process-liveness.js"
import { errorMessage } from "../base/error-message.js"
import type { AgentRefused, ChildOrigin, ChildRole, ChildThread, FollowedRun, ThreadParent } from "../contracts/agents.js"
import { SESSION_VARIABLE } from "../contracts/agent-tools.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import { SessionIdSchema, type Actor } from "../contracts/thread-identity.js"
import { uniqueName, type ThreadCatalog, type ThreadStore } from "../threads/index.js"

/** At most one tail read per run this often: a Session can write many times a second. */
export const READ_EVERY_MS = 500
/** Tail reads a second across every run this host follows: each is a page the catalog's reader decodes. */
export const TAIL_READS_PER_SECOND = 24

/** How often one run's tail is read while `following` runs go: every half second, slower past the shared budget. */
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
/** A Session newer than this, unplaced, is looked for among the processes a conversation started. */
const DISCOVER_MS = 10 * 60_000
/** How far a process's start can be from its Session's, to be the process that wrote it. */
const DISCOVER_START_MS = 60_000
/** A stopped run gets this long before its process group is killed. */
export const STOP_GRACE_MS = 5_000

export type RunEnd = NonNullable<FollowedRun["ended"]>

/** What the follower read of a run: its Session as the catalog lists it, and its process. */
interface RunReading {
  session?: { path: string; updatedAt?: number; title?: string }
  activity?: "active" | "needs-input" | "open"
  alive?: boolean
  step?: string
  toolUses?: number
}

/** What a new Session's process is found by: the marked processes, the files and folders they hold, their starts. */
export interface ProcessReads {
  marked(variable: string, signal: AbortSignal): Promise<MarkedProcess[]>
  holding(file: string, pids: readonly number[], signal: AbortSignal): Promise<Set<number>>
  folders(pids: readonly number[], signal: AbortSignal): Promise<Map<number, string>>
  startedAt(pid: number, signal: AbortSignal): Promise<number>
}

const PROCESS_READS: ProcessReads = { marked: markedProcesses, holding: processesHolding, folders: processFolders, startedAt: processStartedAt }

export interface AgentRunsDeps {
  store(): ThreadStore | undefined
  catalog: Pick<ThreadCatalog, "nativePath" | "ref" | "page" | "activity" | "subscribe" | "announce">
  jobs: HostJobs
  /** Whether `harness` has a CLI a conversation's shell can run, so a Session of it can be one started there. */
  runs(harness: string): boolean
  /**
   * Whether this native session is a conversation's own (one Mako runs, or the Session of one): never a followed
   * run. `marker` is the Session a process that holds it names, whose own harness may not have named it yet.
   */
  conversationOwns(ref: Pick<ThreadRef, "harness" | "nativeId" | "sessionId">, marker?: string): boolean
  /** A followed child's reading changed; `progressOnly` when only a step or a count did. */
  changed(edge: ThreadParent, progressOnly: boolean): void
  /** A followed run ended, once: written to its edge before this is called. */
  ended(edge: ThreadParent, ended: RunEnd): void
  processes?: ProcessReads
  now?(): number
}

interface Followed {
  edge: ThreadParent
  reading: RunReading
  /** Entries of its Session counted into `reading.toolUses`, from its start. */
  counted: number
  lastRead: number
  timer?: NodeJS.Timeout
  inFlight: boolean
  again: boolean
  /** Its process's identity was checked against its start this host's life: after that, a signal says it runs. */
  checked: boolean
}

/** What a link or a discovery takes in. */
export interface RunAdoption {
  parentSession: string
  ref: ThreadRef
  origin: Extract<ChildOrigin, "linked" | "discovered">
  process?: FollowedRun["process"]
  name?: string
  role?: ChildRole
  startedBy: Actor
}

/**
 * The children whose turns a process Mako didn't start runs (`discovered`,
 * `linked`, and #286's migrated runs): a harness CLI a Thread's shell ran,
 * found by the Session its environment names (`SESSION_VARIABLE`), or one the
 * Thread names. Each is followed the same way whatever its harness: through
 * its own Session as the catalog lists it (the step its tail shows, the
 * calls it made) and through its process, whose end is written to its edge
 * once, with how it went. A run that ended while no host watched says so
 * when the next host reads it: the exit status #286's wrapper wrote, else
 * what its Session last shows. Nothing reads a run's output as it goes: the
 * catalog already watches every Session.
 */
export class AgentRuns {
  private readonly deps: AgentRunsDeps
  private readonly followed = new Map<string, Followed>()
  private readonly byNative = new Map<string, string>()
  private readonly byPath = new Map<string, string>()
  private readonly demand: JobDemand
  private readonly abort = new AbortController()
  private readonly cancelJob: () => void
  private readonly unsubscribe: () => void
  private readonly discovering = new Set<string>()
  private discoveries: Promise<void> = Promise.resolve()
  private seen: unknown
  private stopped = false

  constructor(deps: AgentRunsDeps) {
    this.deps = deps
    this.demand = deps.jobs.demand("followed agent runs on this device")
    this.cancelJob = deps.jobs.every("follow agent runs", LIVENESS_MS, () => this.check(), { firstAfterMs: 0, needs: [this.demand] })
    this.unsubscribe = deps.catalog.subscribe((event) => this.catalogEvent(event))
    this.sync()
  }

  /** Settles once every new Session's search for the process that started it, begun so far, has ended. */
  discovered(): Promise<void> {
    return this.discoveries
  }

  /** What a followed child's Thread shows now; undefined for a child no process of its own runs. */
  reading(child: string): ChildThread | undefined {
    const followed = this.followed.get(child)
    if (!followed) return undefined
    const { edge, reading } = followed
    const run = edge.run!
    const ended = run.ended
    return {
      source: "followed",
      ...(run.nativeId && { nativeId: run.nativeId }),
      ...(reading.session && { path: reading.session.path }),
      ...(reading.session?.title && { title: reading.session.title }),
      harness: run.harness,
      ...(!ended && { working: reading.alive !== false || reading.activity === "active" }),
      ...(!ended && reading.step && { step: reading.step }),
      ...(!ended && reading.activity === "needs-input" && { waiting: { question: "It waits for an answer in its own terminal.", on: "person" as const } }),
      ...(ended && { ended: { outcome: ended.kind === "unknown" ? "unknown" : ended.kind, ...(ended.detail && { reason: ended.detail }), at: ended.at } }),
      ...((ended?.toolUses ?? reading.toolUses) && { toolUses: ended?.toolUses ?? reading.toolUses }),
      startedAt: run.startedAt,
      ...(reading.session?.updatedAt && { updatedAt: reading.session.updatedAt }),
    }
  }

  /** Whether a followed run still runs: a message to it waits for its process to end (`held`). */
  running(child: string): boolean {
    const followed = this.followed.get(child)
    return Boolean(followed && !followed.edge.run?.ended)
  }

  /** How many followed runs share the tail reads. */
  following(): number {
    let count = 0
    for (const followed of this.followed.values()) if (!followed.edge.run?.ended) count += 1
    return count
  }

  /** Takes in a run as a child: its Session's Thread gets an edge under the parent Session's Thread. */
  async adopt(input: RunAdoption): Promise<ThreadParent | AgentRefused> {
    const store = this.requireStore()
    const { ref } = input
    const kept = store.edges().byRun(ref.harness, ref.nativeId)
    const parent = store.sessionPlacement(SessionIdSchema.parse(input.parentSession))
    if (!parent) return { refused: "no-parent", why: "This Thread isn't in the Thread store yet." }
    if (kept) return kept.parent === parent.thread ? kept : { refused: "conflict", why: "That session already works for another Thread." }
    const child = store.place(ref, input.startedBy).thread
    if (child === parent.thread || store.ancestors(parent.thread).includes(child))
      return { refused: "cycle", why: "That session is this Thread or one that leads it." }
    if (store.edges().of(child)) return { refused: "conflict", why: "That session's Thread already has a lead." }
    const started = Date.parse(ref.startedAt ?? "")
    const startedAt = Number.isFinite(started) ? started : this.now()
    const name = uniqueName(input.name ?? ref.title ?? ref.harness, new Set(store.edges().children(parent.thread).map((edge) => edge.name)))
    const edge = store.keepEdge({
      child,
      parent: parent.thread,
      parentSession: SessionIdSchema.parse(input.parentSession),
      name,
      role: input.role ?? "worker",
      origin: input.origin,
      asked: { brief: { objective: (ref.title ?? ref.harness).slice(0, 2_000) }, harness: ref.harness },
      op: `${input.origin}:${ref.harness}:${ref.nativeId}`,
      startedBy: input.startedBy,
      createdAt: startedAt,
      run: {
        harness: ref.harness,
        nativeId: ref.nativeId,
        device: store.deviceId,
        ...(input.process && { process: input.process }),
        startedAt,
      },
    })
    hostLog("agents", "edge written", { op: edge.op, child: edge.child, parent: edge.parent, origin: input.origin, harness: ref.harness })
    this.sync()
    const followed = this.followed.get(edge.child) ?? this.follow(edge)
    this.byPath.set(ref.path, edge.child)
    followed.reading = { ...followed.reading, session: sessionOf(ref.path, ref), ...activityOf(this.deps.catalog.activity()[ref.path]) }
    this.deps.catalog.announce(ref.path)
    if (input.process) {
      followed.checked = true
      followed.reading = { ...followed.reading, alive: true }
      void this.read(followed)
    } else await this.settle(followed)
    this.deps.changed(followed.edge, false)
    return followed.edge
  }

  /** The pid a link names, checked to run on this device now. */
  async processOf(pid: number): Promise<FollowedRun["process"] | undefined> {
    const startedAt = await processStartedAt(pid, this.abort.signal).catch(() => undefined)
    return startedAt === undefined ? undefined : { pid, startedAt }
  }

  /** Stops a followed run on this device: its whole process group, killed after `STOP_GRACE_MS`. */
  stop(child: string): boolean {
    this.sync()
    const followed = this.followed.get(child)
    const run = followed?.edge.run
    const store = this.deps.store()
    if (!followed || !run || !store || run.ended || !run.process || run.device !== store.deviceId) return false
    const { pid } = run.process
    this.end(followed, { at: this.now(), kind: "stopped", ...(followed.reading.toolUses && { toolUses: followed.reading.toolUses }) })
    signalGroup(pid, "SIGTERM")
    setTimeout(() => signalGroup(pid, "SIGKILL"), STOP_GRACE_MS).unref()
    return true
  }

  /** The last entries of a followed child's Session, for `agents_read`. */
  async tail(child: string, entries: number): Promise<readonly Entry[]> {
    const path = this.followed.get(child)?.reading.session?.path
    if (!path) return []
    const page = await this.deps.catalog.page(path, undefined, entries).catch(() => null)
    return page?.entries ?? []
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
    if (!store) throw new Error("Children need the Thread store, which didn't open.")
    return store
  }

  /** Follows what the store keeps: an edge another host wrote, or changed, is taken in here. */
  private sync(): void {
    const store = this.deps.store()
    if (!store || this.stopped) return
    const edges = store.edges()
    if (edges === this.seen) return
    this.seen = edges
    const kept = new Set<string>()
    for (const edge of edges.all) {
      if (!edge.run) continue
      kept.add(edge.child)
      const followed = this.followed.get(edge.child)
      if (!followed) this.follow(edge)
      else if (JSON.stringify(followed.edge) !== JSON.stringify(edge)) {
        followed.edge = edge
        this.index(followed)
        this.deps.changed(edge, false)
      }
    }
    for (const [child, followed] of this.followed) if (!kept.has(child)) {
      clearTimeout(followed.timer)
      this.followed.delete(child)
    }
    this.wantChecks()
  }

  private follow(edge: ThreadParent): Followed {
    const followed: Followed = { edge, reading: {}, counted: 0, lastRead: 0, inFlight: false, again: false, checked: false }
    this.followed.set(edge.child, followed)
    this.index(followed)
    this.wantChecks()
    if (followed.reading.session && !edge.run?.ended) void this.read(followed)
    return followed
  }

  private index(followed: Followed): void {
    const run = followed.edge.run
    if (!run?.nativeId) return
    this.byNative.set(nativeKey(run.harness, run.nativeId), followed.edge.child)
    if (followed.reading.session) return
    const path = this.deps.catalog.nativePath({ harness: run.harness, nativeId: run.nativeId })
    if (!path) return
    const ref = this.deps.catalog.ref(path)
    this.byPath.set(path, followed.edge.child)
    followed.reading = { ...followed.reading, session: sessionOf(path, ref), ...activityOf(this.deps.catalog.activity()[path]) }
  }

  /** Writes how the run ended, once: an end already kept stands. */
  private end(followed: Followed, ended: RunEnd): void {
    const store = this.deps.store()
    const run = followed.edge.run
    if (!store || this.stopped || !run || run.ended) return
    try {
      followed.edge = store.keepEdge({ ...followed.edge, run: { ...run, ended } })
    } catch (error) {
      hostWarn("agents", "a followed run's end could not be kept", { child: followed.edge.child, error: errorMessage({ error }) })
      return
    }
    this.wantChecks()
    this.deps.changed(followed.edge, false)
    if (followed.edge.run?.ended) this.deps.ended(followed.edge, followed.edge.run.ended)
  }

  /** The process check runs only while a run on this device has no end. */
  private wantChecks(): void {
    const device = this.deps.store()?.deviceId
    let wanted = false
    for (const followed of this.followed.values()) {
      const run = followed.edge.run
      if (run && !run.ended && run.process && run.device === device) wanted = true
    }
    this.demand.set(wanted)
  }

  private async check(): Promise<void> {
    this.sync()
    const device = this.deps.store()?.deviceId
    for (const followed of this.followed.values()) {
      const run = followed.edge.run
      if (!run || run.ended || !run.process || run.device !== device) continue
      const alive = await this.alive(followed, run.process).catch(() => true)
      if (alive !== followed.reading.alive) {
        followed.reading = { ...followed.reading, alive }
        this.deps.changed(followed.edge, false)
      }
      if (!alive) await this.settle(followed)
    }
  }

  private async alive(followed: Followed, process: NonNullable<FollowedRun["process"]>): Promise<boolean> {
    if (followed.checked) return signalable(process.pid)
    const alive = await processIdentityMatches({ pid: process.pid, startedAt: process.startedAt, exact: process.startedAt !== undefined, signal: this.abort.signal })
    followed.checked = true
    return alive
  }

  /** Its process has gone: how it went, from the status #286's wrapper wrote, else from what its Session last shows. */
  private async settle(followed: Followed): Promise<void> {
    const run = followed.edge.run
    if (!run) return
    const status = run.runDir ? await readFile(join(run.runDir, "exit"), "utf8").then((text) => Number(text.trim()), () => undefined) : undefined
    await this.read(followed)
    const last = await this.lastEntries(followed)
    const summary = finalSummary(last)
    const toolUses = followed.reading.toolUses
    const at = this.now()
    const counted = toolUses ? { toolUses } : {}
    if (status === 0) return this.end(followed, { at, kind: "done", ...(summary && { detail: summary }), ...counted })
    if (status !== undefined && Number.isFinite(status)) {
      const error = run.runDir ? await lastLine(join(run.runDir, "errors.log")) : undefined
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
      const child = this.byPath.get(event.path)
      const followed = child ? this.followed.get(child) : undefined
      if (!followed) return
      const activity = activityOf(event.activity ?? undefined).activity
      if (activity === followed.reading.activity) return
      followed.reading = { ...followed.reading, activity }
      this.deps.changed(followed.edge, false)
      return
    }
    if (event.type === "thread-ref") return this.refChanged(event.ref)
    if (event.type === "threads") {
      for (const followed of this.followed.values()) if (!followed.reading.session) this.index(followed)
      for (const ref of event.threads) this.refChanged(ref)
    }
  }

  private refChanged(ref: ThreadRef): void {
    const child = this.byNative.get(nativeKey(ref.harness, ref.nativeId)) ?? this.byPath.get(ref.path)
    const followed = child ? this.followed.get(child) : undefined
    if (followed) {
      if (followed.reading.session?.path !== ref.path) {
        this.byPath.set(ref.path, followed.edge.child)
        followed.reading = { ...followed.reading, session: sessionOf(ref.path, ref) }
      }
      this.schedule(followed)
      return
    }
    if (ref.parent || ref.childOf || !this.deps.runs(ref.harness)) return
    const started = Date.parse(ref.startedAt ?? "")
    if (!Number.isFinite(started) || this.now() - started > DISCOVER_MS) return
    this.discover(ref, started)
  }

  /** A new Session a conversation's shell started: the marked process that holds it, or that started with it in its folder. */
  private discover(ref: ThreadRef, started: number): void {
    const key = nativeKey(ref.harness, ref.nativeId)
    if (this.discovering.has(key)) return
    this.discovering.add(key)
    this.discoveries = this.discoveries.then(async () => {
      if (this.stopped || this.deps.conversationOwns(ref)) return
      const reads = this.deps.processes ?? PROCESS_READS
      const marked = await reads.marked(SESSION_VARIABLE, this.abort.signal)
      if (!marked.length) return
      const pids = marked.map((process) => process.pid)
      const holding = await reads.holding(ref.path, pids, this.abort.signal)
      let found = marked.find((process) => holding.has(process.pid))
      let startedAt: number | undefined
      if (!found) {
        const folders = await reads.folders(pids, this.abort.signal)
        let best: number | undefined
        for (const process of marked) {
          if (folders.get(process.pid) !== ref.cwd) continue
          const at = await reads.startedAt(process.pid, this.abort.signal).catch(() => undefined)
          if (at === undefined || Math.abs(at - started) > DISCOVER_START_MS || (best !== undefined && at < best)) continue
          best = at
          found = process
        }
        startedAt = best
      }
      if (!found) return
      startedAt ??= await reads.startedAt(found.pid, this.abort.signal).catch(() => undefined)
      // A conversation's own harness carries the marker too, and writes its new Session before its driver names it.
      if (this.stopped || this.deps.conversationOwns(ref, found.value) || !this.deps.store()?.conversationsOf(found.value).length) return
      const adopted = await this.adopt({
        parentSession: found.value,
        ref,
        origin: "discovered",
        process: { pid: found.pid, ...(startedAt !== undefined && { startedAt }) },
        startedBy: { kind: "agent", session: SessionIdSchema.parse(found.value) },
      })
      if ("refused" in adopted) hostLog("agents", "a run its shell started was not taken in", { harness: ref.harness, refused: adopted.refused })
    }).catch((error) => {
      if (!this.stopped) hostWarn("agents", "a new session's process could not be read", { harness: ref.harness, error: errorMessage({ error }) })
    }).finally(() => this.discovering.delete(key))
  }

  /** A tail read soon, at most `tailReadEvery` apart for each run. */
  private schedule(followed: Followed): void {
    if (followed.inFlight) {
      followed.again = true
      return
    }
    if (followed.timer) return
    const wait = followed.lastRead + tailReadEvery(this.following()) - this.now()
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
      const step = lastStep(page.entries, followed.edge.run?.harness ?? page.ref.harness)
      const updatedAt = Date.parse(page.ref.updatedAt ?? "")
      followed.reading = {
        ...followed.reading,
        session: { path, ...(Number.isFinite(updatedAt) && { updatedAt }), ...(page.ref.title && { title: page.ref.title }) },
        ...(step && { step }),
        ...(toolUses && { toolUses }),
      }
      this.deps.changed(followed.edge, true)
    } catch (error) {
      if (!this.stopped) hostWarn("agents", "a followed run's session could not be read", { child: followed.edge.child, error: errorMessage({ error }) })
    } finally {
      followed.inFlight = false
      if (followed.again) {
        followed.again = false
        this.schedule(followed)
      }
    }
  }

  /** Calls among entries `[from, to)`, read a page at a time: once for each run, when the host first reads it. */
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

function sessionOf(path: string, ref: ThreadRef | undefined): NonNullable<RunReading["session"]> {
  const updatedAt = Date.parse(ref?.updatedAt ?? "")
  return { path, ...(Number.isFinite(updatedAt) && { updatedAt }), ...(ref?.title && { title: ref.title }) }
}

function activityOf(activity: { status: "active" | "needs-input" | "open" } | undefined): Pick<RunReading, "activity"> {
  return { activity: activity?.status }
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

/** Its process group when it leads one, else the process alone. */
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
