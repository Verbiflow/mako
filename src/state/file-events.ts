import type { FileEventsService } from "@mako/host/contracts/file-events-service"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

export interface FileEventsState {
  /** fseventsd as the host reads it; null until the first answer, or from a host without the reading. */
  service: FileEventsService | null
  error: string | null
}

export const fileEventsStore = createStore<FileEventsState>({ service: null, error: null })
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
  /** "Not now", kept by the host for every window and across restarts: not said again today unless it gets worse. */
  async dismiss(): Promise<void> {
    fileEventsStore.set({ error: null })
    const service = fileEventsStore.get().service
    // Gone at once; the host's answer says what stands.
    if (service) fileEventsStore.set({ service: { ...service, notice: false, ...(service.restart && { restart: { ...service.restart, seen: true } }) } })
    applyFileEvents(await getMako().fileEventsDismiss())
  },
}
