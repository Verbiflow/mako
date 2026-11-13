import { useSyncExternalStore } from "react"

/**
 * A chunk of the app the list paints without, read once: its module as soon as it has arrived, and until then nothing.
 * Read without suspending, so a screen whose code is already here draws in the frame it's asked for: a Suspense
 * boundary holds a fallback it showed for 300 ms before revealing what replaced it, which `React.lazy` asks of every
 * first render, even of code already here.
 */
export function chunk<Module>(load: () => Promise<Module>) {
  let module: Module | undefined
  let reading: Promise<Module> | undefined
  const listeners = new Set<() => void>()
  const read = (): Promise<Module> => {
    reading ??= load().then((loaded) => {
      module = loaded
      for (const listener of listeners) listener()
      return loaded
    })
    // Not here (offline before the service worker kept it): asked again next time.
    reading.catch(() => {
      reading = undefined
    })
    return reading
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return { read, use: () => useSyncExternalStore(subscribe, () => module) }
}

/** A Thread's transcript: read as soon as the list has painted, and drawn by its screen in the frame it's opened. */
export const transcriptChunk = chunk(() => import("./live-session"))

/** The Files screen's code (its browser, its file kinds, its reader): read after the list's next screens, or when Files opens. */
export const filesScreenChunk = chunk(() => import("./files-screen"))
