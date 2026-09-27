import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import { acpForThread, acpStore, updateAcpConversation } from "@/state/acp-state"
import type { AcpPresence } from "@/state/acp-presence"
import { markSeen, subjectId } from "@/state/notifications"
import { markThreadReviewed } from "@/state/thread-status"
import { threadsStore } from "@/state/thread-store"
import { formatTranscript, type TranscriptDepth } from "@mako/sessions/transcript"
import { threadArchiveKey, type ThreadTarget, type ThreadArchiveSnapshot, type StopTarget, type ThreadRef } from "../../electron/shared"
import { toast } from "sonner"

export const threadArchiveStore = createStore({ revision: -1, keys: new Set<string>() })
export const useThreadArchives = createHook(threadArchiveStore)
export type { ThreadTarget, ThreadControls } from "../../electron/shared"

export function applyThreadArchives(snapshot: ThreadArchiveSnapshot) {
  if (snapshot.revision < threadArchiveStore.get().revision) return
  threadArchiveStore.set({ revision: snapshot.revision, keys: new Set(snapshot.keys) })
}

export function nativeThreadTarget(ref: ThreadRef): ThreadTarget {
  const owner = acpForThread(acpStore.get(), ref)
  if (owner?.kind === "live") return { kind: "live", id: owner.key }
  return ref.nativeId ? { kind: "native", provider: ref.harness, nativeId: ref.nativeId } : { kind: "file", path: ref.path }
}

export function archivedThread(ref: ThreadRef, keys: ReadonlySet<string>): boolean {
  return keys.has(threadArchiveKey(nativeThreadTarget(ref))) || keys.has(threadArchiveKey({ kind: "file", path: ref.path })) || (ref.nativeId ? keys.has(threadArchiveKey({ kind: "native", provider: ref.harness, nativeId: ref.nativeId })) : false)
}

export function archivedLive(presence: AcpPresence, keys: ReadonlySet<string>): boolean {
  return keys.has(threadArchiveKey({ kind: "live", id: presence.key })) || (presence.nativeId ? keys.has(threadArchiveKey({ kind: "native", provider: presence.harness, nativeId: presence.nativeId })) : false) || (presence.threadPath ? keys.has(threadArchiveKey({ kind: "file", path: presence.threadPath })) : false)
}

/** The thread paths and live key a lifecycle target is known by in the renderer. */
export interface ThreadTargetIdentity {
  paths: string[]
  liveKey?: string
}

export function threadTargetIdentity(target: ThreadTarget): ThreadTargetIdentity {
  const paths = new Set<string>()
  let liveKey: string | undefined
  if (target.kind === "file") paths.add(target.path)
  if (target.kind === "native")
    for (const ref of threadsStore.get().threads)
      if (ref.harness === target.provider && ref.nativeId === target.nativeId) paths.add(ref.path)
  if (target.kind === "live") {
    liveKey = target.id
    const conversation = acpStore.get().conversations[target.id]
    if (conversation?.threadPath) paths.add(conversation.threadPath)
  } else {
    for (const path of paths) {
      const owner = acpForThread(acpStore.get(), { path })
      if (owner?.kind === "live") liveKey = owner.key
    }
  }
  return { paths: [...paths], liveKey }
}

/** What opening the thread would have done: its outcomes are seen. */
export function acknowledgeThread(target: ThreadTarget): void {
  const { paths, liveKey } = threadTargetIdentity(target)
  for (const path of paths) markThreadReviewed(path)
  if (liveKey) {
    const conversation = acpStore.get().conversations[liveKey]
    if (conversation?.kind === "live" && conversation.session.status === "failed" && !conversation.failureSeen)
      updateAcpConversation(liveKey, (current) => ({ ...current, failureSeen: true }))
  }
  markSeen([
    ...paths.map((path) => subjectId({ kind: "thread", path })),
    ...(liveKey ? [subjectId({ kind: "live", key: liveKey })] : []),
  ])
}

export const threadLifecycle = {
  async load() {
    if (!hasBridge()) return
    try { applyThreadArchives(await getMako().threadArchives()) }
    catch (error) { toast.error("Archived threads could not be loaded", { description: error instanceof Error ? error.message : String(error) }) }
  },
  controls(target: ThreadTarget) { return getMako().threadControls(target) },
  /** Archive or restore a thread; a Thread with several Sessions passes one target per Session. */
  async archive(targets: readonly ThreadTarget[], archived: boolean): Promise<boolean> {
    let changed = 0
    try {
      for (const one of targets) {
        applyThreadArchives(await getMako().archiveThread({ id: crypto.randomUUID(), target: one, archived }))
        changed += 1
        // Putting a thread away is at least as much an acknowledgement as
        // opening it: its unread answer or failure stops counting in the
        // app icon's badge, and the row's mark stands down so a
        // restore does not bring back news you have already dismissed.
        if (archived) acknowledgeThread(one)
      }
      toast(archived ? "Thread archived. Running work is not stopped." : "Thread restored")
      return true
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error)
      toast.error(changed ? `${changed} of ${targets.length} sessions in this thread were ${archived ? "archived" : "restored"}` : "The thread was not changed", { description })
      return false
    }
  },
  async stop(target: StopTarget) {
    try {
      const accepted = await getMako().stopThread(target)
      toast(accepted ? "Stop requested. Queued messages are paused." : "That run already finished. No other run was stopped.")
    } catch (error) { toast.error("The run could not be stopped", { description: error instanceof Error ? error.message : String(error) }) }
  },
  /** One serializer for the clipboard and handoffs — the provider never knows. */
  async copyTranscript(path: string, depth: TranscriptDepth) {
    try {
      const thread = await getMako().openThread(path)
      if (!thread) throw new Error("The thread could not be read")
      await navigator.clipboard.writeText(
        formatTranscript(thread.entries, depth)
      )
      toast(depth === "concise" ? "Copied the concise transcript" : "Copied the full transcript")
    } catch (error) {
      toast.error("The transcript could not be copied", { description: error instanceof Error ? error.message : String(error) })
    }
  },
}
