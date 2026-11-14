import { useSyncExternalStore } from "react"
import { z } from "zod"
import { createHook, createStore } from "@/state/store"
import { noteReadStarted, whenSlow } from "@/lib/code-patience"

/*
 * Which Changes screen is open, if any: one Session's turn, or every turn of
 * its Thread. It opens over the Thread with an entry of its own in the
 * browser's history, so Back (the system's, an edge swipe, the screen's own)
 * closes it and lands on the Thread as it was.
 */

export type ReviewScope = { kind: "turn"; requestId: string } | { kind: "thread" }

export interface ReviewOpen {
  conversation: string
  scope: ReviewScope
}

export const reviewOpenStore = createStore<{ open: ReviewOpen | null }>({ open: null })
export const useReviewOpen = createHook(reviewOpenStore)

/**
 * A history entry as the app writes it: how many of its own steps lie behind it (`route.ts`), and whether it's
 * Changes' own. Anything else on an entry is kept as it was.
 */
const EntrySchema = z.object({ depth: z.number().int().nonnegative().catch(0), makoReview: z.literal(true).optional().catch(undefined) }).loose()
type Entry = z.infer<typeof EntrySchema>

function entryNow(): Entry {
  return EntrySchema.safeParse(history.state).data ?? { depth: 0 }
}

/** Opens Changes over the Thread, or moves the open one to another scope without another history entry. */
export function openReview(open: ReviewOpen): void {
  const was = reviewOpenStore.get().open
  reviewOpenStore.set({ open })
  const entry = entryNow()
  if (was || entry.makoReview) return
  // One step of the app's own, as `useRoute` counts them: Back goes back to the Thread.
  history.pushState({ ...entry, depth: entry.depth + 1, makoReview: true }, "")
}

/** Closes Changes by going back past its entry, so the browser's own Back and this agree. */
export function closeReview(): void {
  if (entryNow().makoReview) history.back()
  else reviewOpenStore.set({ open: null })
}

/** Follows the history: an entry without the mark closes the screen; started once, with the app. */
export function followReviewHistory(): () => void {
  const popped = () => {
    if (!entryNow().makoReview && reviewOpenStore.get().open) reviewOpenStore.set({ open: null })
  }
  window.addEventListener("popstate", popped)
  // A reload lands on Changes' entry with nothing open: it's the Thread's again.
  const entry = entryNow()
  if (entry.makoReview && !reviewOpenStore.get().open) {
    const thread: Entry = { ...entry }
    delete thread.makoReview
    history.replaceState(thread, "")
  }
  return () => window.removeEventListener("popstate", popped)
}

/** The app went somewhere else on its own (another Thread from the rail): Changes was the last Thread's. */
export function leftReview(): void {
  if (reviewOpenStore.get().open) reviewOpenStore.set({ open: null })
}

/** One kind of Changes' code, its own chunk: read once, ahead of the first tap where it can be, so a tap finds it here. */
export interface ReviewCode<T> {
  read(): Promise<void>
  useCode(): T | undefined
  /** Its last read failed and none has been asked since: Changes says so (`CodeUnavailable`). */
  useFailed(): boolean
  /** Its read is still under way past its patience: Changes says "Still loading…". */
  useSlow(): boolean
}

function lazyCode<T>(load: () => Promise<T>): ReviewCode<T> {
  const codeStore = createStore<{ code: T | undefined; reading: Promise<void> | undefined; failed: boolean; slow: boolean }>({ code: undefined, reading: undefined, failed: false, slow: false })
  return {
    read() {
      const { reading } = codeStore.get()
      if (reading) return reading
      noteReadStarted()
      // As every chunk's read (`chunk`): slow past its patience (failed if offline), and drawn whenever it lands.
      const read = load().then((code) => codeStore.set({ code, failed: false, slow: false }))
      // Only the read in hand speaks: one given up for a failure (below) says nothing more, though it still lands.
      const current = () => codeStore.get().code === undefined && codeStore.get().reading === read
      const stopWatching = whenSlow(read, (offline) => {
        if (!current()) return
        // Offline, it's a failure and given up: the next read (Retry, or back online) starts a new load, and this one's
        // watch ends with it.
        if (offline) {
          codeStore.set({ failed: true, slow: false, reading: undefined })
          stopWatching()
        } else codeStore.set({ failed: false, slow: true })
      })
      // Not here (offline before the service worker kept it): asked again next time. `failed` stands until a read
      // succeeds, so Changes keeps saying so while it tries again.
      read.catch(() => {
        if (current()) codeStore.set({ reading: undefined, failed: true, slow: false })
      })
      codeStore.set({ reading: read })
      return read
    },
    useCode() {
      return useSyncExternalStore(codeStore.subscribe, () => codeStore.get().code)
    },
    useFailed() {
      return useSyncExternalStore(codeStore.subscribe, () => codeStore.get().failed)
    },
    useSlow() {
      return useSyncExternalStore(codeStore.subscribe, () => codeStore.get().slow)
    },
  }
}

/** The touch screen's (a phone's, a tablet's) and a laptop's desk's: the desktop's own review, which a phone never loads. */
export const touchReviewCode = lazyCode(() => import("./review"))
export const deskReviewCode = lazyCode(() => import("./desk-review"))
