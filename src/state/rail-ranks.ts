import { z } from "zod"
import { keptFolderRanks, threadFolderKey, type FolderRanks, type RailRanks } from "@/lib/thread-folders"
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
 * more, a different six folders each time. So the window keeps each folder's
 * newest time as it last settled (`folders`, in localStorage), and a folder
 * ranks by the newer of that and what has landed: the times only ever grow,
 * so the kept one is never wrong, only possibly behind. A reload paints the
 * order it left, and only new work moves a folder.
 */
const KEY = "mako.rail.folders.v1"
/** Each folder's time as an ISO string; a time that doesn't parse is a folder not kept. */
const StoredFolders = z.record(z.string(), z.string().datetime({ offset: true }).catch(""))
/** Folders kept: the rail shows a few dozen; one not seen among this many is long cold. */
const KEPT_FOLDERS = 400

export const railRanksStore = createStore<{
  ranks: RailRanks
  folders: FolderRanks
  /**
   * The folder the person just made a Thread in or added, and the tab that
   * Thread opened in: the rail opens that folder, scrolls it into view and
   * draws the unsent Thread selected there (`AgentThreads`).
   */
  reveal: { key: string; tab: string | null; at: number } | null
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

/** Keep what the rail settled on: each folder's newer time, the newest `KEPT_FOLDERS`. */
export function keepFolderRanks(fresh: FolderRanks): void {
  const held = railRanksStore.get().folders
  const next = keptFolderRanks(held, fresh, KEPT_FOLDERS)
  if (next === held) return
  railRanksStore.set({ folders: next })
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(next))
  } catch {
    // Storage full or unavailable: the rail still holds the order for this window's life.
  }
}

/**
 * The person made a Thread in `folder` or added it: working there, now, as a
 * prompt sent there is. It ranks by that until a Session there says newer,
 * and the rail reveals it where they're looking.
 */
export function revealFolder(folder: string, tab: string | null, at = Date.now()): void {
  const key = threadFolderKey({ cwd: folder })
  if (!key) return
  keepFolderRanks({ [key]: new Date(at).toISOString() })
  railRanksStore.set({ reveal: { key, tab, at } })
}
