import { useSyncExternalStore } from "react"
import { noteReadStarted, whenSlow } from "@/lib/code-patience"

/**
 * A chunk of the app the list paints without, read once: its module as soon as it has arrived, and until then nothing.
 * Read without suspending, so a screen whose code is already here draws in the frame it's asked for: a Suspense
 * boundary holds a fallback it showed for 300 ms before revealing what replaced it, which `React.lazy` asks of every
 * first render, even of code already here.
 */
export function chunk<Module>(load: () => Promise<Module>) {
  let module: Module | undefined
  let reading: Promise<Module> | undefined
  /** Its last read failed (or is still pending with the browser offline): a screen waiting on it says so (`CodeUnavailable`). */
  let failed = false
  /** Its read is still under way past its patience (`CODE_PATIENCE_MS`): a screen waiting on it says "Still loading…". */
  let slow = false
  const listeners = new Set<() => void>()
  const told = () => {
    for (const listener of listeners) listener()
  }
  const read = (): Promise<Module> => {
    // `failed` stands until a read succeeds: a screen saying so keeps saying it while it tries again. A read still
    // under way past its patience is slow, not failed (offline, it is failed), and draws when it lands.
    if (reading) return reading
    noteReadStarted()
    const started = load().then((loaded) => {
      module = loaded
      failed = false
      slow = false
      told()
      return loaded
    })
    reading = started
    whenSlow(started, (offline) => {
      // Only the read in hand speaks: one given up for a failure (below) says nothing more, though it still lands.
      if (module || reading !== started) return
      failed = offline
      slow = !offline
      // Offline, it's a failure and given up: the next read (Retry, or back online) starts a new load, not this one.
      if (offline) reading = undefined
      told()
    })
    // Not here (offline before the service worker kept it): asked again next time.
    started.catch(() => {
      if (module || reading !== started) return
      reading = undefined
      slow = false
      failed = true
      told()
    })
    return started
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return {
    read,
    use: () => useSyncExternalStore(subscribe, () => module),
    useFailed: () => useSyncExternalStore(subscribe, () => failed),
    useSlow: () => useSyncExternalStore(subscribe, () => slow),
  }
}

/** A Thread's transcript: read as soon as the list has painted, and drawn by its screen in the frame it's opened. */
export const transcriptChunk = chunk(() => import("./live-session"))

/** The Files screen's code (its browser, its file kinds, its reader): read after the list's next screens, or when Files opens. */
export const filesScreenChunk = chunk(() => import("./files-screen"))

/**
 * The desktop's composer, which only a laptop's browser (the desk) draws under a Thread: read as the desk mounts, so it's
 * here before a Thread opens there, and never on a phone or a tablet, whose Thread has the web's own dock.
 */
export const deskComposerChunk = chunk(() => import("@/components/composer/composer"))

/** The roster a phone's Agents sheet draws (the desk's Agents panel): read when the sheet first opens. */
export const agentsPanelChunk = chunk(() => import("@/components/inspector/agents-panel"))
