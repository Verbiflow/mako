import { useCallback, useRef, useSyncExternalStore } from "react"

/**
 * A small observable store.
 *
 * The point is the read path: components subscribe through a selector and
 * re-render only when *their* slice changes identity. A token arriving on the
 * streaming message therefore wakes the one component rendering it, not the
 * transcript, the rail, or the inspector.
 */

export type StorePatch<T> = Partial<T>
export type StoreUpdater<T> = (state: T) => StorePatch<T>

export interface Store<T> {
  get: () => T
  set(patch: StorePatch<T>): void
  set(update: StoreUpdater<T>): void
  subscribe: (listener: () => void) => () => void
  /**
   * Runs `run` with each `set` inside it applied as it's made and said to the
   * listeners once, when `run` ends: a list taken in as one change costs one
   * pass over the selectors, not one per entry.
   */
  batch: (run: () => void) => void
}

interface SelectorCache<T, S> {
  value: S
  source: T
  selector: (state: T) => S
}

export interface StoreHook<T> {
  <S>(selector: (state: T) => S, isEqual?: (a: S, b: S) => boolean): S
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  let batching = 0
  let unsaid = false

  function set(patch: StorePatch<T>): void
  function set(update: StoreUpdater<T>): void
  function set(update: StorePatch<T> | StoreUpdater<T>) {
    const patch = update instanceof Function ? update(state) : update
    const next = { ...state, ...patch }
    if (shallowEqual(state, next)) return
    state = next
    if (batching) unsaid = true
    else for (const listener of listeners) listener()
  }

  function batch(run: () => void): void {
    batching += 1
    try {
      run()
    } finally {
      batching -= 1
      if (!batching && unsaid) {
        unsaid = false
        for (const listener of listeners) listener()
      }
    }
  }

  return {
    get: () => state,
    set,
    batch,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function shallowEqual<Value>(a: Value, b: Value): boolean {
  if (Object.is(a, b)) return true
  if (
    Object(a) !== a ||
    Object(b) !== b ||
    a instanceof Function ||
    b instanceof Function
  )
    return false
  const left = Object.entries(Object(a))
  const right = Object.entries(Object(b))
  if (left.length !== right.length) return false
  return left.every(([key, value]) => {
    const match = right.find(([candidate]) => candidate === key)
    return match !== undefined && Object.is(value, match[1])
  })
}

/** Bind a store slice to React. `isEqual` defaults to reference identity. */
export function createHook<T extends object>(store: Store<T>): StoreHook<T> {
  return function useSlice<S>(
    selector: (state: T) => S,
    isEqual: (a: S, b: S) => boolean = Object.is
  ): S {
    const cache = useRef<SelectorCache<T, S> | null>(null)

    const getSnapshot = useCallback(() => {
      const source = store.get()
      const previous = cache.current
      // The cache is keyed on the *selector* as well as the state. An inline
      // selector that closes over a changing value (the active tab id, say)
      // arrives with a new identity each render; serving it the previous
      // selector's slice showed one tab's companion on another tab.
      if (previous && previous.source === source && previous.selector === selector)
        return previous.value
      const value = selector(source)
      if (previous && isEqual(previous.value, value)) {
        cache.current = { value: previous.value, source, selector }
        return previous.value
      }
      cache.current = { value, source, selector }
      return value
    }, [selector, isEqual])

    return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
  }
}

/** A store's keyed entries, each with its own listeners: `subscribe(key, listener)` hears only that entry change. */
export interface KeyedSubscriptions<Entry> {
  get: (key: string) => Entry | undefined
  subscribe: (key: string, listener: () => void) => () => void
}

/**
 * Listeners by the entry they read. The store is heard once, however many listen: each change, the entries that have
 * listeners are compared by identity, and only a changed entry's listeners are told. A selector on the whole store
 * runs for every listener on every change of any entry; a conversation's rows, hundreds of them, then ran theirs for
 * each batch of every other conversation.
 */
export function keyedSubscriptions<T extends object, Entry>(
  store: Store<T>,
  entries: (state: T) => Readonly<Record<string, Entry>>
): KeyedSubscriptions<Entry> {
  const listeners = new Map<string, Set<() => void>>()
  let said = entries(store.get())
  let stop: (() => void) | undefined
  const hear = () => {
    const now = entries(store.get())
    if (now === said) return
    const before = said
    said = now
    for (const [key, heard] of listeners) if (before[key] !== now[key]) for (const listener of heard) listener()
  }
  return {
    get: (key) => entries(store.get())[key],
    subscribe: (key, listener) => {
      // Heard only while someone listens, and from what the entries are then: nothing said meanwhile is replayed.
      if (!listeners.size) {
        said = entries(store.get())
        stop = store.subscribe(hear)
      }
      const heard = listeners.get(key) ?? new Set()
      heard.add(listener)
      listeners.set(key, heard)
      return () => {
        heard.delete(listener)
        if (!heard.size && listeners.get(key) === heard) listeners.delete(key)
        if (!listeners.size) {
          stop?.()
          stop = undefined
        }
      }
    },
  }
}

export interface EntryHook<Entry> {
  <S>(key: string | undefined, selector: (entry: Entry | undefined) => S, isEqual?: (a: S, b: S) => boolean): S
}

interface EntryCache<Entry, S> {
  value: S
  source: Entry | undefined
  selector: (entry: Entry | undefined) => S
}

const NOT_HEARD = () => () => {}

/** Bind one entry of a store to React: `selector` runs when that entry changes, and for no other's change. */
export function createEntryHook<Entry>(keyed: KeyedSubscriptions<Entry>): EntryHook<Entry> {
  return function useEntry<S>(
    key: string | undefined,
    selector: (entry: Entry | undefined) => S,
    isEqual: (a: S, b: S) => boolean = Object.is
  ): S {
    const cache = useRef<EntryCache<Entry, S> | null>(null)
    const subscribe = useCallback(
      (notify: () => void) => (key === undefined ? NOT_HEARD() : keyed.subscribe(key, notify)),
      [key]
    )
    const getSnapshot = useCallback(() => {
      const source = key === undefined ? undefined : keyed.get(key)
      const previous = cache.current
      // Keyed on the selector as well as the entry, as `createHook` is: an inline selector closes over what it reads.
      if (previous && previous.source === source && previous.selector === selector) return previous.value
      const value = selector(source)
      if (previous && isEqual(previous.value, value)) {
        cache.current = { value: previous.value, source, selector }
        return previous.value
      }
      cache.current = { value, source, selector }
      return value
    }, [key, selector, isEqual])

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  }
}
