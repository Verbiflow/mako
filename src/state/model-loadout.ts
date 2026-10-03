import { toast } from "sonner"
import {
  chooseComposerModel,
  currentSettingsTarget,
} from "@/state/composer-settings"
import { prefsStore, setPref } from "@/state/prefs"
import { modelByIdentity } from "@mako/sessions/settings"
import type { HarnessProfile } from "@/lib/types"
import { providerProfileKey, providerStore, providers } from "@/state/providers"

/** The five models a chord away: provider and id, in pick order. */
export interface LoadoutEntry {
  harness: string
  model: string
}

export const LOADOUT_LIMIT = 5

export function loadoutAvailability(entry: LoadoutEntry, profile?: HarnessProfile) {
  if (!profile || profile.pending)
    return { kind: "loading" as const, label: entry.model, reason: "Checking model availability…" }
  const model = modelByIdentity(profile.models, entry.model)
  const label = model?.label ?? entry.model
  if (!profile.available || profile.configurationError)
    return { kind: "unavailable" as const, label, reason: profile.configurationError ?? profile.error ?? "This agent is not available." }
  if (!model)
    return { kind: "unavailable" as const, label, reason: "This saved model is no longer available. Choose another model or remove it from your loadout." }
  // A native variant is a valid saved choice; retain its tuning identity.
  return { kind: "ready" as const, label, model: entry.model }
}

/** Menu and shortcut both recheck the current workspace before changing intent. */
export function availableLoadoutModel(entry: LoadoutEntry, cwd: string): string | undefined {
  const state = providerStore.get()
  const profile = state.contexts[providerProfileKey(entry.harness, cwd)] ?? state.profiles[entry.harness]
  const availability = loadoutAvailability(entry, profile)
  if (availability.kind === "ready") return availability.model
  if (availability.kind === "loading") void providers.load(entry.harness, false, cwd).catch(() => {})
  toast(availability.label, { description: availability.reason })
  return undefined
}

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

/**
 * A drop lands `entry` in slot `at`: an entry already in the loadout moves
 * there, a new one is inserted and the last falls off a full loadout.
 */
export function placeInLoadout(entry: LoadoutEntry, at: number) {
  const rest = prefsStore
    .get()
    .modelLoadout.filter((held) => held.harness !== entry.harness || held.model !== entry.model)
  const slot = Math.max(0, Math.min(at, rest.length))
  save([...rest.slice(0, slot), entry, ...rest.slice(slot)])
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
  const model = availableLoadoutModel(entry, target.cwd)
  if (!model) return
  if (entry.harness === target.harness) {
    chooseComposerModel(target, model)
    toast(`Model: ${model}`)
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
    model
  )
  toast(`Model: ${entry.model}`)
}
