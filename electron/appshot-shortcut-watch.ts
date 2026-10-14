import type { AppshotCheckReason, AppshotPressEvidence } from "@mako/host/contracts/appshot-shortcut"

/**
 * When the Appshot shortcut is checked again after it was set, and what a
 * press says about another app, as rules with no Electron in them, so a
 * test drives them with its own clock (`scripts/test-appshot-shortcut-watch.ts`).
 * Measured in docs/audits/2026-10-12/appshot-shortcut-clashes.md, "Taken later".
 *
 * A check is the brief exclusive registration and the read of macOS's
 * shortcuts the client makes before it holds a chord: about 110 ms of a
 * helper and 70 ms of its CPU. So it never runs on a timer of its own, only
 * when something could have changed: System Settings wrote its shortcuts,
 * the Mac woke or was unlocked, a window asked for the keys again (Settings
 * opened), Mako came to the front, and once an hour while the Mac is idle.
 * Requests close together are one check, a fresh check isn't repeated for
 * the reasons that come often, and nothing is checked within a few seconds
 * of a press, since the person is using the keys.
 */

/** How long a reason waits for more of the same before the check runs. */
const SETTLE_MS = {
  set: 0,
  asked: 300,
  // cfprefsd writes a domain up to ~3 s after the change, sometimes twice.
  preferences: 1_500,
  // The window server and the apps' hot keys come back after the screens do.
  wake: 5_000,
  unlock: 2_000,
  active: 1_000,
  hourly: 0,
} as const satisfies Record<AppshotCheckReason, number>

/** A reason that comes often skips the check when the last one is newer than this. */
const FRESH_MS = {
  set: 0,
  asked: 60_000,
  preferences: 0,
  wake: 0,
  unlock: 0,
  active: 10 * 60_000,
  hourly: 50 * 60_000,
} as const satisfies Record<AppshotCheckReason, number>

/** Which reason a check that several asked for is recorded under: the one that says most. */
const RANK: readonly AppshotCheckReason[] = ["preferences", "wake", "unlock", "asked", "active", "hourly", "set"]

/** A check that keeps being asked for still runs this long after the first ask. */
const MAX_SETTLE_MS = 10_000
/** No check this soon after a press: the person is using the keys. */
export const QUIET_AFTER_PRESS_MS = 3_000
/** A check that found the keys' modifiers held tries again this much later, this many times. */
const BUSY_RETRY_MS = 3_000
const BUSY_TRIES = 5
export const HOURLY_MS = 60 * 60_000
/** The hourly check runs only once the Mac has had no input this long, else 5 minutes later. */
const IDLE_SECONDS = 30
const NOT_IDLE_RETRY_MS = 5 * 60_000

export interface ScheduleClock {
  now(): number
  /** Runs `run` after `ms`, unreferenced; returns its cancel. */
  after(ms: number, run: () => void): () => void
}

/** A check's outcome as the schedule needs it: done, or the keys were in use and it should try again. */
export type CheckOutcome = "done" | "busy"

export class CheckSchedule {
  private readonly clock: ScheduleClock
  private readonly check: (reason: AppshotCheckReason) => Promise<CheckOutcome>
  private readonly idleSeconds: () => number
  private pending: { reasons: Set<AppshotCheckReason>; first: number; due: number; cancel: () => void } | null = null
  private hourly: { due: number; cancel: () => void } | null = null
  private running = false
  private again: AppshotCheckReason | null = null
  private busyTries = 0
  private lastCheck = 0
  private lastPress = 0
  private on = false

  constructor(clock: ScheduleClock, check: (reason: AppshotCheckReason) => Promise<CheckOutcome>, idleSeconds: () => number) {
    this.clock = clock
    this.check = check
    this.idleSeconds = idleSeconds
  }

  /** Watching begins: the hourly check is armed. */
  start(): void {
    if (this.on) return
    this.on = true
    this.armHourly(HOURLY_MS)
  }

  /** Nothing is watched: every timer goes. */
  stop(): void {
    this.on = false
    this.pending?.cancel()
    this.pending = null
    this.hourly?.cancel()
    this.hourly = null
    this.again = null
    this.busyTries = 0
  }

  /** A check ran outside the schedule (the one `set` makes). */
  checked(at = this.clock.now()): void {
    this.lastCheck = at
  }

  pressed(at = this.clock.now()): void {
    this.lastPress = at
  }

  /** When the next check is due, if one is waiting or armed. */
  next(): number | null {
    return this.pending?.due ?? this.hourly?.due ?? null
  }

  request(reason: AppshotCheckReason): void {
    if (!this.on) return
    const now = this.clock.now()
    if (this.lastCheck > 0 && now - this.lastCheck < FRESH_MS[reason]) return
    if (this.running) {
      this.again = this.again ? first([this.again, reason]) : reason
      return
    }
    const pending = this.pending
    const due = Math.min((pending?.first ?? now) + MAX_SETTLE_MS, Math.max(pending?.due ?? 0, now + SETTLE_MS[reason]))
    pending?.cancel()
    const reasons = new Set(pending?.reasons ?? [])
    reasons.add(reason)
    this.pending = { reasons, first: pending?.first ?? now, due, cancel: this.clock.after(due - now, () => void this.fire()) }
  }

  private async fire(): Promise<void> {
    const pending = this.pending
    this.pending = null
    if (!pending || !this.on) return
    const now = this.clock.now()
    const quietUntil = this.lastPress + QUIET_AFTER_PRESS_MS
    if (now < quietUntil) {
      this.pending = { ...pending, due: quietUntil, cancel: this.clock.after(quietUntil - now, () => void this.fire()) }
      return
    }
    const reason = first([...pending.reasons])
    this.running = true
    let outcome: CheckOutcome = "done"
    try {
      outcome = await this.check(reason)
    } catch {
      // The check says why in its own record; the schedule goes on.
    } finally {
      this.running = false
    }
    if (!this.on) return
    if (outcome === "busy" && this.busyTries < BUSY_TRIES) {
      this.busyTries += 1
      const at = this.clock.now()
      this.pending = { reasons: pending.reasons, first: at, due: at + BUSY_RETRY_MS, cancel: this.clock.after(BUSY_RETRY_MS, () => void this.fire()) }
      return
    }
    this.busyTries = 0
    // Kept busy all along, it waits for the next reason or the next hour.
    if (outcome === "done") this.lastCheck = this.clock.now()
    this.armHourly(HOURLY_MS)
    const again = this.again
    this.again = null
    if (again) this.request(again)
  }

  private armHourly(ms: number): void {
    this.hourly?.cancel()
    if (!this.on) return
    const due = this.clock.now() + ms
    this.hourly = {
      due,
      cancel: this.clock.after(ms, () => {
        this.hourly = null
        if (this.idleSeconds() < IDLE_SECONDS) return this.armHourly(NOT_IDLE_RETRY_MS)
        this.request("hourly")
        // A fresh check skipped it: the next hour is armed from here.
        if (!this.pending && !this.running) this.armHourly(HOURLY_MS)
      }),
    }
  }
}

function first(reasons: AppshotCheckReason[]): AppshotCheckReason {
  return RANK.find((reason) => reasons.includes(reason)) ?? "asked"
}

/* What a press says about another app ------------------------------------------------ */

/** An app macOS brought to the front, as NSWorkspace said, when the client heard it. */
export interface Activation {
  at: number
  pid: number
  bundleId: string | null
}

/**
 * How long after a press another app coming to the front counts as having
 * reacted to it. A launcher holding the same keys came forward 1–2 ms after
 * the press in the live test; this leaves room for a slower app, while a
 * person switching apps on their own falls in the same window rarely
 * (measured in the audit).
 */
export const REACT_MS = 500

/**
 * The app that came to the front within `REACT_MS` of a press: not Mako
 * (`own`), and not the app that was already in front. Null when none did.
 */
export function reactingActivation(press: { at: number; frontPid: number | null }, activations: readonly Activation[], own: ReadonlySet<number>, windowMs = REACT_MS): Activation | null {
  return (
    activations.find(
      (activation) => activation.at >= press.at && activation.at <= press.at + windowMs && !own.has(activation.pid) && activation.pid !== press.frontPid,
    ) ?? null
  )
}

/** Apps macOS itself runs (Finder, the Dock, permission prompts): their coming forward says nothing about the keys. */
export function systemApp(bundlePath: string | null): boolean {
  return bundlePath !== null && /^\/(System\/Library|usr|Library\/Apple)\//.test(bundlePath)
}

/**
 * What a press leaves known about another app. A press another app reacted
 * to replaces what was known. A press none did clears it, unless the app
 * known was already in front then, when it couldn't have come forward.
 */
export function keptEvidence(known: AppshotPressEvidence | null, found: AppshotPressEvidence | null, frontPid: number | null): AppshotPressEvidence | null {
  if (found) return found
  return known && known.pid === frontPid ? known : null
}

export interface RunningApplication {
  pid: number
  bundleId: string | null
}

/**
 * An `NSRunningApplication`'s description, which is how Electron hands the
 * app over in a workspace notification's `userInfo`:
 * `<NSRunningApplication: 0x… (com.example.app - 1234) LSASN:{…}>`. The
 * bundle id is `(null)` for an app without one.
 */
export function runningApplication(description: string): RunningApplication | null {
  const match = /\((\S*) - (\d+)\)/.exec(description)
  if (!match) return null
  const pid = Number(match[2])
  if (!Number.isInteger(pid) || pid <= 0) return null
  const bundleId = match[1] && match[1] !== "(null)" ? match[1] : null
  return { pid, bundleId }
}

/** `lsappinfo info -only name -only bundlepath -only bundleid <pid>`'s lines, read. */
export interface AppInfo {
  name: string | null
  bundlePath: string | null
  bundleId: string | null
}

export function appInfo(text: string): AppInfo {
  const value = (key: string) => new RegExp(`"${key}"="([^"]*)"`).exec(text)?.[1] ?? null
  return { name: value("LSDisplayName"), bundlePath: value("LSBundlePath"), bundleId: value("CFBundleIdentifier") }
}
