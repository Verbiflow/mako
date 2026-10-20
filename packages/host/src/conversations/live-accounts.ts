import { randomUUID } from "node:crypto"
import { errorMessage, type FailureBoundary } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { ExecutionAccountChanged, resumes } from "../harnesses/index.js"
import type { AccountRemovalSession, AccountRemovalWait } from "../contracts/accounts.js"
import type { AccountSwitchWait, LiveRequest, SignInHold, SignInReadiness, SignInResume } from "../contracts/live-conversations.js"
import { isBusyNativeAgent } from "../contracts/native-agents.js"
import { classifyStartFailure } from "../contracts/provider-failure.js"
import { holdForSignIn, releaseSignIn, signInPause } from "../contracts/sign-in-hold.js"
import type { Actor } from "../contracts/thread-identity.js"
import { continueTurnPrompt } from "../contracts/turn-continuation.js"
import { promptFingerprint } from "./live-assets.js"
import { LiveRequestSchema } from "./live-journal.js"
import { activeBinding, conversationControl, type LiveAccess, type Resident } from "./live-runtime.js"

type AccountsAccess = Pick<LiveAccess,
  "dependencies" | "epoch" | "admission" | "require" | "residents" | "actor" | "flush" | "drain" | "canHibernate" |
  "hibernate" | "wake" | "reopens" | "returnFromRemovedWorktree" | "launch">

/**
 * Conversations and the accounts their processes run on: work paused when
 * an account signs out and resumed when it is back, sessions letting go of
 * an account being removed, and input waiting for a session to switch.
 */
export class LiveAccounts {
  private readonly access: AccountsAccess

  constructor(access: AccountsAccess) {
    this.access = access
  }

  /** Queued work once a launch failed: it waits for the user when the account signed out, and fails otherwise. */
  failedStart(resident: Resident, boundary: FailureBoundary, resuming: boolean): LiveRequest[] {
    const message = errorMessage(boundary)
    const failure = classifyStartFailure(message, resuming)
    if (failure === "auth" && !(boundary.error instanceof ExecutionAccountChanged))
      return holdForSignIn(resident.snapshot.requests, this.signInHold(resident))
    return resident.snapshot.requests.map((request) =>
      request.status === "queued"
        ? { ...request, status: "failed", error: message, failure, nativeDelivery: this.unsentStartupDelivery(resident, request, message) }
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
    const hold: SignInHold = {
      harness: binding?.provider ?? resident.snapshot.session.harness,
      account: account?.kind === "configured" ? account.name : "",
      credential: "",
      at: Date.now(),
    }
    hostLog("live", "work paused on a sign-out", { conversation: resident.snapshot.session.id, harness: hold.harness })
    void this.recordSignInCredential(resident, hold)
    return hold
  }

  /** Completes a new hold: a launch refused before it ran names no account, so it is the one selected. */
  private async recordSignInCredential(resident: Resident, hold: SignInHold): Promise<void> {
    const signInState = this.access.dependencies.signInState
    if (!signInState) return
    try {
      let state = await signInState(hold.harness, hold.account || "default")
      const account = hold.account || state.selected
      if (account !== (hold.account || "default")) state = await signInState(hold.harness, account)
      const recorded: SignInHold = { ...hold, account, credential: state.credential }
      let changed = false
      resident.snapshot = {
        ...resident.snapshot,
        requests: resident.snapshot.requests.map((request) => {
          if (request.signIn?.at !== hold.at || request.signIn.credential) return request
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
    const signInState = this.access.dependencies.signInState
    if (!pause.hold.credential || !signInState) {
      await this.recordSignInCredential(resident, pause.hold)
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
    })
    return resident.signInResume
  }

  private async resumeSignInNow(resident: Resident, anyway: boolean, actor?: Actor): Promise<SignInResume> {
    this.access.admission.assert()
    if (!signInPause(resident.snapshot.requests)) return "resumed"
    if (!anyway && (await this.signInReadiness(resident.snapshot.session.id)) !== "ready") return "signed-out"
    const pause = signInPause(resident.snapshot.requests)
    if (!pause || resident.closing || resident.snapshot.session.status === "closed") return "resumed"
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
    resident.snapshot = {
      ...resident.snapshot,
      session: session.status === "failed" ? { ...session, status: "ready", error: undefined } : session,
      requests: releaseSignIn(resident.snapshot.requests, continuation),
    }
    this.access.flush(resident)
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

  /** Resumed work runs in a fresh process: the old one may keep the credentials it launched with. */
  private async reopenAfterSignIn(resident: Resident): Promise<void> {
    const { dependencies } = this.access
    if (resident.driver && this.access.canHibernate(resident, false, true)) await this.access.hibernate(resident, "account-change")
    if (resident.closing || resident.snapshot.session.status === "closed") return
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
    if ((resident.snapshot.nativeAgents?.agents ?? []).some(isBusyNativeAgent)) return "subagents"
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
