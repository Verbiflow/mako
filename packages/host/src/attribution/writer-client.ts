import { STOP_GRACE_MS, StoppableWorker } from "../base/worker-stop.js"
import { postToWriter } from "./writer-messages.js"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"
import { locate } from "@mako/git"
import { hostLog, hostWarn, hostError } from "../base/host-log.js"
import type { AttributionDeps, CataloguedSession } from "./index.js"
import type { BackfillResult } from "./backfill.js"
import { FromWriterSchema, WriterSnapshotSchema, WriterCommandResults, type WriterReply, type WriterStateMessage, type WriterCommandResult, type WriterHostResult, type ToWriter, type WriterCommand, type WriterHostRequest, type WriterSettings, type WriterSnapshot, type WriterContextChange } from "./writer-protocol.js"

const ASK_MS = 30_000
const PROBE_MS = 5_000
const START_MS = 60_000
const MAX_PENDING = 256
interface Pending { resolve(reply: WriterReply): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface Subscription { closed: boolean; close?: () => void }
interface Generation {
  child: StoppableWorker
  ready: Promise<WriterSnapshot>
  accept(snapshot: WriterSnapshot): void
  fail(error: Error): void
  pending: Map<number, Pending>
  subscriptions: Map<number, Subscription>
  /** Each repository root the writer opened, with how its Git folder is watched (`watchGitDir`), when it is. */
  repositories: Map<string, { watchHead?(moved: () => void): { close(): void } }>
  context: SentContext
  closed: boolean
  started: boolean
  privateReason?: string
  exit: Promise<void>
  cleanup?: Promise<void>
}
interface WriterClientOptions {
  entry?: string
  applied?(): Promise<void>
  /** `stopMs`: how long a retired worker has to end itself before it is terminated (`StoppableWorker`). */
  timing?: { startMs?: number; askMs?: number; probeMs?: number; stopMs?: number }
  /** A read-back pass asked with `read-back` ended. */
  readBack?(result: BackfillResult | undefined): void
  /** The writer settled every change made by `through`. */
  settled?(through: number): void
}

/** The host talks to a writing worker; its normal journal client still owns replay and acknowledgements. */
export class AttributionWriter {
  private readonly deps: AttributionDeps
  private readonly settings: Omit<WriterSettings, "privateReason">
  private readonly entry: string
  private readonly applied: (() => Promise<void>) | undefined
  private readonly said: Pick<WriterClientOptions, "readBack" | "settled">
  private generation: Generation | undefined
  private next = 0
  private closed = false
  private closing: Promise<void> | undefined
  private state: WriterSnapshot | undefined
  private readonly timing: { startMs: number; askMs: number; probeMs: number; stopMs: number }

  constructor(deps: AttributionDeps, settings: Omit<WriterSettings, "privateReason">, options: WriterClientOptions = {}) {
    this.deps = deps
    this.settings = settings
    this.entry = options.entry ?? defaultEntry()
    this.applied = options.applied
    this.said = { readBack: options.readBack, settled: options.settled }
    this.timing = { startMs: options.timing?.startMs ?? START_MS, askMs: options.timing?.askMs ?? ASK_MS, probeMs: options.timing?.probeMs ?? PROBE_MS, stopMs: options.timing?.stopMs ?? STOP_GRACE_MS }
  }

  snapshot(): WriterSnapshot | undefined { return this.state }

  async ensure(privateReason?: string): Promise<WriterSnapshot> {
    if (this.closed) throw new Error("The record of changes is closing.")
    if (privateReason && this.generation && this.generation.privateReason !== privateReason) {
      this.retire(this.generation, new Error("The shared record of changes was refused; opening its private writer."))
    }
    if (this.generation?.closed) {
      await this.generation.cleanup
      this.generation = undefined
    }
    if (!this.generation) this.generation = this.start(privateReason)
    const generation = this.generation
    try {
      // A ready generation may have stopped answering since its journal link was lost.
      const snapshot = generation.started
        ? WriterSnapshotSchema.parse(await this.ask(generation, { kind: "snapshot" }, "liveness"))
        : await generation.ready
      if (generation.closed || this.closed) throw new Error("The record of changes' writer stopped while opening.")
      this.state = snapshot
      return snapshot
    } catch (error) {
      this.retire(generation, error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  async command(request: WriterCommand): Promise<WriterCommandResult> {
    const generation = this.generation
    if (!generation || generation.closed) return undefined
    await generation.ready
    const value = await this.ask(generation, request)
    if (request.kind === "snapshot") this.state = WriterSnapshotSchema.parse(value)
    return value
  }

  close(): Promise<void> {
    this.closing ??= this.stop()
    return this.closing
  }

  private async stop(): Promise<void> {
    this.closed = true
    const generation = this.generation
    if (!generation) return
    if (!generation.started) {
      this.retire(generation, new Error("The record of changes closed during startup."))
      await generation.cleanup
      await generation.exit
      return
    }
    try {
      await generation.ready
      await this.applied?.()
      if (!generation.closed) await this.ask(generation, { kind: "close" })
    } finally {
      this.retire(generation, new Error("The record of changes is closing."))
      await generation.cleanup
      await generation.exit
    }
  }

  private start(privateReason?: string): Generation {
    const entry = this.entry
    // The writing owner drains acknowledged writes before ending its worker.
    // The outer host owns this close; termination must not race the accepted-write drain.
    const child = new StoppableWorker(entry, {
      name: "attribution-writer", resourceLimits: { maxYoungGenerationSizeMb: 4 }, execArgv: entry.endsWith(".ts") ? process.execArgv : [],
    })
    let accept!: (snapshot: WriterSnapshot) => void
    let fail!: (error: Error) => void
    const ready = new Promise<WriterSnapshot>((resolve, reject) => { accept = resolve; fail = reject })
    // A late startup failure is consumed even when the host began closing before joining ready.
    void ready.catch(() => {})
    const exit = new Promise<void>(resolve => child.once("exit", () => resolve()))
    const generation: Generation = { child, ready, accept, fail, exit, pending: new Map(), subscriptions: new Map(), repositories: new Map(), context: { version: 0, byPath: new Map(), running: "" }, closed: false, started: false, privateReason }
    const timer = setTimeout(() => {
      this.retire(generation, new Error("The record of changes' writer took too long to open."))
      void child.stop(this.timing.stopMs)
    }, this.timing.startMs)
    timer.unref()
    child.on("message", message => {
      const parsed = FromWriterSchema.safeParse(message)
      if (!parsed.success || generation.closed) return
      const reply = parsed.data
      switch (reply.type) {
        case "log": {
          const log = reply.line.level === "warn" ? hostWarn : reply.line.level === "error" ? hostError : hostLog
          log(reply.line.scope, reply.line.message, reply.line.fields)
          return
        }
        case "ready":
          clearTimeout(timer)
          try { const snapshot = snapshotOf(reply); generation.started = true; accept(snapshot) }
          catch { this.retire(generation, new Error("The writing owner returned invalid startup state.")) }
          return
        case "snapshot":
          try { if (this.generation === generation) this.state = snapshotOf(reply) }
          catch { this.retire(generation, new Error("The writing owner returned invalid state.")) }
          return
        case "failed":
          clearTimeout(timer)
          this.retire(generation, new Error(reply.error))
          return
        case "reply": {
          const pending = generation.pending.get(reply.id)
          if (!pending) return
          clearTimeout(pending.timer)
          generation.pending.delete(reply.id)
          if (reply.ok) pending.resolve(reply)
          else pending.reject(new Error(reply.error ?? "The writing owner refused the request."))
          return
        }
        case "read-back":
          this.said.readBack?.(reply.result)
          return
        case "settled":
          this.said.settled?.(reply.through)
          return
        case "host-request":
          void this.host(generation, reply.request).then(
            value => this.send(generation, { type: "host-reply", id: reply.id, ok: true, value, lagMs: this.lag() }),
            error => this.send(generation, { type: "host-reply", id: reply.id, ok: false, error: error instanceof Error ? error.message : String(error), lagMs: this.lag() }),
          ).catch(() => {})
      }
    })
    child.once("error", error => { clearTimeout(timer); this.retire(generation, error) })
    child.once("exit", (code) => {
      clearTimeout(timer)
      this.retire(generation, new Error(`The record of changes' writer exited (${code}).`))
    })
    void this.send(generation, { type: "start", settings: { ...this.settings, ...(privateReason && { privateReason }) } }).catch(error => this.retire(generation, error))
    return generation
  }

  private ask(generation: Generation, command: WriterCommand, probe?: "liveness"): Promise<WriterCommandResult> {
    if (generation.closed) return Promise.reject(new Error("The writing owner has stopped."))
    if (generation.pending.size >= MAX_PENDING) return Promise.reject(new Error("Too many requests are waiting on the writing owner."))
    const id = ++this.next
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error("The record of changes' writer took too long to answer.")
        if (probe) this.retire(generation, error)
        else { generation.pending.delete(id); reject(error) }
      }, probe ? this.timing.probeMs : this.timing.askMs)
      timer.unref()
      generation.pending.set(id, { resolve: reply => {
        try { resolve(WriterCommandResults[command.kind].parse(reply.value)) } catch (error) { reject(error) }
      }, reject, timer })
      void this.send(generation, { type: "command", id, command }).catch(error => {
        clearTimeout(timer); generation.pending.delete(id); reject(error)
      })
    })
  }

  private retire(generation: Generation, error: Error): void {
    if (generation.closed) return
    generation.closed = true
    generation.fail(error)
    for (const pending of generation.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    generation.pending.clear()
    for (const subscription of generation.subscriptions.values()) { subscription.closed = true; release(subscription) }
    generation.subscriptions.clear()
    if (this.generation === generation) this.state = undefined
    generation.cleanup = generation.child.stop(this.timing.stopMs).then(() => {})
    void generation.cleanup.catch(() => {})
  }

  private lag(): number { return Math.max(0, this.deps.deliveryLagMs?.() ?? 0) }
  private send(generation: Generation, message: ToWriter): Promise<void> {
    if (generation.closed) return Promise.reject(new Error("The writing owner has stopped."))
    try { postToWriter(generation.child, message); return Promise.resolve() }
    catch (error) { return Promise.reject(error) }
  }

  private async host(generation: Generation, request: WriterHostRequest): Promise<WriterHostResult> {
    if (generation.closed || this.closed) throw new Error("The writing owner has stopped.")
    switch (request.kind) {
      case "context": return this.context(generation, request.have)
      case "repository": {
        const found = await locate(this.deps.git, request.root).catch(() => null)
        if (generation.closed) throw new Error("The writing owner has stopped.")
        if (found?.root !== request.root) return null
        const watchGitDir = this.deps.watchGitDir
        const repository = { ...(watchGitDir && { watchHead: (moved: () => void) => watchGitDir(request.root, moved) }) }
        generation.repositories.set(request.root, repository)
        return { watchHead: Boolean(repository.watchHead) }
      }
      case "history-mark": return this.deps.history?.mark()
      case "history-since": return this.deps.history?.since(request.mark, request.roots, request.options)
      case "children": return this.deps.children?.children(request.path) ?? null
      case "open": return this.deps.children?.open(request.path) ?? null
      case "unwatch": {
        const subscription = generation.subscriptions.get(request.subscription)
        if (subscription) { subscription.closed = true; release(subscription); generation.subscriptions.delete(request.subscription) }
        return
      }
      case "watch":
      case "watch-head": {
        const subscription: Subscription = { closed: false }
        generation.subscriptions.set(request.subscription, subscription)
        const event = (kind: "changed" | "gone" | "dropped" | "head", paths?: string[], why?: "dropped" | "polling" | "listening") => {
          if (!subscription.closed) void this.send(generation, { type: "event", subscription: request.subscription, event: kind, paths, why, lagMs: this.lag() }).catch(() => {})
        }
        const watching = request.kind === "watch"
          ? this.deps.watch(request.root, paths => event("changed", paths), () => event("gone"), why => event("dropped", undefined, why))
          : this.repository(generation, request.root).watchHead?.(() => event("head"))
        if (!watching) { generation.subscriptions.delete(request.subscription); return false }
        subscription.close = () => watching.close()
        if (subscription.closed || generation.closed) { release(subscription); return false }
        if ("ready" in watching) await watching.ready
        if (subscription.closed || generation.closed) { release(subscription); return false }
        return true
      }
    }
  }

  private context(generation: Generation, have: number): WriterContextChange {
    const told = contextChange(generation.context, have, { rows: this.deps.catalogued?.() ?? [], running: this.deps.running?.() ?? {}, stores: this.deps.stores() })
    generation.context = told.sent
    return told.change
  }

  private repository(generation: Generation, root: string): { watchHead?(moved: () => void): { close(): void } } {
    const repository = generation.repositories.get(root)
    if (!repository) throw new Error("The writing owner asked for a repository it hasn't opened.")
    return repository
  }
}

/** The context a writer was last sent: the catalog's rows as they were then, by path, and what else it holds. */
export interface SentContext {
  version: number
  rows?: readonly CataloguedSession[]
  byPath: Map<string, CataloguedSession>
  running: string
  stores?: readonly string[]
}

/**
 * What moved in the host's context since the writer's version of it (`have`), and what the writer holds once told.
 * The catalog keeps a row's object until that row changes and its list until any does, so the same list is nothing
 * to send, and of another list only the rows that are other objects are. Each is cut to what the writer reads
 * before it crosses.
 */
export function contextChange(sent: SentContext, have: number, now: { rows: readonly CataloguedSession[]; running: Readonly<Record<string, { status: string }>>; stores: readonly string[] }) {
  const ran = JSON.stringify(now.running)
  if (have === sent.version && sent.version > 0 && now.rows === sent.rows && now.stores === sent.stores && ran === sent.running) return { change: { same: true } satisfies WriterContextChange, sent }
  // A writer holding another version (a new one, or one whose answer was lost) is sent everything.
  const whole = have !== sent.version || sent.version === 0
  const byPath = new Map(now.rows.map(row => [row.path, row]))
  const sessions = now.rows.filter(row => whole || sent.byPath.get(row.path) !== row).map(reduced)
  const removed = whole ? [] : [...sent.byPath.keys()].filter(path => !byPath.has(path))
  const version = Math.max(sent.version, have) + 1
  const change: WriterContextChange = { version, whole, sessions, removed, running: { ...now.running }, stores: [...now.stores] }
  return { change, sent: { version, rows: now.rows, byPath, running: ran, stores: now.stores } satisfies SentContext }
}

/** A catalogued session as the writer reads it (`CataloguedSession`): its own fields, never the rest of the catalog's row. */
function reduced(row: CataloguedSession): Extract<WriterContextChange, { version: number }>["sessions"][number] {
  return {
    harness: row.harness, nativeId: row.nativeId, path: row.path,
    ...(row.cwd !== undefined && { cwd: row.cwd }), ...(row.currentCwd !== undefined && { currentCwd: row.currentCwd }),
    ...(row.worktrees && { worktrees: row.worktrees.map(worktree => ({ path: worktree.path })) }),
    ...(row.updatedAt !== undefined && { updatedAt: row.updatedAt }), ...(row.threadId !== undefined && { threadId: row.threadId }), ...(row.sessionId !== undefined && { sessionId: row.sessionId }),
  }
}

function snapshotOf(message: WriterStateMessage): WriterSnapshot {
  return WriterSnapshotSchema.parse(message.snapshot)
}

function defaultEntry(): string {
  const compiled = fileURLToPath(new URL("./writer-main.js", import.meta.url))
  return existsSync(compiled) ? compiled : compiled.replace(/\.js$/, ".ts")
}

function release(subscription: Subscription): void {
  const close = subscription.close
  subscription.close = undefined
  close?.()
}
