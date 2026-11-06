import { z } from "zod"
import { createHook, createStore } from "@/state/store"

/**
 * What's open in this window, across Threads: the workbench strip's Threads and new Threads, in the person's order.
 * Files stay in the viewer's own tabs, after these.
 *
 * The list follows the screen (`showInTabs`), so whatever opens a Thread, a rail row, the Inbox, the crew card or an
 * address, opens it here. A Thread opened by looking at it replaces the tab on screen, unless that one was typed into
 * or kept, so reading down the rail leaves one tab. A Thread already open is focused, whichever opens it.
 *
 * A tab holds identities only. Its title, mark and whether it runs are read at draw time (`useOpenTabs`).
 */
export type OpenEntry =
  /** `session`: the conversation it shows, which a Thread that moved by a fork, or a cloud Thread left whole, can change. */
  | { kind: "thread"; thread: string; session: string; kept?: boolean }
  /** A new Thread beside `place`, before its first send. */
  | { kind: "draft"; place: string }

interface OpenTabsState {
  entries: readonly OpenEntry[]
  /** The entry on screen. */
  active?: string
}

const SAVED_KEY = "mako.open-tabs.v1"

const OpenEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), thread: z.string(), session: z.string(), kept: z.boolean().optional() }),
  z.object({ kind: z.literal("draft"), place: z.string() }),
])

/** This window's list across a reload, else the last window's across a relaunch. */
function restoredEntries(): OpenEntry[] {
  try {
    const saved = globalThis.sessionStorage?.getItem(SAVED_KEY) ?? globalThis.localStorage?.getItem(SAVED_KEY)
    return saved ? z.array(OpenEntrySchema).parse(JSON.parse(saved)) : []
  } catch {
    return []
  }
}

export const openTabsStore = createStore<OpenTabsState>({ entries: restoredEntries() })
export const useOpenEntries = createHook(openTabsStore)

let savedEntries = openTabsStore.get().entries
openTabsStore.subscribe(() => {
  const { entries } = openTabsStore.get()
  if (entries === savedEntries) return
  savedEntries = entries
  const saved = JSON.stringify(entries)
  globalThis.sessionStorage?.setItem(SAVED_KEY, saved)
  globalThis.localStorage?.setItem(SAVED_KEY, saved)
})

export function entryKey(entry: OpenEntry): string {
  return entry.kind === "thread" ? entry.thread : `draft:${entry.place}`
}

/** The next Thread to reach the screen gets a tab of its own: a fork, a Fin, a Cmd-click. */
let ownTabNext = false

export function openNextInOwnTab(): void {
  ownTabNext = true
}

/** What the screen shows, as an entry: nothing while it's no Thread's. */
function shownEntry(here: { thread?: string; session?: string; draft?: { thread: string } | null }): OpenEntry | undefined {
  if (here.draft) return { kind: "draft", place: here.draft.thread }
  return here.thread && here.session ? { kind: "thread", thread: here.thread, session: here.session } : undefined
}

function replaceable(entry: OpenEntry | undefined): boolean {
  return entry?.kind === "thread" && !entry.kept
}

/** Put what's on screen in the strip, by the rule at the top of this file. */
export function showInTabs(here: { thread?: string; session?: string; draft?: { thread: string } | null }): void {
  const shown = shownEntry(here)
  if (!shown) return
  const own = ownTabNext
  ownTabNext = false
  openTabsStore.set(({ entries, active }) => {
    const key = entryKey(shown)
    const at = entries.findIndex((entry) => entryKey(entry) === key)
    if (at >= 0) {
      const found = entries[at]!
      const changed = found.kind === "thread" && shown.kind === "thread" && (found.session !== shown.session || (own && !found.kept))
      if (!changed) return active === key ? {} : { active: key }
      return { active: key, entries: entries.with(at, { ...shown, kept: own || found.kept }) }
    }
    const from = entries.findIndex((entry) => entryKey(entry) === active)
    const next = shown.kind === "thread" && own ? { ...shown, kept: true } : shown
    if (!own && shown.kind === "thread" && replaceable(entries[from])) return { active: key, entries: entries.with(from, next) }
    const place = from < 0 ? entries.length : from + 1
    return { active: key, entries: [...entries.slice(0, place), next, ...entries.slice(place)] }
  })
}

/** The tab on screen stays: the person typed into it. */
export function keepActiveTab(): void {
  openTabsStore.set(({ entries, active }) => {
    const at = entries.findIndex((entry) => entryKey(entry) === active)
    const entry = entries[at]
    return entry?.kind === "thread" && !entry.kept ? { entries: entries.with(at, { ...entry, kept: true }) } : {}
  })
}

/** A new Thread's first send made it: its tab is that Thread's now, in the same place. */
export function draftBecameThread(place: string, placed: { thread: string; session: string }): void {
  openTabsStore.set(({ entries, active }) => {
    const key = `draft:${place}`
    const opened: OpenEntry = { kind: "thread", ...placed, kept: true }
    const at = entries.findIndex((entry) => entryKey(entry) === key)
    // A repeated send: it's made already, where it stood.
    if (at < 0) return entries.some((entry) => entryKey(entry) === placed.thread) ? {} : { entries: [...entries, opened] }
    return {
      entries: entries.filter((entry) => entryKey(entry) !== placed.thread).with(entries.slice(0, at).some((entry) => entryKey(entry) === placed.thread) ? at - 1 : at, opened),
      active: active === key ? placed.thread : active,
    }
  })
}

/** Close tabs, by their entries' keys. What they name stays where it was. */
export function closeEntries(keys: ReadonlySet<string>): void {
  openTabsStore.set(({ entries, active }) => ({
    entries: entries.filter((entry) => !keys.has(entryKey(entry))),
    active: active !== undefined && keys.has(active) ? undefined : active,
  }))
}
