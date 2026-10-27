import { compareVersions } from "./runtime-version.js"

/**
 * Every version of a runtime Mako bundles that this repository pinned, and
 * when the commit that pinned it was made (`git log --all` over every
 * `package.json` naming the package). Mako's own sessions of a bundled runtime
 * from before their streams named its version are bounded by it: the newest
 * version pinned on or before a session's last write is the newest Mako ran
 * it with, a `range` whose `bound` is `pins`.
 *
 * It's the repository's history, not proof of which build ran: a checkout
 * may run a version before the commit that pins it lands. `scripts/test-restore-versions.ts`
 * holds this table to the history, so a new pin is added here in the same change.
 */
export const MAKO_PINS = [
  { package: "@cursor/sdk", version: "1.0.31", since: "2026-09-13T22:35:45-07:00", commit: "c5fe8133" },
  { package: "@cursor/sdk", version: "1.0.40", since: "2026-10-25T08:36:53Z", commit: "eedbf8ae" },
] as const satisfies readonly MakoPin[]

export interface MakoPin {
  package: string
  version: string
  /** The pinning commit's time, as `git log` prints it. */
  since: string
  commit: string
}

/** The newest version of `npmPackage` Mako's repository pinned by `time`, or null when it pinned none by then. */
export function pinnedBy(npmPackage: string, time: number, pins: readonly MakoPin[] = MAKO_PINS): MakoPin | null {
  const by = pins.filter((pin) => pin.package === npmPackage && Date.parse(pin.since) <= time)
  return by.reduce<MakoPin | null>((best, pin) => (!best || compareVersions(pin.version, best.version) > 0 ? pin : best), null)
}
