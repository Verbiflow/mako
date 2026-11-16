import { AppKeySchema, type AppKey } from "@mako/host/contracts/thread-environments"
import type { AppOutputChunk, AppOutputCursor, AppOutputKey } from "@mako/host/contracts/thread-app"
import type { RefetchLease } from "@/lib/view-refetch"
import { DESK_SCOPE, type DeskRefetch } from "./desk-refetch"

const OUTPUT_MS = 500
const FULL_READ_CHARS = 128 * 1024
interface OutputWatch {
  listeners: Set<(text: string, reset: boolean) => void>
  app?: AppKey
  releaseApp?: () => void
  cursor?: AppOutputCursor
  lease?: RefetchLease
}

/** One cursor stream per output, shared by its visible consumers; the scheduler owns hiding and stale answers. */
export function appOutputReader(owner: Pick<DeskRefetch, "reads" | "supports" | "outputFollowing" | "watchOutput">, read: (cwd: string, key: AppOutputKey, cursor?: AppOutputCursor) => Promise<AppOutputChunk>) {
  const outputs = new Map<string, OutputWatch>()
  return (cwd: string, key: AppOutputKey, listener: (text: string, reset: boolean) => void) => {
    const id = JSON.stringify(["host:output", cwd, key])
    let entry = outputs.get(id)
    if (!entry) {
      entry = { listeners: new Set() }
      outputs.set(id, entry)
      const output = entry
      output.lease = owner.reads.watch(id, {
        scope: DESK_SCOPE, domain: "output", key: cwd, fields: ["output", "state"],
        every: () => output.app && owner.outputFollowing(output.app) ? undefined : owner.supports("apps") ? 2_000 : OUTPUT_MS,
        read: async (current) => {
          const chunk = await read(cwd, key, output.cursor)
          if (!current()) return
          const app = AppKeySchema.safeParse(chunk.app)
          const next = app.success ? app.data : undefined
          if (output.app !== next) {
            output.releaseApp?.()
            output.app = next
            output.releaseApp = next ? owner.watchOutput(next) : undefined
          }
          const reset = chunk.reset || !output.cursor
          if (reset || chunk.text) for (const told of output.listeners) told(chunk.text, reset)
          output.cursor = chunk.cursor
          if (chunk.text.length >= FULL_READ_CHARS) output.lease?.refresh({ immediate: true })
        },
      })
    } else {
      // A new reader needs the prefix too; reset every consumer through the same bounded cursor stream.
      entry.cursor = undefined
      entry.lease?.refresh({ immediate: true, invalidate: true })
    }
    const output = entry
    output.listeners.add(listener)
    let released = false
    return () => {
      if (released) return
      released = true
      output.listeners.delete(listener)
      if (output.listeners.size) return
      output.releaseApp?.()
      output.lease?.release()
      outputs.delete(id)
    }
  }
}
