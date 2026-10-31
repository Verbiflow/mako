import type { LiveSummary } from "@mako/host/contracts/live-conversations"
import { acpStore } from "@/state/acp"
import { listLive, unlistLive } from "@/state/live-recovery"
import { threadsStore } from "@/state/thread-store"
import { accountListStore, type AccountListState } from "./account-list"
import { archivingStore } from "./archive-thread"
import { webHarnessDescriptors } from "./descriptors"
import { sessionOf } from "./threads"

/*
 * The desk's rail is the desktop's own (`AgentThreads`), which lists another
 * device's Sessions the way a Mac's window does: each one a conversation the
 * window holds unopened, from the account's list (`listedSummary`), folded
 * into its Thread by its Thread ID and grouped by its folder. A Mac's host
 * says each change of that list to its windows (`live-listed`,
 * `live-unlisted`); in a browser the account's list is right here, so this
 * says the same changes to the browser's own window.
 */

/** What was last listed of each conversation, by its summary's text: a summary is said again only once it changed. */
export type Listed = ReadonlyMap<string, { text: string; quietSince: number | undefined }>

export interface ListingChanges {
  listed: LiveSummary[]
  gone: string[]
  /** What is listed after these changes. */
  now: Listed
}

/**
 * The changes to say to the window, as a Mac's host says them (`CloudConversations`): a conversation new to the list
 * or changed in it is listed, one no longer listed is unlisted. The one open is read from its owner's own stream, so
 * the list doesn't overwrite it, unless its device went quiet, which the stream can't say; it is listed again as it
 * stands once the person leaves it.
 */
export function listingChanges(summaries: readonly LiveSummary[], before: Listed, open: string | null): ListingChanges {
  const now = new Map<string, { text: string; quietSince: number | undefined }>()
  const listed: LiveSummary[] = []
  for (const summary of summaries) {
    const id = summary.session.id
    const was = before.get(id)
    if (id === open && was && was.quietSince === summary.quietSince) {
      now.set(id, was)
      continue
    }
    const text = JSON.stringify(summary)
    now.set(id, { text, quietSince: summary.quietSince })
    if (was?.text !== text) listed.push(summary)
  }
  const gone = [...before.keys()].filter((id) => !now.has(id))
  return { listed, gone, now }
}

/**
 * The account's Sessions as a window lists them: one summary per listed row, archived cloud Threads apart, and the
 * Threads being archived from here (`archivingStore`) left out while that may still be undone.
 */
export function listedSummaries(list: Pick<AccountListState, "rows" | "devices" | "quiet" | "waiting">, archiving: ReadonlySet<string> = new Set()): LiveSummary[] {
  return list.rows.flatMap((row) => (archiving.has(row.thread) ? [] : [sessionOf(row, list).summary]))
}

/**
 * Says the account's list to the window while the desk shows: every listed Session in the rail, kept current as the
 * list and the open conversation change. Returns how to stop.
 */
export function followListing(): () => void {
  let before: Listed = new Map()
  let open = acpStore.get().activeKey
  const say = () => {
    const list = accountListStore.get()
    if (list.phase === "starting" || list.phase === "signed-out") return
    if (!threadsStore.get().loaded) threadsStore.set({ loaded: true, descriptors: webHarnessDescriptors() })
    const changes = listingChanges(listedSummaries(list, archivingStore.get().hidden), before, open)
    before = changes.now
    if (changes.listed.length) listLive(changes.listed)
    if (changes.gone.length) unlistLive(changes.gone)
  }
  say()
  const stopList = accountListStore.subscribe(say)
  const stopArchiving = archivingStore.subscribe(say)
  const stopOpen = acpStore.subscribe(() => {
    const next = acpStore.get().activeKey
    if (next === open) return
    open = next
    say()
  })
  return () => {
    stopList()
    stopArchiving()
    stopOpen()
  }
}
