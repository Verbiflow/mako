import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import { acpForThread, acpStore, updateAcpConversation } from "@/state/acp-state"
import type { AcpPresence } from "@/state/acp-presence"
import { markSeen, subjectId } from "@/state/notifications"
import { markThreadReviewed } from "@/state/thread-status"
import { threadsStore } from "@/state/thread-store"
import type { TranscriptDepth } from "@mako/host/contracts/transcript-document"
import { archivedByKeys, threadArchiveKey, type ArchiveCommand, type CloudArchiveOutcome, type ThreadTarget, type ThreadArchiveSnapshot, type StopTarget } from "@mako/host/contracts/thread-lifecycle"
import { cloudArchiveSettled } from "@/state/cloud-archive"
import { type ThreadRef } from "@mako/host/contracts/conversation-session"
import { toast } from "sonner"

export const threadArchiveStore = createStore({ revision: -1, keys: new Set<string>() })
export const useThreadArchives = createHook(threadArchiveStore)
export type { ThreadTarget, ThreadControls } from "@mako/host/contracts/thread-lifecycle"

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
  const own = [threadArchiveKey(nativeThreadTarget(ref)), threadArchiveKey({ kind: "file", path: ref.path })]
  if (ref.nativeId) own.push(threadArchiveKey({ kind: "native", provider: ref.harness, nativeId: ref.nativeId }))
  return archivedByKeys(own, keys, ref)
}

export function archivedLive(presence: AcpPresence, keys: ReadonlySet<string>): boolean {
  return keys.has(threadArchiveKey({ kind: "live", id: presence.key })) || (presence.nativeId ? keys.has(threadArchiveKey({ kind: "native", provider: presence.harness, nativeId: presence.nativeId })) : false) || (presence.threadPath ? keys.has(threadArchiveKey({ kind: "file", path: presence.threadPath })) : false)
}

/** Where a cloud Thread's conversation runs, as its row says it (`CLOUD_FOLDER_WHERE`). */
const CLOUD_WHERE = "a cloud machine"

/** Whether a target is a conversation that runs, or ran, in the cloud: its archive is the cloud's, not this Mac's. */
export function inCloud(target: ThreadTarget): boolean {
  return target.kind === "live" && acpStore.get().conversations[target.id]?.elsewhere === CLOUD_WHERE
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
  /**
   * Archive or restore a thread; a Thread with several Sessions passes one
   * target per Session. A caller that says what happened itself passes
   * `announce: false`; failures are always reported.
   */
  async archive(targets: readonly ThreadTarget[], archived: boolean, announce = true, anyway = false): Promise<boolean> {
    let changed = 0
    // A cloud Thread is archived, or restored, in the cloud, once for all its Sessions: its toast says how it went.
    let cloud: CloudArchiveOutcome | undefined
    try {
      for (const one of targets) {
        const command: ArchiveCommand = { id: crypto.randomUUID(), target: one, archived }
        if (anyway) command.anyway = true
        const answer = await getMako().archiveThread(command)
        applyThreadArchives(answer)
        if (answer.cloud) {
          cloud = answer.cloud
          if (cloud.kind === "refused") break
        }
        changed += 1
        // Putting a thread away is at least as much an acknowledgement as
        // opening it: its unread answer or failure stops counting in the
        // app icon's badge, and the row's mark stands down so a
        // restore does not bring back news you have already dismissed.
        if (archived) acknowledgeThread(one)
      }
      if (cloud) {
        cloudArchiveSettled(cloud, archived, () => void threadLifecycle.archive(targets, archived, announce, true))
        return cloud.kind !== "refused"
      }
      if (announce) toast(archived ? "Thread archived. Running work is not stopped." : "Thread restored")
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
  /** The host's copy of the conversation (`buildTranscript`, folded), the one the transcript tab shows. */
  async copyTranscript(path: string, depth: TranscriptDepth) {
    try {
      const document = await getMako().transcriptDocument({ kind: "file", path }, depth)
      await navigator.clipboard.writeText(document.markdown)
      toast(depth === "concise" ? "Copied the concise transcript" : "Copied the full transcript")
    } catch (error) {
      toast.error("The transcript could not be copied", { description: error instanceof Error ? error.message : String(error) })
    }
  },
}
