/**
 * The host calls a fixture desk may make.
 *
 * A fixture host runs Mako's interface on a dedicated profile for agents to
 * look at. Every client of it (its own hidden desk windows, Electron windows
 * on its socket and browser pages behind the dev proxy) reaches the same
 * handler table, and that table refuses anything not listed here before
 * arguments are parsed. Each entry was read: it answers from memory or the
 * profile's own stores and starts no provider, process, network request or
 * write. Reads that refresh from a provider, run git, or probe browsers,
 * accounts or applications are left out.
 *
 * Kept free of imports so the host and the dev proxy read one table.
 */
const fixtureReads = [
  /** Builds the workspace shell, which has no provider behind it. */
  "mako:boot",
  "mako:capabilities",
  "mako:lifecycle-state",
  "mako:installation-state",
  "mako:update-state",
  "mako:harness-descriptors",
  "mako:threads",
  "mako:thread-page",
  "mako:thread-preview",
  "mako:thread-block",
  /** Formats a fixture Session's history from memory or the profile's own record. */
  "mako:transcript-document",
  "mako:thread-archives",
  "mako:thread-groups",
  "mako:thread-purposes",
  "mako:thread-titles",
  "mako:worktrees",
  /** Reads and watches HEAD files; runs no git. Finds worktrees made outside Mako. */
  "mako:checkout-heads",
  "mako:workspace-moves",
  "mako:plan-builds",
  "mako:live-snapshot",
  "mako:live-state",
  "mako:live-locate",
  "mako:automations",
  "mako:native-requests",
  "mako:terminal-list",
  "mako:utility-model-settings",
  "mako:harness-order-saved",
  "mako:default-commit-prompt",
  /** Says telemetry is off on a fixture desk; answers from memory. */
  "mako:telemetry",
] as const

export const fixtureDeskHostCalls: ReadonlySet<string> = new Set<string>(fixtureReads)

/**
 * The Mako account, so agents can look at signing in. These reach the network, but only a
 * cloud on this Mac's loopback: on a fixture desk `CloudAccounts` refuses any other, and it
 * keeps the sign-in in memory, so the profile isn't written.
 */
export const fixtureCloudHostCalls: ReadonlySet<string> = new Set<string>([
  "mako:cloud-account",
  "mako:cloud-sign-in",
  "mako:cloud-sign-in-cancel",
  "mako:cloud-devices",
  "mako:cloud-device-remove",
  "mako:cloud-sign-out",
])

/**
 * Calls the launcher makes on the host's socket to replace a fixture host
 * built from older source. They stop only that host. Pages never get them:
 * the dev proxy refuses them and in-process windows are not on the socket.
 */
export const fixtureLauncherHostCalls: ReadonlySet<string> = new Set<string>([
  "mako:lifecycle-command",
])

export const FIXTURE_REFUSED_CODE = "fixture-refused"

export class FixtureDeskRefusedError extends Error {}

/** The refusal for a channel a fixture desk may not call, or undefined when it may. */
export function fixtureDeskRefusal(channel: string, transport: "page" | "socket" = "page"): string | undefined {
  if (fixtureDeskHostCalls.has(channel) || fixtureCloudHostCalls.has(channel)) return undefined
  if (transport === "socket" && fixtureLauncherHostCalls.has(channel)) return undefined
  return `The fixture desk refused ${channel.slice(0, 80)} before it reached the host: a fixture desk only reads, and writes, provider calls and processes are not available in it.`
}
