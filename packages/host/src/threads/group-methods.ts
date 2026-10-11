import type { MethodTable } from "../base/methods.js"
import type { ThreadStore } from "./store.js"
import type { ThreadGroup } from "../contracts/thread-groups.js"
import type { ThreadPurpose } from "../contracts/thread-purposes.js"
import { ThreadIdSchema, type ThreadPlacement } from "../contracts/thread-identity.js"

/**
 * A window's view of multi-Session Threads: the groups to draw, and a new
 * Session in a Thread for a `+` tab's first send. The operation ID is the
 * tab's own, so a send repeated after a dropped connection gets the Session
 * the first attempt created.
 */
export function declareThreadGroupMethods(methods: MethodTable, store: ThreadStore | null, announceGroup: (thread: string) => void, problem?: string, notify?: (message: string) => void) {
  // Every window asks for groups as it loads: without a store each says why,
  // and a store started over after damage is told once.
  let told = false
  methods.handle("mako:thread-groups", (): ThreadGroup[] => {
    if (!store) {
      if (problem) throw new Error(problem)
      return []
    }
    if (problem && !told) {
      told = true
      notify?.(problem)
    }
    return store.groups()
  })
  methods.handle("mako:thread-purposes", (): ThreadPurpose[] => store?.purposes() ?? [])
  methods.handle("mako:thread-create-session", (operationId: string, thread: string): ThreadPlacement => {
    if (!store) throw new Error("This Mako couldn't open its Thread store, so it can't add a session to a Thread.")
    const placed = store.createSession({ operationId, thread: ThreadIdSchema.parse(thread), actor: store.person() })
    announceGroup(placed.thread)
    return placed
  })
}
