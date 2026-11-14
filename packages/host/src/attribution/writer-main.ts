import type { z } from "zod"
import { parentPort } from "node:worker_threads"
import { followHostLog } from "../base/host-log.js"
import { openWriter } from "./writer-runtime.js"
import { ToWriterSchema, WriterContextSchema, WriterRepositorySchema, WriterInventorySchema, WriterStringSchema, WriterSetSchema, WriterBytesSchema, WriterBooleanSchema, WriterVoidSchema, WriterHistoryMarkSchema, WriterHistorySchema, WriterChildrenSchema, WriterThreadSchema, WriterPathsSchema, type WriterHostReply, type FromWriter, type WriterHostRequest, type WriterPorts } from "./writer-protocol.js"

interface WriterExecution { next: number; lag: number; closed: boolean; opening?: ReturnType<typeof openWriter>; stopping?: Promise<void> }
interface HostPending { resolve(reply: WriterHostReply): void; reject(error: Error): void; timer: NodeJS.Timeout }

function disconnect(): void { parentPort?.close() }

/** The journal writing worker: no host composition or provider module is loaded here. */
async function main(): Promise<void> {
  if (!parentPort) throw new Error("The attribution writer needs its host message port.")
  const port = parentPort
  const pending = new Map<number, HostPending>()
  const subscriptions = new Map<number, (event: Extract<ReturnType<typeof ToWriterSchema.parse>, { type: "event" }>) => void>()
  const state: WriterExecution = { next: 0, lag: 0, closed: false }
  const send = async (message: FromWriter): Promise<void> => { port.postMessage(message) }
  const unlog = followHostLog(line => { void send({ type: "log", line }).catch(() => {}) })
  const ask = <Schema extends z.ZodType>(request: WriterHostRequest, schema: Schema): Promise<z.infer<Schema>> => {
    if (state.closed) return Promise.reject(new Error("The record of changes is closing."))
    if (pending.size >= 256) return Promise.reject(new Error("Too many attribution port requests are waiting on the host."))
    const id = ++state.next
    return new Promise<z.infer<Schema>>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("The host took too long to answer the writing owner.")) }, 30_000)
      timer.unref()
      pending.set(id, { resolve: reply => {
        try { resolve(schema.parse(reply.value)) } catch (error) { reject(error) }
      }, reject, timer })
      void send({ type: "host-request", id, request }).catch(error => { clearTimeout(timer); pending.delete(id); reject(error) })
    })
  }
  const unwatch = (id: number) => {
    subscriptions.delete(id)
    if (!state.closed) void ask({ kind: "unwatch", subscription: id }, WriterVoidSchema).catch(() => {})
  }
  const ports: WriterPorts = {
    context: () => ask({ kind: "context" }, WriterContextSchema),
    deliveryLagMs: () => state.lag,
    async repository(root) {
      const found = await ask({ kind: "repository", root }, WriterRepositorySchema)
      if (!found) return null
      return {
        head: () => ask({ kind: "head", root }, WriterStringSchema),
        inventory: () => ask({ kind: "inventory", root }, WriterInventorySchema),
        ignored: paths => ask({ kind: "ignored", root, paths: [...paths] }, WriterSetSchema),
        ...(found.ignoredEntries && { ignoredEntries: () => ask({ kind: "ignored-entries", root }, WriterPathsSchema) }),
        read: (commit, path) => ask({ kind: "read", root, commit, path }, WriterBytesSchema),
        changed: (from, to) => ask({ kind: "changed", root, from, to }, WriterPathsSchema),
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

void main().catch(error => { console.error(error); process.exitCode = 1; disconnect() })
