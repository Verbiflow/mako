import type {
  HarnessUpdateCommand,
  HarnessUpdates,
} from "@mako/host/contracts/harness-updates"

/**
 * A harness that isn't installed here, as every place that offers its install reads it: Settings › Agents, the
 * harness picker and the line above the composer. Decided from the host's reading alone, so a click in one place
 * shows its progress and its outcome in all of them. Kept React-free so the words can be checked without a renderer.
 */
export interface MissingHarness {
  /** The runtime key the install runs under: the harness's own row. */
  id: string
  /** What Mako would run here; none when none of the harness's installers can run on this machine. */
  install?: HarnessUpdateCommand
  /** The version the install puts in place, when it is pinned to the one Mako tested. */
  installs?: string
  installing: boolean
  /** The last install's failure, in Mako's sentence. */
  failure?: string
}

/** How long a finished install still offers its next step, signing in, before it reads as an ordinary harness. */
export const RECENT_INSTALL_MS = 10 * 60_000

/** The harness as its install reads, or nothing once it's installed or before its first reading. */
export function missingHarness(
  updates: HarnessUpdates | null | undefined,
  harness: string | null | undefined
): MissingHarness | undefined {
  const info = harness ? updates?.[harness] : undefined
  if (!harness || !info || info.binary || info.error) return undefined
  if (info.checkedAt === undefined && info.phase !== "installing") return undefined
  return {
    id: harness,
    ...(info.install && { install: info.install }),
    ...(info.installs && { installs: info.installs }),
    installing: info.phase === "installing",
    ...(info.result?.outcome === "failed" && { failure: info.result.message ?? "The installer didn't finish." }),
  }
}

/** Whether Mako installed the harness a moment ago, so its sign-in is the next thing to offer. */
export function justInstalled(
  updates: HarnessUpdates | null | undefined,
  harness: string | null | undefined,
  now = Date.now()
): boolean {
  const result = harness ? updates?.[harness]?.result : undefined
  return result?.outcome === "installed" && now - result.at < RECENT_INSTALL_MS
}

/** The installer in a line: what a script of Mako's own does, else the command as a person would type it. */
export function installPlanText(install: HarnessUpdateCommand): string {
  if (install.summary) return install.summary
  return install.command === "/bin/bash"
    ? (install.args.at(-1) ?? install.command)
    : [install.command, ...install.args].join(" ")
}
