import type { LifecycleState, LifecycleAction, UpdateInstallation } from "./app-lifecycle.js"
import type { ThreadArchiveSnapshot } from "./thread-lifecycle.js"
import type { CheckoutHeads } from "./checkout-heads.js"
import type { MoveOutcome, WorkspaceMoves } from "./workspace-moves.js"
import type { PlanBuilds } from "./plan-builds.js"
import type { ThreadGroupChange } from "./thread-groups.js"
import type { ThreadPurpose } from "./thread-purposes.js"
import type { StoreFormats } from "./store-formats.js"
import type { ThreadTitleEntry } from "./thread-titles.js"
import type { Entry } from "@mako/sessions/entries"
import type { WorktreeStep } from "./thread-worktrees.js"
import type { MachineOffer } from "./machine-offer.js"
import type { CloudSignInsState } from "./cloud-sign-ins.js"
import type { CloudStartStep, ThreadMoveStep } from "./cloud-threads.js"
import type {
  ControlActivity,
  BrowserControlStatus,
} from "@mako/control-runtime/contracts"
import type { NativeRequest } from "./native-requests.js"
import type { AccountRemovalEvent, AccountUsage } from "./accounts.js"
import type { ProcessPlatform } from "./platform.js"
import type { AppshotShortcutWatch } from "./appshot-shortcut.js"
import type { LiveBatch, LiveSummary } from "./live-conversations.js"
import type {
  ThreadRef as CatalogThreadRef,
} from "@mako/sessions"
import type {
  Automation,
  AutomationRun,
  UpdateState,
} from "./automations-usage-updates.js"
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
  | { type: "application-lifecycle"; lifecycle: LifecycleState }
  | { type: "installation"; installation: UpdateInstallation }
  | { type: "app-command"; command: "app.quit" | "app.updates" }
  | { type: "app-shutdown"; requestId: string; action: LifecycleAction }
  | { type: "host-disconnected"; message: string }
  | { type: "host-reconnected" }
  | { type: "thread-archives"; snapshot: ThreadArchiveSnapshot }
  /** A followed checkout's HEAD moved, by folder; window-wide. */
  | { type: "checkout-heads"; heads: CheckoutHeads }
  /** A new Thread's worktree is checked out; its provider starts next. */
  | { type: "worktree-ready"; conversationId: string }
  | { type: "worktree-step"; conversationId: string; step: WorktreeStep }
  /**
   * A new cloud conversation's start: `preparing` while its machine and its copy of `project` come up, `starting`
   * once the harness is starting there. A start whose machine was ready from the composer goes straight to `starting`.
   */
  | { type: "cloud-start-step"; conversationId: string; step: CloudStartStep; project: string }
  /** A Thread's move to the cloud (`mako:thread-move`), step by step, for the conversation it was asked from. */
  | { type: "thread-move-step"; conversationId: string; move: string; step: ThreadMoveStep }
  /** An agent's tool changed this device's worktrees; windows read them again. */
  | { type: "worktrees-changed" }
  /** An agent's tool pushed, opened or merged a pull request; windows read GitHub and the worktrees' summaries again. */
  | { type: "github-changed" }
  /** Agents' requests to move onto their Thread's own branch, and the projects that always allow it. */
  | { type: "workspace-moves"; moves: WorkspaceMoves }
  /** The host's record of built plans changed; window-wide. */
  | { type: "plan-builds"; builds: PlanBuilds }
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
  | { type: "live-batch"; batch: LiveBatch }
  | { type: "live-owner-connection"; ids: string[]; connected: boolean }
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
  /** A runtime's installed or public version was read, or an update moved; window-wide. */
  | { type: "runtime-updates"; updates: HarnessUpdates }
  | { type: "notice"; level: "info" | "success" | "error"; message: string }
  /** The file open in the viewer changed on disk (any writer). */
  | { type: "file-changed"; path: string }
  /** A file in the plugins directory changed; the renderer should re-read them. */
  | { type: "plugins-changed" }
  /** Update progress. Window-wide, not tied to any tab. */
  | { type: "update"; update: UpdateState }
  | { type: "automations"; automations: Automation[] }
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
  /** These Threads' names changed, from any host; the rest are as they were. Window-wide. */
  | { type: "thread-titles"; titles: ThreadTitleEntry[] }
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
