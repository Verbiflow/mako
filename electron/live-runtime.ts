import { z } from "zod"
import type {
  PromptAttachment,
  LiveSnapshot,
  LiveBatch,
  LiveSessionState,
  HostEvent,
  LiveDriverEvent,
  McpRegistrySnapshot,
} from "./shared.js"
import type { EmitResult, Thread, ThreadPage } from "@mako/sessions"
import type {
  ProviderBinding,
  ResumeVerdict,
  ContextTransfer,
  ConversationControl,
} from "./contracts/conversation-control.js"
import type {
  ProviderLiveDriver,
  ConversationTools,
} from "./providers/live-driver.js"
import type { LiveJournal } from "./live-journal.js"
import type { SessionMemory } from "./session-memory.js"
import type { ThreadStore } from "./thread-store.js"
import type { Actor } from "./contracts/thread-identity.js"
import type { ThreadEnvironment } from "./contracts/thread-environments.js"
import type { WorkspaceSnapshots } from "./workspace-snapshots.js"
import type { TurnSteps } from "./interrupted-turn.js"
import type { PlanBuild } from "./contracts/plan-builds.js"
import type { SignInResume } from "./contracts/live-conversations.js"
export interface ProviderConnection {
  driver: ProviderLiveDriver
  session: LiveSessionState
}

export interface Resident {
  closing?: boolean
  closeOperation?: Promise<void>
  checkpointing?: boolean
  rewinding?: boolean
  connections: Map<string, ProviderConnection>
  bindingGenerations: Map<string, number>
  transferring: boolean
  transferOperation?: Promise<void>
  snapshot: LiveSnapshot
  journalSnapshot?: LiveSnapshot
  journal: LiveJournal
  driver: ProviderLiveDriver | null
  storageFault?: boolean
  generation: number
  opening: boolean
  openingOperation?: Promise<void>
  pendingCharacters: number
  updates: LiveBatch["updates"]
  /** See `LiveSnapshot.activityAt`; the next flush publishes it. */
  activityAt?: number
  timer: ReturnType<typeof setTimeout> | null
  displayPrompt?: string
  /** When this ready provider became eligible to leave the bounded warm pool. */
  idleSince?: number
  idleTimer?: ReturnType<typeof setTimeout>
  /** Intentional transport teardown; prompts accepted during it wake afterwards. */
  hibernating?: Promise<void>
  /** One coalesced resume for every prompt that arrives while hibernated. */
  waking?: Promise<void>
  /** At most one automatic account reopen for an input proven unsent. */
  accountRefreshRequest?: string
  /** Set while an input waiting for an account switch retires and reopens this session. */
  accountSwitching?: boolean
  /** The Resume of work paused on a sign-out while it runs; a second press shares it. */
  signInResume?: Promise<SignInResume>
  retireWhenIdle?: boolean
  /** The scheduled continuation of a turn that ended on a dropped connection, while it is pending. */
  autoContinue?: { requestId: string; timer: ReturnType<typeof setTimeout> }
  /**
   * The request the user pressed Stop on, until it settles. However its
   * driver ends it (an acknowledged cancel, a closed process, a failed
   * result), it settles stopped and is never continued automatically.
   */
  stopping?: string
  /** The running turn's steps and results in the order they arrived; see `TurnSteps`. */
  steps?: TurnSteps
}

export interface Dependencies {
  mcpSnapshot?(cwd: string): Promise<McpRegistrySnapshot>
  workspaceSnapshots?: WorkspaceSnapshots
  appPath: string
  tools?(
    bindingId: string,
    conversationId: string
  ): ConversationTools | undefined | Promise<ConversationTools | undefined>
  /** The Thread's values for an agent process about to start; never blocks the start when they can't be had. */
  threadEnvironment?(conversationId: string, title?: string, cwd?: string): Promise<ThreadEnvironment | undefined>
  /**
   * The lines of Mako's note sent ahead of each prompt: Local Control and the
   * values the conversation's process started with. The note wraps them with
   * anything Mako has to tell about the conversation itself.
   */
  controlInstructions?(bindingId: string, conversationId: string): string[]
  revokeTools?(bindingId: string, conversationId: string): void | Promise<void>
  root: string
  checkpoint?(path: string, provider?: string): Promise<string | undefined>
  nativePath?(session: LiveSessionState): string | undefined
  /** Who has a saved binding's native session and whether its record moved; see `ResumeVerdict`. */
  resumeVerdict?(binding: ProviderBinding): Promise<ResumeVerdict>
  driver(provider: string): ProviderLiveDriver | undefined
  /** Writes a conversation into the provider's own session store; null when it has no writer. */
  emitSession?(provider: string, thread: Thread): Promise<EmitResult | null>
  history(path: string, before?: number): Promise<ThreadPage | null>
  emit(event: HostEvent): void
  /** A plan approval was answered with its approve choice and the agent confirmed it; see `PlanBuild`. */
  planBuilt?(planId: string, build: PlanBuild): void
  /**
   * The per-user ledger of settings, access mode and live holds per native
   * session. Written from every flush that changes what a connected session
   * reports; consulted before a resume so two hosts never open one store.
   */
  memory?: SessionMemory
  /**
   * The per-user Thread store: every journal registers into a Session, and
   * requests take their actor's principal from it. Without it conversations
   * run as before and carry no Thread identity.
   */
  threads?: ThreadStore
  /**
   * Whether the account this binding's process runs on is being removed: the
   * session then lets go of it as soon as it is idle. Called on every idle
   * check, so it must be cheap when nothing is being removed.
   */
  accountRemoving?(bindingId: string): boolean
  /** Test override for `AUTO_CONTINUE_DELAY_MS`, the wait before Mako continues a dropped turn itself. */
  autoContinueDelayMs?: number
  /** Test override for ready provider residency. */
  providerIdleMs?: number
  /** Test override for the number of ready transports retained for fast reuse. */
  providerWarmLimit?: number
  /** Test clock for deterministic residency decisions. */
  now?: () => number
}

export interface LiveAccess {
  discoverNativePath(resident: Resident): void
  observe(event: LiveDriverEvent): void
  retainAttachments(attachments: PromptAttachment[]): PromptAttachment[]
  dependencies: Dependencies
  bindingOwners: Map<string, string>
  require(id: string): Resident
  load(id: string): Resident | undefined
  control(resident: Resident): ConversationControl
  flush(resident: Resident): void
  drain(resident: Resident): void
  residencyChanged(resident: Resident): void
  driverEvents(
    resident: Resident,
    bindingId: string
  ): (event: LiveDriverEvent) => void
  close(id: string): Promise<void>
  pending(resident: Resident): ContextTransfer | undefined
  storageFailed(resident: Resident, boundary: FailureBoundary): void
  /** A conversation acting through Mako's tools, named by its Session. */
  agentActor(conversationId: string): Actor | undefined
}

export interface FailureBoundary {
  error: unknown
}

/**
 * The path a binding records for a session: the catalog's when it lists that
 * session, the reported one otherwise. A driver can name its file through an
 * account's store, a symlink to the one the catalog lists.
 */
export function bindingPath(dependencies: Pick<Dependencies, "nativePath">, session: LiveSessionState, reported: string | undefined): string | undefined {
  return dependencies.nativePath?.({ ...session, nativePath: reported }) ?? reported
}

const RpcErrorSchema = z
  .object({
    data: z
      .object({ message: z.string().optional(), details: z.string().optional() })
      .loose()
      .optional(),
  })
  .loose()

/**
 * A JSON-RPC error carries its reason in `data`, not in `message`: Cursor
 * answers `session/set_config_option` with "Invalid params" and puts
 * "Unknown model config option: effort" beside it. Dropping that once left
 * two failed threads explained by nothing more than the generic code text.
 */
export function errorMessage({ error }: FailureBoundary): string {
  if (!(error instanceof Error)) return String(error)
  // `data` is an own enumerable property on a JSON-RPC RequestError; the
  // Error prototype's own fields are not, so the entries are exactly the extras.
  const parsed = RpcErrorSchema.safeParse(Object.fromEntries(Object.entries(error)))
  const reason = parsed.success ? (parsed.data.data?.message ?? parsed.data.data?.details) : undefined
  if (!reason || !error.message || error.message.includes(reason)) return error.message || (reason ?? String(error))
  return `${error.message}: ${reason}`
}
