import type { ThreadTitleEntry } from "../../electron/contracts/thread-titles.ts"
import { toast } from "sonner"
import { getMako, hasBridge } from "@/lib/bridge"
import { prefsStore, setPref } from "@/state/prefs"
import { createHook, createStore } from "@/state/store"
import type { ThreadRef } from "@/lib/types"

export interface ThreadTitle {
  title: string
  /** `auto` is a model's title; `user` and `frozen` are never replaced automatically. */
  source: "user" | "frozen" | "auto"
}

export interface ThreadTitlesState {
  /** Each Thread's own name, by Thread ID; a Thread without one shows its Session's. */
  byThread: Readonly<Record<string, ThreadTitle>>
}

export const threadTitlesStore = createStore<ThreadTitlesState>({ byThread: {} })
export const useThreadTitles = createHook(threadTitlesStore)

/** A Thread's own name now, if it has one. */
export function threadTitle(thread: string | undefined): string | undefined {
  return thread ? threadTitlesStore.get().byThread[thread]?.title : undefined
}

/** Changes told while the whole set is loading, applied over it once it arrives. */
let told: ThreadTitleEntry[] | null = null

function merge(byThread: Readonly<Record<string, ThreadTitle>>, entries: readonly ThreadTitleEntry[]): Readonly<Record<string, ThreadTitle>> {
  let next: Record<string, ThreadTitle> | undefined
  for (const entry of entries) {
    const current = byThread[entry.thread]
    if (entry.title === null) {
      if (!current) continue
      next ??= { ...byThread }
      delete next[entry.thread]
      continue
    }
    const source = entry.source ?? "auto"
    if (current?.title === entry.title && current.source === source) continue
    next ??= { ...byThread }
    next[entry.thread] = { title: entry.title, source }
  }
  return next ?? byThread
}

export function applyThreadTitles(entries: readonly ThreadTitleEntry[]): void {
  told?.push(...entries)
  threadTitlesStore.set((state) => ({ byThread: merge(state.byThread, entries) }))
}

export async function loadThreadTitles(): Promise<void> {
  if (!hasBridge()) return
  told = []
  try {
    const all = await getMako().threadTitles()
    const late = told
    threadTitlesStore.set({ byThread: merge(merge({}, all), late) })
  } finally {
    told = null
  }
}

/**
 * The person's name for a row. A Thread's name lives in the Thread store,
 * so every window and host shows it and automatic titles stop; an empty
 * name gives it back to them. A row the store doesn't place keeps the
 * window's own rename, as before the store kept names.
 */
export async function renameThreadTitle(input: { thread?: string; path: string; title: string; shown: string; native?: string }): Promise<void> {
  const next = input.title.trim()
  if (next === input.shown) return
  const overrides = { ...prefsStore.get().titleOverrides }
  if (!input.thread || !hasBridge()) {
    if (next && next !== input.native) overrides[input.path] = next
    else delete overrides[input.path]
    setPref("titleOverrides", overrides)
    return
  }
  const thread = input.thread
  const before = threadTitlesStore.get().byThread
  const previousOverride = overrides[input.path]
  delete overrides[input.path]
  setPref("titleOverrides", overrides)
  applyThreadTitles([next ? { thread, title: next, source: "user" } : { thread, title: null }])
  try {
    applyThreadTitles([await getMako().renameThread(crypto.randomUUID(), thread, next || null, input.native)])
  } catch (error) {
    threadTitlesStore.set({ byThread: before })
    if (previousOverride) setPref("titleOverrides", { ...prefsStore.get().titleOverrides, [input.path]: previousOverride })
    toast.error("The thread kept its name", { description: error instanceof Error ? error.message : String(error) })
  }
}

/** Rows whose window rename was offered to the store already, this window's life. */
const offered = new Set<string>()

/**
 * A window's renames from before the Thread store kept names are the
 * person's: the store learns them, so no automatic title replaces them.
 * The window keeps drawing its own until it is renamed again.
 */
export function offerWindowRenames(refs: readonly ThreadRef[]): void {
  if (!hasBridge()) return
  const overrides = prefsStore.get().titleOverrides
  const entries: Array<{ thread: string; title: string; path: string }> = []
  for (const ref of refs) {
    const title = overrides[ref.path]
    if (!title || !ref.threadId || offered.has(ref.path)) continue
    offered.add(ref.path)
    if (threadTitlesStore.get().byThread[ref.threadId]?.source === "user") continue
    entries.push({ thread: ref.threadId, title, path: ref.path })
  }
  if (!entries.length) return
  getMako().importThreadTitles(entries.map(({ thread, title }) => ({ thread, title })))
    .then(applyThreadTitles)
    .catch(() => {
      for (const entry of entries) offered.delete(entry.path)
    })
}
