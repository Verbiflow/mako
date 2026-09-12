import type { hostCallInputs } from "./contracts/host-call-inputs.js"
import { RuntimeDisconnectedError } from "./runtime-connection.js"

type HostChannel = keyof typeof hostCallInputs

/**
 * Calls the window may repeat once the shared host is back.
 *
 * Every entry reads state and nothing else, so running it twice is the same as
 * running it once. A mutation never appears here: when the host drops under a
 * stage, commit, prompt or push, the caller is told the outcome is unknown and
 * decides for itself.
 */
const recoverable = [
  "mako:git-status",
  "mako:git-diff",
  "mako:git-diff-all",
  "mako:git-log",
  "mako:git-commit-files",
  "mako:git-commit-file-diff",
  "mako:git-commit-diff-all",
  "mako:github-status",
  "mako:pull-request",
  "mako:pull-requests",
  "mako:pull-branches",
  "mako:lifecycle-state",
  "mako:installation-state",
  "mako:update-state",
  "mako:threads",
  "mako:thread-page",
  "mako:thread-archives",
  "mako:thread-resumable",
  "mako:thread-continue-targets",
  "mako:list-files",
  "mako:read-file",
  "mako:capabilities",
  "mako:live-capabilities",
  "mako:harness-availability",
  "mako:accounts",
  "mako:list-models",
  "mako:list-plugins",
  "mako:usage",
  "mako:crashes",
  "mako:crashes-dir",
  "mako:host-log-path",
  "mako:daemon-status",
  "mako:daemon-login",
  "mako:utility-model-settings",
  "mako:integrations",
  "mako:automations",
  "mako:external-editors",
  "mako:default-commit-prompt",
  "mako:native-requests",
  "mako:terminal-list",
  "mako:browser-control-status",
  "mako:computer-permissions",
  "mako:computer-driver",
] satisfies HostChannel[]
export const recoverableHostCalls: ReadonlySet<string> = new Set<string>(recoverable)

export interface RecoveryLink {
  /** Called once per dropped call, before any retry, so the window can show the reconnect banner. */
  lost(): void
  /** Resolves true once the event stream is attached to a host again, false on timeout. */
  whenConnected(timeoutMs: number): Promise<boolean>
}

/**
 * Run one host call; if the host drops under it and the call is safe to repeat,
 * wait for the reconnect and run it once more against whatever host answers.
 */
export async function invokeWithRecovery<T>(
  channel: string,
  run: () => Promise<T>,
  link: RecoveryLink,
  timeoutMs = 20_000
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof RuntimeDisconnectedError)) throw error
    link.lost()
    if (!recoverableHostCalls.has(channel)) throw error
    if (!(await link.whenConnected(timeoutMs))) throw error
    return run()
  }
}
