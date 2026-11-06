import type { MethodTable } from "../base/methods.js"
import type { ThreadStore } from "./store.js"
import type { ThreadPurpose } from "../contracts/thread-purposes.js"
import type { ThreadOrigin, ThreadSplit } from "../contracts/thread-splits.js"
import { SessionIdSchema, ThreadIdSchema, type ThreadPlacement } from "../contracts/thread-identity.js"

/**
 * What a window reads of the Thread store as it loads, and a new Thread beside another for a `+`'s first send. The
 * operation ID is the draft's own, so a send repeated after a dropped connection gets what the first attempt made.
 */
export function declareThreadGroupMethods(methods: MethodTable, store: ThreadStore | null, problem?: string, notify?: (message: string) => void) {
  // Every window asks for splits as it loads: without a store each says why,
  // and a store started over after damage is told once.
  let told = false
  methods.handle("mako:thread-splits", (): ThreadSplit[] => {
    if (!store) {
      if (problem) throw new Error(problem)
      return []
    }
    if (problem && !told) {
      told = true
      notify?.(problem)
    }
    return store.threadSplits()
  })
  methods.handle("mako:thread-origin", (thread: string): ThreadOrigin | null => store?.threadOrigin(ThreadIdSchema.parse(thread)) ?? null)
  methods.handle("mako:thread-purposes", (): ThreadPurpose[] => store?.purposes() ?? [])
  // `session`: the ID a device gave a `+` tab in a Thread that moved to this cloud machine, so both name it alike.
  methods.handle("mako:thread-create-session", (operationId: string, thread: string, session?: string): ThreadPlacement => {
    if (!store) throw new Error("This Mako couldn't open its Thread store, so it can't add a session to a Thread.")
    return store.createSession({ operationId, thread: ThreadIdSchema.parse(thread), actor: store.person(), ...session && { session: SessionIdSchema.parse(session) } })
  })
}
