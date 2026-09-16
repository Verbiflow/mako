import { z } from "zod"
import type {
  PromptAttachment,
  LiveSnapshot,
  LiveBatch,
  LiveSessionState,
  LiveStartOptions,
  HostEvent,
  LiveDriverEvent,
  McpRegistrySnapshot,
} from "./shared.js"
import type { ThreadPage } from "@mako/sessions"
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
import type { WorkspaceSnapshots } from "./workspace-snapshots.js"
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
  timer: ReturnType<typeof setTimeout> | null
  displayPrompt?: string
  /** When this ready provider became eligible to leave the bounded warm pool. */
  idleSince?: number
  idleTimer?: ReturnType<typeof setTimeout>
  /** Intentional transport teardown; prompts accepted during it wake afterwards. */
  hibernating?: Promise<void>
  /** One coalesced resume for every prompt that arrives while hibernated. */
  waking?: Promise<void>
  retireWhenIdle?: boolean
  /** The scheduled continuation of a turn that ended on a dropped connection, while it is pending. */
  autoContinue?: { requestId: string; timer: ReturnType<typeof setTimeout> }
}

export interface Dependencies {
  mcpSnapshot?(cwd: string): Promise<McpRegistrySnapshot>
  workspaceSnapshots?: WorkspaceSnapshots
  appPath: string
  tools?(
    bindingId: string,
    conversationId: string
  ): ConversationTools | undefined
  revokeTools?(bindingId: string, conversationId: string): void | Promise<void>
  providers?(): string[]
  root: string
  checkpoint?(path: string, provider?: string): Promise<string | undefined>
  nativePath?(session: LiveSessionState): string | undefined
  /** Who has a saved binding's native session and whether its record moved; see `ResumeVerdict`. */
  resumeVerdict?(binding: ProviderBinding): Promise<ResumeVerdict>
  driver(provider: string): ProviderLiveDriver | undefined
  history(path: string, before?: number): Promise<ThreadPage | null>
  emit(event: HostEvent): void
  /**
   * The per-user ledger of settings, access mode and live holds per native
   * session. Written from every flush that changes what a connected session
   * reports; consulted before a resume so two hosts never open one store.
   */
  memory?: SessionMemory
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
  open(
    provider: string,
    cwd: string,
    options: LiveStartOptions,
    ancestry?: ConversationControl["ancestry"]
  ): Promise<LiveSessionState>
}

export interface FailureBoundary {
  error: unknown
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
