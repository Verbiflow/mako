import type { AccountDeviceEvent } from "@mako/protocol/account-events"
import type { LifecycleState, LifecycleAction, UpdateInstallation } from "./app-lifecycle.js"
import type { CloudArchiveStep, ThreadArchiveSnapshot } from "./thread-lifecycle.js"
import type { CheckoutHeads } from "./checkout-heads.js"
import type { MoveOutcome, WorkspaceMoves } from "./workspace-moves.js"
import type { PlanBuilds } from "./plan-builds.js"
import type { ThreadGroupChange } from "./thread-groups.js"
import type { ThreadPurpose } from "./thread-purposes.js"
import type { StoreFormats } from "./store-formats.js"
import type { FileEventsService } from "./file-events-service.js"
import type { McpSignIns } from "./mcp-sign-ins.js"
import type { ThreadTitleEntry } from "./thread-titles.js"
import type { ThreadMarkEntry } from "./thread-marks.js"
import type { Entry } from "@mako/sessions/entries"
import type { WorktreeStep, WorktreeSummary, WorktreeSummaryChanges } from "./thread-worktrees.js"
import type { MachineOffer } from "./machine-offer.js"
import type { CloudSignInsState } from "./cloud-sign-ins.js"
import type { CloudStartStep, ThreadContinueStep, ThreadMoveStep, ThreadReturnStep } from "./cloud-threads.js"
import type {
  ControlActivity,
  BrowserControlStatus,
} from "@mako/control-runtime/contracts"
import type { NativeRequest } from "./native-requests.js"
import type { AccountRemovalEvent, AccountUsage } from "./accounts.js"
import type { ProcessPlatform } from "./platform.js"
import type { AppshotShortcutWatch } from "./appshot-shortcut.js"
import type { CompactLiveBatch, LiveAhead, LiveBatch, LiveSummary } from "./live-conversations.js"
import type {
  ThreadRef as CatalogThreadRef,
} from "@mako/sessions"
import type { UpdateState } from "./automations-usage-updates.js"
import type { AutomationProjectReading, AutomationRun } from "./automations.js"
import type {
  ChatMessage,
  ModelInfo,
  SessionMeta,
  SessionState,
  ThreadRunState,
  TreeNode,
} from "./conversation-session.js"
import type { GitStatus } from "./git-workspace-search.js"
import type { ProviderConnection } from "./provider-connection.js"
import type { CloudAccount } from "./cloud-account.js"
import type { HarnessUpdates } from "./harness-updates.js"
import type { Capabilities } from "./mcp-skills-integrations.js"
import type { HarnessProfile } from "./providers-acp.js"

/**
 * The wire contract between the host and the renderer.
 *
 * Design rule: the hot path (token streaming) must never re-send the whole
 * session. `stream` carries one message; `meta` carries scalars; the heavy
 * payloads (`messages`, `tree`, `git`) are emitted only when they change.
 */
export interface ExternalThreadActivity {
  provider: string
  since: number
  status: "active" | "needs-input" | "open"
  detail?: string
  /**
   * `writes` when `active` was inferred from the store being written while
   * a process or another host holds the session, rather than reported by
   * the process. A pause in writes is not a finished turn, so a settle back
   * to `open` from such activity is never announced as an outcome.
   */
  evidence?: "writes"
}

export type HostEventBody =
  | { type: "view-hint"; hint: import("./view-hints.js").ViewHint }
  | { type: "application-lifecycle"; lifecycle: LifecycleState }
  | { type: "installation"; installation: UpdateInstallation }
  | { type: "app-command"; command: "app.quit" | "app.updates" | "workspace.open" }
  /** The desktop app was handed a folder (dropped on its Dock icon, or `open -a Mako <folder>`): open it as a project. */
  | { type: "app-open-project"; path: string }
  /** How a clone a window asked for stands (`mako:project-clone`). */
  | { type: "project-clone"; clone: import("./projects.js").CloneProgress }
  /** The host's scan of home for checkouts finished (`mako:folders-found`). */
  | { type: "folders-found"; found: import("./projects.js").FoundCheckouts }
  | { type: "app-shutdown"; requestId: string; action: LifecycleAction }
  | { type: "host-disconnected"; message: string; gone?: true }
  | { type: "host-reconnected" }
  | { type: "thread-archives"; snapshot: ThreadArchiveSnapshot }
  | { type: "cloud-archive-step"; step: CloudArchiveStep }
  /** A followed checkout's HEAD moved, by folder; window-wide. */
  | { type: "checkout-heads"; heads: CheckoutHeads }
  /**
   * Every worktree's summary, the whole list, said whenever one changes (`ThreadWorktreeService.followSummaries`);
   * window-wide. The form a window knew before `worktree-summary-changes`: a host says it until a window has asked
   * for changes and none for the whole list.
   */
  | { type: "worktree-summaries"; summaries: WorktreeSummary[] }
  /** The summaries that changed, each as it was read, and the worktrees that went (`followSummaryChanges`); window-wide. */
  | ({ type: "worktree-summary-changes" } & WorktreeSummaryChanges)
  /** What an inventory listed as measured or read behind it is in, sizes or statuses: the next `mako:worktree-inventory` has them. */
  | { type: "worktree-sizes" }
  /** A new Thread's worktree is checked out; its provider starts next. */
  | { type: "worktree-ready"; conversationId: string }
  | { type: "worktree-step"; conversationId: string; step: WorktreeStep }
  /**
   * The conversation's running `mako-computer` `js` call's steps so far, as its program's calls move; `null` once
   * that call has answered. One program runs at a time in a conversation's control session, so these are its oldest
   * call still running.
   */
  | { type: "tool-steps"; conversationId: string; steps: import("./tool-steps.js").ToolSteps | null }
  /**
   * A new cloud conversation's start: `preparing` while its machine and its copy of `project` come up, `starting`
   * once the harness is starting there. A start whose machine was ready from the composer goes straight to `starting`.
   */
  | { type: "cloud-start-step"; conversationId: string; step: CloudStartStep; project: string }
  /** A Thread's move to the cloud (`mako:thread-move`), step by step, for the conversation it was asked from. */
  | { type: "thread-move-step"; conversationId: string; move: string; step: ThreadMoveStep }
  /** Continue in the cloud pressed here for another device's Thread (`mako:thread-continue`), step by step, for the conversation it was pressed from. */
  | { type: "thread-continue-step"; conversationId: string; op: string; step: ThreadContinueStep }
  /**
   * A Thread running in the cloud whose worktree here stopped following it: the person changed it here (`folders`), so
   * nothing more is laid over it, and the way back merges both. Said for each of its conversations here.
   */
  | { type: "thread-follow-stopped"; conversations: string[]; folders: string[]; at: number }
  /** The conversations whose Sessions wait for the account's word since this Mac went away (`AwayNotes`), the whole list each time. */
  | { type: "away-held"; conversations: string[] }
  /** A Thread the cloud took while this Mac was away left these files of its own in the project folder: not as the cloud has them. */
  | { type: "checkout-stayed"; conversation: string; paths: string[]; unpushed: number }
  | { type: "thread-return-step"; conversationId: string; move: string; step: ThreadReturnStep }
  /**
   * The cloud's word on a cloud Thread's work, as its object says it in the Thread's stream, only when the person's own
   * work is affected: changes its machine couldn't keep, or a Thread that can't carry on without them. For each of the
   * Thread's conversations this host shows; the newest stands.
   */
  | { type: "cloud-machine-notice"; conversationIds: string[]; notice: import("@mako/protocol/saves").ThreadMachineNotice }
  /** An agent's tool changed this device's worktrees; windows read them again. */
  | { type: "worktrees-changed" }
  /**
   * Every app on this Mac that isn't stopped, as the sidebar marks them, said when anything about the apps changed:
   * their marks, a run's state, a check or an install ending. Windows read a followed folder's app again on it.
   */
  | { type: "thread-app-marks"; marks: import("./thread-app.js").AppMark[] }
  /** An agent's tool pushed, opened or merged a pull request; windows read GitHub and the worktrees' summaries again. */
  | { type: "github-changed" }
  /** Agents' requests to move onto their Thread's own branch, and the projects that always allow it. */
  | { type: "workspace-moves"; moves: WorkspaceMoves }
  /** Agents' asks to move their Thread to the cloud (`thread_move` below full access), which the person answers above its composer. */
  /** The host's record of built plans changed; window-wide. */
  | { type: "plan-builds"; builds: PlanBuilds }
  /** The person's access choices changed, here or on another device (`contracts/access-choices.ts`); window-wide. */
  | { type: "access-choices"; choices: import("./access-choices.js").AccessChoices }
  /** The preferences that follow the person's account, as they're in effect now (`contracts/preferences.ts`). */
  | { type: "fin-defaults"; reading: import("./fin-tuning.js").FinChoicesReading }
  | { type: "preferences"; values: import("./preferences.js").PreferenceValues }
  /**
   * A move's "Bring these" or "Put back" happened, from a window or by the Thread's agent with worktree_bring: the card
   * above `conversationId`'s composer shows the move as it is now. Older windows ignore it.
   */
  | { type: "workspace-move-adjusted"; conversationId: string; outcome: MoveOutcome }
  /** An agent's allowed move happened: `from` is archived and `to` goes on in the worktree. */
  | {
      type: "workspace-moved"; from: string; to: string; branch?: string; changed: number
      /** What came along and what stayed in the main checkout, by whose it is; older hosts send only `changed`. */
      outcome?: MoveOutcome
      /** Its agent was sent a message to carry on there; false for a Session that followed quietly. Older hosts leave it out, and told every one. */
      told?: boolean
      /** For a Session that followed another into the worktree: where that one goes on, and this one's title. */
      lead?: string; title?: string
    }
  /**
   * A conversation's batch, and as its host emits it, the same in the compact live form (`compact`), which a reader that
   * said it reads that form hears in its place: each is encoded apart (`encodeRuntimeEvent`), never together. A window
   * that reads the compact form may hear `batch` itself so (`HeardLiveBatch`, read by `expandLiveBatch`). `rostered`: the
   * same again for a host's own windows, its roster as what changed, where it has one (`rosteredLiveBatch`).
   */
  | { type: "live-batch"; batch: LiveBatch; compact?: CompactLiveBatch; rostered?: CompactLiveBatch }
  /** What a conversation's next batch will add to its last block, for this host's own windows alone (`LiveAhead`). */
  | { type: "live-ahead"; ahead: LiveAhead }
  /**
   * Conversations the account lists that this host doesn't run (another device's in the cloud): each listed as one is
   * at boot, unopened, or listed again as it changed. Opening one reads it where it runs.
   */
  | { type: "live-listed"; summaries: LiveSummary[] }
  /** Conversations the account no longer lists here: gone from every window. */
  | { type: "live-unlisted"; ids: string[] }
  | { type: "live-owner-connection"; ids: string[]; connected: boolean }
  /**
   * A cloud Thread's machine fell asleep, began waking for a call of this Mac's, or was heard awake (it answered, or
   * its events came): the conversations it runs. A window showing their app looks again now, rather than polling.
   */
  | { type: "cloud-machine"; conversations: string[]; machine: import("./thread-app.js").CloudMachineState }
  | { type: "session"; session: SessionState }
  | { type: "meta"; meta: SessionMeta }
  | { type: "messages"; messages: ChatMessage[] }
  | { type: "stream"; message: ChatMessage | null }
  | { type: "tree"; tree: TreeNode[]; leafId: string | null }
  | { type: "git"; git: GitStatus; cause?: "index" | "workspace" }
  | { type: "capabilities"; capabilities: Capabilities }
  /** One provider's discovery finished; window-wide, keyed by the workspace it ran in. */
  | { type: "harness-profile"; profile: HarnessProfile; cwd?: string }
  /** A provider transport's sign-in changed; window-wide. */
  | { type: "provider-connections"; connections: ProviderConnection[] }
  /** This Mac's Mako account or its connection to the cloud changed; window-wide. */
  | { type: "cloud-account"; account: CloudAccount }
  /** Whether this Mac shares its harnesses' sign-ins with Mako Cloud, and how each stands; window-wide. */
  | { type: "cloud-sign-ins"; signIns: CloudSignInsState }
  /** Turning Mako Cloud on moved: a step done, stuck or under way (`CloudTurnOn`). */
  | { type: "cloud-turn-on"; turnOn: import("./cloud-turn-on.js").CloudTurnOn }
  | { type: "simulator-setup"; setup: import("./simulator-setup.js").SimulatorSetup }
  /** The person's choice about handing agents to the cloud as this Mac sleeps changed. */
  | { type: "handoff-settings"; settings: import("./cloud-threads.js").HandOffSettings }
  /** Keeping this Mac awake while agents work: the person's choice, or what's held, changed (`KeepAwake`). */
  | { type: "keep-awake"; state: import("./keep-awake.js").KeepAwakeState }
  /** The person's conversation settings changed (`ConversationSettings`). */
  | { type: "conversation-settings"; settings: import("./turn-continuation.js").ConversationSettings }
  /** Something happened to the account's devices (`@mako/protocol/account-events`); `mine` when it's about this Mac. */
  | { type: "cloud-account-event"; seq: number; at: string; event: AccountDeviceEvent; mine: boolean }
  /** A runtime's installed or public version was read, or an update moved; window-wide. */
  | { type: "runtime-updates"; updates: HarnessUpdates }
  /**
   * Something the person should know or do, as a toast. Every notice that isn't news either does one thing (`action`:
   * what fixes it) or isn't sent at all: what Mako handled itself, or nobody can act on, is said in the host's log.
   */
  | { type: "notice"; level: "info" | "success" | "error"; message: string; action?: NoticeAction }
  /** The file open in the viewer changed on disk (any writer). */
  | { type: "file-changed"; path: string }
  /** A file in the plugins directory changed; the renderer should re-read them. */
  | { type: "plugins-changed" }
  /** Update progress. Window-wide, not tied to any tab. */
  | { type: "update"; update: UpdateState }
  /** A project's automations, their state on this Mac or their proposals changed: its whole reading (`contracts/automations.ts`). */
  | { type: "automations-changed"; reading: AutomationProjectReading }
  /** A run was recorded or moved: the newest record of its occurrence. */
  | { type: "automation-run"; run: AutomationRun }
  /**
   * The cross-harness session catalog changed: a session somewhere on this
   * machine — from any app — was created or grew. Window-wide.
   */
  | { type: "threads"; threads: CatalogThreadRef[] }
  | { type: "thread-ref"; ref: CatalogThreadRef }
  /** A Thread gained or lost a Session; window-wide. */
  | { type: "thread-group"; change: ThreadGroupChange }
  /** Every Thread Mako started for a job of its own, after one more was recorded; window-wide. */
  | { type: "thread-purposes"; purposes: ThreadPurpose[] }
  /** A shared store's format changed under this host: a newer Mako changed it, so this one now only reads it. Window-wide. */
  | { type: "store-formats"; formats: StoreFormats }
  /** fseventsd's health changed, or a restart moved a step; window-wide. */
  | { type: "file-events-service"; service: FileEventsService }
  /** The MCP servers that need the person's sign-in changed (`McpSignIns`); window-wide. */
  | { type: "mcp-sign-ins"; reading: McpSignIns }
  /** These Threads' names changed, from any host; the rest are as they were. Window-wide. */
  | { type: "thread-titles"; titles: ThreadTitleEntry[] }
  /** Threads the person (or a merged pull request) marked: their whole marks as they now stand. */
  | { type: "thread-marks"; marks: ThreadMarkEntry[] }
  /** Sessions were added to another Thread or split into a new one; window-wide. */
  | { type: "thread-removed"; path: string }
  | {
      type: "thread-activity"
      path: string
      activity: ExternalThreadActivity | null
    }
  /** A replacement reader needs a fresh page checkpoint before following again. */
  | { type: "thread-reader-reset"; path: string }
  /** New entries appended to the thread the viewer is following. */
  | {
      type: "thread-entries"
      path: string
      entries: Entry[]
      replace?: boolean
      replaceFrom?: number
    }
  /** A native resume (the thread's own CLI) started, finished, or failed. */
  | { type: "thread-run"; run: ThreadRunState }
  /** A turn on this harness ended; its accounts' plan limits have moved. */
  | { type: "account-usage-spent"; harness: string }
  | { type: "account-usage"; harness: string; name: string; usage: AccountUsage }
  /** The account in use is near its plan limit, or was refused on it, and another of the harness's has room. */
  | { type: "account-limit"; offer: import("./account-usage.js").AccountLimitOffer }
  /** A removal waits for work on the account, finished, failed or was withdrawn. Window-wide. */
  | { type: "account-removal"; harness: string; name: string; event: AccountRemovalEvent }
  | { type: "native-requests"; requests: NativeRequest[] }
  | { type: "browser-control"; browsers: BrowserControlStatus[] }
  | { type: "control-activity"; activity: ControlActivity }
  /** The user clicked a desktop notification; open its subject. Window-wide. */
  | { type: "notification-activated"; id: string; subject: string }
  /** The Appshot shortcut was pressed, sent by the desktop client to the window the person last used. Never from a host. */
  | { type: "appshot-shortcut"; exclude: number[]; /** The app in front when the keys went down, before anything reacted to them. */ front?: number }
  /** What the desktop client knows of the Appshot shortcut since it was set (a later check, a press); to every window. Never from a host. */
  | { type: "appshot-shortcut-watch"; watch: AppshotShortcutWatch }

/**
 * Every event says which tab it came from.
 *
 * More than one agent runs at a time — that is the whole point of tabs — so an
 * untagged event would be applied to whichever conversation happens to be on
 * screen. Absent only on window-wide events like `plugins-changed`.
 */
/** A rewind the last host stopped in the middle of, which this one couldn't finish on its own. */
export const REWIND_CUT_SHORT = "A rewind didn't finish when Mako last stopped, so some files may be only partly put back."

/** The one thing a notice's button does: open Settings › Storage or Updates, restart Mako, or finish a rewind cut short. */
export type NoticeAction = { label: string; does: "open-storage" | "open-updates" | "restart" | "recover-rewinds" }

export type HostEvent = HostEventBody & { tabId?: string }

/** Everything the renderer needs to draw one tab from cold. */
export interface TabSnapshot {
  id: string
  session: SessionState
  /** Absent at boot while Git is still loading. */
  git?: GitStatus
  capabilities: Capabilities
}

export interface BootPayload {
  archives?: ThreadArchiveSnapshot
  live: LiveSummary[]
  /** Open tabs, in strip order. Always at least one. */
  tabs: TabSnapshot[]
  activeTabId: string
  models: ModelInfo[]
  platform: ProcessPlatform
  /** What the host's machine does for a person at it; absent from a host that predates it. */
  machine?: MachineOffer
  /**
   * Where Mako's own source lives, when it is editable.
   *
   * Present only in development, where the renderer is served by Vite and an
   * edit to `src/` is hot-applied into the running window. A packaged build
   * has no source tree and no dev server, so pointing a session at it would
   * offer a change you could never see — the field is absent there, and the
   * feature hides itself.
   */
  sourceRoot?: string
}
