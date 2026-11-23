import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

/**
 * Where the person dragged projects to, by folder (`rail.projectOrder`, a preference that follows the account, so
 * every device lists them alike). The list is the rail's places from the top: a folder holds the place it was dropped
 * at, and `UNPLACED` is a place nobody chose, which the projects never placed fill in the order they were last worked
 * in (`rail-ranks`), as they do every place past the end. So placing one by hand never stops the rest from moving as
 * work moves.
 *
 * A list with no `UNPLACED` in it is from before places were kept one project at a time, when a drag placed every
 * project shown: it's read as it was written, those projects first in its order, and the next drag keeps only the
 * project dragged. A build from before reads a list with `UNPLACED` as the placed projects first, and passes the
 * rest over as folders it doesn't list.
 */
export const projectOrderStore = createStore<{ order: readonly string[] }>({ order: [] })
export const useProjectOrder = createHook(projectOrderStore)

/** What the host says the account holds; none keeps the order as worked in. */
export function applyProjectOrder(order: readonly string[] | undefined): void {
  const next = order ?? []
  const held = projectOrderStore.get().order
  if (held.length === next.length && held.every((key, index) => key === next[index])) return
  projectOrderStore.set({ order: next })
}

/** A place nobody chose. No folder's key: a key is a folder's path, or `~`. */
export const UNPLACED = ":"

/** The projects the person placed themselves, one at a time; none in a list from before places were kept that way. */
export function placedByHand(order: readonly string[]): ReadonlySet<string> {
  return new Set(order.includes(UNPLACED) ? order.filter((key) => key !== UNPLACED) : [])
}

/**
 * `folders` with each project the person placed at its place, and the rest in the order `folders` already has (the
 * order the projects were last worked in) filling the places nobody chose and every place after. Projects placed by
 * hand that aren't listed now are passed over, and keep their place for when they are.
 */
export function orderByHand<T extends { key: string }>(folders: readonly T[], order: readonly string[]): T[] {
  if (!order.length) return [...folders]
  const named = new Set(order)
  const placed = new Map<string, T>()
  for (const folder of folders) if (named.has(folder.key)) placed.set(folder.key, folder)
  const ordered: T[] = []
  let next = 0
  /** The next project never placed, as `folders` has them. */
  const unplaced = (): T | undefined => {
    while (next < folders.length && placed.has(folders[next]!.key)) next += 1
    return folders[next++]
  }
  for (const key of order) {
    const folder = key === UNPLACED ? unplaced() : placed.get(key)
    if (folder && (key === UNPLACED || named.delete(key))) ordered.push(folder)
  }
  for (let folder = unplaced(); folder; folder = unplaced()) ordered.push(folder)
  return ordered
}

/**
 * Moves `key` to stand before `before` (or last, with none) among `shown`, the projects as the rail lists them now,
 * and keeps the place it lands at as the person's: of the projects shown, only this one and those placed one at a
 * time before it hold a place, so the others go on ordering as they are worked in. Projects placed earlier but not
 * shown keep their place after. A list from before (every project shown placed at each drag) can't say which of its
 * projects the person moved, so only this one is kept from it.
 */
export function placeProject(key: string, before: string | null, shown: readonly string[]): readonly string[] {
  const list = shown.filter((each) => each !== key)
  const at = before === null ? -1 : list.indexOf(before)
  list.splice(at < 0 ? list.length : at, 0, key)
  const placed = placedByHand(projectOrderStore.get().order)
  const places = list.map((each) => (each === key || placed.has(each) ? each : UNPLACED))
  while (places.at(-1) === UNPLACED) places.pop()
  const unseen = [...placed].filter((each) => !list.includes(each))
  // It ends with a place nobody chose, which changes no project's place and says the list keeps them one at a time.
  const order = [...places, ...unseen].slice(0, 399).concat(UNPLACED)
  projectOrderStore.set({ order })
  if (hasBridge()) void getMako().setPreference("rail.projectOrder", order).catch(() => {
    // A fixture desk refuses the write; the window keeps the order it shows until the host says otherwise.
  })
  return order
}
