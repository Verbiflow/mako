import { resumes } from "./providers/live-capabilities.js"
import { retireQuestionsForInput } from "./contracts/live-questions.js"
import { knownApprovalOccurrences } from "./live-approvals.js"
import { disconnectNativeAgents } from "./contracts/native-agents.js"
import { createHash, randomUUID } from "node:crypto"
import { access, realpath } from "node:fs/promises"
import { join } from "node:path"
import { TransferInputSchema, resumable } from "./contracts/conversation-control.js"
import type {
  TransferInput,
  ContextTransfer,
  ResumeVerdict,
} from "./contracts/conversation-control.js"
import { heldReason } from "./contracts/session-hold.js"
import type { Actor } from "./contracts/thread-identity.js"
import type { TurnContinuation } from "./contracts/live-conversations.js"
import { classifyStartFailure } from "./contracts/provider-failure.js"
import type { LiveSnapshot } from "./shared.js"
import { hostLog, hostWarn } from "./host-log.js"
import { verifyRecoveredSession } from "./provider-recovery.js"
import { LiveRequestSchema } from "./live-journal.js"
import { departedBinding, restorableTotals } from "./session-usage.js"
import { capturedThread, prepareLiveContext } from "./live-context.js"
import { bindingPath, errorMessage } from "./live-runtime.js"
import type {
  LiveAccess,
  Resident,
  ProviderConnection,
} from "./live-runtime.js"

/** Why a reconnect could not go on from the saved session; the reason is the verdict's own. */
export function reconnectRefusal(verdict: ResumeVerdict | undefined): string {
  if (verdict?.kind === "held") return heldReason(verdict.by)
  if (verdict?.kind === "closed") return `${verdict.reason} Send the message again to continue.`
  const reason = verdict?.kind === "unavailable" ? verdict.reason : "The saved binding names no session this provider can reopen."
  return `The saved native session cannot be resumed. ${reason} No replacement session was started.`
}

/** Durable switch acceptance and provider preparation, separate from token ingestion. */
export class LiveTransfers {
  private readonly host: LiveAccess
  constructor(host: LiveAccess) {
    this.host = host
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
  accept(id: string, input: TransferInput, actor?: Actor, continues?: TurnContinuation): LiveSnapshot {
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
    if (!command.text.trim() && !command.attachments.length)
      throw new Error("A transfer needs a request or an attachment")
    if (this.pending(resident))
      throw new Error("A provider switch is already pending")
    if (
      resident.snapshot.requests.some((request) => request.status === "queued")
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
    this.start(resident)
    return resident.snapshot
  }

  start(resident: Resident): void {
    const transfer = this.pending(resident)
    if (
      !transfer ||
      resident.transferOperation ||
      resident.storageFault ||
      resident.hibernating ||
      resident.waking ||
      resident.transferring ||
      resident.closing ||
      resident.checkpointing ||
      resident.rewinding ||
      resident.opening ||
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

  pending(resident: Resident): ContextTransfer | undefined {
    return this.host
      .control(resident)
      .transfers.find(
        (transfer) =>
          transfer.state.kind === "queued" ||
          transfer.state.kind === "preparing"
      )
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
  }

  /**
   * The whole conversation written into the destination's own session store,
   * for a destination that opens a new session. Any harness with a session
   * emitter and a driver that resumes gets this; the rest go as transcript.
   */
  private async importSession(
    source: LiveSnapshot,
    provider: string,
    canResume: boolean
  ): Promise<{ sessionId: string; path: string } | { fallback: string }> {
    if (!canResume || !this.host.dependencies.emitSession)
      return { fallback: "This agent cannot resume an imported session." }
    const thread = capturedThread(source, 0, true)
    try {
      const emitted = await this.host.dependencies.emitSession(provider, {
        ...thread,
        ref: { ...thread.ref, cwd: source.session.cwd },
      })
      if (!emitted) return { fallback: "This agent has no session import." }
      // An account's store can reach the shared one through a symlink; the
      // session index knows the file by its real path.
      return { sessionId: emitted.sessionId, path: await realSourcePath(emitted.path) }
    } catch (error) {
      hostLog("transfer", "session import failed", {
        conversation: source.session.id,
        harness: provider,
        error: errorMessage({ error }),
      })
      return { fallback: `Writing its session failed: ${errorMessage({ error })}` }
    }
  }

  private async perform(
    resident: Resident,
    transfer: ContextTransfer
  ): Promise<void> {
    resident.transferring = true
    const generation = resident.generation
    let prepared: ProviderConnection | null = null
    let preparedId: string | null = null
    let held: string | null = null
    let reconnect = false
    let activated = false
    try {
      this.save(resident, { ...transfer, state: { kind: "preparing" } })
      await this.host.locateNativePath(resident)
      this.host.returnFromRemovedWorktree(resident)
      const source = resident.snapshot
      const control = this.host.control(resident)
      const target = transfer.input.bindingId
      if (target && !control.bindings.some((binding) => binding.id === target && binding.provider === transfer.input.provider))
        throw new Error("The selected native session is unavailable")
      const currentBinding = control.bindings.find((binding) => binding.id === control.activeBindingId)
      reconnect = (!target || target === control.activeBindingId) && !resident.driver && currentBinding?.provider === transfer.input.provider && Boolean(currentBinding.nativeId)
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
      // Reuse only a live, idle connection with identical launch settings. A dormant
      // native file may have changed outside Mako; a fresh full handoff is the safe fallback.
      let prior = bindings.find(
        (binding) =>
          (!target || binding.id === target) &&
          binding.provider === transfer.input.provider &&
          (transfer.input.tuning === undefined ||
            JSON.stringify(binding.tuning) ===
              JSON.stringify(transfer.input.tuning)) &&
          resident.connections.get(binding.id)?.session.status === "ready"
      )
      // A reconnect goes on from the session as it is: a record that moved past
      // the binding's checkpoint is the turn this host lost when it died, or the
      // CLI's own continuation, and the native session carries it either way.
      // Only ownership refuses. A provider switch that reuses an old binding
      // sends context from that checkpoint, so it still wants the record unmoved.
      let verdict: ResumeVerdict | undefined
      if (
        !prior &&
        resumes(this.host.dependencies.driver(transfer.input.provider))
      ) {
        for (const binding of [...bindings].reverse()) {
          if (
            (target && binding.id !== target) ||
            binding.provider !== transfer.input.provider ||
            !(target || (reconnect
              ? binding.id === control.activeBindingId
              : transfer.input.tuning === undefined ||
                JSON.stringify(binding.tuning) ===
                  JSON.stringify(transfer.input.tuning)))
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
      // whole conversation; any other record that won't reopen refuses.
      if (verdict?.kind === "closed") reconnect = false
      else if ((reconnect || target) && !prior) throw new Error(reconnectRefusal(verdict))
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
      if (resident.generation !== generation) return
      if (nativeForkDeclined) hostLog("transfer", "native fork declined", { conversation: source.session.id, provider: transfer.input.provider, reason: nativeForkDeclined })
      const nativeFork = nativeForkDeclined ? undefined : forkSource
      const manifest = await prepareLiveContext({
        snapshot: source,
        root: join(this.host.dependencies.root, "context"),
        fromBlock: reconnect ? source.blocks.length : prior?.coveredBlocks ?? 0,
        includesBase: !nativeFork && !prior?.includesBase,
      })
      if (resident.generation !== generation) return
      const driver = this.host.dependencies.driver(transfer.input.provider)
      if (!driver) throw new Error("The destination provider was removed")
      // A fork goes on as the same conversation, so it opens on its history in the harness's own session store unless the harness forks itself.
      const forking = !bindings.length && control.ancestry?.kind === "fork"
      const carry = (transfer.input.carry === "native" || forking) && !prior && !reconnect && !target && !nativeFork
        ? await this.importSession(source, transfer.input.provider, resumes(driver))
        : undefined
      if (resident.generation !== generation) return
      let imported = carry && "sessionId" in carry ? carry : undefined
      let fallback = carry && "fallback" in carry ? carry.fallback : undefined
      const bindingId = prior?.id ?? randomUUID()
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
          title: source.session.title,
          tuning,
          modeId,
        }))
        let session: Awaited<ReturnType<typeof open>>
        if (imported) {
          try {
            session = await open({ nativeId: imported.sessionId, path: imported.path })
            if (session.nativeId !== imported.sessionId) {
              await driver.close(bindingId)
              throw new Error("it opened a different session")
            }
          } catch (error) {
            fallback = `It did not resume the imported session: ${errorMessage({ error })}`
            hostLog("transfer", "native carry fell back to transcript", {
              conversation: source.session.id,
              harness: transfer.input.provider,
              error: errorMessage({ error }),
            })
            imported = undefined
            session = await open()
          }
        } else session = await open(prior && { nativeId: prior.nativeId, path: prior.path })
        prepared = { driver, session }
        if (prior?.nativeId && session.nativeId !== prior.nativeId)
          throw new Error("The provider returned a different session while resuming. The saved conversation was not replaced.")
        if (prior?.nativeId) await verifyRecoveredSession(prior, session, driver)
        if (session.nativeId && held !== session.nativeId) {
          this.host.dependencies.memory?.hold(
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
      if (resident.generation !== generation) {
        if (preparedId) {
          await prepared.driver.close(preparedId)
          void this.revokeTools(preparedId, source.session.id)
          this.host.bindingOwners.delete(preparedId)
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
          coveredBlocks: imported ? source.blocks.length : 0,
          includesBase: false,
          path: imported?.path ?? bindingPath(this.host.dependencies, prepared.session, prepared.session.nativePath),
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
          this.host.bindingOwners.delete(preparedId)
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
          carried: imported ? "native" : "transcript",
          fallback,
          ...nativeForkDeclined && { nativeForkDeclined },
        },
      }
      const previous = resident.snapshot
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
        requests: [
          ...previous.requests,
          LiveRequestSchema.parse({
            actor: transfer.actor,
            continues: transfer.continues,
            id: transfer.input.id,
            targetBindingId: transfer.input.bindingId ? bindingId : undefined,
            text: transfer.input.text,
            displayText: transfer.input.displayText ?? transfer.input.text,
            attachments: transfer.input.attachments,
            context:
              !imported && (manifest.includesBase || manifest.toBlock > manifest.fromBlock)
                ? [manifest]
                : [],
            status: "queued",
          }),
        ],
        control: {
          ...this.host.control(resident),
          activeBindingId: bindingId,
          bindings: (prior ? latestBindings : [...latestBindings, binding]).map(
            (candidate) =>
              candidate.id === bindingId
                ? {
                    ...candidate,
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
      // process, its hold and its grants untouched.
      resident.journal.commit(nextSnapshot, resident.journalSnapshot)
      resident.journalSnapshot = nextSnapshot
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
      try {
        await Promise.all(
          retiring.map(([dormantId, dormant]) =>
            dormant.driver.close(dormantId)
          )
        )
      } catch (error) {
        resident.journal.commit(previous, nextSnapshot)
        resident.journalSnapshot = previous
        for (const [dormantId, retiredGeneration] of retiredGenerations)
          resident.bindingGenerations.set(dormantId, retiredGeneration)
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
      if (resident.generation !== generation) {
        await abandonPrepared()
        return
      }
      resident.connections.set(bindingId, prepared)
      resident.driver = prepared.driver
      resident.snapshot = nextSnapshot
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
      this.host.flush(resident)
      if (fallback) this.host.dependencies.emit({
        type: "notice",
        level: "info",
        message: `Session import did not work, so the conversation went as a transcript instead. ${fallback}`,
      })
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
        this.host.bindingOwners.delete(preparedId)
      }
      if (held && preparedClosed)
        this.host.dependencies.memory?.release(
          transfer.input.provider,
          held,
          resident.snapshot.session.id
        )
      if (resident.generation === generation) {
        hostWarn("transfer", reconnect ? "reconnect failed" : "switch failed", {
          conversation: resident.snapshot.session.id,
          harness: transfer.input.provider,
          continues: transfer.continues?.reason ?? "",
          error: errorMessage({ error }),
        })
        try {
          this.save(resident, {
            ...transfer,
            state: {
              kind: "failed",
              error: errorMessage({ error }),
              failure: classifyStartFailure(errorMessage({ error }), reconnect),
            },
          })
        } catch (failure) {
          this.host.storageFailed(resident, { error: failure })
        }
      }
    } finally {
      resident.transferring = false
    }
  }
}

/** A store holding many sessions, as Devin's `sessions.db`, names one as `file#record`; only the file resolves. */
async function realSourcePath(path: string): Promise<string> {
  const record = path.lastIndexOf("#")
  if (record <= 0 || await access(path).then(() => true, () => false)) return realpath(path)
  return `${await realpath(path.slice(0, record))}${path.slice(record)}`
}
