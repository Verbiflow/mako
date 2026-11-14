import { randomUUID } from "node:crypto"
import { errorMessage, type FailureBoundary } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { ExecutionAccountChanged, resumes, type VerifiedSignIn } from "../harnesses/index.js"
import type { AccountRemovalSession, AccountRemovalWait } from "../contracts/accounts.js"
import type { AccountSwitchWait, LiveRequest, LiveSnapshot, SignInHold, SignInReadiness, SignInResume } from "../contracts/live-conversations.js"
import { isBusyProviderWork } from "../contracts/native-agents.js"
import { failureAfterRetry, holdForRetry, transientCause } from "../contracts/delivery-retry.js"
import { classifyStartFailure, failureEvidenceOf } from "../contracts/provider-failure.js"
import { SessionBusyError } from "../contracts/session-hold.js"
import { SessionHeldError } from "../threads/index.js"
import { holdForSignIn, releaseSignIn, signInPause } from "../contracts/sign-in-hold.js"
import type { Actor } from "../contracts/thread-identity.js"
import { continueTurnPrompt } from "../contracts/turn-continuation.js"
import { promptFingerprint } from "./live-assets.js"
import { LiveRequestSchema, JournalWriteError } from "./live-journal.js"
import { activeBinding, conversationControl, launched, type LiveAccess, type Resident } from "./live-runtime.js"

type AccountsAccess = Pick<LiveAccess,
  "dependencies" | "epoch" | "admission" | "require" | "residents" | "actor" | "flush" | "drain" | "canHibernate" |
  "hibernate" | "wake" | "reopens" | "returnFromRemovedWorktree" | "launch" | "summaries" | "loadSliced" | "moves" | "storageFailed" | "stopMark" | "resident">

function sameSignOut(left: SignInHold, right: SignInHold | undefined): boolean {
  return right !== undefined && (left.id ? left.id === right.id :
    right.id === undefined && left.at === right.at && left.harness === right.harness && left.account === right.account)
}

/**
 * Conversations and the accounts their processes run on: work paused when
 * an account signs out and resumed when it is back, sessions letting go of
 * an account being removed, and input waiting for a session to switch.
 */
export class LiveAccounts {
  private readonly access: AccountsAccess
  private stopped = false
  private readonly signInReads = new Map<string, { resident: Resident; reading: Promise<void> }>()

  constructor(access: AccountsAccess) {
    this.access = access
  }

  stop(): void { this.stopped = true }

  /**
   * Queued work once a launch failed: it waits for the user when the account signed out, waits and goes again by
   * itself when the cause clears by itself and the session can reopen (`retryCause`), and fails otherwise.
   */
  failedStart(resident: Resident, boundary: FailureBoundary, resuming: boolean): LiveRequest[] {
    const message = errorMessage(boundary)
    const evidence = failureEvidenceOf(boundary)
    const failure = classifyStartFailure(message, resuming, evidence)
    if (failure === "auth" && !(boundary.error instanceof ExecutionAccountChanged))
      return holdForSignIn(resident.snapshot.requests, this.signInHold(resident))
    const busy = boundary.error instanceof SessionBusyError || boundary.error instanceof SessionHeldError
    // A start with nothing to resume is retried too: its release starts it again (`LiveLaunches.relaunch`).
    const cause = resuming || !launched(activeBinding(resident)) ? transientCause(message, failure, busy, evidence) : undefined
    const retried = cause && holdForRetry(resident.snapshot.requests, cause, message, Date.now())
    if (retried) {
      hostLog("live", "a message waits to go again: its harness couldn't take it for now", { conversation: resident.snapshot.session.id, cause, error: message })
      return retried
    }
    return resident.snapshot.requests.map((request) =>
      request.status === "queued"
        ? { ...request, status: "failed", error: message, failure: failureAfterRetry(failure, evidence, request.retry, Date.now()), failureEvidence: evidence, retry: undefined, nativeDelivery: this.unsentStartupDelivery(resident, request, message) }
        : request
    )
  }

  private unsentStartupDelivery(resident: Resident, request: LiveRequest, reason: string): NonNullable<LiveRequest["nativeDelivery"]> {
    // Only queued requests reach this path: opening/waking blocks drain before
    // prompt dispatch. Preserve any earlier attempt's evidence rather than
    // converting a retained ambiguous receipt into a proven refusal.
    return request.nativeDelivery ?? {
      attemptId: randomUUID(),
      bindingId: conversationControl(resident).activeBindingId,
      ownerEpoch: this.access.epoch,
      evidence: { kind: "not-accepted", source: "preflight", reason },
    }
  }

  /**
   * The sign-out this session's work waits on: the one already holding it,
   * or a new one for the account it ran as. Which account's credentials it
   * measures is settled, and their digest read, just after.
   */
  signInHold(resident: Resident): SignInHold {
    const existing = signInPause(resident.snapshot.requests)?.hold
    if (existing) return existing
    const binding = activeBinding(resident)
    const account = (resident.snapshot.session.executionContext ?? binding?.executionContext)?.account
    const harness = binding?.provider ?? resident.snapshot.session.harness
    const verification = !account || account.kind === "configured" && account.managed ? this.access.dependencies.signInSequence?.(harness) : undefined
    const hold: SignInHold = {
      id: randomUUID(),
      ...(verification !== undefined && { verification }),
      harness,
      account: account?.kind === "configured" ? account.name : "",
      credential: "",
      at: Date.now(),
    }
    hostLog("live", "work paused on a sign-out", { conversation: resident.snapshot.session.id, harness: hold.harness })
    void this.readSignInCredential(resident, hold)
    return hold
  }

  private readSignInCredential(resident: Resident, hold: SignInHold): Promise<void> {
    const key = hold.id ?? `${resident.snapshot.session.id}:${hold.at}`
    const pending = this.signInReads.get(key)
    if (pending?.resident === resident) return pending.reading
    const reading = this.recordSignInCredential(resident, hold)
    this.signInReads.set(key, { resident, reading })
    void reading.then(() => { if (this.signInReads.get(key)?.reading === reading) this.signInReads.delete(key) })
    return reading
  }

  /** Completes a new hold: a launch refused before it ran names no account, so it is the one selected. */
  private async recordSignInCredential(resident: Resident, hold: SignInHold): Promise<void> {
    const signInState = this.access.dependencies.signInState
    if (!signInState) return
    try {
      let state = await signInState(hold.harness, hold.account || "default")
      const account = hold.account || state.selected
      if (account !== (hold.account || "default")) state = await signInState(hold.harness, account)
      if (this.stopped || this.access.resident(resident.snapshot.session.id) !== resident) return
      const recorded: SignInHold = { ...hold, account, credential: state.credential, ...(account === "default" && { verification: undefined }) }
      let changed = false
      resident.snapshot = {
        ...resident.snapshot,
        requests: resident.snapshot.requests.map((request) => {
          if (!sameSignOut(hold, request.signIn) || request.signIn?.credential) return request
          changed = true
          return { ...request, signIn: recorded }
        }),
      }
      if (changed) this.access.flush(resident)
    } catch (error) {
      hostWarn("live", "the paused account's sign-in could not be read", { conversation: resident.snapshot.session.id, error: errorMessage({ error }) })
    }
  }

  /** Whether work paused on a sign-out can go: its account signed in again, or another one is selected. */
  async signInReadiness(id: string): Promise<SignInReadiness | null> {
    const resident = this.access.require(id)
    const pause = signInPause(resident.snapshot.requests)
    if (!pause) return null
    const proof = this.access.dependencies.signInProof?.(pause.hold.harness, pause.hold.account)
    if (proof && (pause.hold.ready === proof.id || pause.hold.verification !== undefined && proof.sequence > pause.hold.verification)) return "ready"
    const signInState = this.access.dependencies.signInState
    if (!pause.hold.credential || !signInState) {
      await this.readSignInCredential(resident, pause.hold)
      return "signed-out"
    }
    const state = await signInState(pause.hold.harness, pause.hold.account)
    return state.selected !== pause.hold.account || state.credential !== pause.hold.credential ? "ready" : "signed-out"
  }

  /**
   * Resume work paused on a sign-out, once: the turn it cut short continues
   * when the provider had accepted it, then the waiting messages go in order,
   * from a fresh process. Unless `anyway`, only once the account is signed in
   * again or another one chosen. A second press while one runs shares it,
   * and one after the pause ended finds nothing left to resume.
   */
  resumeSignIn(id: string, anyway = false, actor?: Actor): Promise<SignInResume> {
    const resident = this.access.require(id)
    resident.signInResume ??= this.resumeSignInNow(resident, anyway, actor).finally(() => {
      resident.signInResume = undefined
      if (!this.stopped) void this.recoverSignIns().catch(error => hostWarn("live", "held sign-ins could not be reconciled", { error: errorMessage({ error }) }))
    })
    return resident.signInResume
  }

  private async resumeSignInNow(resident: Resident, anyway: boolean, actor?: Actor, verified?: { hold: SignInHold; receipt: string }): Promise<SignInResume> {
    this.access.admission.assert()
    const before = signInPause(resident.snapshot.requests)
    if (!before) return "resumed"
    const generation = resident.generation
    const stop = this.access.stopMark(resident.snapshot.session.id)
    const binding = conversationControl(resident).activeBindingId
    if (!verified && !anyway && (await this.signInReadiness(resident.snapshot.session.id)) !== "ready") return "signed-out"
    const pause = signInPause(resident.snapshot.requests)
    if (!pause) return "resumed"
    if (this.stopped || this.access.resident(resident.snapshot.session.id) !== resident || !sameSignOut(before.hold, pause.hold) || generation !== resident.generation || stop !== this.access.stopMark(resident.snapshot.session.id) || binding !== conversationControl(resident).activeBindingId || resident.closing) return "signed-out"
    const currentProof = verified && this.access.dependencies.signInProof?.(pause.hold.harness, pause.hold.account)
    if (verified && (!sameSignOut(verified.hold, pause.hold) || !this.automaticallyResumable(resident) ||
      !currentProof || currentProof.id !== verified.receipt || pause.hold.verification !== undefined && currentProof.sequence <= pause.hold.verification)) return "signed-out"
    const control = conversationControl(resident)
    const source = activeBinding(resident)
    if (verified && (!source || source.provider !== pause.hold.harness || source.account !== undefined && source.account !== pause.hold.account)) return "signed-out"
    if (verified && this.access.dependencies.agents?.()?.mayWake?.(resident.snapshot.session.id) === false) {
      if (pause.hold.ready !== verified.receipt) this.commitSignIn(resident, {
        ...resident.snapshot,
        requests: resident.snapshot.requests.map(request => sameSignOut(pause.hold, request.signIn) ? { ...request, signIn: { ...request.signIn!, ready: verified.receipt } } : request),
      })
      return "resumed"
    }
    const cut = pause.cut?.outcome === "continue"
      ? resident.snapshot.requests.find((request) => request.id === pause.cut?.requestId)
      : undefined
    const continuation = cut
      ? LiveRequestSchema.parse({
          actor: this.access.actor(actor),
          id: randomUUID(),
          createdAt: Date.now(),
          text: continueTurnPrompt("signed-out", "mako"),
          attachments: [],
          tuning: cut.tuning,
          status: "queued",
          continues: { requestId: cut.id, reason: "signed-out", auto: true },
        })
      : undefined
    if (continuation)
      continuation.inputDigest = promptFingerprint(continuation.text, continuation.attachments, continuation.tuning)
    const session = resident.snapshot.session
    this.commitSignIn(resident, {
      ...resident.snapshot,
      // Automatic recovery retains the account whose work was held, even if Settings selected another meanwhile.
      ...(verified && { control: { ...control, bindings: control.bindings.map(binding => binding.id === control.activeBindingId ? { ...binding, account: pause.hold.account } : binding) } }),
      session: session.status === "failed" || session.status === "closed" ? { ...session, status: "ready", error: undefined } : session,
      requests: releaseSignIn(resident.snapshot.requests, continuation),
    })
    hostLog("live", "resumed work paused on a sign-out", {
      conversation: session.id,
      harness: pause.hold.harness,
      waiting: pause.waiting.length,
      cut: pause.cut?.outcome,
      anyway,
    })
    await this.reopenAfterSignIn(resident)
    return "resumed"
  }

  private commitSignIn(resident: Resident, next: LiveSnapshot): void {
    if (this.access.resident(next.session.id) !== resident) throw new Error("The conversation owner changed before sign-in recovery could be saved. Its held work was preserved.")
    const previous = resident.snapshot
    resident.snapshot = next
    try { this.access.flush(resident) }
    catch (error) {
      if (error instanceof JournalWriteError) {
        // No provider input before the release is durable. Force a real save after the store recovers.
        resident.snapshot = { ...previous }
        this.access.storageFailed(resident, { error })
      }
      throw error
    }
  }

  private automaticallyResumable(resident: Resident): boolean {
    return !this.stopped && this.access.resident(resident.snapshot.session.id) === resident && !this.access.admission.closed && !resident.storageFault && !resident.closing && !resident.retireWhenIdle && this.access.moves.executes(resident) &&
      !resident.snapshot.requests.some(request => request.signIn && request.pause === "stop") &&
      this.access.dependencies.signInAllowed?.(resident.snapshot.session.id) !== false
  }

  /** A login settles an account cohort, not just the tab whose sign-in card is visible. */
  async recoverSignIns(receipt?: VerifiedSignIn): Promise<void> {
    if (this.stopped || !this.access.dependencies.signInProof || this.access.admission.closed) return
    const pending: Promise<unknown>[] = []
    for (const summary of this.access.summaries()) {
      if (!summary.hasSignInHold || receipt && receipt.harness !== summary.session.harness) continue
      try {
        const observed = await this.access.loadSliced(summary.session.id)
        const resident = this.access.resident(summary.session.id)
        if (!observed || !resident) continue
        if (observed !== resident) {
          const previous = signInPause(observed.snapshot.requests)
          if (!previous || !sameSignOut(previous.hold, signInPause(resident.snapshot.requests)?.hold)) continue
        }
        pending.push(this.recoverSignIn(resident, receipt).catch(error => {
          hostWarn("live", "verified sign-in could not resume held work", { conversation: summary.session.id, error: errorMessage({ error }) })
        }))
      } catch (error) {
        hostWarn("live", "verified sign-in could not resume held work", { conversation: summary.session.id, error: errorMessage({ error }) })
      }
    }
    await Promise.allSettled(pending)
  }

  private async recoverSignIn(resident: Resident, receipt?: VerifiedSignIn): Promise<void> {
    if (!this.automaticallyResumable(resident)) return
    while (resident.signInResume) {
      const previous = resident.signInResume
      await previous.catch(() => {})
      if (resident.signInResume === previous) resident.signInResume = undefined
      // A fresh login arriving during an older admission keeps its own evaluation after that admission ends.
      if (!receipt || !this.automaticallyResumable(resident)) return
    }
    if (!signInPause(resident.snapshot.requests)) return
    // Pin the entire asynchronous admission, including account lookup, to this exact memory owner.
    const operation = this.recoverOwnedSignIn(resident, receipt)
    resident.signInResume = operation
    try { await operation }
    finally { if (resident.signInResume === operation) resident.signInResume = undefined }
  }

  private async recoverOwnedSignIn(resident: Resident, receipt?: VerifiedSignIn): Promise<SignInResume> {
    const before = signInPause(resident.snapshot.requests)
    if (!before) return "resumed"
    // A refused first launch may still be naming its account. Keep this exact event through that read, independently of siblings.
    if (!before.hold.account || !before.hold.credential) await this.readSignInCredential(resident, before.hold)
    else {
      const pending = before.hold.id && this.signInReads.get(before.hold.id)
      if (pending && pending.resident === resident) await pending.reading
    }
    const pause = signInPause(resident.snapshot.requests)
    if (!pause || !sameSignOut(before.hold, pause.hold) || !this.automaticallyResumable(resident)) return "signed-out"
    if (receipt && (receipt.harness !== pause.hold.harness || receipt.account !== pause.hold.account)) return "signed-out"
    const proof = this.access.dependencies.signInProof?.(pause.hold.harness, pause.hold.account)
    // The stored receipt closes the publication/event crash gap. Legacy holds need a fresh event to prove its ordering.
    if (!proof || pause.hold.verification !== undefined && proof.sequence <= pause.hold.verification || !receipt && pause.hold.verification === undefined && pause.hold.ready !== proof.id || receipt && receipt.id !== proof.id) return "signed-out"
    return this.resumeSignInNow(resident, false, { kind: "service", name: "auto-continue" }, { hold: pause.hold, receipt: proof.id })
  }

  /** Resumed work runs in a fresh process: the old one may keep the credentials it launched with. */
  private async reopenAfterSignIn(resident: Resident): Promise<void> {
    const { dependencies } = this.access
    if (resident.driver && this.access.canHibernate(resident, false, true)) await this.access.hibernate(resident, "account-change")
    if (this.stopped || this.access.resident(resident.snapshot.session.id) !== resident || resident.closing || resident.snapshot.session.status === "closed") return
    if (!resident.driver && this.access.reopens(resident)) return this.access.wake(resident)
    const binding = activeBinding(resident)
    const driver = dependencies.driver(binding?.provider ?? "")
    if (!resident.driver && !resident.opening && binding && !binding.nativeId && binding.id === resident.snapshot.session.id &&
      driver?.available(dependencies.appPath)) {
      // The launch was refused before any native session existed: start it as the first launch would.
      this.access.returnFromRemovedWorktree(resident)
      const session = resident.snapshot.session
      resident.opening = true
      resident.driver = driver
      resident.snapshot = { ...resident.snapshot, session: { ...session, status: "starting", connection: "starting", error: undefined } }
      this.access.flush(resident)
      this.access.launch(resident, driver, binding.provider, session.cwd, { conversationId: session.id, title: session.title, modeId: binding.modeId, tuning: binding.tuning }, binding.modeId, binding.tuning)
      return
    }
    this.access.drain(resident)
  }

  /**
   * The sessions whose process runs on one of these bindings, each with what
   * it waits for before it lets go of its account; an idle one waits for
   * nothing and its next message reopens it on the selected account.
   */
  accountSessions(bindingIds: readonly string[]): AccountRemovalSession[] {
    return this.residentsOn(bindingIds).map((resident) => {
      const session: AccountRemovalSession = {
        conversation: resident.snapshot.session.id,
        title: resident.snapshot.session.title || "Untitled conversation",
      }
      const waitingFor = this.removalWait(resident)
      if (waitingFor) session.waitingFor = waitingFor
      return session
    })
  }

  /** Let idle sessions on these bindings go of their account now; busy ones go once idle. */
  retireAccountSessions(bindingIds: readonly string[]): void {
    for (const resident of this.residentsOn(bindingIds))
      if (this.access.canHibernate(resident, false, true)) void this.retireFromAccount(resident)
  }

  private residentsOn(bindingIds: readonly string[]): Resident[] {
    const wanted = new Set(bindingIds)
    return [...this.access.residents()].filter((resident) => resident.driver && wanted.has(conversationControl(resident).activeBindingId))
  }

  private removalWait(resident: Resident): AccountRemovalWait | undefined {
    if (this.access.canHibernate(resident, false, true)) return undefined
    if (!resumes(this.access.dependencies.driver(activeBinding(resident)?.provider ?? ""))) return "close"
    return this.accountSwitchWait(resident) ?? "operation"
  }

  /** Close the process so its account can be removed; queued input then sends on the selected account. */
  async retireFromAccount(resident: Resident): Promise<void> {
    if (resident.accountSwitching) return
    const conversation = resident.snapshot.session.id
    resident.accountSwitching = true
    hostLog("live", "a session lets go of an account being removed", { conversation })
    try {
      // Input waiting to switch is carried by this reopen, not a second one.
      if (resident.snapshot.requests.some((request) => request.accountSwitch)) {
        resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map((request) =>
          request.accountSwitch ? { ...request, accountSwitch: undefined } : request) }
        this.access.flush(resident)
      }
      await this.access.hibernate(resident, "account-change")
      resident.accountSwitching = false
      if (resident.closing || resident.snapshot.session.status === "closed") return
      if (resident.snapshot.session.connection === "hibernated" &&
        resident.snapshot.requests.some((request) => request.status === "queued"))
        await this.access.wake(resident)
    } catch (error) {
      hostWarn("live", "a session could not let go of an account being removed", { conversation, error: errorMessage({ error }) })
    } finally {
      resident.accountSwitching = false
    }
  }

  /**
   * What keeps a session that has to change account from reopening now, in
   * words for the person waiting; undefined when nothing will clear on its
   * own, such as a harness that cannot resume.
   */
  accountSwitchWait(resident: Resident): AccountSwitchWait | undefined {
    const binding = activeBinding(resident)
    if (!resumes(this.access.dependencies.driver(binding?.provider ?? "")) || !binding?.nativeId || !binding.path) return undefined
    if (resident.snapshot.session.backgroundTasks) return "background"
    if ((resident.snapshot.nativeAgents?.agents ?? []).some(isBusyProviderWork)) return "subagents"
    if (resident.snapshot.permissions.length) return "approval"
    if (resident.snapshot.session.status === "running") return "turn"
    return "operation"
  }

  /** Retire and reopen under the selected account once nothing is running; the queued input then sends. */
  async switchAccount(resident: Resident, request: LiveRequest): Promise<void> {
    if (resident.accountSwitching) return
    if (!this.access.canHibernate(resident, false, true)) {
      const waitingFor = this.accountSwitchWait(resident)
      if (waitingFor && waitingFor !== request.accountSwitch?.waitingFor) {
        resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map(candidate =>
          candidate.id === request.id && candidate.accountSwitch ? { ...candidate, accountSwitch: { ...candidate.accountSwitch, waitingFor } } : candidate) }
        this.access.flush(resident)
      }
      return
    }
    resident.accountSwitching = true
    try {
      resident.accountRefreshRequest = request.id
      resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map(candidate =>
        candidate.id === request.id ? { ...candidate, accountSwitch: undefined } : candidate) }
      this.access.flush(resident)
      hostLog("live", "switching a session's account for waiting input", {
        conversation: resident.snapshot.session.id, request: request.id, reason: request.accountSwitch?.reason,
      })
      await this.access.hibernate(resident, "account-change")
    } finally {
      resident.accountSwitching = false
    }
    if (resident.closing || resident.snapshot.session.status === "closed") return
    if (resident.snapshot.session.connection === "hibernated" &&
      resident.snapshot.requests.some(candidate => candidate.status === "queued")) {
      await this.access.wake(resident)
      return
    }
    // Work that started during retirement waits again; a failed close fails
    // the input rather than retrying it, and never sends under the old account.
    const waitingFor = this.access.canHibernate(resident, false, true) ? undefined : this.accountSwitchWait(resident)
    resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map(candidate =>
      candidate.id !== request.id || candidate.status !== "queued" ? candidate
        : waitingFor ? { ...candidate, accountSwitch: { reason: request.accountSwitch?.reason ?? "selection", waitingFor } }
          : { ...candidate, status: "failed", error: new ExecutionAccountChanged(request.accountSwitch?.reason ?? "selection").message }) }
    resident.accountRefreshRequest = undefined
    this.access.flush(resident)
  }
}
