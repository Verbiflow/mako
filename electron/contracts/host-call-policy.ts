/**
 * What a client may do with a host call whose connection dropped under it.
 *
 * Kept free of imports so the Electron client, the dev web bridge and the
 * host itself read one table. A call has one of three answers:
 *
 * - `read`: it changes nothing, so running it twice is running it once.
 * - `replay`: it is a mutation the host settles by a caller-minted id (a
 *   request, conversation, transfer, action or fork id) or one whose repeat
 *   reaches the same end state (cancel, close, set a mode). The host answers
 *   a repeat with the first acceptance and never starts the work twice, so
 *   the client re-issues it once the host is back instead of telling the
 *   user its outcome is unknown.
 * - `never`: the outcome is unknown and only the user can decide (a commit,
 *   a push, a shell write).
 */
export type HostCallReplay = "read" | "replay" | "never"

const reads = [
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
  "mako:thread-preview",
  "mako:thread-block",
  "mako:thread-archives",
  "mako:harness-descriptors",
  "mako:thread-continuation-plan",
  "mako:thread-continuation-resolve",
  "mako:thread-owner-resolve",
  "mako:list-files",
  "mako:read-file",
  "mako:capabilities",
  "mako:live-snapshot",
  "mako:live-attach",
  "mako:live-locate",
  "mako:live-state",
  "mako:harness-availability",
  /** Answers from the host's readings; a re-read it starts behind the answer is idempotent. */
  "mako:harness-updates",
  "mako:accounts",
  "mako:provider-connections",
  "mako:list-models",
  "mako:list-plugins",
  "mako:usage",
  "mako:crashes",
  "mako:crashes-dir",
  "mako:host-log-path",
  "mako:provider-residency",
  "mako:daemon-status",
  "mako:daemon-login",
  "mako:utility-model-settings",
  "mako:integrations",
  "mako:skills-discover",
  "mako:skills-resolve",
  "mako:automations",
  "mako:external-editors",
  "mako:default-commit-prompt",
  "mako:native-requests",
  "mako:terminal-list",
  "mako:browser-control-status",
  "mako:computer-permissions",
  "mako:computer-driver",
] as const

/**
 * Each entry names the id the host settles the call by, or why a repeat is
 * harmless. Add a channel here only after reading its handler: the host must
 * return the first acceptance for a repeated id and refuse a repeated id whose
 * content differs.
 */
const replays = [
  /** `LiveConversations.submit`: the request id; content is fingerprinted. */
  "mako:live-prompt",
  "mako:live-continue",
  /** `LiveConversations.start`: the conversation id; a second start returns the session. */
  "mako:live-start",
  /** `LiveTransfers.accept`: the transfer id; content is fingerprinted. */
  "mako:live-transfer",
  /** `LiveActions.submit`: the action id. */
  "mako:live-action",
  /** `LiveChildren.delegate`: the child task id. */
  "mako:live-delegate",
  /** `LiveConversations.fork`: the fork id and source point. */
  "mako:live-fork",
  /** `LiveConversations.mergeFork`: the merge id. */
  "mako:live-merge-fork",
  /** `LiveConversations.capture`: the conversation id owns one source path. */
  "mako:live-capture",
  /** `NativeRequests.submit`: the request id; content is fingerprinted. */
  "mako:native-submit",
  /** Cancelling a turn that has already stopped stops nothing. */
  "mako:live-cancel",
  /** Closing a closed conversation is a no-op. */
  "mako:live-close",
  /** Setting the mode a session already has is a no-op. */
  "mako:live-mode",
  /** The ledger keeps one mode per thread; the same write twice is one write. */
  "mako:thread-remember-mode",
] as const

export const readOnlyHostCalls: ReadonlySet<string> = new Set<string>(reads)
export const replayableHostCalls: ReadonlySet<string> = new Set<string>(replays)

export function hostCallReplay(channel: string): HostCallReplay {
  if (readOnlyHostCalls.has(channel)) return "read"
  if (replayableHostCalls.has(channel)) return "replay"
  return "never"
}

/** How long a client waits for the host to come back before it gives a dropped call up. */
export const HOST_CALL_REPLAY_WAIT_MS = 20_000
