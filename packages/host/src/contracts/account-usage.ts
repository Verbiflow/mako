import type { AccountUsage, UsageWindow } from "./accounts.js"

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

/** A window this full makes the account worth switching from. */
export const LIMIT_NEAR_PERCENT = 90
/** An account offered instead must be at most this full in its binding window. */
export const LIMIT_HEADROOM_PERCENT = 70

/**
 * Another account of the same harness with room, offered when the one in
 * use is near its plan limit or the harness just refused a turn on it.
 * Never taken by itself: an account is money, so switching is the person's
 * click. `window` is the binding one, which names the limit.
 */
export interface AccountLimitOffer {
  harness: string
  because: "near-limit" | "refused"
  from: { name: string; email?: string; window?: UsageWindow }
  to: { name: string; email?: string; window?: UsageWindow }
}

/**
 * The offer the readings make, or `null`: the active account near its limit
 * (or refused, whatever its reading says) and the account with the most
 * room in its binding window under `LIMIT_HEADROOM_PERCENT`. Accounts whose
 * reading failed are never offered: an unread account may be as spent.
 */
export function limitOffer(
  harness: string,
  accounts: readonly { name: string; email?: string; active?: boolean; missing?: boolean; removing?: boolean; usage?: AccountUsage }[],
  now: number,
  refused = false
): AccountLimitOffer | null {
  const active = accounts.find((account) => account.active)
  if (!active) return null
  const binding = (usage: AccountUsage | undefined) => usage?.status === "ok" ? bindingWindow(windowsAt(usage.windows, now)) : undefined
  const window = binding(active.usage)
  if (!refused && (window?.usedPercent ?? 0) < LIMIT_NEAR_PERCENT) return null
  let best: { account: (typeof accounts)[number]; window: UsageWindow | null } | undefined
  for (const account of accounts) {
    if (account === active || account.missing || account.removing || account.usage?.status !== "ok") continue
    const room = binding(account.usage) ?? null
    if ((room?.usedPercent ?? 0) >= LIMIT_HEADROOM_PERCENT) continue
    if (!best || (room?.usedPercent ?? 0) < (best.window?.usedPercent ?? 0)) best = { account, window: room }
  }
  if (!best) return null
  const side = (account: (typeof accounts)[number], window: UsageWindow | null | undefined) => ({
    name: account.name,
    ...account.email !== undefined && { email: account.email },
    ...window && { window },
  })
  return { harness, because: refused ? "refused" : "near-limit", from: side(active, window), to: side(best.account, best.window) }
}
