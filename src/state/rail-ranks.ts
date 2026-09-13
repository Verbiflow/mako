import type { FolderRanks, RailRanks } from "@/lib/thread-folders"
import { createStore } from "@/state/store"

/**
 * The rail's held order, kept outside React so the next render can read
 * what the last one decided. `stableThreadRanks` freezes a busy thread's
 * rank and `stableFolderRanks` holds every folder's; this is where the held
 * values live between renders.
 */
export const railRanksStore = createStore<{
  ranks: RailRanks
  folderRanks: FolderRanks
}>({ ranks: {}, folderRanks: {} })
