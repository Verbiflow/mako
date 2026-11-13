import { useSyncExternalStore } from "react"
import { withPatience } from "@/lib/code-patience"

/**
 * A chunk of the app the list paints without, read once: its module as soon as it has arrived, and until then nothing.
 * Read without suspending, so a screen whose code is already here draws in the frame it's asked for: a Suspense
 * boundary holds a fallback it showed for 300 ms before revealing what replaced it, which `React.lazy` asks of every
 * first render, even of code already here.
 */
export function chunk<Module>(load: () => Promise<Module>) {
  let module: Module | undefined
  let reading: Promise<Module> | undefined
  /** Its last read failed and none has been asked since: a screen waiting on it says so (`CodeUnavailable`). */
  let failed = false
  const listeners = new Set<() => void>()
  const told = () => {
    for (const listener of listeners) listener()
  }
  const read = (): Promise<Module> => {
    // `failed` stands until a read succeeds: a screen saying so keeps saying it while it tries again. A read that
    // arrives after its patience ran out still lands, and the screen draws then.
    reading ??= withPatience(
      load().then((loaded) => {
        module = loaded
        failed = false
        told()
        return loaded
      }),
      "This code"
    )
    // Not here (offline before the service worker kept it), or not within its patience: asked again next time.
    reading.catch(() => {
      reading = undefined
      if (module) return
      failed = true
      told()
    })
    return reading
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return { read, use: () => useSyncExternalStore(subscribe, () => module), useFailed: () => useSyncExternalStore(subscribe, () => failed) }
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
