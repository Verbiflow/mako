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
