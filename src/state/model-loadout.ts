import { toast } from "sonner"
import {
  chooseComposerModel,
  currentSettingsTarget,
} from "@/state/composer-settings"
import { prefsStore, setPref } from "@/state/prefs"

/** The five models a chord away: provider and id, in pick order. */
export interface LoadoutEntry {
  harness: string
  model: string
}

export const LOADOUT_LIMIT = 5

function save(entries: LoadoutEntry[]) {
  setPref("modelLoadout", entries.slice(0, LOADOUT_LIMIT))
}

/** The picker's "add" lands the model once, in the next free slot. */
export function addToLoadout(harness: string, model: string) {
  const entries = prefsStore.get().modelLoadout
  if (entries.some((entry) => entry.harness === harness && entry.model === model))
    return
  if (entries.length >= LOADOUT_LIMIT) {
    toast(`The loadout holds ${LOADOUT_LIMIT} models — remove one first`)
    return
  }
  save([...entries, { harness, model }])
}

export function removeFromLoadout(index: number) {
  const entries = prefsStore.get().modelLoadout
  save(entries.filter((_, at) => at !== index))
}

/** Tab/arrow reordering moves the entry one slot at a time. */
export function moveLoadoutEntry(index: number, delta: -1 | 1) {
  const entries = [...prefsStore.get().modelLoadout]
  const to = index + delta
  if (to < 0 || to >= entries.length) return
  const [entry] = entries.splice(index, 1)
  entries.splice(to, 0, entry!)
  save(entries)
}

/**
 * ⌃⌘1–5 picks the entry. Same provider lands as a model choice; another
 * provider retargets the composer's next session — an open thread never
 * changes transport silently.
 */
export function applyLoadoutEntry(index: number) {
  const entry = prefsStore.get().modelLoadout[index]
  if (!entry) return
  const target = currentSettingsTarget()
  if (entry.harness === target.harness) {
    chooseComposerModel(target, entry.model)
    toast(`Model: ${entry.model}`)
    return
  }
  if (target.kind !== "new") {
    toast(`${entry.model} applies to a new conversation`, {
      description: "This conversation keeps its provider.",
    })
    return
  }
  setPref("composerHarness", entry.harness)
  chooseComposerModel(
    { kind: "new", harness: entry.harness, cwd: target.cwd },
    entry.model
  )
  toast(`Model: ${entry.model}`)
}
