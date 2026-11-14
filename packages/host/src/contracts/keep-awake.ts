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
 * - `lid`: agents work, on power, and macOS was asked to hold off sleep with the lid closed too.
 * - `low-battery`: agents work, but the battery is below the floor, so nothing is held and the Mac may sleep.
 * - `failed`: agents work and the choice is on, but nothing is held: the helper is missing or gone, or macOS refused.
 * - `rest`: nothing is held: no agent works, or the choice is off.
 */
export type KeepAwakeHold =
  | { kind: "idle" | "lid"; agents: number }
  | { kind: "low-battery"; agents: number; percent: number; floor: number }
  | { kind: "failed"; agents: number }
  | { kind: "rest" }

export interface KeepAwakeState {
  settings: KeepAwakeSettings
  hold: KeepAwakeHold
  /** Why this Mako has no Mac to keep awake; absent on a Mac. */
  unavailable?: string
}
