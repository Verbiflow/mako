// Copied as a standalone module into this launch's private native plugin directory.
// build-native-observers bundles its schema dependency: OpenCode loads this outside Mako.
import { appendFile, stat } from "node:fs/promises"
import { z } from "zod"

const id = z.string().min(1).max(512)
const options = z.object({ path: z.string().min(1) })
const observation = z.discriminatedUnion("type", [
  z.object({ type: z.literal("permission.asked"), data: z.object({ sessionID: id, id, source: z.object({ id }).optional() }) }),
  z.object({ type: z.literal("permission.replied"), data: z.object({ sessionID: id, requestID: id, reply: z.enum(["once", "always", "reject"]) }) }),
])

interface Context {
  options: unknown
  event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<unknown> }
}

export default {
  id: "mako-native-approval-observer",
  async setup(context: Context) {
    const parsedOptions = options.safeParse(context.options)
    if (!parsedOptions.success) return
    const { path } = parsedOptions.data
    // Native plugin reactivation in the same process must keep the launch cap.
    let bytes = (await stat(path)).size
    const stop = new AbortController()
    const task = (async () => {
      for await (const input of context.event.subscribe({ signal: stop.signal })) {
        const parsed = observation.safeParse(input)
        if (!parsed.success) continue
        const event = parsed.data
        let record: { type: "asked"; sessionId: string; requestId: string; toolId: string } |
          { type: "replied"; sessionId: string; requestId: string; reply: string; observedAt: number } | undefined
        if (event.type === "permission.asked") {
          const data = event.data
          const toolId = data.source?.id ?? data.id
          record = { type: "asked", sessionId: data.sessionID, requestId: data.id, toolId }
        } else {
          const data = event.data
          record = { type: "replied", sessionId: data.sessionID, requestId: data.requestID, reply: data.reply, observedAt: Date.now() }
        }
        if (!record) continue
        const line = JSON.stringify(record) + "\n"
        bytes += Buffer.byteLength(line)
        // Observation loss remains unknown; it must never change permission policy.
        if (line.length > 4096 || bytes > 1_048_576) break
        await appendFile(path, line, { mode: 0o600 })
      }
    })().catch(() => { /* Native observation is optional; never intercept a permission reply. */ })
    return async () => { stop.abort(); await task }
  },
}
