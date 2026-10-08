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
import { openThreadTab } from "@/state/thread-tabs"
import { toast } from "sonner"
import { createHook, createStore } from "@/state/store"
import { nativeReadingSource, transcriptReaders } from "@/state/transcript-reading"
import { historyTurns, releaseEntries } from "@/state/transcript-residency"
import { threadToMessages } from "@/lib/foreign-thread"
import { toExchanges } from "@/lib/exchanges"
import { foldTools } from "@/lib/tools"
import { nativeHistoryRevision } from "../../electron/contracts/native-history"

/** The composer harness to give back when the viewer closes. */
let harnessBeforeViewing: string | null = null
let viewingGeneration = 0
/** The transcript the viewer last handed to the live conversation that owns it. */
let handedOff: string | null = null

/** Whether the live panel takes over a transcript the viewer was just showing, so it continues in place. */
export function viewerHandedOff(path: string | undefined): boolean {
  return path !== undefined && path === handedOff
}

export function leaveViewerForLive(harness: string) {
  viewingGeneration += 1
  harnessBeforeViewing = null
  handedOff = threadsStore.get().viewing?.ref.path ?? null
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
const threadCacheStore = createStore({ views: new Map<string, ViewedThread>() })
export const useRememberedThreads = createHook(threadCacheStore)
export const subscribeThreadCache = threadCacheStore.subscribe
const THREAD_CACHE_MAX = 16
const THREAD_CACHE_BYTES = 48 * 1024 * 1024

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
  if (threadCache.get(thread.ref.path) === thread) return
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
    const protectedPaths = transcriptReaders.heldSources()
    const oldest = [...threadCache.keys()].find(path => path !== thread.ref.path && !protectedPaths.has(nativeReadingSource(path)))
    if (!oldest) break
    const removed = threadCache.get(oldest)
    threadCache.delete(oldest)
    if (removed) bytes -= estimatedThreadBytes(removed)
  }
  threadCacheStore.set({ views: new Map(threadCache) })
  if (threadsStore.get().viewing?.ref.path === thread.ref.path && threadsStore.get().viewing !== thread)
    threadsStore.set({ viewing: thread })
}

/** Every native pane reads this shared cache view; eviction cannot leave a
 * second full copy alive in a pane's component state. */
export function sweepThreadResidency(target = THREAD_CACHE_BYTES): void {
  let bytes = [...threadCache.values()].reduce((sum, thread) => sum + estimatedThreadBytes(thread), 0)
  if (bytes <= target) return
  for (const [path, thread] of threadCache) {
    if (bytes <= target || thread.preview || thread.loadingEarlier || threadsStore.get().working[path] ||
        (threadsStore.get().viewing?.ref.path === path && threadsStore.get().run?.status === "running")) continue
    const source = nativeReadingSource(path)
    const protectedTurns = transcriptReaders.protected(source)
    if (!protectedTurns) continue
    const releasedIds = new Set(thread.releasedTurns?.map(turn => turn.id))
    const exchanges = toExchanges(foldTools(threadToMessages(thread.entries, thread.pageStart, thread.ref.harness)))
    const turns = historyTurns(exchanges, [], 0, thread.entries, thread.pageStart)
      .filter(turn => !releasedIds.has(turn.id) && !protectedTurns.has(turn.id) && !transcriptReaders.warm(source, turn.id) &&
        !thread.entries.slice(turn.base.start - thread.pageStart, turn.base.end - thread.pageStart).some(isOptimisticEcho))
      .sort((a, b) => transcriptReaders.usedAt(source, a.id) - transcriptReaders.usedAt(source, b.id))
    const released = []
    for (const turn of turns) {
      if (bytes <= target) break
      const part = thread.entries.slice(turn.base.start - thread.pageStart, turn.base.end - thread.pageStart)
      const next = releaseEntries(part, turn.base.start, [turn])
      bytes -= estimatedThreadBytes({ ...thread, entries: part }) - estimatedThreadBytes({ ...thread, entries: next })
      released.push(turn)
    }
    if (!released.length) continue
    const entries = releaseEntries(thread.entries, thread.pageStart, released)
    const next = { ...thread, entries, releasedTurns: [...(thread.releasedTurns ?? []), ...released],
      streamRevision: (thread.streamRevision ?? 0) + 1, streamReplaceFrom: 0 }
    if (threadsStore.get().viewing?.ref.path === path) threadsStore.set({ viewing: next })
    rememberThread(next)
  }
}

const turnReads = new Map<string, Promise<void>>()
export function loadReleasedThreadTurn(path: string, id: string): Promise<void> {
  const key = JSON.stringify([path, id])
  const held = turnReads.get(key)
  if (held) return held
  const work = (async () => {
    const thread = threadCache.get(path)
    const turn = thread?.releasedTurns?.find(item => item.id === id)
    if (!thread || !turn || !hasBridge()) return
    const release = transcriptReaders.protect(nativeReadingSource(path), id)
    try {
      let before = turn.base.end
      const entries: ThreadEntry[] = []
      while (before > turn.base.start) {
        const page = await getMako().pageThread(path, before)
        if (!page || page.start >= before || page.start + page.entries.length !== before ||
            nativeHistoryRevision(page) !== nativeHistoryRevision({ ...thread, total: thread.totalEntries })) {
          if (threadsStore.get().viewing?.ref.path === path) await recoverThreadReader(path)
          else {
            const fresh = await readThreadForPane(path)
            if (!fresh) throw new Error("This conversation could not refresh.")
          }
          return
        }
        entries.unshift(...page.entries.slice(Math.max(0, turn.base.start - page.start)))
        before = page.start
      }
      const current = threadCache.get(path)
      if (!current || current.releasedTurns?.find(item => item.id === id) !== turn ||
          nativeHistoryRevision({ ...current, total: current.totalEntries }) !==
          nativeHistoryRevision({ ...thread, total: thread.totalEntries })) return
      const restored = current.entries.slice()
      restored.splice(turn.base.start - current.pageStart, entries.length, ...entries)
      const next = { ...current, entries: restored, releasedTurns: current.releasedTurns.filter(item => item !== turn),
        streamRevision: (current.streamRevision ?? 0) + 1, streamReplaceFrom: turn.base.start - current.pageStart }
      if (threadsStore.get().viewing?.ref.path === path) threadsStore.set({ viewing: next })
      rememberThread(next)
    } finally { release() }
  })().finally(() => turnReads.delete(key))
  turnReads.set(key, work)
  return work
}

/** The last read of a transcript, if this window still holds it. */
export function rememberedThread(path: string): ViewedThread | undefined {
  return threadCache.get(path)
}

/** A fresh read for a pane without focus, kept for the moment it takes focus. */
export function readThreadForPane(path: string): Promise<ViewedThread | null> {
  if (!hasBridge()) return Promise.resolve(null)
  const pending = windowReads.get(path)
  if (pending) {
    // A record-change notification arriving during a read must be observed
    // by a subsequent capture, even when both panes ask at once.
    pending.again = true
    return pending.promise
  }
  const read = { again: false, promise: Promise.resolve<ViewedThread | null>(null) }
  const release = transcriptReaders.protect(nativeReadingSource(path), "*")
  read.promise = (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      read.again = false
      const held = threadCache.get(path)
      const page = await readThreadWindow(path, held?.pageStart ?? transcriptReaders.rememberedWindow(nativeReadingSource(path))?.base)
      // Streaming, paging, or a range reload published while this capture
      // was in flight. Its bytes are no longer entitled to replace that view.
      if (read.again || threadCache.get(path) !== held) continue
      if (!page) return null
      const arrived = new Set(page.entries.filter(entry => entry.kind === "user").map(entry => entry.text))
      const echoes = held?.entries.filter(entry => isOptimisticEcho(entry) && entry.kind === "user" && !arrived.has(entry.text)) ?? []
      const thread: ViewedThread = { ...viewedPage(page), entries: [...page.entries, ...echoes],
        streamRevision: (held?.streamRevision ?? 0) + 1, streamReplaceFrom: 0 }
      rememberThread(thread)
      return thread
    }
    throw new Error("The conversation kept changing while its history was refreshed. Try opening it again.")
  })().finally(() => {
    release()
    if (windowReads.get(path) === read) windowReads.delete(path)
  })
  windowReads.set(path, read)
  return read.promise
}
const windowReads = new Map<string, { again: boolean; promise: Promise<ViewedThread | null> }>()

/** Refresh the held reading window coherently. A fresh tail alone must not
 * discard the earlier pages a returning or unfocused pane still reads. */
async function readThreadWindow(path: string, from?: number): Promise<ThreadPage | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await getMako().pageThread(path)
    if (!latest || from === undefined || latest.start <= from) return latest
    let first = latest
    const chunks = [latest.entries]
    let changed = false
    while (first.hasEarlier && first.start > from) {
      const earlier = await getMako().pageThread(path, first.start)
      if (!earlier)
        throw new Error("Earlier conversation history could not be read")
      if (nativeHistoryRevision(earlier) !== nativeHistoryRevision(latest)) { changed = true; break }
      if (earlier.start >= first.start || earlier.start + earlier.entries.length !== first.start)
        throw new Error("Earlier conversation history could not be read")
      chunks.push(earlier.entries)
      first = earlier
    }
    if (!changed) return { ...latest, entries: chunks.reverse().flat(), start: first.start, hasEarlier: first.hasEarlier }
  }
  throw new Error("The conversation kept changing while its history was refreshed. Try opening it again.")
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
  if (replace && viewing.releasedTurns?.some(turn => (replaceFrom ?? 0) < turn.base.end)) {
    void recoverThreadReader(path)
    return
  }
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
  const held = threadCache.get(path)
  if (!hasBridge() || !held || held.preview)
    return Promise.resolve()
  const original = held.entries[at.entry - held.pageStart]
  const originalBlock = original?.kind === "assistant" ? original.blocks[at.block] : undefined
  if (!originalBlock) return Promise.resolve()
  const release = transcriptReaders.protect(nativeReadingSource(path), "*")
  const load = getMako()
    .threadBlock(path, at)
    .then((block) => {
      if (!block) return
      const viewing = threadCache.get(path)
      if (!viewing || nativeHistoryRevision({ ...viewing, total: viewing.totalEntries }) !==
          nativeHistoryRevision({ ...held, total: held.totalEntries })) return
      const local = at.entry - viewing.pageStart
      const entry = viewing.entries[local]
      if (entry?.kind !== "assistant" || entry.blocks[at.block] !== originalBlock) return
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
      rememberThread(next)
    })
    .catch((error) => {
      toast.error(
        `Could not read the rest of this tool output. ${error instanceof Error ? error.message : String(error)}`
      )
    })
    .finally(() => {
      release()
      blockLoads.delete(key)
    })
  blockLoads.set(key, load)
  return load
}

const liveModules = Promise.all([
  import("@/state/acp"),
  import("@/state/live-recovery"),
]).then(([acpModule, recovery]) => ({ ...acpModule, applyLiveSnapshot: recovery.applyLiveSnapshot }))

/**
 * How long a row another host owns waits for that conversation before its
 * saved transcript is read instead. A warm owner answers well inside it; a
 * cold one still takes over from the transcript when it answers.
 */
const OWNER_PATIENCE_MS = 1_200

/** Show the Mako conversation that owns `ref`; false when none took over. */
async function adoptOwner(ref: ThreadRef, generation: number): Promise<boolean> {
  try {
    const [owner, { acp, acpStore, applyLiveSnapshot }] = await Promise.all([
      getMako().resolveOwner(ref.path),
      liveModules,
    ])
    if (!owner || generation !== viewingGeneration) return false
    applyLiveSnapshot(owner.snapshot, owner.bindingId ?? null)
    if (acpStore.get().activeKey !== owner.snapshot.session.id)
      acp.activate(owner.snapshot.session.id, false)
    openThreadTab(ref.path)
    if (threadsStore.get().viewing || threadsStore.get().opening)
      leaveViewerForLive(owner.provider)
    return true
  } catch (error) {
    if (generation === viewingGeneration)
      toast.error(error instanceof Error ? error.message : String(error))
    return false
  }
}

/** Recover the selected native view from pages, then follow its fresh checkpoint. */
export async function recoverThreadReader(path: string): Promise<void> {
  const viewing = threadsStore.get().viewing
  if (!viewing || viewing.ref.path !== path || !hasBridge()) return
  const generation = ++viewingGeneration
  rememberThread({ ...viewing, loadingEarlier: false })
  const current = () => generation === viewingGeneration && threadsStore.get().viewing?.ref.path === path
  try {
    const next = await readThreadForPane(path)
    if (!current()) return
    if (!next) throw new Error("This session could not be read")
    threadsStore.set({ viewing: next, opening: null })
    await getMako().followThread(path, next.checkpoint ?? next.ref.bytes ?? 0)
  } catch (error) {
    if (!current()) return
    threadsStore.set({ opening: { kind: "failed", ref: viewing.ref, error: error instanceof Error ? error.message : String(error) } })
  }
}

/**
 * Keep showing a session whose record moved. What is on screen stays while
 * the record is read again where it now lives and followed from there.
 */
export function followMovedThread(from: string, to: ThreadRef): void {
  const cached = threadCache.get(from)
  if (cached) {
    threadCache.delete(from)
    rememberThread({ ...cached, ref: to })
  }
  const { viewing, opening } = threadsStore.get()
  if (viewing?.ref.path === from) {
    threadsStore.set({ viewing: { ...viewing, ref: to } })
    if (opening?.ref.path === from) threadsStore.set({ opening: { ...opening, ref: to } })
    void recoverThreadReader(to.path)
  } else if (opening?.ref.path === from) void threadViewingActions.view(to)
}

export const threadViewingActions = {
  /** Open a foreign session read-only, translated to the canonical shape. */
  async view(ref: ThreadRef, mode: "conversation" | "native" = "conversation") {
    if (!hasBridge()) return
    const generation = ++viewingGeneration
    handedOff = null
    const { acp, acpStore, activeAcp } = await liveModules
    if (generation !== viewingGeneration) return
    // A Mako conversation that owns this thread takes over when the host
    // names it. Sending resolves again, so this lookup never decides where
    // a reply goes.
    const adopted = mode === "conversation" ? adoptOwner(ref, generation) : null
    const activated = mode === "conversation" && acp.activateThread(ref)
    if (!activated) acp.deactivate()
    const liveHarness = activated
      ? (activeAcp(acpStore.get())?.harness ?? ref.harness)
      : ref.harness
    openThreadTab(ref.path)
    if (activated) {
      leaveViewerForLive(liveHarness)
      return
    }
    if (harnessBeforeViewing === null)
      harnessBeforeViewing = threadsStore.get().composerHarness
    threadsStore.set({ composerHarness: liveHarness })
    markThreadReviewed(ref.path)
    // A row another host's conversation owns opens straight into it. Read
    // first, its saved transcript painted only to be replaced by the live one.
    if (adopted && ref.ownedElsewhere) {
      threadsStore.set({ viewing: null, opening: { kind: "loading", ref }, run: null })
      const patience = new Promise<"waited">((resolve) => setTimeout(resolve, OWNER_PATIENCE_MS, "waited"))
      const owned = await Promise.race([adopted, patience])
      if (owned === true || generation !== viewingGeneration) return
    }
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
      void readThreadForPane(ref.path)
        .then((fresh) => {
          if (generation !== viewingGeneration) return
          if (!fresh) throw new Error("This session could not be read")
          const replaced = fresh
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
    // A large record's newest exchanges paint from its tail while the full
    // page is read; whichever lands second never overwrites the full page.
    void getMako()
      .previewThread(ref.path)
      .then((preview) => {
        const state = threadsStore.get()
        if (
          !preview ||
          generation !== viewingGeneration ||
          state.viewing ||
          state.opening?.kind !== "loading"
        )
          return
        threadsStore.set({
          viewing: { ...viewedPage(preview), preview: true },
          composerHarness: liveHarness,
        })
      })
      .catch(() => {})
    try {
      const [page, run] = await Promise.all([
        readThreadForPane(ref.path),
        getMako()
          .threadRun(ref.path)
          .catch(() => null),
      ])
      if (generation !== viewingGeneration) return
      if (!page) throw new Error("This session could not be read")
      const thread = page
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
      viewing.preview ||
      !hasBridge()
    )
      return
    const generation = viewingGeneration
    const release = transcriptReaders.protect(nativeReadingSource(viewing.ref.path), "*")
    rememberThread({ ...viewing, loadingEarlier: true })
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
        if (fetched.start >= before || fetched.start + fetched.entries.length !== before ||
            nativeHistoryRevision(fetched) !== nativeHistoryRevision({ ...viewing, total: viewing.totalEntries })) {
          await recoverThreadReader(viewing.ref.path)
          return
        }
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
      if (generation !== viewingGeneration || !current || current.ref.path !== viewing.ref.path) return
      if (current.pageStart !== viewing.pageStart || nativeHistoryRevision({ ...current, total: current.totalEntries }) !==
          nativeHistoryRevision({ ...viewing, total: viewing.totalEntries })) {
        await recoverThreadReader(viewing.ref.path)
        return
      }
      if (!page) {
        rememberThread({ ...current, loadingEarlier: false })
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
      if (generation !== viewingGeneration) return
      if (current?.ref.path === viewing.ref.path)
        rememberThread({ ...current, loadingEarlier: false })
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      release()
    }
  },

  closeViewer() {
    viewingGeneration += 1
    handedOff = null
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
