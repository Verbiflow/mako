import { useCallback, useRef, useSyncExternalStore } from "react"

/**
 * A ~40-line observable store.
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

  function set(patch: StorePatch<T>): void
  function set(update: StoreUpdater<T>): void
  function set(update: StorePatch<T> | StoreUpdater<T>) {
    const patch = update instanceof Function ? update(state) : update
    const next = { ...state, ...patch }
    if (shallowEqual(state, next)) return
    state = next
    for (const listener of listeners) listener()
  }

  return {
    get: () => state,
    set,
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
