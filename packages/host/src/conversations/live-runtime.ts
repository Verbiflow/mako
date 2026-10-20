import type { Admission } from "../base/admission.js"
import type { Foreground } from "../base/foreground.js"
import { errorMessage, type FailureBoundary } from "../base/error-message.js"
import { dirname } from "node:path"
import { hostWarn } from "../base/host-log.js"
import type { PromptAttachment, LiveSessionState } from "../contracts/providers-acp.js"
import type {
  AccountSwitchWait,
  LiveBatch,
  LiveDriverEvent,
  LiveRequest,
  LiveSnapshot,
  LiveStartOptions,
  LiveSummary,
  SignInHold,
  SignInResume,
  TurnContinuation,
} from "../contracts/live-conversations.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import type { McpRegistrySnapshot } from "../contracts/mcp-skills-integrations.js"
import type { ChildSource, ThreadPage } from "@mako/sessions"
import type { SessionSettings } from "@mako/sessions/settings"
import type {
  ProviderBinding,
  ResumeVerdict,
  ContextTransfer,
  ConversationControl,
  TransferInput,
} from "../contracts/conversation-control.js"
import type {
  AdmittedLiveDriver,
  ConversationTools,
} from "../harnesses/index.js"
import type { LiveJournal } from "./live-journal.js"
import type { JournalReclaims } from "./journal-reclaim.js"
import type { LiveMoves } from "./live-moves.js"
import type { NativeSourceIdentity, SessionMemory, SourceRef, ThreadStore } from "../threads/index.js"
import type { ThreadEnvironment } from "../contracts/thread-environments.js"
import type { Actor } from "../contracts/thread-identity.js"
import type { StartPurpose } from "../contracts/thread-purposes.js"
import type { WorkspaceSnapshots } from "../workspaces/index.js"
import type { TurnSteps } from "./interrupted-turn.js"
import type { ContextBundles } from "./live-context.js"
import type { PlanBuild } from "../contracts/plan-builds.js"
import type { ResidencyBudget } from "../contracts/residency.js"
import type { GoalObservation } from "../contracts/live-goals.js"

export interface ProviderConnection {
  driver: AdmittedLiveDriver
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
  /**
   * The binding a transfer is opening, which the conversation doesn't listen
   * to yet, and what its harness said while it opened that the conversation
   * draws (`drawnWhileOpening`): taken in when the transfer goes on with it.
   */
  transferOpening?: { bindingId: string; said: LiveBatch["updates"] }
  snapshot: LiveSnapshot
  journalSnapshot?: LiveSnapshot
  journal: LiveJournal
  driver: AdmittedLiveDriver | null
  storageFault?: boolean
  generation: number
  opening: boolean
  openingOperation?: Promise<void>
  /** A driver start still in its native setup; Close cancels it instead of waiting it out. */
  starting?: { driver: AdmittedLiveDriver; bindingId: string }
  /** Cleanup of bindings whose process exited by itself; a start of the same binding waits for it. */
  exited?: Map<string, Promise<void>>
  pendingCharacters: number
  updates: LiveBatch["updates"]
  /** See `LiveSnapshot.activityAt`; the next flush publishes it. */
  activityAt?: number
  timer: ReturnType<typeof setTimeout> | null
  displayPrompt?: string
  /** When anything last loaded or changed it; the memory budget lets the oldest go first. */
  usedAt?: number
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
  /** Mako's goal loop's next continuation, while it waits. */
  goalContinue?: ReturnType<typeof setTimeout>
  /** The turn whose tokens the goal is counting, and the goal's count before it. */
  goalTurn?: { request: string; before: number }
  /**
   * The side answer the driver is writing, until its call returns, which
   * can be after Stop showed it stopped; its process stays open meanwhile,
   * and the next question waits for `driving`.
   */
  sideAnswer?: { exchange: string; controller: AbortController; driving: Promise<void> }
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
  /** Held while a harness starts, so the host's routine work waits for it (`base/foreground.ts`). */
  foreground?: Pick<Foreground, "hold" | "started">
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
  /** Where the catalog lists the session with this identity now; `nativePath` is kept when it still lists it there. */
  nativePath?(identity: NativeSourceIdentity): string | undefined
  /** The environment of the account a binding ran on, to find its native session; host-only. */
  accountEnv?(binding: ProviderBinding): Promise<NodeJS.ProcessEnv>
  /** The account a harness has selected and a digest of `account`'s credentials. Without it, work paused on a sign-out waits to be resumed by hand. */
  signInState?(harness: string, account: string): Promise<{ selected: string; credential: string }>
  /** Who has a saved binding's native session and whether its record moved; see `ResumeVerdict`. */
  resumeVerdict?(binding: ProviderBinding): Promise<ResumeVerdict>
  /** The same folder in the project a since-removed worktree holding `cwd` was made from; undefined while `cwd` is there. */
  projectFolderOfRemoved?(cwd: string): string | undefined
  /** The conversation changed in a way that may let a waiting move go ahead (`LiveConversations.relocation`); called on the write path. */
  settled?(conversationId: string): void
  driver(provider: string): AdmittedLiveDriver | undefined
  /**
   * The catalog's listing and reader of native sessions: a handoff carries
   * the child agents they started, and reads again an imported history that
   * older code decoded.
   */
  children?: ChildSource
  /** A harness's id as people read it (the registry's label), in the transcripts a handoff writes and the note it sends. */
  harnessLabel?(harness: string): string
  history(path: string, before?: number): Promise<ThreadPage | null>
  /** `history` from the view an earlier build decoded of the unchanged record; null when there is none (`ThreadPageOptions.stale`). */
  staleHistory?(path: string, before?: number): Promise<ThreadPage | null>
  /**
   * Captures the session at `path` into the record store now: true once its
   * records are there, so a journal may keep the source in place of a copy
   * of its history (`LiveSnapshot.baseSource`).
   */
  holdHistory?(path: string): Promise<boolean>
  /**
   * Notes that the session `nativeId` was given the transcript folder `folder`
   * (`record-carried.ts`), so the record store keeps it as that session's own
   * and a restore writes it back where its first turn names it.
   */
  noteCarried?(harness: string, nativeId: string, folder: string): Promise<void>
  /** The session at `path` as Mako's record store had captured it by `asOf` (`ThreadPageOptions.asOf`). */
  historyAsOf?(path: string, asOf: number, before?: number): Promise<ThreadPage | null>
  emit(event: HostEvent): void
  /** A plan approval was answered with its approve choice and the agent confirmed it; see `PlanBuild`. */
  planBuilt?(planId: string, build: PlanBuild): void
  /** A commit changed the conversation's requests; called on the write path, so it must be cheap and never throw. */
  turns?(previous: LiveSnapshot, next: LiveSnapshot): void
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
  /** Whether the host takes new work; closed while it stops its agents to quit, restart or install. */
  admission?: Admission
  /** Test override for `AUTO_CONTINUE_DELAY_MS`, the wait before Mako continues a dropped turn itself. */
  autoContinueDelayMs?: number
  /** Test override for `GOAL_CONTINUE_DELAY_MS`, the wait before Mako's goal loop continues. */
  goalContinueDelayMs?: number
  /** Test override for ready provider residency. */
  providerIdleMs?: number
  /** Test override for the number of ready transports retained for fast reuse. */
  providerWarmLimit?: number
  /** Test override for `CONVERSATION_MEMORY` and the wait before a sweep. */
  conversationMemory?: ResidencyBudget & { sweepMs: number }
  /** Test clock for deterministic residency decisions. */
  now?: () => number
}

/**
 * What the parts of a host's conversations reach each other through. Each
 * part takes the members it uses (`Pick<LiveAccess, ...>`), so its type says
 * what it depends on; `LiveConversations` wires them.
 */
export interface LiveAccess {
  dependencies: Dependencies
  /** Compacts the journals this host closes with much of them free. */
  reclaims: JournalReclaims
  /** See `LiveConversations.epoch`. */
  epoch: string
  bundles: ContextBundles
  admission: Admission
  moves: LiveMoves
  /** The conversation each binding's driver events belong to. */
  bindingOwners: Map<string, string>
  /** A conversation in memory; never reads one in. */
  resident(id: string): Resident | undefined
  residents(): Iterable<Resident>
  require(id: string): Resident
  load(id: string): Resident | undefined
  /** Keeps a new conversation, its journal already written. */
  add(resident: Resident): void
  control(resident: Resident): ConversationControl
  flush(resident: Resident): void
  /** A flush within the frame, so a burst of text shares one write. */
  schedule(resident: Resident): void
  storageFailed(resident: Resident, boundary: FailureBoundary): void
  stamp(snapshot: LiveSnapshot): LiveSnapshot
  snapshot(id: string): LiveSnapshot | null
  summaries(): LiveSummary[]
  actor(explicit?: Actor): Actor | undefined
  register(snapshot: LiveSnapshot, actor: Actor | undefined): void
  markPurpose(conversationId: string, purpose: StartPurpose, options: LiveStartOptions): void
  startingSession(session: string): string
  /** Whether an existing journal is the same Session as the row being opened; see `LiveThreads.sameSession`. */
  sameSession(conversationId: string, ref: SourceRef): boolean
  announceGroup(thread: string): void
  observe(event: LiveDriverEvent): void
  /** Updates into the conversation as its active binding's are taken in (`LiveEvents.take`). */
  takeUpdates(resident: Resident, updates: LiveBatch["updates"]): void
  driverEvents(
    resident: Resident,
    bindingId: string
  ): (event: LiveDriverEvent) => void
  nativeStart(
    resident: Resident,
    driver: AdmittedLiveDriver,
    bindingId: string,
    start: () => Promise<LiveSessionState>
  ): Promise<LiveSessionState>
  retainAttachments(attachments: PromptAttachment[]): PromptAttachment[]
  reconcileQuestions(resident: Resident): Promise<void> | undefined
  pending(resident: Resident): ContextTransfer | undefined
  /** Record a new request in the journal and start it when the session is free. */
  admit(resident: Resident, request: LiveRequest): LiveRequest
  transfer(id: string, input: TransferInput, actor?: Actor, continues?: TurnContinuation): LiveSnapshot
  /** Send the next queued prompt once nothing holds it back. */
  drain(resident: Resident): void
  close(id: string): Promise<void>
  launch(
    resident: Resident,
    driver: AdmittedLiveDriver,
    provider: string,
    cwd: string,
    options: LiveStartOptions,
    modeId: string | undefined,
    tuning: SessionSettings | undefined
  ): void
  discoverNativePath(resident: Resident): void
  /** See `LiveSources.readBase`. */
  readBase(resident: Resident): Promise<void>
  /** Lets go of a conversation now when nothing is using it (`LiveRecords.release`). */
  release(id: string): boolean
  /** Whether any conversation runs, starts or stops anything (`LiveConversations.lifecycleWork`). */
  hasActiveWork(): boolean
  /** `discoverNativePath`, then the driver's own lookup by native ID when the catalog doesn't list the session. */
  locateNativePath(resident: Resident): Promise<void>
  nativeRewound(resident: Resident, run: string): void
  canHibernate(resident: Resident, preparing?: boolean, recoverAccount?: boolean): boolean
  hibernate(resident: Resident, reason: string): Promise<void>
  scheduleHibernation(resident: Resident, enforceWarmLimit?: boolean): void
  clearHibernationTimer(resident: Resident, clearSince?: boolean): void
  /** Reconnect an idle conversation whose native session can resume, as a follow-up would. */
  reopen(resident: Resident): Promise<void>
  /** Whether an unconnected conversation resumes on wake; a disconnected one with a recorded session becomes hibernated. */
  reopens(resident: Resident): boolean
  wake(resident: Resident): Promise<void>
  residencyChanged(resident: Resident): void
  /** The project folder a conversation whose worktree was removed goes on in, when its harness resumes a session there. */
  homeFromRemovedWorktree(resident: Resident): string | undefined
  /** Before a native start: a conversation whose worktree was removed goes on in the project folder it was made from. */
  returnFromRemovedWorktree(resident: Resident): void
  failedStart(resident: Resident, boundary: FailureBoundary, resuming: boolean): LiveRequest[]
  signInHold(resident: Resident): SignInHold
  retireFromAccount(resident: Resident): Promise<void>
  switchAccount(resident: Resident, request: LiveRequest): Promise<void>
  accountSwitchWait(resident: Resident): AccountSwitchWait | undefined
  scheduleAutoContinue(resident: Resident, settled: string): void
  declineAutoContinue(resident: Resident): void
  /** A turn ended; Mako's goal loop decides whether the agent keeps going. */
  goalSettled(resident: Resident, settled: string): void
  goalObserved(resident: Resident, goal: GoalObservation | null): void
  /** The running turn's usage changed; a goal whose tokens Mako counts follows it. */
  goalSpent(resident: Resident): void
}

/** The conversation's bindings and transfers; a journal from before them has its session as its only binding. */
export function conversationControl(resident: Resident): ConversationControl {
  return (
    resident.snapshot.control ?? {
      merges: [],
      activeBindingId: resident.snapshot.session.id,
      bindings: [
        {
          id: resident.snapshot.session.id,
          provider: resident.snapshot.session.harness,
          nativeId: resident.snapshot.session.nativeId,
          path: resident.snapshot.threadPath,
          coveredBlocks: resident.snapshot.blocks.length,
          includesBase: true,
        },
      ],
      transfers: [],
    }
  )
}

export function activeBinding(resident: Resident): ProviderBinding | undefined {
  const control = conversationControl(resident)
  return control.bindings.find(
    (binding) => binding.id === control.activeBindingId
  )
}

/** Whether a binding's native session exists, stored against the folder it ran in. */
export function launched(binding: ProviderBinding | undefined): binding is ProviderBinding & { nativeId: string; path: string } {
  return Boolean(binding?.nativeId && binding.path)
}

/** A conversation as it is held in memory once its journal is open, with nothing connected. */
export function residentOf(snapshot: LiveSnapshot, journal: LiveJournal, state: Partial<Resident> = {}): Resident {
  return {
    snapshot,
    journalSnapshot: snapshot,
    journal,
    driver: null,
    connections: new Map(),
    bindingGenerations: new Map(),
    transferring: false,
    generation: 0,
    opening: false,
    pendingCharacters: 0,
    updates: [],
    timer: null,
    ...state,
  }
}

/** Withdraw what a binding's agent could call in Mako; a failure is logged and never blocks the close. */
export async function revokeTools(dependencies: Pick<Dependencies, "revokeTools">, bindingId: string, conversationId: string): Promise<void> {
  try {
    await dependencies.revokeTools?.(bindingId, conversationId)
  } catch (error) {
    hostWarn("residency", "control grant revocation failed", {
      conversation: conversationId,
      binding: bindingId,
      error: errorMessage({ error }),
    })
  }
}

/**
 * The path a binding records for a session: the catalog's when it lists that
 * session, the reported one otherwise. A driver can name its file through an
 * account's store, a symlink to the one the catalog lists.
 */
export function bindingPath(dependencies: Pick<Dependencies, "nativePath">, session: LiveSessionState, reported: string | undefined): string | undefined {
  return dependencies.nativePath?.({ ...session, nativePath: reported }) ?? reported
}

/**
 * The transcript folders a conversation's switches gave the session `bindingId`
 * opened, for the record store to keep with it once it has a native id.
 */
export function carriedFoldersOf(snapshot: Pick<LiveSnapshot, "control">, bindingId: string): string[] {
  return (snapshot.control?.transfers ?? []).flatMap((transfer) =>
    transfer.state.kind === "accepted" && transfer.state.bindingId === bindingId && (transfer.state.manifest.includesBase || transfer.state.manifest.toBlock > transfer.state.manifest.fromBlock)
      ? [dirname(transfer.state.manifest.file)]
      : [])
}

/** Notes each folder `bindingId`'s session was given, now that it has a native id; a failure costs only the copy the store would have kept. */
export function noteCarriedFolders(dependencies: Pick<Dependencies, "noteCarried">, snapshot: Pick<LiveSnapshot, "control" | "session">, binding: { id: string; provider: string; nativeId?: string }): void {
  const note = dependencies.noteCarried
  if (!note || !binding.nativeId) return
  for (const folder of carriedFoldersOf(snapshot, binding.id))
    void note(binding.provider, binding.nativeId, folder).catch((error) =>
      hostWarn("transfer", "a session's transcript could not be noted for the record store", { conversation: snapshot.session.id, harness: binding.provider, error: errorMessage({ error }) }))
}
