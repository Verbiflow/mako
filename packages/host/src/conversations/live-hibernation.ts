import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { resumable, type ProviderBinding } from "../contracts/conversation-control.js"
import { disconnectNativeAgents, isActiveNativeAgent } from "../contracts/native-agents.js"
import type { ConversationMemory, ProviderResidencyEntry, ProviderResidencySnapshot } from "../contracts/provider-residency.js"
import type { LiveSessionState } from "../contracts/providers-acp.js"
import { signInPause } from "../contracts/sign-in-hold.js"
import { resumes, restorableTotals, verifyRecoveredSession } from "../harnesses/index.js"
import { knownApprovalOccurrences } from "./live-approvals.js"
import { nativeStart } from "./live-launches.js"
import { releaseHold } from "./live-ledger.js"
import { activeBinding, conversationControl, revokeTools, type LiveAccess, type Resident } from "./live-runtime.js"
import { updateBinding } from "./live-sources.js"
import { reconnectRefusal } from "./live-transfers.js"

export const PROVIDER_IDLE_MS = 10 * 60_000
export const PROVIDER_WARM_LIMIT = 2

type HibernationAccess = Pick<LiveAccess,
  "dependencies" | "residents" | "load" | "flush" | "drain" | "moves" | "retireFromAccount" | "locateNativePath" |
  "failedStart" | "returnFromRemovedWorktree" | "driverEvents">

/**
 * Which conversations keep a provider process: a ready one stays warm for
 * `PROVIDER_IDLE_MS`, at most `PROVIDER_WARM_LIMIT` at once, then hibernates
 * on its native session and wakes on the next prompt.
 */
export class LiveHibernation {
  private readonly access: HibernationAccess

  constructor(access: HibernationAccess) {
    this.access = access
  }

  snapshot(memory: ConversationMemory): ProviderResidencySnapshot {
    const entries: ProviderResidencyEntry[] = [...this.access.residents()]
      .filter(
        (resident) => resident.snapshot.session.status !== "closed"
      )
      .map(
      (resident) => {
        const { session } = resident.snapshot
        const binding = activeBinding(resident)
        const resumable =
          Boolean(binding?.nativeId && binding.path) &&
          resident.snapshot.requests.some(
            (request) =>
              request.status === "completed" ||
              request.status === "interrupted"
          )
        const state: ProviderResidencyEntry["state"] =
          session.connection === "hibernated"
            ? "hibernated"
            : session.connection === "disconnected"
              ? "disconnected"
              : session.status === "running" ||
                  session.backgroundTasks ||
                  resident.snapshot.nativeAgents?.agents.some(isActiveNativeAgent) ||
                  resident.opening ||
                  resident.transferring ||
                  resident.snapshot.requests.some(
                    (request) =>
                      request.status === "queued" ||
                      request.status === "dispatching"
                  )
                ? "active"
                : resumable
                  ? "warm"
                  : "protected"
        return {
          conversationId: session.id,
          provider: session.harness,
          title: session.title || "Untitled conversation",
          state,
        }
      }
      )
    const count = (state: ProviderResidencyEntry["state"]) =>
      entries.filter((entry) => entry.state === state).length
    return {
      entries,
      active: count("active"),
      warm: count("warm"),
      protected: count("protected"),
      hibernated: count("hibernated"),
      disconnected: count("disconnected"),
      warmLimit:
        this.access.dependencies.providerWarmLimit ?? PROVIDER_WARM_LIMIT,
      idleMs: this.access.dependencies.providerIdleMs ?? PROVIDER_IDLE_MS,
      memory,
    }
  }

  hibernateIfIdle(id: string, reason = "explicit"): boolean {
    const resident = this.access.load(id)
    if (!resident || !this.canHibernate(resident)) return false
    void this.hibernate(resident, reason)
    return true
  }

  /**
   * The user started writing to this conversation. A hibernated one wakes now,
   * so its two-second restart overlaps the typing instead of following Send;
   * a warm one restarts its idle window so it cannot hibernate under the draft.
   */
  prewarm(id: string): "waking" | "kept-warm" | "unchanged" {
    const resident = this.access.load(id)
    if (!resident || resident.closing || resident.retireWhenIdle || resident.snapshot.session.status === "closed") return "unchanged"
    if (signInPause(resident.snapshot.requests)) return "unchanged"
    if (resident.hibernating || (!resident.driver && this.reopens(resident))) {
      if (!resident.waking) hostLog("residency", "prewarm waking", { conversation: id, harness: resident.snapshot.session.harness })
      void this.wake(resident)
      return "waking"
    }
    if (!this.canHibernate(resident)) return "unchanged"
    this.clearHibernationTimer(resident)
    this.scheduleHibernation(resident, false)
    return "kept-warm"
  }

  setArchived(id: string, archived: boolean): void {
    const resident = this.access.load(id)
    if (!resident) return
    resident.retireWhenIdle = archived
    if (archived) {
      if (this.canHibernate(resident))
        void this.hibernate(resident, "thread-archived")
    } else if (this.canHibernate(resident)) {
      this.scheduleHibernation(resident)
    }
  }

  clearHibernationTimer(resident: Resident, clearSince = true): void {
    if (resident.idleTimer) clearTimeout(resident.idleTimer)
    resident.idleTimer = undefined
    if (clearSince) resident.idleSince = undefined
  }

  canHibernate(resident: Resident, preparing = false, recoverAccount = false): boolean {
    const native = resident.snapshot.nativeAgents?.agents ?? []
    const binding = activeBinding(resident)
    const driver = this.access.dependencies.driver(binding?.provider ?? "")
    return Boolean(
      resident.driver &&
        resumes(driver) &&
        resident.snapshot.session.connection === "connected" &&
        resident.snapshot.session.status === "ready" &&
        !resident.snapshot.session.backgroundTasks &&
        binding?.nativeId &&
        binding.path &&
        !resident.opening &&
        !resident.closing &&
        (!resident.hibernating || preparing) &&
        !resident.waking &&
        !resident.transferring &&
        !resident.checkpointing &&
        !resident.rewinding &&
        !resident.autoContinue &&
        !resident.snapshot.permissions.length &&
        (recoverAccount || resident.snapshot.requests.some(
          (request) =>
            request.status === "completed" ||
            request.status === "interrupted"
        )) &&
        !resident.snapshot.requests.some(
          (request) =>
            request.status === "dispatching" ||
            (request.status === "queued" && !this.access.moves.holdsQueued(resident) &&
              !(recoverAccount && (!request.nativeDelivery || request.nativeDelivery.evidence.kind === "not-accepted")))
        ) &&
        !native.some(isActiveNativeAgent)
    )
  }

  scheduleHibernation(
    resident: Resident,
    enforceWarmLimit = true
  ): void {
    const { dependencies } = this.access
    if (resident.driver && dependencies.accountRemoving?.(conversationControl(resident).activeBindingId) &&
      this.canHibernate(resident, false, true)) {
      this.clearHibernationTimer(resident)
      void this.access.retireFromAccount(resident)
      return
    }
    if (!this.canHibernate(resident)) {
      this.clearHibernationTimer(resident)
      return
    }
    const now = dependencies.now?.() ?? Date.now()
    resident.idleSince ??= now
    if (resident.retireWhenIdle) {
      void this.hibernate(resident, "thread-archived")
      return
    }
    if (resident.idleTimer) clearTimeout(resident.idleTimer)
    const idleMs = dependencies.providerIdleMs ?? PROVIDER_IDLE_MS
    resident.idleTimer = setTimeout(() => {
      resident.idleTimer = undefined
      void this.hibernate(resident, "idle-timeout")
    }, Math.max(0, idleMs - (now - resident.idleSince)))
    resident.idleTimer.unref?.()
    if (!enforceWarmLimit) return
    const warmLimit =
      dependencies.providerWarmLimit ?? PROVIDER_WARM_LIMIT
    const warm = [...this.access.residents()]
      .filter((candidate) => this.canHibernate(candidate))
      .sort(
        (left, right) =>
          (left.idleSince ?? Number.POSITIVE_INFINITY) -
          (right.idleSince ?? Number.POSITIVE_INFINITY)
      )
    for (const candidate of warm.slice(
      0,
      Math.max(0, warm.length - warmLimit)
    ))
      void this.hibernate(candidate, "warm-pool-limit")
  }

  private async refreshIdleCheckpoint(
    resident: Resident,
    binding: ProviderBinding,
    generation: number
  ): Promise<boolean> {
    const { dependencies } = this.access
    if (!binding.path || !dependencies.checkpoint)
      return Boolean(binding.path)
    const checkpoint = await dependencies.checkpoint(
      binding.path,
      binding.provider
    )
    if (
      !checkpoint ||
      resident.generation !== generation ||
      activeBinding(resident)?.id !== binding.id
    )
      return false
    const control = conversationControl(resident)
    resident.snapshot = {
      ...resident.snapshot,
      control: {
        ...control,
        bindings: control.bindings.map((candidate) =>
          candidate.id === binding.id
            ? {
                ...candidate,
                checkpoint,
                coveredBlocks: resident.snapshot.blocks.length,
              }
            : candidate
        ),
      },
    }
    this.access.flush(resident)
    return true
  }

  hibernate(resident: Resident, reason: string): Promise<void> {
    if (resident.hibernating) return resident.hibernating
    const operation = this.hibernateNow(resident, reason)
      .catch((error) => {
        hostWarn("residency", "hibernate failed", {
          conversation: resident.snapshot.session.id,
          harness: resident.snapshot.session.harness,
          error: errorMessage({ error }),
        })
      })
      .finally(() => {
        if (resident.hibernating === operation) {
          resident.hibernating = undefined
          if (this.canHibernate(resident))
            this.scheduleHibernation(resident, false)
        }
      })
    resident.hibernating = operation
    return operation
  }

  private async hibernateNow(
    resident: Resident,
    reason: string
  ): Promise<void> {
    // Input that never reached the provider waits through these, for the provider that starts next.
    const recoverAccount = reason === "account-change" || reason === "folder-removed"
    if (!this.canHibernate(resident, false, recoverAccount)) return
    const binding = activeBinding(resident)
    if (!binding?.nativeId || !binding.path) return
    const generation = resident.generation
    this.clearHibernationTimer(resident)
    const checkpointReady = await this.refreshIdleCheckpoint(
      resident,
      binding,
      generation
    )
    if (
      !checkpointReady ||
      resident.generation !== generation ||
      !this.canHibernate(resident, true, recoverAccount)
    )
      return
    const retiringGeneration = ++resident.generation
    const connectionIds = [...resident.connections.keys()]
    try {
      await Promise.all(
        [...resident.connections].map(([bindingId, connection]) =>
          connection.driver.close(bindingId)
        )
      )
    } catch (error) {
      if (resident.generation === retiringGeneration)
        resident.generation = generation
      throw error
    }
    if (resident.generation !== retiringGeneration) return
    await Promise.all(
      connectionIds.map((bindingId) =>
        revokeTools(this.access.dependencies, bindingId, resident.snapshot.session.id)
      )
    )
    if (resident.generation !== retiringGeneration) return
    resident.connections.clear()
    resident.driver = null
    resident.snapshot = {
      ...resident.snapshot,
      nativeAgents: disconnectNativeAgents(resident.snapshot.nativeAgents),
      session: {
        ...resident.snapshot.session,
        connection: "hibernated",
        status: "ready",
        error: undefined,
      },
    }
    this.access.flush(resident)
    hostLog("residency", "provider hibernated", {
      conversation: resident.snapshot.session.id,
      harness: resident.snapshot.session.harness,
      nativeId: binding.nativeId,
      reason,
    })
  }

  /** Reconnect an idle conversation whose native session can resume, as a follow-up would. */
  async reopen(resident: Resident): Promise<void> {
    if (resident.driver || resident.snapshot.session.status === "closed") return
    await this.access.locateNativePath(resident)
    if (!resident.driver && this.reopens(resident)) await this.wake(resident)
  }

  /** Whether an unconnected conversation resumes on wake; a disconnected one with a recorded session becomes hibernated. */
  reopens(resident: Resident): boolean {
    const binding = activeBinding(resident)
    if (resident.snapshot.session.connection === "disconnected" && binding?.nativeId && binding.path) {
      resident.snapshot = { ...resident.snapshot, session: { ...resident.snapshot.session, connection: "hibernated" } }
      this.access.flush(resident)
    }
    return resident.snapshot.session.connection === "hibernated"
  }

  wake(resident: Resident): Promise<void> {
    if (resident.waking) return resident.waking
    const hibernating = resident.hibernating
    const operation = (async () => {
      await hibernating
      await this.wakeNow(resident)
    })().finally(() => {
      if (resident.waking === operation) {
        resident.waking = undefined
        this.access.drain(resident)
      }
    })
    resident.waking = operation
    return operation
  }

  private async wakeNow(resident: Resident): Promise<void> {
    const { dependencies } = this.access
    if (
      !this.access.moves.executes(resident) ||
      resident.driver ||
      resident.snapshot.session.connection !== "hibernated" ||
      resident.snapshot.session.status === "closed"
    )
      return
    const binding = activeBinding(resident)
    const driver = dependencies.driver(binding?.provider ?? "")
    if (
      !binding?.nativeId ||
      !binding.path ||
      !driver ||
      !resumes(driver) ||
      !driver.available(dependencies.appPath)
    ) {
      const message =
        "The hibernated provider has no resumable native session"
      resident.snapshot = {
        ...resident.snapshot,
        session: {
          ...resident.snapshot.session,
          connection: "disconnected",
          status: "failed",
          error: message,
        },
        requests: this.access.failedStart(resident, { error: message }, true),
      }
      this.access.flush(resident)
      return
    }
    this.access.returnFromRemovedWorktree(resident)
    const generation = ++resident.generation
    resident.opening = true
    resident.driver = driver
    resident.snapshot = {
      ...resident.snapshot,
      session: {
        ...resident.snapshot.session,
        connection: "starting",
        status: "starting",
        error: undefined,
      },
    }
    this.access.flush(resident)
    let held = false
    let startedSession: LiveSessionState | undefined
    try {
      const verdict = await dependencies.resumeVerdict?.(binding)
      if (!verdict || !resumable(verdict, "moved"))
        throw new Error(reconnectRefusal(verdict))
      if (resident.generation !== generation || resident.closing) return
      if (!this.access.moves.executes(resident)) throw new Error("Execution ownership changed while preparing native recovery.")
      dependencies.memory?.hold(
        binding.provider,
        binding.nativeId,
        resident.snapshot.session.id
      )
      held = true
      const modeId =
        resident.snapshot.session.currentMode ?? binding.modeId
      const tuning =
        resident.snapshot.requests.find(
          (request) => request.status === "queued"
        )?.tuning ??
        resident.snapshot.session.settings ??
        binding.tuning
      const conversationTools = await dependencies.tools?.(binding.id, resident.snapshot.session.id)
      const threadEnvironment = await dependencies.threadEnvironment?.(
        resident.snapshot.session.id, resident.snapshot.session.title, resident.snapshot.session.cwd
      )
      // Close or an ownership move may have happened during asynchronous preparation.
      // Keep this check and start in the same event-loop turn.
      if (resident.generation !== generation || resident.closing) {
        if (held) releaseHold(dependencies.memory, binding.provider, binding.nativeId, resident.snapshot.session.id)
        held = false
        return
      }
      if (!this.access.moves.executes(resident)) throw new Error("Execution ownership changed while preparing native recovery.")
      const session = await nativeStart(resident, driver, binding.id, () => driver.start(resident.snapshot.session.cwd, {
        conversationId: binding.id,
        resume: binding.nativeId,
        observedAgents: resident.snapshot.nativeAgents?.agents.filter((agent) => agent.bindingId === binding.id && agent.provider === binding.provider),
        observedApprovals: knownApprovalOccurrences(conversationControl(resident), binding.id),
        observedUsage: restorableTotals(resident.snapshot.session, binding),
        threadPath: binding.path,
        title: resident.snapshot.session.title,
        tuning,
        modeId,
        launchModeId: resident.snapshot.session.launchMode,
        emit: this.access.driverEvents(resident, binding.id),
        mcpSnapshot: dependencies.mcpSnapshot
          ? () =>
              dependencies.mcpSnapshot!(resident.snapshot.session.cwd)
          : undefined,
        conversationTools,
        threadEnvironment,
      }))
      startedSession = session
      if (resident.generation !== generation) {
        await driver.close(binding.id)
        await revokeTools(dependencies, binding.id, resident.snapshot.session.id)
        if (held)
          releaseHold(
            dependencies.memory,
            binding.provider,
            binding.nativeId,
            resident.snapshot.session.id
          )
        return
      }
      if (
        session.status !== "ready" ||
        session.connection !== "connected"
      )
        throw new Error("The provider did not become ready while waking")
      if (session.nativeId !== binding.nativeId)
        throw new Error(
          "The provider returned a different session while waking. The saved conversation was not replaced."
        )
      await verifyRecoveredSession(binding, session, driver)
      if (
        modeId &&
        modeId !== session.currentMode &&
        !session.modes.some((mode) => mode.id === modeId)
      )
        throw new Error(
          "The saved agent mode is no longer available after waking"
        )
      if (modeId && modeId !== session.currentMode)
        await driver.setMode(binding.id, modeId)
      if (resident.generation !== generation) {
        await driver.close(binding.id)
        await revokeTools(dependencies, binding.id, resident.snapshot.session.id)
        if (held)
          releaseHold(
            dependencies.memory,
            binding.provider,
            binding.nativeId,
            resident.snapshot.session.id
          )
        return
      }
      const connected = {
        ...session,
        id: resident.snapshot.session.id,
        title: session.title ?? resident.snapshot.session.title,
        currentMode: modeId ?? session.currentMode,
      }
      resident.connections.set(binding.id, {
        driver,
        session: { ...connected, id: binding.id },
      })
      resident.snapshot = { ...resident.snapshot, session: connected }
      updateBinding(dependencies, resident, connected)
      const control = conversationControl(resident)
      resident.snapshot = {
        ...resident.snapshot,
        control: {
          ...control,
          bindings: control.bindings.map((candidate) =>
            candidate.id === binding.id
              ? {
                  ...candidate,
                  tuning: connected.settings ?? tuning,
                  modeId: connected.currentMode ?? modeId,
                }
              : candidate
          ),
        },
      }
      resident.opening = false
      this.access.flush(resident)
      hostLog("residency", "provider woke", {
        conversation: resident.snapshot.session.id,
        harness: binding.provider,
        nativeId: binding.nativeId,
      })
      this.access.drain(resident)
      this.scheduleHibernation(resident)
    } catch (error) {
      const closed = await Promise.resolve(driver.close(binding.id)).then(
        () => true,
        () => false
      )
      await revokeTools(dependencies, binding.id, resident.snapshot.session.id)
      if (closed && held)
        releaseHold(
          dependencies.memory,
          binding.provider,
          binding.nativeId,
          resident.snapshot.session.id
        )
      if (!closed) {
        resident.driver = driver
        resident.opening = true
        if (startedSession)
          resident.connections.set(binding.id, {
            driver,
            session: startedSession,
          })
      }
      if (resident.generation !== generation) return
      const message = errorMessage({ error })
      if (closed) {
        resident.driver = null
        resident.connections.delete(binding.id)
        resident.opening = false
      }
      resident.snapshot = {
        ...resident.snapshot,
        session: {
          ...resident.snapshot.session,
          connection: closed ? "disconnected" : "connected",
          nativeId: closed ? binding.nativeId : resident.snapshot.session.nativeId,
          nativePath: closed ? binding.path : resident.snapshot.session.nativePath,
          executionContext: closed ? binding.executionContext : resident.snapshot.session.executionContext,
          status: "failed",
          error: message,
        },
        requests: this.access.failedStart(resident, { error }, true),
      }
      this.access.flush(resident)
      hostWarn("residency", "provider wake failed", {
        conversation: resident.snapshot.session.id,
        harness: binding.provider,
        nativeId: binding.nativeId,
        error: message,
      })
    }
  }
}
