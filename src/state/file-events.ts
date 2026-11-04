import type { FileEventsService } from "@mako/host/contracts/file-events-service"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

export interface FileEventsState {
  /** fseventsd as the host reads it; null until the first answer, or from a host without the reading. */
  service: FileEventsService | null
  /** The degradation the person said "Not now" to, by when it began: a new one is said again. */
  dismissed: number | null
  /** The restart's outcome the person has read. */
  seenRestart: number | null
  error: string | null
}

export const fileEventsStore = createStore<FileEventsState>({ service: null, dismissed: null, seenRestart: null, error: null })
export const useFileEvents = createHook(fileEventsStore)

/** The host's reading, at boot and whenever it changes (`file-events-service`). */
export function applyFileEvents(service: FileEventsService): void {
  fileEventsStore.set({ service })
}

export async function loadFileEvents(): Promise<void> {
  if (!hasBridge()) return
  applyFileEvents(await getMako().fileEventsService())
}

export const fileEvents = {
  /** Asks for the password, saves the evidence, restarts fseventsd and says before and after; the host's events say each step. */
  async restart(): Promise<void> {
    fileEventsStore.set({ error: null })
    try {
      applyFileEvents(await getMako().fileEventsRestart())
    } catch (error) {
      fileEventsStore.set({ error: error instanceof Error ? error.message : String(error) })
    }
  },
  dismiss(): void {
    const service = fileEventsStore.get().service
    fileEventsStore.set({ dismissed: service?.degraded?.since ?? null, seenRestart: service?.restart?.at ?? null, error: null })
  },
}
