import { disconnectNativeAgents } from "./contracts/native-agents.js"
import { createHash, randomUUID } from "node:crypto"
import { join } from "node:path"
import { TransferInputSchema, resumable } from "./contracts/conversation-control.js"
import type {
  TransferInput,
  ContextTransfer,
  ResumeVerdict,
} from "./contracts/conversation-control.js"
import { heldReason } from "./contracts/session-hold.js"
import { classifyStartFailure } from "./contracts/provider-failure.js"
import type { LiveSnapshot } from "./shared.js"
import { hostLog } from "./host-log.js"
import { LiveRequestSchema } from "./live-journal.js"
import { prepareLiveContext } from "./live-context.js"
import { errorMessage } from "./live-runtime.js"
import type {
  LiveAccess,
  Resident,
  ProviderConnection,
} from "./live-runtime.js"

/** Why a reconnect could not go on from the saved session; the reason is the verdict's own. */
export function reconnectRefusal(verdict: ResumeVerdict | undefined): string {
  if (verdict?.kind === "held") return heldReason(verdict.by)
  const reason = verdict?.kind === "unavailable" ? verdict.reason : "The saved binding names no session this provider can reopen."
  return `The saved native session cannot be resumed. ${reason} No replacement session was started.`
}

/** Durable switch acceptance and provider preparation, separate from token ingestion. */
export class LiveTransfers {
  private readonly host: LiveAccess
  constructor(host: LiveAccess) {
    this.host = host
  }
  accept(id: string, input: TransferInput): LiveSnapshot {
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
        ...control,
        transfers: [
          ...control.transfers,
          {
            input: command,
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
    void this.perform(resident)
    return resident.snapshot
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

  async perform(resident: Resident): Promise<void> {
    const transfer = this.pending(resident)
    if (
      !transfer ||
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
    resident.transferring = true
    const generation = resident.generation
    let prepared: ProviderConnection | null = null
    let preparedId: string | null = null
    let held: string | null = null
    let reconnect = false
    try {
      this.save(resident, { ...transfer, state: { kind: "preparing" } })
      const source = resident.snapshot
      const control = this.host.control(resident)
      const currentBinding = control.bindings.find((binding) => binding.id === control.activeBindingId)
      reconnect = !resident.driver && currentBinding?.provider === transfer.input.provider && Boolean(currentBinding.nativeId)
      const tuning = transfer.input.tuning ?? (reconnect ? source.session.settings ?? currentBinding?.tuning : undefined)
      const bindings = control.bindings.map((binding) =>
        binding.id === control.activeBindingId && resident.driver
          ? {
              ...binding,
              coveredBlocks: source.blocks.length,
              includesBase: binding.includesBase,
            }
          : binding
      )
      // Reuse only a live, idle connection with identical launch settings. A dormant
      // native file may have changed outside Mako; a fresh full handoff is the safe fallback.
      let prior = bindings.find(
        (binding) =>
          binding.provider === transfer.input.provider &&
          JSON.stringify(binding.tuning) ===
            JSON.stringify(transfer.input.tuning) &&
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
        this.host.dependencies.driver(transfer.input.provider)?.canResume
      ) {
        for (const binding of [...bindings].reverse()) {
          if (
            binding.provider !== transfer.input.provider ||
            !(reconnect ? binding.id === control.activeBindingId : JSON.stringify(binding.tuning) === JSON.stringify(transfer.input.tuning))
          )
            continue
          const candidate = await this.host.dependencies.resumeVerdict?.(binding)
          if (reconnect) verdict = candidate
          if (candidate && resumable(candidate, reconnect ? "moved" : "same")) {
            prior = binding
            break
          }
        }
      }
      if (reconnect && !prior) throw new Error(reconnectRefusal(verdict))
      const moved = reconnect && verdict?.kind === "resumable" && verdict.record === "moved"
      const nativeFork =
        !bindings.length &&
        control.ancestry?.nativeFork?.provider === transfer.input.provider &&
        this.host.dependencies.driver(transfer.input.provider)?.forkPoint
          ? control.ancestry.nativeFork
          : undefined
      const manifest = await prepareLiveContext({
        snapshot: source,
        root: join(this.host.dependencies.root, "context"),
        fromBlock: reconnect ? source.blocks.length : prior?.coveredBlocks ?? 0,
        includesBase: !nativeFork && !prior?.includesBase,
      })
      if (resident.generation !== generation) return
      const driver = this.host.dependencies.driver(transfer.input.provider)
      if (!driver) throw new Error("The destination provider was removed")
      const bindingId = prior?.id ?? randomUUID()
      const connection = prior ? resident.connections.get(prior.id) : undefined
      if (connection) prepared = connection
      else {
        preparedId = bindingId
        this.host.bindingOwners.set(bindingId, source.session.id)
        // Two Mako hosts share every provider store; the ledger's hold is
        // taken before anything spawns so they never open one session twice.
        if (prior?.nativeId) {
          this.host.dependencies.memory?.hold(transfer.input.provider, prior.nativeId, source.session.id)
          held = prior.nativeId
        }
        const session = await driver.start(source.session.cwd, {
          emit: (event) => this.host.observe(event),
          mcpSnapshot: this.host.dependencies.mcpSnapshot
            ? () => this.host.dependencies.mcpSnapshot!(source.session.cwd)
            : undefined,
          conversationId: bindingId,
          resume: prior?.nativeId,
          fork: nativeFork,
          conversationTools: this.host.dependencies.tools?.(
            bindingId,
            source.session.id
          ),
          title: source.session.title,
          tuning,
        })
        prepared = { driver, session }
        if (prior?.nativeId && session.nativeId !== prior.nativeId)
          throw new Error("The provider returned a different session while resuming. The saved conversation was not replaced.")
        const mode = reconnect ? source.session.currentMode : null
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
          prepared.driver.close(preparedId)
          this.host.bindingOwners.delete(preparedId)
        }
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
              }
            : binding
        })
      const binding = (prior &&
        latestBindings.find((candidate) => candidate.id === prior.id)) ?? {
        id: bindingId,
        provider: transfer.input.provider,
        nativeId: prepared.session.nativeId,
        tuning: appliedTuning,
        coveredBlocks: 0,
        includesBase: false,
      }
      const accepted: ContextTransfer = {
        ...transfer,
        state: { kind: "accepted", bindingId, manifest },
      }
      const previous = resident.snapshot
      const previousDriver = resident.driver
      resident.connections.set(bindingId, prepared)
      resident.driver = prepared.driver
      resident.snapshot = {
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
            id: transfer.input.id,
            text: transfer.input.text,
            displayText: transfer.input.text,
            attachments: transfer.input.attachments,
            context:
              manifest.includesBase || manifest.toBlock > manifest.fromBlock
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
                ? { ...candidate, includesBase: true, tuning: appliedTuning }
                : candidate
          ),
          transfers: this.host
            .control(resident)
            .transfers.map((candidate) =>
              candidate.input.id === transfer.input.id ? accepted : candidate
            ),
        },
      }
      try {
        this.host.flush(resident)
      } catch (error) {
        resident.snapshot = previous
        resident.driver = previousDriver
        if (preparedId) resident.connections.delete(preparedId)
        throw error
      }
      preparedId = null
      held = null
      if (moved) {
        hostLog("transfer", "reconnected past checkpoint", {
          conversation: source.session.id,
          harness: transfer.input.provider,
          nativeId: prior?.nativeId,
        })
        this.host.dependencies.emit({
          type: "notice",
          level: "info",
          message: "This session's record moved while Mako was away: the interrupted turn finished, or the session was continued elsewhere. The saved transcript may not show that part; the session itself continues from where the provider left it.",
        })
      }
      // Bound idle provider processes. Evicted bindings remain in provenance and
      // receive a complete context package if selected again.
      resident.connections.delete(bindingId)
      resident.connections.set(bindingId, prepared)
      while (resident.connections.size > 4) {
        const oldest = resident.connections.entries().next().value
        if (!oldest) break
        resident.connections.delete(oldest[0])
        oldest[1].driver.close(oldest[0])
      }
    } catch (error) {
      if (preparedId) {
        prepared?.driver.close(preparedId)
        this.host.bindingOwners.delete(preparedId)
      }
      if (held) this.host.dependencies.memory?.release(transfer.input.provider, held, resident.snapshot.session.id)
      if (resident.generation === generation) {
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
      if (!this.pending(resident)) this.host.drain(resident)
    }
  }
}
