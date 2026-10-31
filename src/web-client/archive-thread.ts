import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { createHook, createStore } from "@/state/store"
import type { WebClient } from "./client"
import type { WebThread } from "./threads"

/** How a Thread's archive went: done, or refused in its owner's words (`anyway`: its machine couldn't start). */
export type ArchiveOutcome = { kind: "archived" } | { kind: "refused"; reason: string; anyway: boolean }

/** The words for a cloud archive's steps, as the screen that asked says them. */
export const ARCHIVE_STEP_WORDS = { packing: "Saving its work…", ending: "Ending its machine…" } as const

/**
 * Archives a Thread from this browser, as its owner archives one. A cloud Thread's archive is the cloud's own: its
 * machine packs its work and ends (`archive.ts`); another device's Sessions are archived by asking that device, each
 * of them. Throws when its owner can't be reached (a Mac that's off says so).
 */
export async function archiveThread(client: WebClient, thread: WebThread, options: { anyway?: boolean; step?: (words: string) => void } = {}): Promise<ArchiveOutcome> {
  const cloud = thread.sessions.find((each) => each.row.runsOn.kind === "cloud")?.row.runsOn
  if (cloud?.kind === "cloud") {
    const { archiveCloudThread } = await import("./archive")
    const { step } = options
    const outcome = await archiveCloudThread(client.gateway, client.deviceId, cloud.threadId, client.list.rows(), {
      anyway: options.anyway ?? false,
      ...(step && { step: (kind) => kind !== "bringing" && step(ARCHIVE_STEP_WORDS[kind]) }),
    })
    return outcome.kind === "refused" ? { kind: "refused", reason: outcome.reason, anyway: outcome.anyway ?? false } : { kind: "archived" }
  }
  const conversations = await client.conversations()
  for (const each of thread.sessions) await conversations.archiveOnOwner(each.row.conversation)
  return { kind: "archived" }
}

/**
 * Archives a Thread from this browser and says how it went: archived, or why not, with "Archive anyway" where its owner
 * allows it. `step` hears each step's words while it goes, then `undefined`.
 */
export async function archiveAndSay(client: WebClient, thread: WebThread, step: (words: string | undefined) => void, onArchived: () => void, anyway = false): Promise<void> {
  step("Archiving…")
  try {
    const outcome = await archiveThread(client, thread, { anyway, step })
    if (outcome.kind === "refused") {
      if (outcome.anyway) toast.error("Not archived", { description: outcome.reason, action: { label: "Archive anyway", onClick: () => void archiveAndSay(client, thread, step, onArchived, true) }, duration: ACTION_TOAST_MS })
      else toast.error("Not archived", { description: outcome.reason })
      return
    }
    toast.success("Archived", { description: thread.title })
    onArchived()
  } catch (error) {
    toast.error("Not archived", { description: error instanceof Error ? error.message : String(error) })
  } finally {
    step(undefined)
  }
}

/** How long an archive from the list can be taken back before it's asked of its owner. */
export const UNDO_MS = 5_000
/** After its owner archived it, a row stays hidden until the list drops it, at most this long. */
const GONE_WITHIN_MS = 30_000
const UNDO_TOAST = "web-archive-undo"

/** The Threads the list hides while their archive is pending, under way or just done. */
export const archivingStore = createStore<{ hidden: ReadonlySet<string> }>({ hidden: new Set() })
export const useArchiving = createHook(archivingStore)

function hide(thread: string, hidden: boolean): void {
  const next = new Set(archivingStore.get().hidden)
  if (hidden) next.add(thread)
  else next.delete(thread)
  archivingStore.set({ hidden: next })
}

/** The one archive that can still be taken back: a second archive asks the first of its owner at once. */
let pending: { thread: WebThread; commit: () => void; timer: ReturnType<typeof setTimeout> } | undefined

/**
 * Archives a Thread from the list as the person swipes it away: gone from the list at once, with one "Archived · Undo"
 * for five seconds. Asked of its owner only then (or at once, if the page is put away or another is archived), so an
 * Undo never has to bring anything back; a refusal brings the row back and says why.
 */
export function archiveWithUndo(client: WebClient, thread: WebThread): void {
  pending?.commit()
  hide(thread.id, true)
  let settled = false
  const commit = () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    document.removeEventListener("visibilitychange", whenHidden)
    if (pending?.thread.id === thread.id) pending = undefined
    toast.dismiss(UNDO_TOAST)
    void ask(client, thread)
  }
  const undo = () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    document.removeEventListener("visibilitychange", whenHidden)
    if (pending?.thread.id === thread.id) pending = undefined
    toast.dismiss(UNDO_TOAST)
    hide(thread.id, false)
  }
  // A page put away may never run its timer again (iOS freezes it): what was swiped away is asked for now.
  const whenHidden = () => {
    if (document.visibilityState === "hidden") commit()
  }
  const timer = setTimeout(commit, UNDO_MS)
  document.addEventListener("visibilitychange", whenHidden)
  pending = { thread, commit, timer }
  // It leaves when the five seconds are up (`commit` dismisses it); the toast's own time is only the longest it could.
  toast("Archived", { id: UNDO_TOAST, description: thread.title, action: { label: "Undo", onClick: undo }, duration: ACTION_TOAST_MS })
}

/** Asks the Thread's owner to archive it; a refusal or a failure puts the row back and says why. */
async function ask(client: WebClient, thread: WebThread, anyway = false): Promise<void> {
  try {
    const outcome = await archiveThread(client, thread, { anyway })
    if (outcome.kind === "refused") {
      hide(thread.id, false)
      if (outcome.anyway) toast.error("Not archived", { description: outcome.reason, action: { label: "Archive anyway", onClick: () => void retry(client, thread) }, duration: ACTION_TOAST_MS })
      else toast.error("Not archived", { description: outcome.reason })
      return
    }
    // Hidden until the list drops it, so it doesn't flash back between its owner's word and the list's.
    const gone = () => !client.list.rows().some((row) => row.thread === thread.id)
    const started = Date.now()
    const watch = setInterval(() => {
      if (!gone() && Date.now() - started < GONE_WITHIN_MS) return
      clearInterval(watch)
      hide(thread.id, false)
    }, 500)
  } catch (error) {
    hide(thread.id, false)
    toast.error("Not archived", { description: error instanceof Error ? error.message : String(error) })
  }
}

function retry(client: WebClient, thread: WebThread): Promise<void> {
  hide(thread.id, true)
  return ask(client, thread, true)
}
