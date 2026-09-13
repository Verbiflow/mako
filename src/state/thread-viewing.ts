import { getMako, hasBridge } from "@/lib/bridge"
import type {
  BlockAddress,
  Thread,
  ThreadEntry,
  ThreadPage,
  ThreadRef,
} from "@/lib/types"
import type {
  ThreadsState,
  ViewedThread,
  ViewedThreadEntry,
} from "@/state/thread-state"
import { markObserved, markThreadReviewed } from "@/state/thread-status"
import { threadsStore } from "@/state/thread-store"
import { toast } from "sonner"

/** The composer harness to give back when the viewer closes. */
let harnessBeforeViewing: string | null = null
let viewingGeneration = 0

export function leaveViewerForLive(harness: string) {
  viewingGeneration += 1
  harnessBeforeViewing = null
  threadsStore.set({
    viewing: null,
    opening: null,

    run: null,
    composerHarness: harness,
  })
  if (hasBridge()) void getMako().unfollowThread()
}

/**
 * Threads already read this run, so switching back is a paint, not a fetch.
 * Stale-while-revalidate: the cached conversation shows instantly and the
 * fresh read replaces it the moment it lands. Bounded; oldest falls out.
 */
const threadCache = new Map<string, ViewedThread>()
const THREAD_CACHE_MAX = 4
const THREAD_CACHE_BYTES = 24 * 1024 * 1024

/** The most host pages one request for earlier history reads before it shows what it has. */
const EARLIER_PAGES_PER_LOAD = 4

const entryBytes = new WeakMap<ViewedThreadEntry, number>()
function estimatedThreadBytes(thread: ViewedThread): number {
  let bytes = 0
  for (const entry of thread.entries) {
    let size = entryBytes.get(entry)
    if (size === undefined) {
      size = JSON.stringify(entry).length * 2 + 256
      entryBytes.set(entry, size)
    }
    bytes += size
  }
  return bytes
}

export function viewedThread(thread: Thread): ViewedThread {
  return {
    ...thread,
    pageStart: 0,
    totalEntries: thread.entries.length,
    hasEarlier: false,
  }
}

function viewedPage(page: ThreadPage): ViewedThread {
  return {
    ref: page.ref,
    checkpoint: page.checkpoint,
    entries: page.entries,
    pageStart: page.start,
    totalEntries: page.total,
    hasEarlier: page.hasEarlier,
  }
}

export function rememberThread(thread: ViewedThread) {
  threadCache.delete(thread.ref.path)
  threadCache.set(thread.ref.path, thread)
  let bytes = 0
  for (const cached of threadCache.values()) {
    bytes += estimatedThreadBytes(cached)
  }
  while (
    threadCache.size > 1 &&
    (threadCache.size > THREAD_CACHE_MAX || bytes > THREAD_CACHE_BYTES)
  ) {
    const oldest = threadCache.keys().next().value
    if (!oldest) break
    const removed = threadCache.get(oldest)
    threadCache.delete(oldest)
    if (removed) bytes -= estimatedThreadBytes(removed)
  }
}

export function isOptimisticEcho(entry: ViewedThreadEntry): boolean {
  return entry.kind === "user" && entry.echo === true
}

/** Entries appended — by whatever app is writing — to the viewed thread. */
export function applyThreadEntries(
  path: string,
  entries: ThreadEntry[],
  replace?: boolean,
  replaceFrom?: number
) {
  markObserved(path)
  const { viewing } = threadsStore.get()
  if (!viewing || viewing.ref.path !== path) return
  // The real turn arriving retires its optimistic echo: the reply was
  // painted the instant it was sent, and the file tail is the truth that
  // replaces it rather than doubling it.
  const arrivedUserTexts = new Set(
    entries.filter((entry) => entry.kind === "user").map((entry) => entry.text)
  )
  const absoluteReplaceFrom = replaceFrom ?? 0
  const localReplaceFrom = Math.max(0, absoluteReplaceFrom - viewing.pageStart)
  const incoming =
    replace && absoluteReplaceFrom < viewing.pageStart
      ? entries.slice(viewing.pageStart - absoluteReplaceFrom)
      : entries
  const base = replace
    ? viewing.entries.slice(0, localReplaceFrom)
    : viewing.entries.filter(
        (entry) =>
          !isOptimisticEcho(entry) ||
          !(entry.kind === "user" && arrivedUserTexts.has(entry.text))
      )
  const next: ViewedThread = {
    ...viewing,
    entries: [...base, ...incoming],
    totalEntries: replace
      ? viewing.pageStart + base.length + incoming.length
      : viewing.totalEntries + incoming.length,
  }
  if (replace) {
    next.streamRevision = (viewing.streamRevision ?? 0) + 1
    next.streamReplaceFrom = localReplaceFrom
  }
  threadsStore.set({ viewing: next })
  rememberThread(next)
}

/** Full blocks in flight, so a row opened twice asks once. */
const blockLoads = new Map<string, Promise<void>>()

/**
 * Fetch the rest of a tool output a viewer page trimmed and put the whole
 * block back into the viewed entry. Pages carry the head of each tool
 * output because a row is collapsed until opened; the swap re-projects only
 * the exchange that holds the entry.
 */
export function loadThreadBlock(path: string, at: BlockAddress): Promise<void> {
  const key = `${path}\u0000${at.entry}\u0000${at.block}`
  const inFlight = blockLoads.get(key)
  if (inFlight) return inFlight
  if (!hasBridge()) return Promise.resolve()
  const load = getMako()
    .threadBlock(path, at)
    .then((block) => {
      if (!block) return
      const { viewing } = threadsStore.get()
      if (!viewing || viewing.ref.path !== path) return
      const local = at.entry - viewing.pageStart
      const entry = viewing.entries[local]
      if (entry?.kind !== "assistant" || !entry.blocks[at.block]) return
      const blocks = entry.blocks.slice()
      blocks[at.block] = block
      const entries = viewing.entries.slice()
      entries[local] = { ...entry, blocks }
      const next: ViewedThread = {
        ...viewing,
        entries,
        streamRevision: (viewing.streamRevision ?? 0) + 1,
        streamReplaceFrom: local,
      }
      threadsStore.set({ viewing: next })
      rememberThread(next)
    })
    .catch((error) => {
      toast.error(
        `Could not read the rest of this tool output. ${error instanceof Error ? error.message : String(error)}`
      )
    })
    .finally(() => {
      blockLoads.delete(key)
    })
  blockLoads.set(key, load)
  return load
}

export const threadViewingActions = {
  /** Open a foreign session read-only, translated to the canonical shape. */
  async view(ref: ThreadRef, mode: "conversation" | "native" = "conversation") {
    if (!hasBridge()) return
    const { acp, acpStore, activeAcp } = await import("@/state/acp")
    const activated = mode === "conversation" && acp.activateThread(ref)
    if (!activated) acp.deactivate()
    const liveHarness = activated
      ? (activeAcp(acpStore.get())?.harness ?? ref.harness)
      : ref.harness
    if (activated) {
      leaveViewerForLive(liveHarness)
      return
    }
    if (harnessBeforeViewing === null)
      harnessBeforeViewing = threadsStore.get().composerHarness
    threadsStore.set({ composerHarness: liveHarness })
    const generation = ++viewingGeneration
    markThreadReviewed(ref.path)
    const cached = threadCache.get(ref.path)
    if (cached) {
      // Instant: the last read paints now, the fresh one lands underneath.
      if (harnessBeforeViewing === null) {
        harnessBeforeViewing = threadsStore.get().composerHarness
      }
      threadsStore.set({
        viewing: cached,
        opening: { kind: "loading", ref },

        run: null,
        composerHarness: liveHarness,
      })
      void getMako()
        .threadRun(ref.path)
        .then((run) => {
          if (
            generation === viewingGeneration &&
            threadsStore.get().viewing?.ref.path === ref.path
          )
            threadsStore.set({ run })
        })
        .catch(() => {})
      // One follow, registered only after the fresh read, from the fresh
      // byte offset. Following from the cached (stale) offset once replayed
      // the overlap into the viewer as duplicates.
      void getMako()
        .pageThread(ref.path)
        .then((fresh) => {
          if (generation !== viewingGeneration) return
          if (!fresh) throw new Error("This session could not be read")
          const replaced: ViewedThread = {
            ...viewedPage(fresh),
            streamRevision: (cached.streamRevision ?? 0) + 1,
            streamReplaceFrom: 0,
          }
          rememberThread(replaced)
          if (threadsStore.get().viewing?.ref.path === ref.path) {
            threadsStore.set({
              viewing: replaced,
              opening: null,
            })
            void getMako().followThread(
              ref.path,
              replaced.checkpoint ?? replaced.ref.bytes ?? 0
            )
          }
        })
        .catch((error) => {
          if (
            generation !== viewingGeneration ||
            threadsStore.get().viewing?.ref.path !== ref.path
          )
            return
          threadsStore.set({
            opening: {
              kind: "failed",
              ref,
              error: error instanceof Error ? error.message : String(error),
            },
          })
          toast.error(
            `Could not refresh this conversation. Showing saved messages. ${error instanceof Error ? error.message : String(error)}`
          )
        })
      return
    }
    threadsStore.set({
      viewing: null,
      opening: { kind: "loading", ref },

      run: null,
    })
    try {
      const [page, run] = await Promise.all([
        getMako().pageThread(ref.path),
        getMako()
          .threadRun(ref.path)
          .catch(() => null),
      ])
      if (generation !== viewingGeneration) return
      if (!page) throw new Error("This session could not be read")
      const thread = viewedPage(page)
      rememberThread(thread)
      // The composer adopts this conversation: its agent picker shows the
      // harness that owns the session, and switching it moves the
      // conversation on the next send. No separate "move" ceremony.
      if (harnessBeforeViewing === null) {
        harnessBeforeViewing = threadsStore.get().composerHarness
      }
      threadsStore.set({
        viewing: thread,
        opening: null,

        run,
        composerHarness: liveHarness,
      })
      // Live from here: the agent writing this session — in whatever app —
      // keeps appending, and those entries belong on screen.
      void getMako().followThread(
        ref.path,
        thread.checkpoint ?? thread.ref.bytes ?? 0
      )
    } catch (error) {
      if (generation !== viewingGeneration) return
      threadsStore.set({
        opening: {
          kind: "failed",
          ref,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  /**
   * Prepend earlier history. The host pages by entry, and a tool-heavy turn
   * can fill a whole page with calls and results, so one load keeps paging
   * until it has brought at least one earlier prompt into view — bounded, so
   * a session that is nothing but tool output still arrives in pieces.
   */
  async loadEarlier() {
    const viewing = threadsStore.get().viewing
    if (
      !viewing ||
      !viewing.hasEarlier ||
      viewing.loadingEarlier ||
      !hasBridge()
    )
      return
    threadsStore.set({ viewing: { ...viewing, loadingEarlier: true } })
    try {
      const earlier: ThreadEntry[] = []
      let page: ThreadPage | null = null
      let before = viewing.pageStart
      for (let pages = 0; pages < EARLIER_PAGES_PER_LOAD; pages += 1) {
        const fetched: ThreadPage | null = await getMako().pageThread(
          viewing.ref.path,
          before
        )
        if (!fetched) break
        page = fetched
        earlier.unshift(...fetched.entries)
        before = fetched.start
        if (
          !fetched.hasEarlier ||
          fetched.entries.some((entry) => entry.kind === "user")
        )
          break
      }
      const current = threadsStore.get().viewing
      if (!current || current.ref.path !== viewing.ref.path) return
      if (!page) {
        threadsStore.set({ viewing: { ...current, loadingEarlier: false } })
        return
      }
      const next: ViewedThread = {
        ...current,
        ref: page.ref,
        entries: [...earlier, ...current.entries],
        pageStart: page.start,
        totalEntries: page.total,
        hasEarlier: page.hasEarlier,
        loadingEarlier: false,
        streamRevision: (current.streamRevision ?? 0) + 1,
        streamReplaceFrom: 0,
      }
      threadsStore.set({ viewing: next })
      rememberThread(next)
    } catch (error) {
      const current = threadsStore.get().viewing
      if (current?.ref.path === viewing.ref.path)
        threadsStore.set({ viewing: { ...current, loadingEarlier: false } })
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  closeViewer() {
    viewingGeneration += 1
    const restore = harnessBeforeViewing
    harnessBeforeViewing = null
    const patch: Partial<ThreadsState> = {
      viewing: null,
      opening: null,

      run: null,
    }
    if (restore !== null) patch.composerHarness = restore
    threadsStore.set(patch)
    if (hasBridge()) void getMako().unfollowThread()
  },
}
