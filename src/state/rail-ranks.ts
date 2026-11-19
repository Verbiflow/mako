import type { RailRanks } from "@/lib/thread-folders"
import { createStore } from "@/state/store"

/**
 * The rail's held order, kept outside React so the next render can read
 * what the last one decided. `stableThreadRanks` freezes a busy thread's
 * rank; this is where the held values live between renders. A folder's
 * place holds nothing: it's when you last worked there (`workedFolderRanks`).
 */
export const railRanksStore = createStore<{
  ranks: RailRanks
}>({ ranks: {} })
