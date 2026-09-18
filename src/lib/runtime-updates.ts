import type {
  HarnessUpdateInfo,
  HarnessUpdates,
} from "../../electron/contracts/harness-updates"
import { versionBehind } from "../../electron/contracts/runtime-version"

/**
 * What one runtime row says, decided from the host's reading alone.
 *
 * The host reads installed and public versions on its own clock and pushes
 * every change, so a row is a projection of that reading and nothing else:
 * no request in flight here decides what it shows. Kept React-free so the
 * words can be checked without a renderer.
 */
export interface RuntimeRowView {
  /** The installed version, or what stands in for it. */
  version: string
  /** The reading's status in a few words, after the version. */
  detail: string
  /** The row's one control, when Mako can run something for this runtime. */
  action?: { label: string }
  /** The version column shimmers while the first reading is taken. */
  shimmer: boolean
  /** A failed update's own words, under the row. */
  note?: string
  tone: "faint" | "muted" | "negative"
}

/** How long a finished update is named in the row before it reads as merely current. */
const RECENT_UPDATE_MS = 5 * 60_000

export function runtimeRowView(info: HarnessUpdateInfo, now = Date.now()): RuntimeRowView {
  const failed = info.result?.outcome === "failed" ? info.result : undefined
  const note = failed ? `Update failed: ${failed.message ?? "the updater did not finish"}` : undefined
  if (info.phase === "updating")
    return { version: info.installed ?? "…", detail: "Updating…", shimmer: false, tone: "muted" }
  if (!info.installed && info.phase === "checking")
    return { version: "…", detail: "Checking…", shimmer: true, tone: "faint" }
  if (info.error)
    return { version: "—", detail: info.error, shimmer: false, tone: "negative", note }
  const version = info.installed ?? "—"
  if (info.latestError && !info.latest)
    return { version, detail: "Latest version unknown", shimmer: false, tone: "faint", note }
  const behind = versionBehind(info.installed, info.latest)
  const owner = ownerText(info)
  if (behind === true) {
    return {
      version,
      detail: info.update
        ? `${info.latest} available`
        : `${info.latest} available · ${owner ?? "not installed through a package manager Mako runs"}`,
      action: info.update ? { label: failed ? "Try again" : info.update.label } : undefined,
      shimmer: false,
      tone: "muted",
      note,
    }
  }
  const recent =
    info.result?.outcome === "updated" && now - info.result.at < RECENT_UPDATE_MS
      ? `Updated from ${info.result.from ?? "an earlier version"}`
      : undefined
  if (behind === false)
    return {
      version,
      detail: recent ?? (owner ? `Current · ${owner}` : "Current"),
      shimmer: false,
      tone: "faint",
      note,
    }
  // No public reading: the registry failed, or the runtime publishes none.
  if (info.channel === "self" && info.update)
    return {
      version,
      detail: recent ?? (info.latestError ? "Latest version unknown" : "Checks with its own updater"),
      action: { label: failed ? "Try again" : "Check for updates" },
      shimmer: false,
      tone: "faint",
      note,
    }
  return {
    version,
    detail:
      recent ??
      owner ??
      (info.latestError
        ? "Latest version unknown"
        : info.checkedAt
          ? "No public version to compare"
          : "Checking…"),
    shimmer: false,
    tone: "faint",
    note,
  }
}

function ownerText(info: HarnessUpdateInfo): string | undefined {
  if (info.channel === "managed" && info.managedBy) return `Updates come from ${info.managedBy}`
  if (info.channel === "app" && info.managedBy) return `Updates come with ${info.managedBy}`
  if (info.channel === "brew" && !info.update) return "Installed with Homebrew"
  return undefined
}

/** Rows worth showing: runtimes found on this machine, or ones that would not say their version. */
export function runtimeRows(updates: HarnessUpdates | null): Array<[string, HarnessUpdateInfo]> {
  return Object.entries(updates ?? {})
    .filter(([, info]) => info.binary || info.error)
    .sort(([left], [right]) => left.localeCompare(right))
}

/** The oldest installed reading among the rows, for the card's "checked … ago". */
export function runtimeCheckedAt(updates: HarnessUpdates | null): number | undefined {
  let oldest: number | undefined
  for (const [, info] of runtimeRows(updates)) {
    if (!info.checkedAt) return undefined
    oldest = oldest === undefined ? info.checkedAt : Math.min(oldest, info.checkedAt)
  }
  return oldest
}

/** Whether any row is being read or updated right now. */
export function runtimeBusy(updates: HarnessUpdates | null): boolean {
  return Object.values(updates ?? {}).some((info) => info.phase !== undefined)
}

/** The runtimes with a newer public version than the one installed. */
export function runtimesBehind(updates: HarnessUpdates | null): string[] {
  return runtimeRows(updates)
    .filter(([, info]) => versionBehind(info.installed, info.latest) === true)
    .map(([provider]) => provider)
}
