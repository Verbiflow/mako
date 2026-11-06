import type { AcpPresence } from "@/state/acp-presence"
import type { ThreadStatus } from "@/state/thread-status"

/** A live conversation's state in the rail's status vocabulary. */
export function presenceThreadStatus(presence: AcpPresence): ThreadStatus {
  if (presence.status === "needs-permission") return { kind: "needs-permission", since: presence.createdAt }
  if (presence.status === "failed") return { kind: "failed", at: presence.createdAt }
  if (presence.status === "running" || presence.status === "starting")
    return { kind: "working", since: presence.createdAt }
  if (presence.status === "background") return { kind: "background", count: presence.background ?? 1 }
  if (presence.openElsewhere) return { kind: "external-open", app: presence.harness }
  return { kind: "idle" }
}
