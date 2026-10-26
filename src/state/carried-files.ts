import type { CarriedFilesView } from "@mako/host/contracts/cloud-carried-files"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

/**
 * Each project's carried files in Mako Cloud, by the folder they were asked for (`mako:cloud-carried-files`): what its
 * recipe carries, the person's word, and where each file stands. The host keeps the truth; this mirrors its answers,
 * so Settings › Apps and the move's question read the same.
 */
interface CarriedFilesState {
  byFolder: Record<string, CarriedFilesView>
  /** A change asked and not answered yet, by folder: what it is, so its button says so. */
  busy: Record<string, string>
  failed: Record<string, string>
}

export const carriedFilesStore = createStore<CarriedFilesState>({ byFolder: {}, busy: {}, failed: {} })
export const useCarriedFiles = createHook(carriedFilesStore)

function settled(folder: string, view: CarriedFilesView | undefined, failure?: string) {
  carriedFilesStore.set((state) => {
    const busy = { ...state.busy }
    delete busy[folder]
    const failed = { ...state.failed }
    if (failure) failed[folder] = failure
    else delete failed[folder]
    return { byFolder: view ? { ...state.byFolder, [folder]: view } : state.byFolder, busy, failed }
  })
}

/** Reads the project's carried files again; undefined where the host can't keep them. */
export async function readCarriedFiles(folder: string): Promise<CarriedFilesView | undefined> {
  if (!hasBridge()) return undefined
  try {
    const view = await getMako().cloudCarriedFiles(folder)
    settled(folder, view)
    return view
  } catch (error) {
    settled(folder, undefined, error instanceof Error ? error.message : String(error))
    return undefined
  }
}

async function change(folder: string, what: string, work: () => Promise<CarriedFilesView>): Promise<CarriedFilesView | undefined> {
  carriedFilesStore.set((state) => ({ busy: { ...state.busy, [folder]: what } }))
  try {
    const view = await work()
    settled(folder, view)
    return view
  } catch (error) {
    settled(folder, undefined, error instanceof Error ? error.message : String(error))
    return undefined
  }
}

/** The person's word for the project: copy its files to Mako Cloud, or keep them on this Mac (removing any there). */
export function decideCarriedFiles(folder: string, allowed: boolean) {
  return change(folder, allowed ? "copying" : "stopping", () => getMako().cloudCarriedFilesDecide(folder, allowed))
}

/** One file removed from the cloud and kept on this Mac, or copied again. */
export function keepCarriedFile(folder: string, path: string, keep: boolean) {
  return change(folder, `${keep ? "keeping" : "copying"}:${path}`, () => getMako().cloudCarriedFilesKeep(folder, path, keep))
}
