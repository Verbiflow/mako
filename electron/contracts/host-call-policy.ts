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
  /** Changes nothing Mako keeps: terminals reconnect and the sign-in refreshes, and wakes within ten seconds are one (`watchWake`). */
  "mako:machine-woke",
  /** Warms the MCP listing a launch in that folder reads; nothing else sees it. */
  "mako:launch-prewarm",
  "mako:git-status",
  "mako:git-diff",
  "mako:git-diff-all",
  "mako:git-log",
  "mako:git-commit-files",
  "mako:git-commit-file-diff",
  "mako:git-commit-diff-all",
  "mako:git-changed-since",
  "mako:git-default-branch",
  "mako:git-since-diff",
  "mako:live-turn-changes",
  "mako:live-turn-diff",
  "mako:git-doctor",
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
  "mako:transcript-document",
  "mako:thread-archives",
  "mako:thread-groups",
  "mako:thread-purposes",
  "mako:thread-titles",
  "mako:thread-app-marks",
  /** Reads the app's processes and files; what it records of them only moves its own read point forward. */
  "mako:thread-app-probe",
  "mako:thread-app-room",
  "mako:project-app-setup",
  "mako:worktrees",
  "mako:worktree-ahead",
  "mako:worktree-inventory",
  "mako:worktree-review",
  "mako:worktree-review-diffs",
  "mako:worktree-branches",
  "mako:worktree-pulls",
  "mako:worktree-summaries",
  "mako:worktree-removal",
  "mako:checkout-heads",
  "mako:chat-folders",
  "mako:workspace-moves",
  "mako:plan-builds",
  "mako:harness-descriptors",
  "mako:thread-continuation-plan",
  "mako:thread-continuation-resolve",
  "mako:thread-owner-resolve",
  "mako:list-files",
  "mako:read-file",
  "mako:capabilities",
  "mako:live-snapshot",
  "mako:live-context-breakdown",
  "mako:live-read",
  "mako:live-attach",
  "mako:live-locate",
  "mako:live-state",
  "mako:harness-availability",
  /** Answers from the host's readings; a re-read it starts behind the answer is idempotent. */
  "mako:harness-updates",
  "mako:accounts",
  /** Answers from memory once a saved sign-in has been read back. */
  "mako:cloud-account",
  /** May refresh the connection token, which another caller would have refreshed the same way. */
  "mako:cloud-devices",
  /** Waits on a sign-in the host finishes by itself, whoever is waiting. */
  "mako:account-login-wait",
  "mako:native-authoring-catalog",
  "mako:native-authoring-list",
  "mako:native-authoring-read",
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
  "mako:harness-order-saved",
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
  "mako:telemetry",
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
  "mako:live-steer-queued",
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
  /** Waking a conversation that is awake or already waking does nothing more. */
  "mako:live-prewarm",
  /** Cancelling a sign-in that has ended cancels nothing. */
  "mako:account-login-cancel",
  /** Cancelling a Mako sign-in that has ended cancels nothing. */
  "mako:cloud-sign-in-cancel",
  /** Signing out a Mac that is signed out is a no-op. */
  "mako:cloud-sign-out",
  /** Setting the mode a session already has is a no-op. */
  "mako:live-mode",
  /** The ledger keeps one mode per thread; the same write twice is one write. */
  "mako:thread-remember-mode",
  /** `ThreadStore.createSession`: the operation id is receipted; a repeat returns the first Session. */
  "mako:thread-create-session",
  /** `ThreadStore.renameThread` and `clearThreadTitle`: the operation id is receipted. */
  "mako:thread-rename",
  /** Importing names only fills Threads that have none, so a repeat changes nothing. */
  "mako:thread-titles-import",
  /** Choosing a task's model a second time is the same choice. */
  "mako:utility-choice",
  /** Saving the same harness order again leaves the same order. */
  "mako:harness-order",
  /** `Telemetry.choose`: the same choice saved twice is one choice. */
  "mako:telemetry-choose",
  /** `ThreadWorktreeService.want`: stamps the project wanted and tops its spares up to a fixed count. */
  "mako:worktree-want",
  /** `ThreadWorktreeService.skip`: a start already skipped, or past its worktree, ignores a repeat. */
  "mako:worktree-skip",
  /** `WorktreeStarts.point`: at most a fetch of the upstream, which a repeat within a minute skips. */
  "mako:worktree-start-point",
  /** `WorkspaceMoves.answer`: the request id; an answered request ignores a repeat. */
  "mako:workspace-move-answer",
  /** Forgetting a project that isn't remembered is a no-op. */
  "mako:workspace-move-forget",
  /** `PlanBuilds.record`: keyed by plan id, and a build no newer than the recorded one changes nothing. */
  "mako:plan-build-record",
  /** `PlanBuilds.claim`: the claim id; a repeat gets the first answer. */
  "mako:plan-build-claim",
  /** `PlanBuilds.release`: the claim id; a released claim releases nothing. */
  "mako:plan-build-release",
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
