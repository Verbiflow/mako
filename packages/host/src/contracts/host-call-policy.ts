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
  /**
   * A client's tabs, conversations and models as they are, opening its first tab if it has none: asked twice, the same
   * answer. A cloud start asks it first, so marked so, its Thread sends it on without waiting for the disk.
   */
  "mako:boot",
  /** Changes nothing Mako keeps: terminals reconnect and the sign-in refreshes, and wakes within ten seconds are one (`watchWake`). */
  "mako:machine-woke",
  /** Warms the MCP listing a launch in that folder reads; nothing else sees it. */
  "mako:launch-prewarm",
  /** The Threads at work here a handoff would take, and the person's choice for sleep, as they stand. */
  "mako:handoff-candidates",
  "mako:handoff-settings",
  /** The conversations held since this Mac went away; reads what `AwayNotes` holds. */
  "mako:handoff-away-held",
  "mako:conversation-settings",
  /** Where keeping this Mac awake stands; reads what `KeepAwake` holds. */
  "mako:keep-awake",
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
  /** A turn's diff of one file in stretches, for another device; reads what `live-turn-diff` reads. */
  "mako:live-turn-hunks",
  "mako:live-turn-writers",
  /** What an undo would do, read from the journal; nothing is written. */
  "mako:live-turn-undo-preview",
  "mako:git-doctor",
  "mako:github-status",
  "mako:pull-request",
  "mako:pull-requests",
  /** Asks GitHub and keeps its answer for 30 seconds; changes nothing GitHub or Mako holds. */
  "mako:pull-request-search",
  "mako:pull-branches",
  "mako:lifecycle-state",
  "mako:installation-state",
  /** Fetches the update source's upstream into its remote-tracking branch and reads the checkout; asked twice, the same answer. */
  "mako:check-update-source",
  "mako:update-state",
  "mako:threads",
  "mako:thread-page",
  "mako:thread-preview",
  "mako:thread-entry",
  /** Reads the bytes one saved entry was read from, by the entry's id; the renderer never names a file. */
  "mako:thread-original",
  /** Lists a session's child agents from the stores and the archive; reads no transcript. */
  "mako:thread-children",
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
  "mako:worktree-retention",
  "mako:snapshot-budget",
  "mako:thread-scratch",
  /** Measures Mako's folders with `du`; writes nothing. */
  "mako:storage",
  "mako:worktree-review",
  "mako:worktree-review-diffs",
  "mako:worktree-branches",
  "mako:worktree-pulls",
  "mako:worktree-summaries",
  "mako:worktree-removal",
  "mako:checkout-heads",
  "mako:chat-folders",
  "mako:workspace-moves",
  "mako:workspace-move-hold",
  "mako:workspace-move-outcome",
  "mako:thread-changes",
  "mako:change-usage",
  "mako:resolve-file-references",
  /** Copies a turn's media by its content's hash and keeps the answer by call: asked twice, the same copy and answer. */
  "mako:resolve-turn-media",
  "mako:lost-versions",
  "mako:plan-builds",
  "mako:harness-descriptors",
  "mako:access-choices",
  "mako:thread-continuation-plan",
  "mako:thread-restore-plan",
  /** Weighs a Thread's harnesses against what the cloud says it runs; changes nothing. */
  "mako:thread-harness-check",
  "mako:unread-records",
  "mako:store-formats",
  "mako:stream-original",
  "mako:thread-continuation-resolve",
  "mako:thread-owner-resolve",
  "mako:list-files",
  "mako:files-folders",
  "mako:files-find",
  "mako:live-files-folders",
  "mako:live-files-find",
  /** A text search changes nothing; a newer one in the same folder stops the last. */
  "mako:files-grep",
  "mako:live-files-grep",
  "mako:read-file",
  "mako:capabilities",
  "mako:live-snapshot",
  /** A Thread's children, a child's report or transcript, and a wait for the next report (`contracts/agent-tools.ts`). */
  "mako:agents-list",
  "mako:agents-read",
  "mako:agents-wait",
  /** What this host offers as a place for Fins, as it stands. */
  "mako:agents-capabilities",
  /** Simulators' setup line as it stands, re-read when asked; changes nothing on this Mac. */
  "mako:simulator-setup",
  /** What the hosts run, who holds each simulator, a page or console read, and a screenshot (`contracts/simulators.ts`). */
  "mako:simulators-list",
  "mako:simulators-read",
  "mako:simulators-shot",
  /** A viewer's next packets of a simulator's screen: a repeat answered with the first answer loses nothing it can't redraw from the next key frame. */
  "mako:simulators-watch",
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
  /** How this device's Sessions stand in the account, as last read. */
  "mako:sync-status",
  /** How this device's sync goes, from memory. */
  "mako:sync-readings",
  /** Mako's processes from `ps`, and its file watching from memory. */
  "mako:mako-footprint",
  /** fseventsd's health from memory; the restart is never repeated by a client (`mako:file-events-restart`). */
  "mako:file-events-service",
  /** The continues in the cloud this Mac pressed or its list says, from memory. */
  "mako:continue-readings",
  /** Asks the account what a continue would take now; asked twice, it's asked twice. */
  "mako:thread-continue-offer",
  /** Turning the cloud on, read from what owns each step; keeps only when each was first seen done. */
  "mako:cloud-turn-on",
  /** Asks the cloud again what the account has: a repeat asks the same. */
  "mako:cloud-turn-on-check",
  /** May refresh the connection token, which another caller would have refreshed the same way. */
  "mako:cloud-devices",
  "mako:cloud-browser-sessions",
  /** Reads every harness's sign-in and sends what changed; a repeat finds nothing changed. */
  "mako:cloud-sign-ins",
  /** A project's carried files and where each stands in the cloud, read, never sent. */
  "mako:cloud-carried-files",
  /** A project's Setup: what each place reads of itself and what the broker grants, read, never changed. */
  "mako:setup",
  /** Who the account's own GitHub token belongs to, read from the cloud; never the token. */
  "mako:github-token",
  /** Who the account's cloud commits and pull requests are authored as, read from the cloud. */
  "mako:github-authorship",
  /** Waits on a sign-in the host finishes by itself, whoever is waiting. */
  "mako:account-login-wait",
  "mako:native-authoring-catalog",
  "mako:native-authoring-view",
  /** Reads the files a change would touch and writes nothing. */
  "mako:native-authoring-preview",
  "mako:provider-connections",
  "mako:list-models",
  "mako:list-plugins",
  "mako:usage",
  "mako:crashes",
  "mako:crashes-dir",
  "mako:host-log-path",
  "mako:provider-residency",
  "mako:agents-diagnostics",
  "mako:native-routing",
  "mako:daemon-status",
  "mako:session-reader-history",
  "mako:daemon-login",
  "mako:utility-model-settings",
  /** Read from one small file; never a key. */
  "mako:model-connections",
  /** Asks Ollama's and LM Studio's usual ports on this Mac what they have loaded. */
  "mako:model-connection-local",
  "mako:harness-order-saved",
  /** Reads Settings › Fins and what the person used on each harness from one small file. */
  "mako:fin-defaults",
  "mako:integrations",
  "mako:skills-discover",
  "mako:skills-resolve",
  "mako:automations",
  "mako:automation-context",
  "mako:external-editors",
  "mako:default-commit-prompt",
  "mako:native-requests",
  "mako:terminal-list",
  "mako:browser-control-status",
  /** Lists tabs; changes nothing. */
  "mako:element-pick-targets",
  /** Reads a pick's state; it is kept a minute after it ends, so a repeat reads the same outcome. */
  "mako:element-pick-wait",
  "mako:computer-permissions",
  "mako:computer-driver",
  /** The driver broker's readout: who is connected and what they are doing. */
  "mako:computer-driver-connections",
  "mako:telemetry",
] as const

/**
 * Each entry names the id the host settles the call by, or why a repeat is
 * harmless. Add a channel here only after reading its handler: the host must
 * return the first acceptance for a repeated id and refuse a repeated id whose
 * content differs.
 */
const replays = [
  /** Replaces the same retirement settings; never removes a checkout in this call. */
  "mako:worktree-retention-set",
  /** Replaces the same scratch settings; preview does not remove anything. */
  "mako:snapshot-budget-set",
  "mako:thread-scratch-set",
  /** Snoozes fseventsd's notice until the day ends: a repeat sets the same snooze. */
  "mako:file-events-dismiss",
  /** `MakoStorage.free`: a pass asked for while one runs is that pass, and a second finds nothing more to free. */
  "mako:storage-free",
  /** `LiveConversations.submit`: the request id; content is fingerprinted. */
  "mako:live-prompt",
  "mako:live-continue",
  /** `LiveConversations.holdUntil`, through `submit`: the request id; the repeated words are the failed request's. */
  "mako:live-hold-until",
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
  /** A spawn, a link, a report, a message and an answer are settled by the caller's key; stopping a stopped child stops nothing. */
  "mako:agents-start",
  "mako:agents-move",
  "mako:agents-link",
  "mako:agents-report",
  "mako:agents-send",
  "mako:agents-answer",
  "mako:agents-settle",
  "mako:agents-stop",
  /** A start for an Apex on another device is settled by its op: a repeat answers the same Fin. */
  "mako:agents-place",
  /** A placed Fin's notice is kept once by its report's ID: a repeat is heard as the same one. */
  "mako:agents-notice",
  /** A stop of a placed start is kept by the start's op: a repeat stops nothing more and answers the same. */
  "mako:agents-cancel",
  /** The moved message's id names the one it becomes; a message already moved is withdrawn once. */
  "mako:agents-redirect",
  /** The person's message to a Fin is settled by its request id: a repeat answers the first delivery. */
  "mako:agents-direct",
  /** The person's answer to a Fin's ask is settled by its request id: a repeat answers once. */
  "mako:agents-respond",
  /** A move is settled by its id: a repeat is the same move. */
  "mako:agents-continue-next",
  /** Cancelling a turn that has already stopped stops nothing. */
  "mako:live-cancel",
  /** Stopping a background task that has already ended stops nothing. */
  "mako:live-stop-agent",
  /** Closing a closed conversation is a no-op. */
  "mako:live-close",
  /** Waking a conversation that is awake or already waking does nothing more. */
  "mako:live-prewarm",
  /** Making a cloud Thread ahead that is already made touches it again: one per folder's repository. */
  "mako:cloud-prepare",
  /** Offered once per account on this Mac: a repeat finds it offered. */
  "mako:cloud-offer-projects",
  /** Asking again for the bases that failed: a base asked for twice is one base. */
  "mako:cloud-turn-on-retry-bases",
  /** A move is settled by its id: a repeat joins the move running, or answers how it went. */
  "mako:thread-move",
  /** A continue is settled by its op ID, here and in the account: a repeat joins the press running, or carries it on there. */
  "mako:thread-continue",
  /** A return is settled by its id: a repeat joins the return running, or answers how it went. */
  "mako:thread-return",
  /** `ThreadMoveTool.move`: the move is named by the caller's key, so a repeat joins it or answers how it went. */
  "mako:threads-move",
  /** `ThreadActTool.act`: named by the caller's key, as Rename and Archive are by their operation. */
  "mako:threads-act",
  /** `SettingsTool.call`: a read, or a setting set to a value; asked twice, the same end state. */
  "mako:settings-act",
  /** `HarnessTool.act`: a repeat under its key gets the first outcome (`OnceByKey`), and after a restart an install under way refuses a second and one done is the same end state. */
  "mako:harnesses-act",
  /** `AgentAskGate.answer`: the ask's id; an answered ask ignores a repeat. */
  "mako:agent-ask-answer",
  /** Whether a machine has its folder for a move only reads. */
  "mako:move-ready",
  /** A move staged again stages the same, or what the device sent since: nothing of it is the machine's own yet. */
  "mako:move-stage",
  /** A move's arrival on a machine is marked by its id: a repeat answers what it did without doing it again. */
  "mako:move-arrive",
  /** A Thread's departure for its device: a repeat finds it released, sends the same checkpoint by its hash, and only what's new of the records. */
  "mako:move-depart",
  /** Following a Thread's checkout on its machine only reads it, sending each checkpoint by its hash. */
  "mako:move-follow",
  /** A Thread staying on its machine after a departure: a repeat finds it there and changes nothing. */
  "mako:move-stay",
  /** Cancelling a sign-in that has ended cancels nothing. */
  "mako:account-login-cancel",
  /** Cancelling a Mako sign-in that has ended cancels nothing. */
  "mako:cloud-sign-in-cancel",
  /** Signing out a Mac that is signed out is a no-op. */
  "mako:cloud-sign-out",
  /** Sharing, or not, a second time is the same choice. */
  "mako:cloud-sign-ins-share",
  /** The same word for a project twice is one: a sync after sends only what changed, by its hash. */
  "mako:cloud-carried-files-decide",
  /** Keeping a file on this Mac, or copying it again, a second time is the same end state. */
  "mako:cloud-carried-files-keep",
  /** The same token saved twice is kept once; removing it twice leaves it off. */
  "mako:github-token-save",
  "mako:github-token-remove",
  /** Choosing who cloud commits are authored as a second time is the same choice. */
  "mako:github-authorship-save",
  /** Setting the mode a session already has is a no-op. */
  "mako:live-mode",
  /** The ledger keeps one mode per thread; the same write twice is one write. */
  "mako:thread-remember-mode",
  /** `ThreadStore.createSession`: the operation id is receipted; a repeat returns the first Session. */
  "mako:thread-create-session",
  /** Each Thread's move is named by the handoff's id: a repeat joins the moves it began, or answers how they went. */
  "mako:handoff",
  /** Setting the same choice again leaves the same choice. */
  "mako:handoff-settings-set",
  /** Sessions let go once are let go: a repeat lets go of none. */
  "mako:handoff-run-here",
  /** The same settings saved twice are one choice. */
  "mako:conversation-settings-set",
  /** The same choice saved twice is one choice. */
  "mako:keep-awake-set",
  /** `LiveAutoContinue.continueNow`: the request id is the continuation's; a repeat finds it and changes nothing. */
  "mako:live-continue-turn",
  /** `ThreadStore.renameThread` and `clearThreadTitle`: the operation id is receipted. */
  "mako:thread-rename",
  /** Importing names only fills Threads that have none, so a repeat changes nothing. */
  "mako:thread-titles-import",
  /** Choosing a task's model a second time is the same choice. */
  "mako:utility-choice",
  /** Saving the same harness order again leaves the same order. */
  "mako:harness-order",
  /** `FinDefaultsStore.choose`: the same choice for a harness saved twice is one choice. */
  "mako:fin-default-choose",
  /** `FinDefaultsStore.savePolicy`: the whole policy replaces the last, so saving it twice is saving it once. */
  "mako:fin-policy-save",
  /** `FinDefaultsStore.saveRoleRules`: the same words for a role saved twice are saved once. */
  "mako:fin-role-rules-save",
  /** `FinDefaultsStore.setLimit`: the same number saved twice is one choice. */
  "mako:fin-limit-set",
  /** `FinDefaultsStore.setCeiling`: the same number saved twice is one choice. */
  "mako:fin-ceiling-set",
  /** `FinDefaultsStore.chooseMoveOnLimit`: the same switch set twice is set once. */
  "mako:fin-move-on-limit",
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
  /** `WorkspaceMoves.bring`: sets the request's choice; the same choice again changes nothing. */
  "mako:workspace-move-bring",
  /** `ThreadWorktreeService.bringStayed`: a move whose changes were brought answers the same again. */
  "mako:workspace-move-bring-stayed",
  /** `ThreadWorktreeService.putBack`: a file put back leaves the move's plan, so putting it back again writes nothing. */
  "mako:workspace-move-put-back",
  /** `Attribution.restore`: writes one kept version; writing it again leaves the same file. */
  "mako:restore-version",
  /** `Attribution.chooseFile`: one row a Thread's spelling; the same pick again writes the same row. */
  "mako:choose-file-reference",
  /** `AccessChoiceStore.choose`: the same choice again changes nothing. */
  "mako:access-choose",
  /** `AccessChoiceStore.adopt`: takes only where no choice is made, so a repeat takes nothing. */
  "mako:access-adopt",
  /** `PlanBuilds.record`: keyed by plan id, and a build no newer than the recorded one changes nothing. */
  "mako:plan-build-record",
  /** `PlanBuilds.claim`: the claim id; a repeat gets the first answer. */
  "mako:plan-build-claim",
  /** `PlanBuilds.release`: the claim id; a released claim releases nothing. */
  "mako:plan-build-release",
  /** `ElementPicks.start`: the pick id; a repeat answers with that pick's state. */
  "mako:element-pick-start",
  /** Cancelling a pick that has ended cancels nothing. */
  "mako:element-pick-cancel",
  /** `Simulators.open`: the Thread that holds it opens it again; a booted simulator boots as it is. */
  "mako:simulators-open",
  /** `Simulators.record`: a recording started or stopped already answers as it stands. */
  "mako:simulators-record",
  /** `Simulators.release`: a released simulator releases nothing. */
  "mako:simulators-release",
] as const

export const readOnlyHostCalls: ReadonlySet<string> = new Set<string>(reads)
export const replayableHostCalls: ReadonlySet<string> = new Set<string>(replays)

export function hostCallReplay(channel: string): HostCallReplay {
  if (readOnlyHostCalls.has(channel)) return "read"
  if (replayableHostCalls.has(channel)) return "replay"
  return "never"
}

/**
 * Calls a Thread's runtime needn't be woken for: where it's asleep (a cloud Thread's paused machine), the gateway
 * takes the call at once and delivers it when the runtime next wakes. Only a call whose answer nobody waits on and
 * whose repeat is harmless: closing a conversation that is already quiet.
 */
export const deferredWhenAsleep: ReadonlySet<string> = new Set<string>(["mako:live-close"])

/** How long a client waits for the host to come back before it gives a dropped call up. */
export const HOST_CALL_REPLAY_WAIT_MS = 20_000
