import { useEffect } from "react"
import type { ThreadMarkChange, WorkStatus } from "@mako/host/contracts/thread-marks"
import { createHook, createStore } from "@/state/store"
import type { WebClient } from "./client"
import type { WebThread } from "./threads"

/**
 * A Thread's marks as this browser has asked its owner to set them: its Status and Mark as unread are the owner's to
 * keep (`mako:thread-mark`), and every device hears them on the Thread's rows. Until the rows say what was asked, the
 * list shows it as asked, so a choice shows at once; once they agree, or the ask fails, the rows speak again.
 */
interface AskedMarks {
  /** By Thread: the Status asked for (null: none), and when. */
  status: Readonly<Record<string, { status: WorkStatus | null; at: number }>>
  /** By Thread: asked to read (false) or to read again (true). */
  unread: Readonly<Record<string, boolean>>
}

export const askedMarksStore = createStore<AskedMarks>({ status: {}, unread: {} })
export const useAskedMarks = createHook(askedMarksStore)

/** A Thread's marks as the list shows them: the rows' word, or what this browser asked while they don't say it yet. */
export interface ShownMarks {
  workStatus?: WorkStatus
  workStatusAt?: number
  markedUnread: boolean
}

export function shownMarks(thread: Pick<WebThread, "id" | "workStatus" | "workStatusAt" | "markedUnread">, asked: AskedMarks): ShownMarks {
  const status = asked.status[thread.id]
  const unread = asked.unread[thread.id]
  const shown: ShownMarks = { markedUnread: unread ?? thread.markedUnread === true }
  const workStatus = status ? status.status : thread.workStatus
  if (workStatus) {
    shown.workStatus = workStatus
    shown.workStatusAt = status ? status.at : (thread.workStatusAt ?? 0)
  }
  return shown
}

function forget(thread: string, which: "status" | "unread"): void {
  const asked = askedMarksStore.get()
  askedMarksStore.set({ ...asked, [which]: Object.fromEntries(Object.entries(asked[which]).filter(([id]) => id !== thread)) })
}

/** What was asked and the rows now say is theirs to say again: a change made elsewhere later shows as it is. */
export function settleAskedMarks(threads: readonly WebThread[]): void {
  const asked = askedMarksStore.get()
  if (!Object.keys(asked.status).length && !Object.keys(asked.unread).length) return
  const byId = new Map(threads.map((thread) => [thread.id, thread]))
  const status = Object.fromEntries(Object.entries(asked.status).filter(([id, entry]) => byId.has(id) && (byId.get(id)!.workStatus ?? null) !== entry.status))
  const unread = Object.fromEntries(Object.entries(asked.unread).filter(([id, value]) => byId.has(id) && (byId.get(id)!.markedUnread === true) !== value))
  if (Object.keys(status).length !== Object.keys(asked.status).length || Object.keys(unread).length !== Object.keys(asked.unread).length) askedMarksStore.set({ status, unread })
}

/** Whether the Thread's owner can be asked: its device is heard, and it isn't archived. */
export function canMark(thread: Pick<WebThread, "quietSince" | "archived">): boolean {
  return !thread.quietSince && !thread.archived
}

/**
 * Asks the Thread's owner to set its marks, through the Session the list opens it on (`mako:thread-mark`), showing it as
 * asked meanwhile. A refusal puts the rows' word back and is thrown.
 */
export async function markOnOwner(client: WebClient, thread: WebThread, change: ThreadMarkChange): Promise<void> {
  const asked = askedMarksStore.get()
  askedMarksStore.set({
    status: change.status !== undefined ? { ...asked.status, [thread.id]: { status: change.status, at: Date.now() } } : asked.status,
    unread: change.unread !== undefined ? { ...asked.unread, [thread.id]: change.unread } : asked.unread,
  })
  try {
    const conversations = await client.conversations()
    await conversations.call(thread.sessions[0]!.row.conversation, "mako:thread-mark", [crypto.randomUUID(), thread.id, change])
  } catch (error) {
    if (change.status !== undefined) forget(thread.id, "status")
    if (change.unread !== undefined) forget(thread.id, "unread")
    throw error
  }
}

/**
 * The Thread on screen is read on every device: one the person marked to read again (here or elsewhere) has its owner
 * drop the mark, once, as it opens. Best effort: a Mac that's off keeps the mark until it's next opened while on.
 */
export function useReadOnOwnerWhenOpened(client: WebClient, thread: WebThread | undefined): void {
  const marked = useAskedMarks((state) => (thread ? shownMarks(thread, state).markedUnread : false))
  useEffect(() => {
    if (!thread) return
    // Its rows no longer say it: a later mark, from anywhere, is read as it opens again.
    if (!thread.markedUnread) triedRead.delete(thread.id)
    if (!marked || !canMark(thread) || triedRead.has(thread.id)) return
    triedRead.add(thread.id)
    markOnOwner(client, thread, { unread: false }).catch((error: Error) => console.warn("[mako] the Thread's Mark as unread wasn't cleared on its owner", error.message))
  }, [client, thread, marked])
}

/** The Threads whose owner was asked to read them while their rows still say the mark: asked once each. */
const triedRead = new Set<string>()
