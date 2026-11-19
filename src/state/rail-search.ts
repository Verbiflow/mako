import { createHook, createStore } from "@/state/store"

/**
 * The rail's search: whether its header is the search box, and what's typed in it. Kept here, apart from the list, so
 * a keystroke draws the box again and nothing else: the list takes what's sought when it next has time to
 * (`AgentThreads`), and typing never waits on a few hundred rows.
 */
export const railSearchStore = createStore({ searching: false, query: "" })
export const useRailSearch = createHook(railSearchStore)

/** Opens or closes the search box; closing clears what was typed. */
export function setRailSearching(searching: boolean): void {
  railSearchStore.set(searching ? { searching } : { searching, query: "" })
}
