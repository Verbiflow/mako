import { harnessLabel } from "@/lib/harness-label"
import { acpStore } from "@/state/acp-state"
import type { NotificationSiblings, NotificationTarget } from "@/state/notifications"
import { rowThread, threadGroupsStore } from "@/state/thread-groups"
import { threadStatus } from "@/state/thread-status"
import { threadsStore } from "@/state/thread-store"

/**
 * The Mako Thread an outcome's Session belongs to, and which of the Thread's
 * other Sessions are still working when it lands. "Codex finished" in a
 * Thread where Claude is still running is half the news; this is the other
 * half. A tab, or a Session outside any Thread, has no siblings.
 */
export function threadSiblings(target: NotificationTarget): NotificationSiblings | undefined {
  const { groups, threadOf } = threadGroupsStore.get()
  const threads = threadsStore.get()
  const acp = acpStore.get()
  const own =
    target.kind === "thread" ? threads.threads.find((ref) => ref.path === target.path)
    : target.kind === "live" ? acp.conversations[target.key]
    : undefined
  if (!own) return undefined
  const thread = rowThread(own, threadOf)
  if (!thread) return undefined
  const working: string[] = []
  for (const { id } of groups[thread]?.sessions ?? []) {
    if (id === own.sessionId) continue
    const live = Object.values(acp.conversations).find((conversation) => conversation.sessionId === id)
    if (live) {
      const status = live.kind === "starting" ? "starting" : live.session.status
      if (status === "running" || status === "starting") working.push(harnessLabel(live.harness))
      continue
    }
    const ref = threads.threads.find((entry) => entry.sessionId === id)
    const status = ref ? threadStatus(ref, threads).kind : undefined
    if (ref && (status === "working" || status === "external-active")) working.push(harnessLabel(ref.harness))
  }
  return { thread, working }
}
