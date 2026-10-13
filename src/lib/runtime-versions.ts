import type { HarnessFeatureKey } from "@mako/host/contracts/harness-features"
import type { HarnessUpdateInfo, HarnessUpdates } from "@mako/host/contracts/harness-updates"

/**
 * What the window says about a harness's version, decided from the host's
 * runtime readings alone. Kept React-free so the rules can be checked
 * without a renderer.
 *
 * The rules, in the user's words: never nag fast upgraders. A version newer
 * than Mako has tested runs with no notice anywhere but a quiet line in
 * Settings › Agents; a version Mako couldn't read never stops anything; and
 * the one case that asks for something, a version below the harness's
 * declared oldest, is said once, above the composer, when that harness is
 * picked, with the Update that fixes it.
 */

/** The installation a harness's sessions run: the primary one, else the harness's own row. */
export function sessionRuntime(
  updates: HarnessUpdates | null,
  harness: string | null
): { id: string; info: HarnessUpdateInfo } | undefined {
  if (!harness) return undefined
  const rows = Object.entries(updates ?? {}).filter(
    ([id, info]) => (info.provider ?? id.split(":")[0]) === harness && info.binary
  )
  const found = rows.find(([, info]) => info.primary === true) ?? rows.find(([id]) => id === harness)
  return found && { id: found[0], info: found[1] }
}

/** The installation a harness would run, when it is too old for Mako's client. */
export interface TooOld {
  id: string
  installed: string
  oldest?: string
  /** The update Mako can run, by its label. */
  update?: string
  /** Who updates it when Mako can't: another app, Homebrew, a terminal. */
  owner: string
  updating: boolean
  /** The last update's own words, when it failed. */
  failure?: string
}

export function tooOld(updates: HarnessUpdates | null, harness: string | null): TooOld | undefined {
  const runtime = sessionRuntime(updates, harness)
  const info = runtime?.info
  if (!runtime || !info?.installed || info.versions?.standing !== "below-oldest") return undefined
  const blocked: TooOld = { id: runtime.id, installed: info.installed, owner: ownerOf(info), updating: info.phase === "updating" }
  if (info.versions.oldest) blocked.oldest = info.versions.oldest
  if (info.update) blocked.update = info.update.label
  if (info.result?.outcome === "failed" && info.result.message) blocked.failure = info.result.message
  return blocked
}

/** The one line the composer shows for a harness below its oldest version. */
export function tooOldText(label: string, runtime: TooOld): string {
  const needs = runtime.oldest ? ` Mako needs ${runtime.oldest} or newer.` : ""
  return `${label} ${runtime.installed} is older than Mako supports.${needs}`
}

/** A shared feature the installed CLI is too old for, with the version it needs. */
export interface FeatureFloor {
  id: string
  installed: string
  needs: string
  update?: string
  owner: string
}

export function featureFloor(
  updates: HarnessUpdates | null,
  harness: string | null,
  feature: HarnessFeatureKey
): FeatureFloor | undefined {
  const runtime = sessionRuntime(updates, harness)
  const needs = runtime?.info.versions?.needs?.[feature]
  if (!runtime || !needs || !runtime.info.installed) return undefined
  const floor: FeatureFloor = { id: runtime.id, installed: runtime.info.installed, needs, owner: ownerOf(runtime.info) }
  if (runtime.info.update) floor.update = runtime.info.update.label
  return floor
}

/** The short reason a control is unavailable on an older CLI. */
export function featureFloorText(label: string, feature: string, floor: FeatureFloor): string {
  return `${feature} needs ${label} ${floor.needs} or newer; this one is ${floor.installed}.`
}

function ownerOf(info: HarnessUpdateInfo): string {
  if ((info.channel === "managed" || info.channel === "app") && info.managedBy)
    return `Update it through ${info.managedBy.replace(/\.app$/, "")}.`
  if (info.channel === "brew") return "Update it with Homebrew."
  return "Update it from a terminal."
}
