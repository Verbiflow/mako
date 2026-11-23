import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

/**
 * The rail's projects in the order the person dragged them to, by folder (`rail.projectOrder`, a preference that
 * follows the account, so every device lists them alike). Projects never placed follow, in the order they were last
 * worked in (`rail-ranks`): placing one by hand never stops the rest from moving as work moves.
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

/**
 * The person's order first, then every project they never placed in the order `folders` already has: the order the
 * projects were last worked in. Projects placed by hand that aren't listed now are passed over, and keep their place
 * for when they are.
 */
export function orderByHand<T extends { key: string }>(folders: readonly T[], order: readonly string[]): T[] {
  if (!order.length) return [...folders]
  const at = new Map(order.map((key, index) => [key, index]))
  const placed = folders.filter((folder) => at.has(folder.key)).sort((left, right) => at.get(left.key)! - at.get(right.key)!)
  return [...placed, ...folders.filter((folder) => !at.has(folder.key))]
}

/**
 * Moves `key` to stand before `before` (or last, with none) among `shown`, the projects as the rail lists them now,
 * and keeps that as the person's order: every project shown becomes placed, so the list stays as they see it.
 * Projects placed earlier but not shown keep their place after.
 */
export function placeProject(key: string, before: string | null, shown: readonly string[]): readonly string[] {
  const list = shown.filter((each) => each !== key)
  const at = before === null ? -1 : list.indexOf(before)
  list.splice(at < 0 ? list.length : at, 0, key)
  const unseen = projectOrderStore.get().order.filter((each) => !list.includes(each))
  const order = [...list, ...unseen].slice(0, 400)
  projectOrderStore.set({ order })
  if (hasBridge()) void getMako().setPreference("rail.projectOrder", order).catch(() => {
    // A fixture desk refuses the write; the window keeps the order it shows until the host says otherwise.
  })
  return order
}
