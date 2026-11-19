import type { z } from "zod"
import { parentPort } from "node:worker_threads"
import { followHostLog, hostLog } from "../base/host-log.js"
import { exitWhenStopped } from "../base/worker-stop.js"
import { openWriter } from "./writer-runtime.js"
import { Git } from "@mako/git"
import { gitRepository } from "./ports.js"
import { applyContextChange, ToWriterSchema, WriterContextChangeSchema, WriterRepositorySchema, WriterBooleanSchema, WriterVoidSchema, WriterHistoryMarkSchema, WriterHistorySchema, WriterChildrenSchema, WriterThreadSchema, type WriterHostReply, type FromWriter, type WriterHostRequest, type WriterPorts, type WriterContext, type HeldContext } from "./writer-protocol.js"

interface WriterExecution { next: number; lag: number; closed: boolean; opening?: ReturnType<typeof openWriter>; stopping?: Promise<void> }
/** The host's context as held here, and the ask for it under way. */
interface ContextAsk { held: HeldContext; asking?: Promise<WriterContext>; at: number }
/** The host's context is asked again behind what's held at most this often. */
const CONTEXT_FRESH_MS = 1_000
/** How long the owner waits on any one ask of the host. */
const ASK_MS = 30_000
/** An ask the host answered slower than this is counted, and said at most once a `SLOW_LOG_MS`. */
const SLOW_ASK_MS = 1_000
const SLOW_LOG_MS = 10_000
/** A Git process of the owner's slower than this is logged, as the host logs its own. */
const GIT_SLOW_MS = 2_000

/** The host's slow answers by ask, said together: the asks say what the owner waited on, and for how long. */
class SlowAsks {
  private readonly kinds = new Map<string, { count: number; maxMs: number }>()
  private said = -Infinity

  heard(kind: string, ms: number): void {
    if (ms < SLOW_ASK_MS) return
    const known = this.kinds.get(kind) ?? { count: 0, maxMs: 0 }
    this.kinds.set(kind, { count: known.count + 1, maxMs: Math.max(known.maxMs, ms) })
    const now = Date.now()
    if (now - this.said < SLOW_LOG_MS) return
    this.said = now
    const asks = [...this.kinds].map(([name, { count, maxMs }]) => `${name}×${count} max ${Math.round(maxMs)} ms`).join(", ")
    this.kinds.clear()
    hostLog("attribution", "the host was slow to answer the writing owner", { asks })
  }
}
interface HostPending { resolve(reply: WriterHostReply): void; reject(error: Error): void; timer: NodeJS.Timeout }

function disconnect(): void { parentPort?.close() }

/** The journal writing worker: no host composition or provider module is loaded here. */
async function main(): Promise<void> {
  if (!parentPort) throw new Error("The attribution writer needs its host message port.")
  const port = parentPort
  const pending = new Map<number, HostPending>()
  const subscriptions = new Map<number, (event: Extract<ReturnType<typeof ToWriterSchema.parse>, { type: "event" }>) => void>()
  const state: WriterExecution = { next: 0, lag: 0, closed: false }
  const slowAsks = new SlowAsks()
  const gitStop = new AbortController()
  const git = new Git({ signal: gitStop.signal, trace: run => {
    if (run.ms < GIT_SLOW_MS && run.outcome !== "timeout") return
    hostLog("git", `${run.command} ${run.outcome}`, { args: run.args.slice(0, 6).join(" ").slice(0, 200), cwd: run.cwd, ms: Math.round(run.ms), queuedMs: Math.round(run.queuedMs), code: run.code ?? -1, by: "attribution" })
  } })
  const send = async (message: FromWriter): Promise<void> => { port.postMessage(message) }
  const unlog = followHostLog(line => { void send({ type: "log", line }).catch(() => {}) })
  const ask = <Schema extends z.ZodType>(request: WriterHostRequest, schema: Schema): Promise<z.infer<Schema>> => {
    if (state.closed) return Promise.reject(new Error("The record of changes is closing."))
    if (pending.size >= 256) return Promise.reject(new Error("Too many attribution port requests are waiting on the host."))
    const id = ++state.next
    const asked = performance.now()
    return new Promise<z.infer<Schema>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`The host took too long to answer the writing owner: its ${request.kind} ask waited ${ASK_MS / 1000} s.`))
      }, ASK_MS)
      timer.unref()
      pending.set(id, { resolve: reply => {
        slowAsks.heard(request.kind, performance.now() - asked)
        try { resolve(schema.parse(reply.value)) } catch (error) { reject(error) }
      }, reject, timer })
      void send({ type: "host-request", id, request }).catch(error => { clearTimeout(timer); pending.delete(id); reject(error) })
    })
  }
  const unwatch = (id: number) => {
    subscriptions.delete(id)
    if (!state.closed) void ask({ kind: "unwatch", subscription: id }, WriterVoidSchema).catch(() => {})
  }
  // The host's context as last told, kept by session: each ask sends the version held, and takes back only what moved.
  const context: ContextAsk = { held: { version: 0, sessions: new Map(), context: { sessions: [], running: {}, stores: [] } }, at: -Infinity }
  const refreshContext = (): Promise<WriterContext> => context.asking ??= (async () => {
    try {
      context.held = applyContextChange(context.held, await ask({ kind: "context", have: context.held.version }, WriterContextChangeSchema))
      return context.held.context
    } finally { context.asking = undefined; context.at = Date.now() }
  })()
  // Once told, what's held answers at once and is asked again behind it, at most once a `CONTEXT_FRESH_MS`: a flush
  // asked before its write, and on 2026-11-18 one-file writes took 1.6-2 s, each the host's loop held as long.
  const askContext = (): Promise<WriterContext> => {
    if (!context.held.version) return refreshContext()
    if (!context.asking && Date.now() - context.at >= CONTEXT_FRESH_MS) void refreshContext().catch(() => {})
    return Promise.resolve(context.held.context)
  }
  const ports: WriterPorts = {
    context: askContext,
    readBack: result => { void send({ type: "read-back", result }).catch(() => {}) },
    settledThrough: through => { void send({ type: "settled", through }).catch(() => {}) },
    deliveryLagMs: () => state.lag,
    async repository(root) {
      // The host says whether `root` is a repository and watches its Git folder; Git itself runs from here, never through
      // the host's thread: a flush waited on it for `check-ignore`, `ls-files` and `cat-file` (stats of 4 files took
      // 4.4 s, and a `check-ignore` queued 9.4 s behind the host's own Git, on 2026-11-18).
      const found = await ask({ kind: "repository", root }, WriterRepositorySchema)
      if (!found) return null
      const own = gitRepository(git, root)
      return {
        head: own.head, inventory: own.inventory, ignored: own.ignored, read: own.read, changed: own.changed,
        ...(own.ignoredEntries && { ignoredEntries: own.ignoredEntries }),
        ...(found.watchHead && { watchHead: (moved: () => void) => {
          const id = ++state.next
          subscriptions.set(id, () => moved())
          void ask({ kind: "watch-head", root, subscription: id }, WriterBooleanSchema).catch(() => unwatch(id))
          return { close: () => unwatch(id) }
        } }),
      }
    },
    watch(root, changed, gone, dropped) {
      const id = ++state.next
      subscriptions.set(id, event => {
        if (event.event === "changed") changed(event.paths ?? [])
        else if (event.event === "gone") gone()
        else if (event.event === "dropped" && event.why) dropped(event.why)
      })
      const ready = ask({ kind: "watch", root, subscription: id }, WriterBooleanSchema).then(found => {
        if (!found) throw new Error("The host couldn't watch an attribution root.")
      })
      return { ready, close: () => unwatch(id) }
    },
  }
  const stop = (): Promise<void> => {
    state.stopping ??= (async () => {
      state.closed = true
      gitStop.abort()
      // End host-dependent waits before joining the tracker that may be waiting on them.
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Mako's host is stopping.")) }
      pending.clear()
      subscriptions.clear()
      try { await (await state.opening)?.close() }
      finally { unlog() }
    })()
    return state.stopping
  }
  port.once("close", () => { void stop().catch(() => {}) })
  port.on("message", message => {
    const parsed = ToWriterSchema.safeParse(message)
    if (!parsed.success || state.closed) return
    const input = parsed.data
    switch (input.type) {
      case "host-reply": {
        state.lag = input.lagMs
        const request = pending.get(input.id)
        if (!request) return
        clearTimeout(request.timer)
        pending.delete(input.id)
        if (input.ok) request.resolve(input)
        else request.reject(new Error(input.error ?? "The host refused an attribution port request."))
        return
      }
      case "event":
        state.lag = input.lagMs
        subscriptions.get(input.subscription)?.(input)
        return
      case "start": {
        if (state.opening) return
        const settings = input.settings
        if (settings.history) ports.history = { mark: () => ask({ kind: "history-mark" }, WriterHistoryMarkSchema), since: (mark, roots, options) => ask({ kind: "history-since", mark, roots: [...roots], options: options ? { ignore: options.ignore ? [...options.ignore] : undefined, exclude: options.exclude ? [...options.exclude] : undefined } : undefined }, WriterHistorySchema) }
        if (settings.children) ports.children = { children: path => ask({ kind: "children", path }, WriterChildrenSchema), open: path => ask({ kind: "open", path }, WriterThreadSchema) }
        state.opening = openWriter(settings, ports)
        void state.opening.then(
          async writer => {
            const publication = { queued: false }
            writer.follow(() => {
              if (publication.queued || state.closed) return
              publication.queued = true
              setImmediate(() => {
                publication.queued = false
                if (!state.closed) void send({ type: "snapshot", snapshot: writer.snapshot() }).catch(() => {})
              })
            })
            await send({ type: "ready", snapshot: writer.snapshot() })
          },
          async error => { await send({ type: "failed", error: error instanceof Error ? error.message : String(error) }); await stop(); disconnect() },
        ).catch(() => { process.exitCode = 1; disconnect() })
        return
      }
      case "command":
        void (async () => {
          try {
            const writer = await state.opening
            if (!writer) throw new Error("The attribution writer hasn't started.")
            const value = input.command.kind === "close" ? await stop() : await writer.command(input.command)
            await send({ type: "reply", id: input.id, ok: true, value })
          } catch (error) { await send({ type: "reply", id: input.id, ok: false, error: error instanceof Error ? error.message : String(error) }) }
          finally { if (input.command.kind === "close") disconnect() }
        })().catch(() => { process.exitCode = 1; disconnect() })
    }
  })
}

exitWhenStopped()
void main().catch(error => { console.error(error); process.exitCode = 1; disconnect() })
