import { registerIpc } from "./register.js"
import type { LiveConversations } from "../live-conversations.js"
import type { ThreadStore } from "../thread-store.js"
import type { ThreadGroup, ThreadRegroup } from "../contracts/thread-groups.js"
import { ThreadIdSchema, type ThreadPlacement } from "../contracts/thread-identity.js"

/**
 * A window's view of multi-Session Threads: the groups to draw, and a new
 * Session in a Thread for a `+` tab's first send. The operation ID is the
 * tab's own, so a send repeated after a dropped connection gets the Session
 * the first attempt created. Adding Sessions to a Thread and splitting them
 * out are receipted the same way.
 */
export function installThreadGroupsIpc(store: ThreadStore | null, live: LiveConversations) {
  registerIpc("mako:thread-groups", (): ThreadGroup[] => store?.groups() ?? [])
  registerIpc("mako:thread-create-session", (_event, operationId: string, thread: string): ThreadPlacement => {
    if (!store) throw new Error("This Mako couldn't open its Thread store, so it can't add a session to a Thread.")
    const placed = store.createSession({ operationId, thread: ThreadIdSchema.parse(thread), actor: store.person() })
    live.announceGroup(placed.thread)
    return placed
  })
  registerIpc("mako:thread-join", (_event, operationId: string, sessions: string[], thread: string): ThreadRegroup =>
    live.joinThread(operationId, sessions, thread))
  registerIpc("mako:thread-split", (_event, operationId: string, sessions: string[]): ThreadRegroup =>
    live.splitSessions(operationId, sessions))
}
