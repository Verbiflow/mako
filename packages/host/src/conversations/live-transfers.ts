import { resumes, verifyRecoveredSession, departedBinding, restorableTotals } from "../harnesses/index.js"
import { retireQuestionsForInput } from "../contracts/live-questions.js"
import { knownApprovalOccurrences } from "./live-approvals.js"
import { disconnectNativeAgents } from "../contracts/native-agents.js"
import { createHash, randomUUID } from "node:crypto"
import { join } from "node:path"
import { admittedInPlace } from "../contracts/turn-continuation.js"
import { STOP_RETIRED_MOVE, TransferInputSchema, carryingWords, quietSwitch, resumable, retiredMove, type ConversationControl } from "../contracts/conversation-control.js"
import type {
  TransferInput,
  ContextTransfer,
  ResumeVerdict,
} from "../contracts/conversation-control.js"
import { heldReason, SessionBusyError } from "../contracts/session-hold.js"
import type { Actor } from "../contracts/thread-identity.js"
import type { LiveRequest, TurnContinuation, LiveSnapshot } from "../contracts/live-conversations.js"
import { classifyStartFailure } from "../contracts/provider-failure.js"
import { nextRetry, transientCause } from "../contracts/delivery-retry.js"
import { arriving, departing } from "../contracts/request-hold.js"
import { SessionHeldError } from "../threads/index.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { LiveRequestSchema } from "./live-journal.js"
import { prepareLiveContext } from "./live-context.js"
import { bindingPath, launchAccount, launchCalls, launchRouting, neverRan, noteCarriedFolders } from "./live-runtime.js"
import { errorMessage } from "../base/error-message.js"
import type {
  LiveAccess,
  Resident,
  ProviderConnection,
} from "./live-runtime.js"

/**
 * The queue as a switch lands: its message goes ahead of what's queued, which waited behind it or came after it, so the
 * hand-over's context reaches the harness first. Only the row `ahead` goes before it (`arriving`), and carries that context.
 */
function arrival(requests: readonly LiveRequest[], arrived: LiveRequest, ahead: string | undefined): LiveRequest[] {
  const at = arrived.continues?.brief ? -1 : requests.findIndex((request) => request.status === "queued" && request.id !== ahead)
  return at < 0 ? admittedInPlace(requests, arrived) : [...requests.slice(0, at), arrived, ...requests.slice(at)]
}

/** Why a reconnect could not go on from the saved session; the reason is the verdict's own. */
/** The refusal a resume that can't go raises: `SessionBusyError` while a process has the session open. */
export function reconnectError(verdict: ResumeVerdict | undefined): Error {
  return verdict?.kind === "held" ? new SessionBusyError(verdict.by) : new Error(reconnectRefusal(verdict))
}

export function reconnectRefusal(verdict: ResumeVerdict | undefined): string {
  if (verdict?.kind === "held") return heldReason(verdict.by)
  if (verdict?.kind === "closed") return `${verdict.reason} Send the message again to continue.`
  const reason = verdict?.kind === "unavailable" ? verdict.reason : "The saved binding names no session this provider can reopen."
  return `The saved native session cannot be resumed. ${reason} No replacement session was started.`
}

/** What a Stop did to the switches not yet committed: those it holds as messages, and the quiet ones it retired. */
export interface HeldSwitches {
  snapshot: LiveSnapshot
  held: number
  retired: ContextTransfer[]
}

/** A quiet switch: a Thread moved with its queue as it stands (`LiveConversations.moveOn`). */
export interface SwitchMove {
  /** What it was decided on still holds: read last, with nothing awaited before its commit. */
  wanted: () => boolean
  first?: string
}

const CLOSE_RETIRED_MOVE = "Its harness wouldn't let go of it. Nothing changed; ask again to move it."

/** Durable switch acceptance and provider preparation, separate from token ingestion. */
export class LiveTransfers {
  private readonly host: LiveAccess
  /** Who waits for a switch to settle, by its ID (`settled`). */
  private readonly settling = new Map<string, Set<(transfer: ContextTransfer) => void>>()
  /** Each quiet switch's `wanted`, by its ID: what it was decided on is in memory, and a restart retires it. */
  private readonly moves = new Map<string, () => boolean>()
  constructor(host: LiveAccess) {
    this.host = host
  }
  /** A session prepared and let go: its events are no longer the conversation's, unless its binding is one it holds. */
  private forgetPrepared(resident: Resident, preparedId: string): void {
    if (!this.host.control(resident).bindings.some((binding) => binding.id === preparedId)) this.host.bindingOwners.delete(preparedId)
  }

  private async revokeTools(
    bindingId: string,
    conversationId: string
  ): Promise<void> {
    try {
      await this.host.dependencies.revokeTools?.(bindingId, conversationId)
    } catch (error) {
      hostLog("transfer", "control grant revocation failed", {
        conversation: conversationId,
        binding: bindingId,
        error: errorMessage({ error }),
      })
    }
  }
  /** `move`: a quiet switch. It has no message of its own, so it goes ahead of what's queued, which is for its destination. */
  accept(id: string, input: TransferInput, actor?: Actor, continues?: TurnContinuation, move?: SwitchMove): LiveSnapshot {
    const command = TransferInputSchema.parse(input)
    const inputDigest = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex")
    const resident = this.host.require(id)
    const control = this.host.control(resident)
    const existing = control.transfers.find(
      (transfer) => transfer.input.id === command.id
    )
    if (existing) {
      if (
        existing.inputDigest
          ? existing.inputDigest !== inputDigest
          : JSON.stringify(existing.input) !== JSON.stringify(command)
      )
        throw new Error(
          "This transfer ID was already used with different content"
        )
      return resident.snapshot
    }
    if (!move && !command.text.trim() && !command.attachments.length)
      throw new Error("A transfer needs a request or an attachment")
    if (this.pending(resident))
      throw new Error("A provider switch is already pending")
    // One switch at a time: asked for while another is committed and closing its source, it waits behind that one,
    // and so does that one's own message, which goes first.
    const inFlight = resident.transferPhase && (resident.transferPhase.phase === "committed" || resident.transferPhase.phase === "closing") ? resident.transferPhase.id : undefined
    if (
      !move && resident.snapshot.requests.some((request) => request.status === "queued" && request.id !== inFlight)
    )
      throw new Error(
        "Send or remove queued messages before switching providers"
      )
    if (resident.snapshot.requests.some((request) => request.id === command.id))
      throw new Error("That request ID already exists")
    const driver = this.host.dependencies.driver(command.provider)
    if (!driver?.available(this.host.dependencies.appPath))
      throw new Error(
        `${command.provider} has no available interactive transport`
      )
    command.attachments = this.host.retainAttachments(command.attachments)
    const previous = resident.snapshot
    resident.snapshot = {
      ...previous,
      control: {
        ...(continues?.auto ? control : retireQuestionsForInput(control, command.id)),
        transfers: [
          ...control.transfers,
          {
            input: command,
            actor,
            continues,
            inputDigest,
            createdAt: Date.now(),
            state: { kind: "queued" },
            ...inFlight && { behind: inFlight },
            ...move?.first !== undefined && { first: move.first },
          },
        ],
      },
    }
    try {
      this.host.flush(resident)
    } catch (error) {
      resident.snapshot = previous
      throw error
    }
    if (move) this.moves.set(command.id, move.wanted)
    this.start(resident)
    return resident.snapshot
  }

  start(resident: Resident): void {
    const transfer = this.pending(resident)
    if (
      !transfer ||
      // One waiting to go again goes at its time (`wakeDue` opens it), not on every drain.
      (transfer.retry && transfer.retry.at > Date.now()) ||
      resident.transferOperation ||
      resident.storageFault ||
      resident.hibernating ||
      resident.waking ||
      resident.transferring ||
      resident.closing ||
      resident.checkpointing ||
      resident.rewinding ||
      resident.opening ||
      this.host.moves.ownerCheck(resident) !== undefined ||
      resident.snapshot.session.status === "running" ||
      resident.snapshot.requests.some(
        (request) => request.status === "dispatching"
      )
    )
      return
    // A blocked switch has no operation to finish. Scheduling one here would
    // make its completion drain the same blocked switch forever in microtasks.
    const operation = this.perform(resident, transfer)
    resident.transferOperation = operation
    void operation.finally(() => {
      if (resident.transferOperation === operation) {
        resident.transferOperation = undefined
        this.host.drain(resident)
      }
    })
  }

  /**
   * The switch that goes next. One whose message sits held in the queue waits with that message, under its hold, and
   * holds nothing else up (`docs/delivery-queue.md`).
   */
  pending(resident: Resident): ContextTransfer | undefined {
    const { requests } = resident.snapshot
    const free = this.host.control(resident).transfers.filter(
      (transfer) => unsettled(transfer) && requests.find((request) => request.id === transfer.input.id)?.status !== "held"
    )
    // One under way stays next, whatever a resume releases ahead of it in the meantime: one switch at a time.
    return free.find((transfer) => transfer.state.kind === "preparing") ?? free[0]
  }

  /** The switch not yet committed that carries the message `id`, held or not. */
  unsettled(resident: Resident, id: string): ContextTransfer | undefined {
    return this.host.control(resident).transfers.find((transfer) => transfer.input.id === id && unsettled(transfer))
  }

  /**
   * A switch that can't go, as itself, for good: it fails, and a message of its the queue held goes with it, so the
   * failure's retry (`retryTransfer`) carries the person's words and nothing else sends them.
   */
  private fail(resident: Resident, transfer: ContextTransfer, state: Extract<ContextTransfer["state"], { kind: "failed" }>): void {
    const own = resident.snapshot.requests.find((request) => request.id === transfer.input.id)
    if (own) resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.filter((request) => request !== own) }
    this.save(resident, { ...transfer, input: own ? carryingWords(transfer.input, own) : transfer.input, retry: undefined, state })
  }

  /** A quiet switch that won't go: it has no message to wait with, so it's over, and whoever asked hears why. */
  private retire(resident: Resident, transfer: ContextTransfer, error: string): void {
    this.save(resident, retiredMove(transfer, error))
  }

  /** Once the switch `id` has gone or can't go; a retry or a Stop's hold is still waiting. */
  settled(id: string): Promise<ContextTransfer> {
    return new Promise((done) => {
      const waiting = this.settling.get(id) ?? new Set()
      waiting.add(done)
      this.settling.set(id, waiting)
    })
  }

  tell(transfer: ContextTransfer): void {
    if (unsettled(transfer)) return
    this.moves.delete(transfer.input.id)
    const waiting = this.settling.get(transfer.input.id)
    this.settling.delete(transfer.input.id)
    for (const done of waiting ?? []) done(transfer)
  }

  save(resident: Resident, transfer: ContextTransfer): void {
    const control = this.host.control(resident)
    resident.snapshot = {
      ...resident.snapshot,
      control: {
        ...control,
        transfers: control.transfers.map((candidate) =>
          candidate.input.id === transfer.input.id ? transfer : candidate
        ),
      },
    }
    this.host.flush(resident)
    this.tell(transfer)
  }

  private async perform(
    resident: Resident,
    transfer: ContextTransfer
  ): Promise<void> {
    resident.transferring = true
    const generation = resident.generation
    // This attempt goes on only while its own transfer is still the one waiting: a Stop holds it back (`stopHolds`)
    // without moving the resident's generation, so the source binding and its events stay live.
    const owned = () => resident.generation === generation &&
      (phase.phase === "committed" || phase.phase === "closing" || this.pending(resident)?.input.id === transfer.input.id)
    const phase: NonNullable<Resident["transferPhase"]> = { id: transfer.input.id, phase: "preparing" }
    resident.transferPhase = phase
    let prepared: ProviderConnection | null = null
    let preparedId: string | null = null
    let held: string | null = null
    let reconnect = false
    let activated = false
    try {
      this.save(resident, { ...transfer, behind: undefined, state: { kind: "preparing" } })
      await this.host.locateNativePath(resident)
      this.host.returnFromRemovedWorktree(resident)
      const source = resident.snapshot
      const control = this.host.control(resident)
      const target = transfer.input.bindingId
      if (target && !control.bindings.some((binding) => binding.id === target && binding.provider === transfer.input.provider))
        throw new Error("The selected native session is unavailable")
      const currentBinding = control.bindings.find((binding) => binding.id === control.activeBindingId)
      // Another account of its harness, where the session can't go on: a session of its own, handed the conversation.
      const anew = quietSwitch(transfer) && currentBinding?.provider === transfer.input.provider
      // The same, going back: a session another account made goes on under this one only where its harness can.
      const goesOn = (binding: { account?: string | undefined }) => !transfer.input.account || binding.account === transfer.input.account || this.host.dependencies.driver(transfer.input.provider)?.accountContinuation?.kind === "resumes"
      reconnect = (!target || target === control.activeBindingId) && !resident.driver && !anew && currentBinding?.provider === transfer.input.provider && Boolean(currentBinding?.nativeId)
      const bindings = control.bindings.map((binding) =>
        binding.id === control.activeBindingId && resident.driver
          ? {
              ...binding,
              coveredBlocks: source.blocks.length,
              includesBase: binding.includesBase,
              tuning: source.session.settings ?? binding.tuning,
              modeId: source.session.currentMode ?? binding.modeId,
            }
          : binding
      )
      // Going back to a harness goes on in its own session whatever model or
      // effort is chosen now: the tuning rides the turn, as any reply's does.
      // Never compare tunings to pick one: a binding keeps the harness's report
      // of its settings, a transfer the picker's encoding of them. A dormant
      // native file may have changed outside Mako; a fresh full handoff is the
      // fallback then.
      let prior = anew ? undefined : bindings.find(
        (binding) =>
          (!target || binding.id === target) &&
          binding.provider === transfer.input.provider &&
          goesOn(binding) &&
          resident.connections.get(binding.id)?.session.status === "ready"
      )
      // A reconnect goes on from the session as it is: a record that moved past
      // the binding's checkpoint is the turn this host lost when it died, or the
      // CLI's own continuation, and the native session carries it either way.
      // Only ownership refuses. A provider switch that reuses an old binding
      // sends context from that checkpoint, so it still wants the record unmoved.
      let verdict: ResumeVerdict | undefined
      if (
        !prior && !anew &&
        resumes(this.host.dependencies.driver(transfer.input.provider))
      ) {
        for (const binding of [...bindings].reverse()) {
          if (
            (target && binding.id !== target) ||
            binding.provider !== transfer.input.provider ||
            !goesOn(binding) ||
            (!target && reconnect && binding.id !== control.activeBindingId)
          )
            continue
          const candidate = await this.host.dependencies.resumeVerdict?.(binding)
          if (reconnect || target) verdict = candidate
          if (candidate && resumable(candidate, reconnect || target ? "moved" : "same")) {
            prior = binding
            break
          }
        }
      }
      // A record its harness keeps closed goes on in a new session with the
      // whole conversation, and so does one its harness has no record of here
      // (`lost`), the active one or a pick of it: refusing that dropped every
      // message sent to it. Any other record that won't reopen refuses.
      const lost = verdict?.kind === "unavailable" && verdict.lost === true && (!target || target === control.activeBindingId)
      // A session Mako started that never ran a turn has no record to find: Claude writes a session's file with its
      // first turn, so a Fin moved to it that took none before its host went names a session that never existed. It
      // isn't lost; it starts now, in its own binding, with the whole conversation, as it would have.
      const unstarted = lost && currentBinding !== undefined && neverRan(currentBinding, source.requests) ? currentBinding : undefined
      if (lost)
        hostLog("transfer", unstarted ? "a session that never ran a turn starts now with the whole conversation" : "a session its harness can't find goes on as a new one with the whole conversation", {
          conversation: source.session.id,
          harness: transfer.input.provider,
          binding: currentBinding?.id ?? "",
        })
      if (verdict?.kind === "closed" || lost) reconnect = false
      else if ((reconnect || target) && !prior) throw reconnectError(verdict)
      const tuning =
        transfer.input.tuning ??
        prior?.tuning ??
        (reconnect
          ? source.session.settings ?? currentBinding?.tuning
          : undefined)
      // A turn Mako sent after the last idle checkpoint moves the record by
      // itself when its process dies mid-turn, and this transcript already has
      // what streamed of it. Only a move with no such turn happened elsewhere.
      const moved = reconnect && verdict?.kind === "resumable" && verdict.record === "moved"
      const movedByOwnTurn = moved && source.blocks
        .slice(prior?.coveredBlocks ?? 0)
        .some((block) => block.type === "user" && block.requestId !== undefined)
      const forksNatively = this.host.dependencies.driver(transfer.input.provider)?.fork
      const forkSource =
        !bindings.length &&
        control.ancestry?.nativeFork?.provider === transfer.input.provider &&
        forksNatively?.kind === "native"
          ? control.ancestry.nativeFork
          : undefined
      const nativeForkDeclined = forkSource && forksNatively?.kind === "native"
        ? await forksNatively.declines?.(forkSource)
        : undefined
      if (!owned()) return
      if (nativeForkDeclined) hostLog("transfer", "native fork declined", { conversation: source.session.id, provider: transfer.input.provider, reason: nativeForkDeclined })
      const nativeFork = nativeForkDeclined ? undefined : forkSource
      const manifest = await prepareLiveContext({
        snapshot: source,
        root: join(this.host.dependencies.root, "context"),
        fromBlock: reconnect ? source.blocks.length : prior?.coveredBlocks ?? 0,
        includesBase: !nativeFork && !prior?.includesBase,
        bundles: this.host.bundles,
      })
      // Records the harness here is too old to restore go as the transcript, and the line above the reply says why.
      if (verdict?.kind === "closed" && verdict.outdated) manifest.outdated = verdict.outdated
      if (!owned()) return
      const driver = this.host.dependencies.driver(transfer.input.provider)
      if (!driver) throw new Error("The destination provider was removed")
      // A fork the harness doesn't make itself goes on from the transcript of its history, as a switch to another harness does.
      const forking = !bindings.length && control.ancestry?.kind === "fork"
      const bindingId = prior?.id ?? unstarted?.id ?? randomUUID()
      const modeId = reconnect
        ? transfer.input.modeId ??
          source.session.currentMode ??
          currentBinding?.modeId
        : transfer.input.modeId ?? prior?.modeId ?? (forking ? source.session.currentMode ?? undefined : undefined)
      const connection = prior ? resident.connections.get(prior.id) : undefined
      if (connection) {
        prepared = connection
        if (
          modeId &&
          modeId !== connection.session.currentMode
        ) {
          if (
            connection.session.modes.length > 0 &&
            !connection.session.modes.some((mode) => mode.id === modeId)
          )
            throw new Error(
              "The requested agent mode is unavailable for this provider"
            )
          await connection.driver.setMode(bindingId, modeId)
          prepared = {
            ...connection,
            session: {
              ...connection.session,
              currentMode: modeId,
            },
          }
        }
      } else {
        preparedId = bindingId
        this.host.bindingOwners.set(bindingId, source.session.id)
        resident.transferOpening = { bindingId, said: [] }
        phase.phase = "opening"
        // Two Mako hosts share every provider store; the ledger's hold is
        // taken before anything spawns so they never open one session twice.
        if (prior?.nativeId) {
          this.host.dependencies.memory?.hold(transfer.input.provider, prior.nativeId, source.session.id)
          held = prior.nativeId
        }
        const conversationTools = await this.host.dependencies.tools?.(
          bindingId,
          source.session.id
        )
        const threadEnvironment = await this.host.dependencies.threadEnvironment?.(
          source.session.id,
          source.session.title,
          source.session.cwd
        )
        const open = (resume?: { nativeId?: string; path?: string }) => this.host.nativeStart(resident, driver, bindingId, () => driver.start(source.session.cwd, {
          unattended: this.host.dependencies.unattended,
          emit: this.host.driverEvents(resident, bindingId),
          mcpSnapshot: this.host.dependencies.mcpSnapshot
            ? () => this.host.dependencies.mcpSnapshot!(source.session.cwd)
            : undefined,
          conversationId: bindingId,
          resume: resume?.nativeId,
          threadPath: resume?.path,
          observedAgents: prior?.nativeId && !nativeFork
            ? source.nativeAgents?.agents.filter((agent) => agent.bindingId === prior.id && agent.provider === prior.provider)
            : undefined,
          observedApprovals: prior?.nativeId && !nativeFork
            ? knownApprovalOccurrences(source.control, prior.id)
            : undefined,
          observedUsage: prior?.nativeId && !nativeFork && resume?.nativeId === prior.nativeId
            ? restorableTotals(source.session, prior)
            : undefined,
          fork: nativeFork,
          conversationTools,
          threadEnvironment,
          nativeRouting: launchRouting(this.host.dependencies, source.session.id, conversationTools),
          nativeCalls: launchCalls(this.host.dependencies, source.session.id, source.session.cwd, conversationTools, threadEnvironment),
          // A hand-over to another account: the binding that will name it isn't active yet.
          pinnedAccount: transfer.input.account ? () => transfer.input.account : launchAccount(resident, transfer.input.provider),
          title: source.session.title,
          tuning,
          modeId,
        }))
        const session = await open(prior && { nativeId: prior.nativeId, path: prior.path })
        prepared = { driver, session }
        if (prior?.nativeId && session.nativeId !== prior.nativeId)
          throw new Error("The provider returned a different session while resuming. The saved conversation was not replaced.")
        if (prior?.nativeId) await verifyRecoveredSession(prior, session, driver)
        if (session.nativeId && held !== session.nativeId) {
          // A new session this transfer started (a reply going on from its transcript): no other host knows it yet.
          this.host.dependencies.memory?.holdRunning(
            transfer.input.provider,
            session.nativeId,
            source.session.id
          )
          held = session.nativeId
        }
        const mode = modeId ?? null
        if (
          reconnect &&
          mode &&
          session.modes.length > 0 &&
          !session.modes.some((item) => item.id === mode)
        )
          throw new Error("The requested agent mode is unavailable after reconnecting")
        if (mode && mode !== session.currentMode) {
          await driver.setMode(bindingId, mode)
          prepared.session = { ...session, currentMode: mode }
        }
      }
      // Nothing is awaited from here to the commit: what a move was decided on is read for the last time.
      const declined = owned() && this.moves.get(transfer.input.id)?.() === false
      if (!owned() || declined) {
        if (declined) this.retire(resident, transfer, "What it was decided on changed before it moved. Nothing changed.")
        if (preparedId) {
          await prepared.driver.close(preparedId)
          void this.revokeTools(preparedId, source.session.id)
          this.forgetPrepared(resident, preparedId)
        }
        if (held)
          this.host.dependencies.memory?.release(
            transfer.input.provider,
            held,
            source.session.id
          )
        return
      }
      if (
        prepared.session.status !== "ready" ||
        prepared.session.connection !== "connected"
      )
        throw new Error(
          "The destination did not become ready; the source conversation is unchanged"
        )
      const appliedTuning = prepared.session.settings ?? tuning
      const latestBindings = this.host
        .control(resident)
        .bindings.map((binding) => {
          const coverage = bindings.find(
            (candidate) => candidate.id === binding.id
          )
          return coverage
            ? {
                ...binding,
                coveredBlocks: coverage.coveredBlocks,
                includesBase: coverage.includesBase,
                tuning: coverage.tuning,
                modeId: coverage.modeId,
              }
            : binding
        })
      const binding = {
        ...((prior &&
          latestBindings.find((candidate) => candidate.id === prior.id)) ?? {
          id: bindingId,
          provider: transfer.input.provider,
          coveredBlocks: 0,
          includesBase: false,
          path: bindingPath(this.host.dependencies, prepared.session, prepared.session.nativePath),
        }),
        nativeId: prepared.session.nativeId,
        tuning: appliedTuning,
        modeId: prepared.session.currentMode ?? modeId,
      }
      const destination = prepared
      const abandonPrepared = async (): Promise<void> => {
        if (preparedId) {
          await destination.driver.close(preparedId)
          await this.revokeTools(preparedId, source.session.id)
          this.forgetPrepared(resident, preparedId)
        }
        if (held)
          this.host.dependencies.memory?.release(
            transfer.input.provider,
            held,
            source.session.id
          )
        preparedId = null
        held = null
      }
      const accepted: ContextTransfer = {
        ...transfer,
        state: {
          kind: "accepted",
          bindingId,
          manifest,
          carried: "transcript",
          ...nativeForkDeclined && { nativeForkDeclined },
        },
      }
      const previous = resident.snapshot
      const previousControl = this.host.control(resident)
      // Its message is already in the queue when this switch was held or taken back: it stays as the person left it.
      const own = previous.requests.find((request) => request.id === transfer.input.id)
      const quiet = quietSwitch(transfer)
      // On another place the queue lands with it: every row stays a row, and a hold about the account it left goes.
      const leaving = previous.session.harness !== transfer.input.provider
      const staying = quiet || leaving
        ? arriving(previous.requests, { harness: transfer.input.provider, account: transfer.input.account, tuning: transfer.input.tuning }, leaving, transfer.first)
        : previous.requests
      // The transcript goes with the first to go: this switch's message, unless a row goes ahead of it.
      const lead = staying.find((request) => request.status === "queued")
      const ahead = lead && lead.id !== own?.id && (lead.digest || lead.id === transfer.first) ? lead.id : undefined
      const followsRow = own ? lead !== undefined && lead.id !== own.id : ahead !== undefined
      const transcript = manifest.includesBase || manifest.toBlock > manifest.fromBlock ? [manifest] : []
      const merged = quiet || (leaving && followsRow)
      const carries = {
        targetBindingId: transfer.input.bindingId ? bindingId : undefined,
        tuning: prior ? transfer.input.tuning : undefined,
        context: merged ? [] : transcript,
      }
      const nextSnapshot: LiveSnapshot = {
        ...previous,
        nativeAgents: disconnectNativeAgents(previous.nativeAgents),
        session: {
          ...prepared.session,
          id: source.session.id,
          title: source.session.title,
        },
        // The base retains its own native identity. The active native path changes independently.
        threadPath: binding.path,
        permissions: [],
        requests: own
          ? staying.map((request) => (request.id === own.id ? { ...request, ...carries } : request))
          : quiet ? staying : arrival(staying, messageOf(transfer, Date.now(), { ...carries, status: "queued" }), ahead),
        control: {
          ...this.host.control(resident),
          // Its history goes with whichever goes next.
          ...merged && transcript.length > 0 && { merges: [...previousControl.merges, { id: transfer.input.id, sourceId: transfer.input.id, sourceRevision: 0, manifest, status: "pending" as const }] },
          activeBindingId: bindingId,
          bindings: (prior ? latestBindings : unstarted ? latestBindings.map((candidate) => (candidate.id === unstarted.id ? { ...candidate, ...binding } : candidate)) : [...latestBindings, binding]).map(
            (candidate) =>
              candidate.id === bindingId
                ? {
                    ...candidate,
                    ...transfer.input.account && { account: transfer.input.account },
                    includesBase: true,
                    tuning: appliedTuning,
                    modeId: binding.modeId,
                  }
                : departedBinding(candidate, previous.session)
          ),
          transfers: this.host
            .control(resident)
            .transfers.map((candidate) =>
              candidate.input.id === transfer.input.id ? accepted : candidate
            ),
        },
      }
      // Durability precedes retirement. A failed write leaves the source
      // process, its hold and its grants untouched. Committed, the switch's
      // state is the conversation's own from here: what the person does to
      // the queue while the source closes (a Stop, an edit, a resume, a
      // removal) acts on it and is written as itself, and the switch
      // completes, a Stop or not (`Resident.transferPhase`). The flush tells
      // the windows all of it: the new process's session, the questions the
      // old one can no longer answer gone, the request, the binding.
      resident.snapshot = nextSnapshot
      try {
        this.host.flush(resident)
      } catch (error) {
        resident.snapshot = previous
        throw error
      }
      phase.phase = "committed"
      const retiring = [...resident.connections].filter(
        ([dormantId]) => dormantId !== bindingId
      )
      const retiredGenerations = new Map(
        retiring.map(([dormantId]) => [
          dormantId,
          resident.bindingGenerations.get(dormantId) ?? 0,
        ])
      )
      for (const [dormantId] of retiring)
        resident.bindingGenerations.set(
          dormantId,
          (resident.bindingGenerations.get(dormantId) ?? 0) + 1
        )
      phase.phase = "closing"
      try {
        await Promise.all(
          retiring.map(([dormantId, dormant]) =>
            dormant.driver.close(dormantId)
          )
        )
      } catch (error) {
        // Back before its commit: only what this switch did to the binding is undone, on the state as it is now, so
        // whatever else was accepted meanwhile (a Stop, an edit, a removal, another switch behind it) stands. Its
        // message stays in the queue, and the switch waits with it under whatever hold it has.
        resident.snapshot = undoSwitch(resident.snapshot, this.host.control(resident), previous, previousControl, transfer.input.id, nextSnapshot.requests)
        phase.phase = "opening"
        try {
          this.host.flush(resident)
        } catch (failure) {
          this.host.storageFailed(resident, { error: failure })
        }
        for (const [dormantId, retiredGeneration] of retiredGenerations)
          resident.bindingGenerations.set(dormantId, retiredGeneration)
        const left = this.host.control(resident).transfers.find((candidate) => candidate.input.id === transfer.input.id)
        if (left) this.tell(left)
        throw error
      }
      for (const [dormantId] of retiring) {
        resident.connections.delete(dormantId)
        await this.revokeTools(dormantId, source.session.id)
        const dormantBinding = bindings.find(
          (candidate) => candidate.id === dormantId
        )
        if (dormantBinding?.nativeId)
          this.host.dependencies.memory?.release(
            dormantBinding.provider,
            dormantBinding.nativeId,
            source.session.id
          )
      }
      if (!owned()) {
        await abandonPrepared()
        return
      }
      resident.connections.set(bindingId, prepared)
      resident.driver = prepared.driver
      if (prepared.session.nativeId)
        this.host.dependencies.memory?.remember(
          transfer.input.provider,
          prepared.session.nativeId,
          {
            settings: prepared.session.settings ?? appliedTuning,
            modeId: prepared.session.currentMode ?? modeId,
          }
        )
      preparedId = null
      held = null
      activated = true
      noteCarriedFolders(this.host.dependencies, resident.snapshot, binding)
      const said = resident.transferOpening?.said ?? []
      resident.transferOpening = undefined
      if (said.length) this.host.takeUpdates(resident, said)
      resident.snapshot = supersedeMoves(resident.snapshot, transfer.input.id)
      this.host.flush(resident)
      this.tell(accepted)
      if (moved) {
        hostLog("transfer", "reconnected past checkpoint", {
          conversation: source.session.id,
          harness: transfer.input.provider,
          nativeId: prior?.nativeId,
          cause: movedByOwnTurn ? "interrupted turn" : "outside Mako",
        })
        if (!movedByOwnTurn) this.host.dependencies.emit({
          type: "notice",
          level: "info",
          message: "This session was continued outside Mako since its last turn here. Those turns are not in this transcript; the session itself carries them.",
        })
      }
    } catch (error) {
      if (activated) {
        hostLog("transfer", "accepted transfer follow-up failed", {
          conversation: resident.snapshot.session.id,
          error: errorMessage({ error }),
        })
        return
      }
      let preparedClosed = true
      if (preparedId) {
        if (prepared)
          try {
            await prepared.driver.close(preparedId)
          } catch (closeError) {
            preparedClosed = false
            hostLog("transfer", "failed destination did not close", {
              conversation: resident.snapshot.session.id,
              binding: preparedId,
              error: errorMessage({ error: closeError }),
            })
          }
        await this.revokeTools(preparedId, resident.snapshot.session.id)
        this.forgetPrepared(resident, preparedId)
      }
      if (held && preparedClosed)
        this.host.dependencies.memory?.release(
          transfer.input.provider,
          held,
          resident.snapshot.session.id
        )
      if (owned()) {
        hostWarn("transfer", reconnect ? "reconnect failed" : "switch failed", {
          conversation: resident.snapshot.session.id,
          harness: transfer.input.provider,
          continues: transfer.continues?.reason ?? "",
          error: errorMessage({ error }),
        })
        const words = errorMessage({ error })
        const failure = classifyStartFailure(words, reconnect)
        // A cause that clears by itself: the transfer stays queued and goes again at its time (`wakeDue`), once.
        const cause = transientCause(words, failure, error instanceof SessionBusyError || error instanceof SessionHeldError)
        const retry = cause && nextRetry(transfer.retry, cause, words, Date.now())
        try {
          if (retry) {
            this.save(resident, { ...transfer, behind: undefined, state: { kind: "queued" }, retry })
            hostLog("transfer", "goes again by itself", { conversation: resident.snapshot.session.id, cause, attempt: retry.attempt, at: new Date(retry.at).toISOString() })
          } else
            this.fail(resident, transfer, { kind: "failed", error: words, failure })
        } catch (failure) {
          this.host.storageFailed(resident, { error: failure })
        }
      }
    } finally {
      phase.phase = "done"
      if (resident.transferPhase === phase) resident.transferPhase = undefined
      resident.transferring = false
      resident.transferOpening = undefined
      // `preparing` is an attempt under way: one held back as it ran waits as it did before.
      const left = this.unsettled(resident, transfer.input.id)
      if (left?.state.kind === "preparing") {
        try {
          this.save(resident, { ...left, state: { kind: "queued" } })
        } catch (failure) {
          this.host.storageFailed(resident, { error: failure })
        }
      }
    }
  }
}

/** Whether a switch has yet to commit: it has done nothing to the conversation's binding. */
export function unsettled(transfer: ContextTransfer): boolean {
  return transfer.state.kind === "queued" || transfer.state.kind === "preparing"
}

function removed(transfer: ContextTransfer): ContextTransfer {
  return { ...transfer, retry: undefined, state: { kind: "failed", error: "Removed before it was sent", removed: true } }
}

/** A switch's message as a row of the queue. */
function messageOf(transfer: ContextTransfer, createdAt: number, fields: Pick<LiveRequest, "status"> & Partial<LiveRequest>): LiveRequest {
  return LiveRequestSchema.parse({
    actor: transfer.actor,
    continues: transfer.continues,
    id: transfer.input.id,
    createdAt,
    text: transfer.input.text,
    displayText: transfer.input.displayText ?? transfer.input.text,
    attachments: transfer.input.attachments,
    ...transfer.input.grants && { grants: transfer.input.grants },
    ...transfer.input.notification && { notification: transfer.input.notification },
    ...fields,
  })
}

/**
 * A switch's message that left the queue took the switch with it, whatever took it (a removal, Clear Queue, a Thread
 * carrying it away, a start that failed): read at every write (`LiveConversations.flush`), so no path can leave a switch
 * pending behind a row that will never go.
 */
export function withdrawGone(snapshot: LiveSnapshot): LiveSnapshot {
  const control = snapshot.control
  const gone = (transfer: ContextTransfer) => {
    if (!unsettled(transfer)) return false
    const own = snapshot.requests.find((request) => request.id === transfer.input.id)
    return own !== undefined && own.status !== "queued" && own.status !== "held"
  }
  if (!control?.transfers.some(gone)) return snapshot
  return { ...snapshot, control: { ...control, transfers: control.transfers.map((transfer) => (gone(transfer) ? removed(transfer) : transfer)) } }
}

/**
 * A Stop reaches every switch not yet committed, waiting or under way: each is queued work, so it waits as a message of
 * the queue, held by the Stop, and from here on is edited, removed and resumed as any message is. An attempt under way
 * sees its transfer no longer next and drops what it comes back with (`LiveTransfers.perform`).
 */
export function holdSwitches(snapshot: LiveSnapshot): HeldSwitches {
  const control = snapshot.control
  const waiting = control?.transfers.filter(unsettled) ?? []
  if (!control || !waiting.length) return { snapshot, held: 0, retired: [] }
  // One with no message has nothing to wait with: it goes no further, so no binding changes after the Stop.
  const held = waiting.filter((transfer) => !quietSwitch(transfer))
  const retired = waiting.filter(quietSwitch).map((transfer) => retiredMove(transfer, STOP_RETIRED_MOVE))
  const fresh = held.filter((transfer) => !snapshot.requests.some((request) => request.id === transfer.input.id))
  return {
    held: held.length,
    retired,
    snapshot: {
      ...snapshot,
      requests: fresh.reduce((requests, transfer) => admittedInPlace(requests, messageOf(transfer, transfer.createdAt, { status: "held", pause: "stop" })), snapshot.requests),
      control: { ...control, transfers: control.transfers.map((transfer) => retired.find((over) => over.input.id === transfer.input.id) ?? (unsettled(transfer) ? { ...transfer, retry: undefined, state: { kind: "queued" as const } } : transfer)) },
    },
  }
}

/** A move's history no message took yet is the latest switch's to carry: that one's manifest, from its own binding, says it. */
function supersedeMoves(snapshot: LiveSnapshot, id: string): LiveSnapshot {
  const control = snapshot.control
  const moved = (merge: ConversationControl["merges"][number]) => merge.status === "pending" && merge.id === merge.sourceId && merge.id !== id
  if (!control?.merges.some(moved)) return snapshot
  return { ...snapshot, control: { ...control, merges: control.merges.filter((merge) => !moved(merge)) } }
}

/**
 * A committed switch taken back (its source wouldn't close), as an operation on the conversation as it is now: the
 * session, binding and history it made the conversation's go back to `before`'s, and nothing else moves. Its message
 * keeps its words, its place and its holds, losing only the destination's context, and the switch waits with it to go
 * again (`withdrawGone`: one whose message was removed goes with it).
 */
function undoSwitch(current: LiveSnapshot, control: ConversationControl, before: LiveSnapshot, beforeControl: ConversationControl, id: string, landed: LiveSnapshot["requests"]): LiveSnapshot {
  const was = beforeControl.transfers.find((transfer) => transfer.input.id === id)
  return {
    ...current,
    nativeAgents: before.nativeAgents,
    session: before.session,
    threadPath: before.threadPath,
    permissions: before.permissions,
    requests: departing(current.requests, before.requests, landed).map((request) => (request.id === id ? { ...request, context: undefined, targetBindingId: undefined } : request)),
    control: {
      ...control,
      activeBindingId: beforeControl.activeBindingId,
      bindings: beforeControl.bindings,
      merges: control.merges.filter((merge) => merge.id !== id),
      transfers: control.transfers.map((transfer) => {
        if (transfer.input.id !== id || !was) return transfer
        return quietSwitch(was) ? retiredMove(was, CLOSE_RETIRED_MOVE) : { ...was, behind: undefined, state: { kind: "queued" as const } }
      }),
    },
  }
}
