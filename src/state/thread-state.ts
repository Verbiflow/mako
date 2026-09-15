import type {
  HarnessDescriptor,
  NativeRequest,
  ExternalThreadActivity,
  Thread,
  ThreadEntry,
  ThreadRef,
  ThreadRunState,
} from "@/lib/types"
import type { ThreadStatus } from "@/state/thread-status"

interface WorkingThreadsByPath {
  [path: string]: Extract<ThreadStatus, { kind: "working" }>
}

export interface AttentionByPath {
  [path: string]: Extract<
    ThreadStatus,
    { kind: "needs-permission" | "failed" | "review" }
  >
}

export type ViewedUserEntry = Extract<ThreadEntry, { kind: "user" }> & {
  echo?: boolean
}
export type ViewedThreadEntry =
  ViewedUserEntry | Exclude<ThreadEntry, { kind: "user" }>

export interface ViewedThread extends Omit<Thread, "entries"> {
  entries: ViewedThreadEntry[]
  pageStart: number
  totalEntries: number
  hasEarlier: boolean
  loadingEarlier?: boolean
  streamRevision?: number
  streamReplaceFrom?: number
}

/**
 * Every coding agent's sessions on this machine — not just this app's.
 *
 * The host watches every configured provider's native store and pushes the
 * merged catalog here. Nothing in this store polls: a session grown by a
 * terminal on the other monitor
 * arrives as an event, the same way a streaming token does.
 */
export interface ThreadsState {
  threads: ThreadRef[]
  loaded: boolean
  /** The foreign thread open in the viewer overlay, if any. */
  viewing: ViewedThread | null
  opening:
    | { kind: "loading"; ref: ThreadRef }
    | { kind: "failed"; ref: ThreadRef; error: string }
    | null
  /** Every provider the host can serve, described once. */
  descriptors: HarnessDescriptor[]
  /** The native run for the viewed thread, if one was started. */
  run: ThreadRunState | null
  /** Every live run owned by Mako, with its start and current operation. */
  working: WorkingThreadsByPath
  /** Persistent outcomes that must remain visible after the process stops. */
  attention: AttentionByPath
  /** Threads actively writing in another client, inferred from native-store events. */
  observed: Record<string, boolean>
  externalActivity: Record<string, ExternalThreadActivity>
  /** A translation in flight: one conversation becoming another harness's. */
  converting: { from: string; to: string; title?: string; done: boolean } | null
  /** The composer's chosen harness for new conversations. */
  composerHarness: string
  /** Prompts waiting for a thread's current run to end, per path. */
  nativeRequests: NativeRequest[]
}
