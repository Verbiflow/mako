import { z } from "zod"
import { ThreadScratchSettingsSchema } from "./thread-scratch.js"
import type { MethodTable } from "../base/methods.js"
import type { ThreadScratchReport } from "../contracts/thread-scratch.js"
import type { ThreadScratch } from "./thread-scratch.js"

export function declareThreadScratchMethods(methods: MethodTable, scratch: ThreadScratch | null): void {
  methods.handle("mako:thread-scratch", (): Promise<ThreadScratchReport> => {
    if (!scratch) throw new Error("Thread scratch is unavailable on this host.")
    return scratch.preview()
  })
  methods.handle("mako:thread-scratch-set", async (settings: z.input<typeof ThreadScratchSettingsSchema>): Promise<ThreadScratchReport> => {
    if (!scratch) throw new Error("Thread scratch is unavailable on this host.")
    await scratch.configure(ThreadScratchSettingsSchema.parse(settings))
    scratch.changed()
    return scratch.preview()
  })
}
