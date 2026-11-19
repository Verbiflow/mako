import { z } from "zod"
import { keptFolderRanks, savedFolderRanks, threadFolderKey, type FolderRanks, type RailRanks } from "@/lib/thread-folders"
import { createHook, createStore } from "@/state/store"

/**
 * The rail's held order, kept outside React so the next render can read
 * what the last one decided. `stableThreadRanks` freezes a busy thread's
 * rank; this is where the held values live between renders.
 *
 * A folder's place is when you last worked there (`workedFolderRanks`), and
 * what says so arrives in steps: this Mac's conversations with the boot, the
 * catalog as its scan goes, another device's Sessions when the account lists
 * them. Ranked on what had landed, the rail painted one order and then two
 * more, a different six folders each time. So a window saves each folder's
 * time once what it ranks on has settled (in localStorage, `saveFolderRanks`),
 * and the next one starts from it (`folders`): a folder ranks by the newer of
 * that and what has landed, and within a window's life only rises, so data
 * arriving in steps never moves one down. What's saved follows the work
 * exactly, down as well as up: a folder whose newest Thread was archived or
 * moved away is saved lower, and the next window paints it there.
 */
const KEY = "mako.rail.folders.v1"
/** Each folder's time as an ISO string; a time that doesn't parse is a folder not kept. */
const StoredFolders = z.record(z.string(), z.string().datetime({ offset: true }).catch(""))
/** Folders kept: the rail shows a few dozen; one not seen among this many is long cold. */
const KEPT_FOLDERS = 400

export const railRanksStore = createStore<{
  ranks: RailRanks
  /** Each folder's time as this window has ranked it: the saved one at the start, raised by what lands, never lowered. */
  folders: FolderRanks
  /**
   * The folder the person just made a Thread in or added, and the tab that
   * Thread opened in: while that Thread is unsent and on screen, the rail
   * ranks the folder as worked on `at` and draws the unsent Thread selected
   * there (`AgentThreads`). Nothing of it is saved: a Thread never sent
   * leaves the order as it was. `open`: the folder shows open for this
   * reveal, whatever the person's stored choice, until they fold it.
   */
  reveal: { key: string; tab: string | null; at: number; open: boolean } | null
}>({ ranks: {}, folders: readFolders(), reveal: null })

export const useRailRanks = createHook(railRanksStore)

function readFolders(): FolderRanks {
  try {
    const parsed = StoredFolders.safeParse(JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "{}"))
    return parsed.success ? Object.fromEntries(Object.entries(parsed.data).filter(([, at]) => at !== "")) : {}
  } catch {
    // Unparseable JSON: start from what lands.
    return {}
  }
}

/** What has landed, into this window's ranks: each folder's newer time, the newest `KEPT_FOLDERS`. Never saved. */
export function keepFolderRanks(fresh: FolderRanks): void {
  const held = railRanksStore.get().folders
  const next = keptFolderRanks(held, fresh, KEPT_FOLDERS)
  if (next !== held) railRanksStore.set({ folders: next })
}

/**
 * Save what the rail settled on for the next window (`savedFolderRanks`): each folder `worked` names at its time, and
 * the ones it doesn't name as they were saved, read again here since another window may have saved since.
 */
export function saveFolderRanks(worked: FolderRanks): void {
  const saved = readFolders()
  const next = savedFolderRanks(saved, worked, KEPT_FOLDERS)
  if (next === saved) return
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(next))
  } catch {
    // Storage full or unavailable: the rail still holds the order for this window's life.
  }
}

/**
 * The person made a Thread in `folder` or added it: the rail reveals it
 * where they're looking, open and ranked as worked on now while that Thread
 * is unsent there. Its first message, a Session's work there, is what moves
 * the folder for good.
 */
export function revealFolder(folder: string, tab: string | null, at = Date.now()): void {
  const key = threadFolderKey({ cwd: folder })
  if (!key) return
  railRanksStore.set({ reveal: { key, tab, at, open: true } })
}

/** The person folded the revealed folder: their own choice holds again. */
export function releaseRevealedFolder(key: string): void {
  const { reveal } = railRanksStore.get()
  if (reveal?.key === key && reveal.open) railRanksStore.set({ reveal: { ...reveal, open: false } })
}
