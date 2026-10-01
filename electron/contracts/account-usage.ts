import type { AccountUsage, UsageWindow } from "../account-types.js"

/**
 * The window that stops the account first: the most spent one. A Codex
 * account at 20% of its five hours and 96% of its week is out of room, and
 * routing or warning on the shorter window alone would say otherwise.
 */
export function bindingWindow(
  windows: readonly UsageWindow[]
): UsageWindow | null {
  let binding: UsageWindow | null = null
  for (const window of windows)
    if (!binding || window.usedPercent > binding.usedPercent) binding = window
  return binding
}

/** Shortest window first; a scoped cap follows the general window it narrows. */
export function orderWindows(windows: UsageWindow[]): UsageWindow[] {
  return windows.sort(
    (a, b) =>
      a.windowMinutes - b.windowMinutes ||
      Number(a.scope !== undefined) - Number(b.scope !== undefined)
  )
}

/**
 * When the reading stops being true: the soonest reset still ahead of `now`.
 * A window past its reset has emptied, whatever the reading says.
 */
export function nextReset(usage: AccountUsage | undefined, now: number): number | null {
  if (usage?.status !== "ok") return null
  let soonest: number | null = null
  for (const window of usage.windows)
    if (window.resetsAt !== null && window.resetsAt > now && (soonest === null || window.resetsAt < soonest))
      soonest = window.resetsAt
  return soonest
}

/** The windows as they stand at `now`: one past its reset has emptied. */
export function windowsAt(windows: readonly UsageWindow[], now: number): UsageWindow[] {
  return windows.map((window) =>
    window.resetsAt !== null && window.resetsAt <= now ? { ...window, usedPercent: 0 } : window)
}

/** Whether a window in the reading has reset since it was taken. */
export function hasReset(usage: AccountUsage | undefined, now: number): boolean {
  return usage?.status === "ok" && usage.windows.some((window) => window.resetsAt !== null && window.resetsAt <= now)
}

function sameWindow(a: UsageWindow, b: UsageWindow): boolean {
  return a.windowMinutes === b.windowMinutes && a.scope === b.scope
}

/**
 * A live reading names only the windows a turn touched; the rest of the
 * account's reading still stands. Windows match by length and scope.
 * Without a whole reading to amend there is nothing to merge into: a lone
 * five-hour window would read as an account with no weekly limit.
 */
export function mergeWindows(
  previous: AccountUsage | undefined,
  windows: readonly UsageWindow[],
  readAt: number
): AccountUsage | undefined {
  if (windows.length === 0 || previous?.status !== "ok") return undefined
  const kept = previous.windows.filter((window) => !windows.some((update) => sameWindow(window, update)))
  return { ...previous, windows: orderWindows([...kept, ...windows]), readAt }
}
