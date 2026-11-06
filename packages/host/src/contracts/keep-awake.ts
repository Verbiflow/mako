/** The person's choice for keeping this Mac awake while its agents work (`KeepAwake`). */
export interface KeepAwakeSettings {
  /** Hold off idle sleep while any agent here works: on by default. */
  on: boolean
  /** On power, keep working with the lid closed too: off by default, so a closed lid still sleeps. */
  lidClosed: boolean
}

/** Below this charge on battery, Mako lets the Mac sleep even while agents work. */
export const KEEP_AWAKE_BATTERY_FLOOR = 20

/**
 * Where keeping this Mac awake stands, as every window shows it:
 *
 * - `idle`: agents work and idle sleep is held off; a closed lid still sleeps.
 * - `lid`: agents work, on power, and sleep is held off with the lid closed too.
 * - `low-battery`: agents work, but the battery is below the floor, so the Mac may sleep.
 * - `rest`: nothing is held: no agent works, or the choice is off.
 */
export type KeepAwakeHold =
  | { kind: "idle" | "lid"; agents: number }
  | { kind: "low-battery"; agents: number; percent: number; floor: number }
  | { kind: "rest" }

export interface KeepAwakeState {
  settings: KeepAwakeSettings
  hold: KeepAwakeHold
  /** Why this Mako can't keep the Mac awake (not a Mac, or the helper couldn't be had); absent when it can. */
  unavailable?: string
}
