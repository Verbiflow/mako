import type { LifecycleState, LifecycleAction, UpdateInstallation } from "./app-lifecycle.js"
import type { ThreadArchiveSnapshot } from "./thread-lifecycle.js"
import type { ControlActivity } from "./control-preview.js"
import type { NativeRequest } from "./native-requests.js"
import type { BrowserControlStatus } from "./browser-control.js"
import type { LiveBatch, LiveSummary } from "./live-conversations.js"
import type {
  ThreadEntry as CatalogThreadEntry,
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
import type { Capabilities } from "./mcp-skills-integrations.js"
import type { HarnessProfile } from "./providers-acp.js"

/**
 * The wire contract between the Electron host and the renderer.
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
  | { type: "live-batch"; batch: LiveBatch }
  | { type: "session"; session: SessionState }
  | { type: "meta"; meta: SessionMeta }
  | { type: "messages"; messages: ChatMessage[] }
  | { type: "stream"; message: ChatMessage | null }
  | { type: "tree"; tree: TreeNode[]; leafId: string | null }
  | { type: "git"; git: GitStatus; cause?: "index" | "workspace" }
  | { type: "capabilities"; capabilities: Capabilities }
  /** One provider's discovery finished; window-wide, keyed by the workspace it ran in. */
  | { type: "harness-profile"; profile: HarnessProfile; cwd?: string }
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
  | { type: "thread-removed"; path: string }
  | {
      type: "thread-activity"
      path: string
      activity: ExternalThreadActivity | null
    }
  /** New entries appended to the thread the viewer is following. */
  | {
      type: "thread-entries"
      path: string
      entries: CatalogThreadEntry[]
      replace?: boolean
      replaceFrom?: number
    }
  /** A native resume (the thread's own CLI) started, finished, or failed. */
  | { type: "thread-run"; run: ThreadRunState }
  | { type: "native-requests"; requests: NativeRequest[] }
  | { type: "browser-control"; browsers: BrowserControlStatus[] }
  | { type: "control-activity"; activity: ControlActivity }
  /** The user clicked a desktop notification; open its subject. Window-wide. */
  | { type: "notification-activated"; id: string; subject: string }

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
  git: GitStatus
  capabilities: Capabilities
}

export interface BootPayload {
  archives?: ThreadArchiveSnapshot
  live: LiveSummary[]
  /** Open tabs, in strip order. Always at least one. */
  tabs: TabSnapshot[]
  activeTabId: string
  models: ModelInfo[]
  platform: NodeJS.Platform
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
