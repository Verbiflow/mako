import { createHook, createStore } from "@/state/store"
import { threadLifecycle, type ThreadTarget } from "@/state/thread-lifecycle"
import { wholeThreadTargets } from "@/state/session-archive"
import { markThreads } from "@/state/thread-marks"

/**
 * Rows of the rail picked together: ⌘-click adds or drops one, ⇧-click picks every row from the last one picked
 * through it, in the rail's order. While any is picked the footer is the selection's bar (Mark read U, Archive E,
 * Esc to let go), and a plain click on a row lets go and opens it. A window's own: nothing of it is kept.
 */
export interface PickedRow {
  /** The row's key in the rail (`data-flip-key`). */
  key: string
  thread?: string
  target: ThreadTarget
}

interface RailSelection {
  picked: readonly PickedRow[]
}

export const railSelectionStore = createStore<RailSelection>({ picked: [] })
export const useRailSelection = createHook(railSelectionStore)

/** Every row on screen that can be picked, by its key, so a ⇧-click's range knows what each row in it is. */
const pickable = new Map<string, PickedRow>()

/** A row says what picking it means while it's drawn; the function it returns takes that back. */
export function offerPick(row: PickedRow): () => void {
  pickable.set(row.key, row)
  return () => {
    if (pickable.get(row.key) === row) pickable.delete(row.key)
  }
}

/** The rows of `keys` (the rail's rows in the order drawn) that can be picked. */
export function pickableRows(keys: readonly string[]): PickedRow[] {
  return keys.flatMap((key) => pickable.get(key) ?? [])
}

/** A click with ⌘ or ⇧ picks rather than opens: `rows` are the rail's row keys as drawn. */
export function pickByClick(row: PickedRow, event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, rows: () => readonly string[]): boolean {
  if (event.shiftKey) pickRange(row, pickableRows(rows()))
  else if (event.metaKey || event.ctrlKey) togglePicked(row)
  else return false
  return true
}

/** ⌘-click: picks the row, or drops it if it's picked. */
export function togglePicked(row: PickedRow): void {
  const { picked } = railSelectionStore.get()
  railSelectionStore.set({ picked: picked.some((each) => each.key === row.key) ? picked.filter((each) => each.key !== row.key) : [...picked, row] })
}

/**
 * ⇧-click: every row from the last one picked through this one, in `order` (the rail's rows as drawn, each with what
 * picking it needs). With none picked yet, this one alone.
 */
export function pickRange(row: PickedRow, order: readonly PickedRow[]): void {
  const { picked } = railSelectionStore.get()
  const anchor = picked.at(-1)
  const from = anchor ? order.findIndex((each) => each.key === anchor.key) : -1
  const to = order.findIndex((each) => each.key === row.key)
  if (from < 0 || to < 0) {
    railSelectionStore.set({ picked: [row] })
    return
  }
  const [low, high] = from < to ? [from, to] : [to, from]
  const range = order.slice(low, high + 1)
  const held = new Set(picked.map((each) => each.key))
  // The row clicked is the next range's anchor.
  railSelectionStore.set({ picked: [...picked, ...range.filter((each) => !held.has(each.key) && each.key !== row.key), ...(held.has(row.key) ? [] : [row])] })
}

export function clearPicked(): void {
  if (railSelectionStore.get().picked.length) railSelectionStore.set({ picked: [] })
}

/** Mark read (U): every picked Thread's Mark as unread is dropped, and so is the selection. */
export async function markPickedRead(): Promise<void> {
  const { picked } = railSelectionStore.get()
  clearPicked()
  await markThreads(picked.flatMap((row) => (row.thread ? [row.thread] : [])), { unread: false })
}

/** Archive (E): every picked Thread, whole, with one Undo; the selection goes. */
export async function archivePicked(): Promise<void> {
  const { picked } = railSelectionStore.get()
  if (!picked.length) return
  clearPicked()
  const seen = new Set<string>()
  const targets = picked.flatMap((row) => {
    const whole = (row.thread && wholeThreadTargets(row.thread)) || [row.target]
    return whole.filter((target) => {
      const key = target.kind === "live" ? `live:${target.id}` : JSON.stringify(target)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  })
  await threadLifecycle.archive(targets, true)
}
