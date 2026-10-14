import { createHook, createStore } from "@/state/store"

/**
 * Where the next new Thread runs: on this Mac, or on a cloud machine working
 * in a clone of the project's GitHub repository. Not kept across launches, so
 * no machine is started by a choice someone made days ago and forgot.
 */
export const runPlaceStore = createStore<{ cloud: boolean }>({ cloud: false })
export const useRunPlace = createHook(runPlaceStore)
