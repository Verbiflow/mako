import { randomUUID } from "node:crypto"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { controlNote } from "../control/index.js"
import { ExecutionAccountChanged, ExecutionIdentityMismatch, HandoffRefused, TurnInProgressError, type PromptDispatch } from "../harnesses/index.js"
import { digestAsks } from "../contracts/agents.js"
import { FRONT_DOOR_GUIDANCE } from "../contracts/agent-tools.js"
import type { LiveRequest, LiveSnapshot } from "../contracts/live-conversations.js"
import { quietSwitch } from "../contracts/conversation-control.js"
import { retireQuestionsForInput } from "../contracts/live-questions.js"
import { nativePromptReference } from "../contracts/native-prompt-identity.js"
import { advancePromptDelivery, type PromptDelivery, type PromptDeliveryEvidence } from "../contracts/prompt-delivery.js"
import { failureAfterRetry, transientCause, waitsAgain } from "../contracts/delivery-retry.js"
import { nextInLine } from "../contracts/request-hold.js"
import { ASK_EVERY_MS, DIGEST_WAITS, WAKES_PER_MINUTE } from "../contracts/children.js"
import { classifyProviderFailure, failureEvidenceOf } from "../contracts/provider-failure.js"
import { SessionBusyError } from "../contracts/session-hold.js"
import { holdForSignIn } from "../contracts/sign-in-hold.js"
import { checkoutAccount, pendingInterruption, TurnSteps } from "./interrupted-turn.js"
import { checkoutSince } from "../base/checkout-since.js"
import { cutAccount } from "./cut-account.js"
import { standingLines } from "./control-cadence.js"
import type { LiveActions } from "./live-actions.js"
import type { LiveCheckpoints } from "./live-checkpoints.js"
import { contextPrompt } from "./live-context.js"
import type { LiveAccess, Resident } from "./live-runtime.js"
import type { LiveTransfers } from "./live-transfers.js"
import { baseUnread } from "./base-source.js"
import { turnStart, usageMark } from "./live-settlement.js"
import { captureNativeHistory, transcriptHolds } from "./native-history.js"
import type { ConversationControl } from "../contracts/conversation-control.js"
import { continueTurnPrompt } from "../contracts/turn-continuation.js"
import type { ThreadPage } from "@mako/sessions"

const MINUTE_MS = 60_000

/** How often in a row a message the harness refused for a turn of its own is sent again at once (`turnInProgress`). */
const TURN_IN_PROGRESS_RETRIES = 3

/**
 * The message a conversation sends next once nothing holds it back, or undefined when none would go (`nextInLine`):
 * a message being edited, waiting on a sign-in or about to go again keeps its place and holds those behind it; one a
 * Stop or an exit paused lets later ones go. After a failure only the newest goes, since failure doesn't drain old
 * queued work by itself.
 */
export function nextQueued(snapshot: Pick<LiveSnapshot, "session" | "requests">): LiveRequest | undefined {
  return nextInLine(snapshot.requests, snapshot.session.status === "failed")
}

/**
 * Whether the harness's own transcript shows the Fin's brief `briefId` (`transcriptHolds`): under the message id it
 * was sent with, where the harness keeps that, or by its "You're fin:" line, which the brief sent again carries too. A
 * digest is known by its id alone.
 * False when its session has no transcript, or one Mako can't read.
 */
async function briefInTranscript(snapshot: LiveSnapshot, control: ConversationControl, briefId: string, history: (path: string, before?: number) => Promise<ThreadPage | null>): Promise<boolean> {
  const brief = snapshot.requests.find((request) => request.id === briefId)
  const bindingId = brief?.nativeDelivery?.bindingId ?? control.activeBindingId
  const path = control.bindings.find((binding) => binding.id === bindingId)?.path
  if (!brief || !path) return false
  const page = await captureNativeHistory(path, history).catch((error) => {
    hostWarn("live", "a harness's transcript couldn't be read to see whether it had a Fin's brief", { conversation: snapshot.session.id, error: errorMessage({ error }) })
    return null
  })
  // A digest has no line of its own: any of them could be in what the Thread was told before, so only its id proves it.
  const marker = brief.digest ? "" : brief.text.split("\n").find((line) => line.includes("You're fin:")) ?? ""
  return page ? transcriptHolds(page.entries, { attemptId: brief.nativeDelivery?.attemptId, marker }) : false
}

type DispatchAccess = Pick<LiveAccess,
  "dependencies" | "epoch" | "admission" | "control" | "flush" | "storageFailed" | "moves" | "switchAccount" |
  "canHibernate" | "hibernate" | "wake" | "accountSwitchWait" | "signInHold" | "homeFromRemovedWorktree" | "readBase">

/** The parts that can hold a conversation's next prompt back, or carry it. */
export interface DispatchParts {
  actions: LiveActions
  checkpoints: LiveCheckpoints
  transfers: LiveTransfers
}

/** Each conversation's next queued prompt, sent once nothing holds it back, and what became of the send. */
export class LiveDispatch {
  private readonly access: DispatchAccess
  private readonly parts: DispatchParts
  private readonly leaving = new WeakSet<Resident>()

  constructor(access: DispatchAccess, parts: DispatchParts) {
    this.access = access
    this.parts = parts
  }

  /**
   * A connected provider whose folder was a worktree removed under it, by
   * Git or a terminal rather than by Mako: nothing can run there, so it
   * sleeps with the prompt that hasn't reached it, and waking carries both
   * on in the project folder (`returnFromRemovedWorktree`). A failure
   * against the missing folder is what this recovers from, so it no longer
   * holds the conversation. Tried once per prompt: when the provider won't
   * sleep, the send goes ahead and says what's wrong.
   */
  private leaveRemovedFolder(resident: Resident): boolean {
    if (this.leaving.has(resident)) return false
    const from = resident.snapshot.session.cwd
    const to = this.access.homeFromRemovedWorktree(resident)
    if (!to) return false
    if (resident.snapshot.session.status === "failed")
      resident.snapshot = { ...resident.snapshot, session: { ...resident.snapshot.session, status: "ready", error: undefined } }
    if (!this.access.canHibernate(resident, false, true)) return false
    this.leaving.add(resident)
    hostLog("residency", "a provider's folder was removed under it", { conversation: resident.snapshot.session.id, from, to })
    void this.access.hibernate(resident, "folder-removed").then(async () => {
      if (resident.snapshot.session.connection === "hibernated" && !resident.closing) {
        this.leaving.delete(resident)
        await this.access.wake(resident)
        return
      }
      this.drain(resident)
      this.leaving.delete(resident)
    })
    return true
  }

  /** Its queued prompts say they wait for this Mac to hear its account (`LiveRequest.ownerCheck`), each once. */
  private holdForOwner(resident: Resident): void {
    const held = resident.snapshot.requests.filter((request) => request.status === "queued" && !request.ownerCheck)
    if (!held.length) return
    const since = Date.now()
    const ids = new Set(held.map((request) => request.id))
    const previous = resident.snapshot
    resident.snapshot = { ...previous, requests: previous.requests.map((request) => (ids.has(request.id) ? { ...request, ownerCheck: { since } } : request)) }
    try {
      this.access.flush(resident)
    } catch (error) {
      resident.snapshot = previous
      this.access.storageFailed(resident, { error })
      return
    }
    hostLog("live", "a message waits for this Mac to hear its account before it runs here", { conversation: resident.snapshot.session.id, requests: [...ids].join(",") })
  }

  /**
   * The minute's budget for an Apex's digests (`WAKES_PER_MINUTE`), counted from when each was sent: one past it is held
   * until the oldest of the minute is a minute old, and the one timer sends it then. One that asks something can't wait
   * that out, so past the budget it goes at most every `ASK_EVERY_MS`, and what's asked meanwhile joins it. True when
   * it was held.
   */
  private overBudget(resident: Resident, request: LiveRequest): boolean {
    const now = Date.now()
    const recent = resident.snapshot.requests.flatMap((candidate) => {
      const at = candidate.digest?.sentAt
      return at !== undefined && at > now - MINUTE_MS ? [{ at, asks: digestAsks(candidate.digest!.notices) }] : []
    }).sort((left, right) => left.at - right.at)
    if (recent.length < WAKES_PER_MINUTE) return false
    let at = recent[recent.length - WAKES_PER_MINUTE]!.at + MINUTE_MS
    if (digestAsks(request.digest!.notices)) {
      const asked = recent.filter((sent) => sent.asks).at(-1)
      if (!asked || asked.at + ASK_EVERY_MS <= now) return false
      at = asked.at + ASK_EVERY_MS
    }
    const previous = resident.snapshot
    resident.snapshot = { ...previous, requests: previous.requests.map((candidate) => candidate === request ? { ...candidate, status: "held" as const, wake: { at, after: DIGEST_WAITS } } : candidate) }
    try {
      this.access.flush(resident)
    } catch (error) {
      resident.snapshot = previous
      this.access.storageFailed(resident, { error })
      return true
    }
    hostLog("agents", "a digest waits for the minute's budget", { conversation: resident.snapshot.session.id, request: request.id, at: new Date(at).toISOString() })
    return true
  }

  drain(resident: Resident): void {
    const { dependencies } = this.access
    const { actions, checkpoints, transfers } = this.parts
    if (this.access.admission.closed) return
    // The harness hears nothing new until the history it continues is read (`LiveSources.readBase`).
    if (baseUnread(resident.snapshot) && !resident.snapshot.historyFailure) {
      void this.access.readBase(resident)
        .then(() => { if (!baseUnread(resident.snapshot) || resident.snapshot.historyFailure) this.drain(resident) })
        .catch((error) => hostWarn("live", "a queued message waits on a history read that failed", { conversation: resident.snapshot.session.id, error: errorMessage({ error }) }))
      return
    }
    // Nor until the history's rows are written ahead (`LiveJournal.writtenAhead`), so the commit starting the turn writes none of them.
    const ahead = resident.journal.writtenAhead()
    if (ahead) {
      void ahead.then(() => this.drain(resident))
      return
    }
    if (actions.blocks(resident)) return
    // Queued work stays queued, not held: cancelling a move starts it again.
    if (!this.access.moves.executes(resident)) return
    // Nor while this Mac checks with its account after it was away: its Session may have continued in the cloud.
    if (this.access.moves.ownerCheck(resident, true) !== undefined) return this.holdForOwner(resident)
    // Closing file checkpoints still protect relocation/residency, but they never hold a new send.
    if (
      resident.rewinding ||
      resident.closing ||
      resident.hibernating ||
      resident.waking
    )
      return
    // Nor while a transfer is under way: once committed, its source may still be closing, and nothing goes on it.
    if (resident.transferring) return
    // A switch waits for what was queued before it, as a switch asked for behind another waits for that one's message.
    // A quiet one goes first: what's queued is for its destination.
    const transfer = transfers.pending(resident)
    if (transfer && !(transfer.state.kind === "queued" && !quietSwitch(transfer) && resident.snapshot.requests.some((request) => request.status === "queued" && request.id !== transfer.input.id && (request.createdAt ?? 0) <= transfer.createdAt))) {
      transfers.start(resident)
      return
    }
    if (
      resident.opening ||
      !resident.driver ||
      resident.snapshot.session.status === "running" ||
      resident.snapshot.session.status === "closed" ||
      resident.snapshot.requests.some(
        (request) => request.status === "dispatching"
      )
    )
      return
    const request = nextQueued(resident.snapshot)
    if (!request) return
    // A switch's own message goes on its destination, once the switch has committed.
    if (request.id === transfer?.input.id) return
    if (request.digest && this.overBudget(resident, request)) return
    if (this.leaveRemovedFolder(resident)) return
    if (request.accountSwitch) {
      void this.access.switchAccount(resident, request).catch((error) => {
        hostWarn("live", "account switch failed", { conversation: resident.snapshot.session.id, error: errorMessage({ error }) })
      })
      return
    }
    const previousSnapshot = resident.snapshot
    const previousUpdates = [...resident.updates]
    const previousCharacters = resident.pendingCharacters
    const previousDisplayPrompt = resident.displayPrompt
    const control = this.access.control(resident)
    const driver = resident.driver
    const review = request.review && driver.review.kind === "native" && driver.review.start.via === "call"
      ? { run: driver.review.start.run, target: request.review }
      : undefined
    // A command the harness reads only at the start of the message goes as
    // written; Mako's notes and pending context wait for the next message.
    const asWritten = Boolean(request.verbatim || review)
    const pendingMerges = asWritten ? [] : control.merges.filter(
      (merge) => merge.status === "pending"
    )
    const attemptId = randomUUID()
    const bindingId = control.activeBindingId
    const nativeDelivery: PromptDelivery = { attemptId, bindingId, ownerEpoch: this.access.epoch, gated: true, evidence: { kind: "prepared" } }
    const ownerGeneration = this.access.moves.generation(resident)
    if (ownerGeneration !== undefined) nativeDelivery.ownerGeneration = ownerGeneration
    // Its spend counts from the last turn's end in this process: what was spent since, by work between turns, is this turn's.
    const spentThrough = bindingId ? turnStart(resident.snapshot, bindingId) : undefined
    const usageFrom = spentThrough ? spentThrough.usage : usageMark(resident.snapshot.session.usage)
    const current = {
      ...request,
      ownerCheck: undefined,
      nativePrompt: undefined,
      nativeDelivery,
      usageFrom: usageFrom && (usageFrom.tokens || usageFrom.cost || usageFrom.unrecorded) ? usageFrom : undefined,
      status: "dispatching" as const,
      dispatchedAt: Date.now(),
      ...request.digest && { digest: { ...request.digest, sentAt: Date.now() } },
      mode: resident.snapshot.session.currentMode ?? undefined,
      context: [
        ...(request.context ?? []),
        ...pendingMerges.map((merge) => merge.manifest),
      ],
    }
    const told = asWritten ? undefined : pendingInterruption(resident.snapshot.requests, request.id)
    const toldAt = Date.now()
    resident.snapshot = {
      ...resident.snapshot,
      ...spentThrough && { spentThrough },
      control: {
        ...(request.continues?.auto ? control : retireQuestionsForInput(control, request.id)),
        merges: asWritten ? control.merges : control.merges.map((merge) =>
          merge.status === "pending" ? { ...merge, status: "consumed" } : merge
        ),
      },
      requests: resident.snapshot.requests.map((candidate) =>
        candidate.id === request.id
          ? current
          : candidate.id === told?.requestId && candidate.interruption
            ? { ...candidate, interruption: { ...candidate.interruption, told: toldAt } }
            : candidate
      ),
    }
    resident.steps = new TurnSteps()
    const text = request.displayText ?? resident.displayPrompt ?? request.text
    resident.displayPrompt = undefined
    // A request held back behind a turn the provider was still running
    // already shows its message from that attempt.
    const shown = request.nativeDelivery?.evidence.kind === "not-accepted"
    if (!shown && (text || request.attachments.length))
      resident.updates.push({
        kind: "user",
        at: toldAt,
        provider: resident.snapshot.session.harness,
        requestId: request.id,
        ...request.review ? { command: "review" as const } : request.goal ? { command: "goal" as const } : {},
        contextFiles: current.context.map((manifest) => manifest.file),
        text,
        attachments: request.attachments.map((attachment) => ({
          type: "attachment",
          name: attachment.name,
          mimeType: attachment.mimeType,
          source: attachment.path
            ? { kind: "file", path: attachment.path }
            : attachment.data
              ? { kind: "inline", data: attachment.data }
              : {
                  kind: "unavailable",
                  reason: "Attachment bytes were not retained",
                },
        })),
      })
    try {
      this.access.flush(resident)
    } catch (error) {
      resident.snapshot = previousSnapshot
      resident.updates = previousUpdates
      resident.pendingCharacters = previousCharacters
      resident.displayPrompt = previousDisplayPrompt
      this.access.storageFailed(resident, { error })
      return
    }
    const generation = resident.generation
    const report = (evidence: PromptDeliveryEvidence): void => {
      const handoff = evidence.kind === "submitted"
      const target = resident.snapshot.requests.find((item) => item.id === request.id)
      const own = resident.generation === generation && this.access.control(resident).activeBindingId === bindingId &&
        target?.nativeDelivery?.attemptId === attemptId
      // The handoff (`handOff`): the driver sends only if this returns, so a send this attempt no longer owns, one a
      // Stop reached while it was prepared, and one the journal can't record as sent all go no further.
      if (handoff && (!own || target?.status !== "dispatching" || target.nativeDelivery?.evidence.kind !== "prepared")) throw new HandoffRefused("superseded")
      if (handoff && target?.pause === "stop") throw new HandoffRefused("stopped")
      if (handoff && target && dependencies.agents?.()?.admits?.(resident.snapshot.session.id, target) === false) throw new HandoffRefused("withdrawn")
      if (!own || !target?.nativeDelivery) return
      const delivery = target.nativeDelivery
      const next = advancePromptDelivery(delivery.evidence, evidence)
      if (next === delivery.evidence) return
      const binding = this.access.control(resident).bindings.find(item => item.id === bindingId)
      const prompt = nativePromptReference(driver.nativePromptIdentity, next, {
        bindingId, attemptId, provider: binding?.provider ?? driver.provider,
        nativeId: binding?.nativeId,
        path: binding?.path,
      })
      resident.snapshot = {
        ...resident.snapshot,
        requests: resident.snapshot.requests.map((item) =>
          item === target ? { ...item, nativePrompt: prompt, nativeDelivery: { ...delivery, evidence: next } } : item
        ),
      }
      // Unwritten, the handoff didn't happen: the request reads as it did, prepared, so no later write says it was sent.
      const unsent = () => {
        resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map((item) => (item.id === request.id ? target : item)) }
      }
      try {
        this.access.flush(resident)
      } catch (error) {
        if (handoff) unsent()
        this.access.storageFailed(resident, { error })
        if (handoff) throw new HandoffRefused("unsaved", { cause: error })
      }
      // A write the store dropped (a conversation already let go) holds nothing either.
      if (handoff && resident.journalSnapshot?.requests.find((item) => item.id === request.id)?.nativeDelivery?.evidence.kind !== "submitted") {
        unsent()
        throw new HandoffRefused("unsaved")
      }
      if (handoff) dependencies.agents?.()?.inputDelivered?.(resident.snapshot.session.id, request, "turn")
    }
    const drewIt = !shown && Boolean(text || request.attachments.length)
    const dispatch: PromptDispatch = { operationId: request.id, attemptId, report, ...text && { shown: text }, ...drewIt && { shownAt: toldAt } }
    const cwd = resident.snapshot.session.cwd
    void checkpoints
      .prompt(resident, current, async () => {
        // A removed worktree that could resume elsewhere was moved before dispatch. A pinned native session
        // still needs its original folder; detect that independently of whether a checkpoint could be saved.
        if (dependencies.projectFolderOfRemoved?.(cwd)) throw new Error(`The folder ${cwd} no longer exists. Open this in a folder that exists.`)
        const active = this.access.control(resident).activeBindingId
        if (review) return review.run(active, review.target, request.tuning, dispatch)
        // A Fin's brief carried again: a Continue goes in its place when the harness's own transcript shows the brief.
        // Read now, in its place in the queue, and sent through the same handoff and Stop as any message.
        const words = request.continues?.brief && await briefInTranscript(resident.snapshot, this.access.control(resident), request.continues.brief, dependencies.history)
          ? continueTurnPrompt("host-crashed", "mako")
          : request.text
        // A continuation says what moved since the cut, read here too, so nothing crosses the read (`TurnContinuation.since`).
        const since = request.continues?.since
        const moved = since !== undefined ? await cutAccount(cwd, since, request.continues!.reason, Date.now()).catch(() => undefined) : undefined
        const checkout = told?.since !== undefined ? checkoutAccount(await checkoutSince(cwd, told.since).catch(() => [])) : undefined
        const apex = !asWritten && (dependencies.agents?.()?.isApex(resident.snapshot.session.id) ?? false)
        const instructions = asWritten ? undefined : dependencies.controlInstructions?.(active, resident.snapshot.session.id, { role: apex ? "apex" : "thread" })
        const rules = asWritten ? {} : (dependencies.agents?.()?.ruleLines(resident.snapshot.session.id) ?? {})
        const person = !request.actor || request.actor.kind === "person"
        // Service-only turns need no routing paragraph. Once heard, keep its key through service turns, without repeating it.
        const guidance = apex && (person || resident.controlSaid?.lines.has("front-door-guidance"))
          ? `For messages from the person:\n${FRONT_DOOR_GUIDANCE.join("\n")}` : undefined
        const standing = instructions || Object.keys(rules).length || guidance
          ? standingLines(resident.controlSaid, { bindingId: active, generation: resident.bindingGenerations.get(active) ?? 0 }, { ...instructions?.standing, ...rules, "front-door-guidance": guidance })
          : undefined
        if (standing) {
          resident.controlSaid = standing.said
          const carried = Object.entries(rules).filter(([, line]) => line !== undefined && standing.lines.includes(line)).map(([name]) => name)
          if (carried.length) {
            resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map((item) => (item.id === request.id ? { ...item, ruleLines: carried } : item)) }
            try {
              this.access.flush(resident)
            } catch (error) {
              this.access.storageFailed(resident, { error })
            }
          }
        }
        const text = asWritten ? request.text : [
          controlNote([
            ...(standing?.lines ?? []),
            ...(instructions?.notices ?? []),
            ...(told ? [checkout ? `${told.account}\n${checkout}` : told.account] : []),
            ...(dependencies.agents?.()?.frontDoor(resident.snapshot.session.id, request, false) ?? []),
          ]),
          current.context.reduce((text, manifest) => contextPrompt(manifest, text, dependencies.harnessLabel), moved ? `${words}\n\n${moved}` : words),
        ].filter(Boolean).join("\n\n")
        return driver.prompt(active, text, request.attachments, request.tuning, dispatch)
      })
      .catch(async (error) => {
        // The harness may not have heard the note: the next prompt carries it whole.
        resident.controlSaid = undefined
        report({ kind: "uncertain", reason: errorMessage({ error }) })
        const target = resident.snapshot.requests.find(
          (candidate) =>
            candidate.id === request.id && candidate.status === "dispatching"
        )
        if (generation !== resident.generation || !target) return
        // Refused at its handoff, so never sent: it waits, held, and a Stop's mark on it keeps it the Stop's. One whose
        // reason went away is canceled, never to go.
        if (error instanceof HandoffRefused) {
          const status = error.why === "withdrawn" ? "canceled" : "held"
          resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map((candidate) =>
            candidate === target ? { ...candidate, status, error: undefined, snapshots: undefined } : candidate) }
          dependencies.workspaceSnapshots?.abandonRun(request.id)
          hostWarn("live", "a message went no further than its handoff", { conversation: resident.snapshot.session.id, request: request.id, why: error.why })
          try {
            this.access.flush(resident)
          } catch (failure) {
            this.access.storageFailed(resident, { error: failure })
          }
          return
        }
        const session = resident.snapshot.session
        const refused = target.nativeDelivery?.attemptId === attemptId && target.nativeDelivery.evidence.kind === "not-accepted"
        if (refused && error instanceof ExecutionAccountChanged && resident.accountRefreshRequest !== request.id &&
          session.status === "ready" && session.connection === "connected") {
          resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map(candidate =>
            candidate === target ? { ...candidate, status: "queued", error: undefined, snapshots: undefined } : candidate) }
          if (this.access.canHibernate(resident, false, true)) {
            resident.accountRefreshRequest = request.id
            dependencies.workspaceSnapshots?.abandonRun(request.id)
            this.access.flush(resident)
            await this.access.hibernate(resident, "account-change")
            if (resident.snapshot.session.connection === "hibernated" && !resident.closing &&
              resident.snapshot.requests.some(candidate => candidate.status === "queued")) {
              hostLog("live", "reopening an idle account for proven-unsent input", {
                conversation: resident.snapshot.session.id, request: request.id, reason: error.reason,
              })
              await this.access.wake(resident)
              return
            }
          } else {
            // Background work, subagents or an approval keep the old process
            // in use. The input waits unsent and the switch happens when they
            // end, so changing accounts never strands a session on the old one.
            const waitingFor = this.access.accountSwitchWait(resident)
            if (waitingFor) {
              dependencies.workspaceSnapshots?.abandonRun(request.id)
              resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map(candidate =>
                candidate.id === request.id ? { ...candidate, accountSwitch: { reason: error.reason, waitingFor } } : candidate) }
              this.access.flush(resident)
              hostLog("live", "input waits for a session to switch account", {
                conversation: resident.snapshot.session.id, request: request.id, reason: error.reason, waitingFor,
              })
              return
            }
          }
          // Retirement can be refused by a checkpoint, child or ownership
          // change. Keep the unsent receipt and require explicit recovery.
          if (resident.closing || resident.snapshot.session.status === "closed") return
          if (resident.generation !== generation || this.access.control(resident).activeBindingId !== bindingId) return
        }
        if (refused && error instanceof ExecutionIdentityMismatch) {
          // The agent is signed in as someone else. Nothing was sent and the
          // conversation is intact: fail only this input, and retire the
          // process so the next message launches with whatever credentials
          // the user fixes or chooses.
          resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map(candidate =>
            candidate === target ? { ...candidate, status: "failed", error: error.message, failure: "wrong-account" } : candidate) }
          checkpoints.settle(resident, request.id)
          this.access.flush(resident)
          hostWarn("live", "input refused: the agent reported a different account", { conversation: session.id, request: request.id })
          if (this.access.canHibernate(resident, false, true)) await this.access.hibernate(resident, "account-change")
          return
        }
        // A turn the harness started itself can end before this runs (Claude Code's notice of background work it
        // found stopped makes no model call): its refusal, not the status now, says the message only waits.
        const waitsForTurn = refused && error instanceof TurnInProgressError
        if ((session.status === "running" || waitsForTurn) && session.connection === "connected") {
          if (refused) {
            // The driver refused before sending because the provider was
            // still running a turn it had lost track of, and is showing that
            // turn now. Nothing was delivered, so the message waits for it.
            hostWarn("live", "a message waits for a turn the provider was still running", {
              conversation: resident.snapshot.session.id,
              request: request.id,
            })
            resident.snapshot = {
              ...resident.snapshot,
              requests: resident.snapshot.requests.map((candidate) =>
                candidate === target
                  ? { ...candidate, status: "queued", error: undefined, snapshots: undefined }
                  : candidate.id === told?.requestId && candidate.interruption?.told === toldAt
                    ? { ...candidate, interruption: { ...candidate.interruption, told: undefined } }
                    : candidate
              ),
            }
            dependencies.workspaceSnapshots?.abandonRun(request.id)
            this.access.flush(resident)
            // Its turn already over, nothing else drains: send again now, a few times at most, since the status
            // read here can trail the harness's by a flush; past that, the end of its turn drains as usual.
            const refusals = resident.turnInProgress?.request === request.id ? resident.turnInProgress.refusals + 1 : 1
            resident.turnInProgress = { request: request.id, refusals }
            if (resident.snapshot.session.status !== "running" && refusals <= TURN_IN_PROGRESS_RETRIES) this.drain(resident)
            return
          }
          // A send that threw without a receipt may still have started the
          // turn, and the driver still runs it: the request settles when
          // that turn ends, like any other, and is never sent again.
          hostWarn("live", "a send failed without a receipt while its turn runs; waiting for the turn", {
            conversation: resident.snapshot.session.id,
            request: request.id,
            error: errorMessage({ error }),
          })
          return
        }
        // The harness refused it unsent for a cause that clears by itself: it waits and goes again, never a failure.
        const failureEvidence = failureEvidenceOf({ error })
        const failure = classifyProviderFailure(errorMessage({ error }), undefined, failureEvidence).kind
        const cause = refused ? transientCause(errorMessage({ error }), failure, error instanceof SessionBusyError, failureEvidence) : undefined
        const waits = refused ? waitsAgain(target, cause, errorMessage({ error }), Date.now()) : undefined
        const retry = waits?.retry
        if (waits) {
          resident.snapshot = {
            ...resident.snapshot,
            requests: resident.snapshot.requests.map((candidate) =>
              candidate === target ? { ...waits, error: undefined, snapshots: undefined } : candidate),
          }
          dependencies.workspaceSnapshots?.abandonRun(request.id)
          this.access.flush(resident)
          hostWarn("live", "a message its harness refused for now goes again by itself", { conversation: session.id, request: request.id, ...(cause && { cause }), ...(retry && { attempt: retry.attempt, at: new Date(retry.at).toISOString() }) })
          return
        }
        resident.snapshot = {
          ...resident.snapshot,
          session: {
            ...resident.snapshot.session,
            status: "failed",
            error: errorMessage({ error }),
          },
          requests: resident.snapshot.requests.map((candidate) =>
            candidate.id === request.id
              ? {
                  ...candidate,
                  status: "failed",
                  error: errorMessage({ error }),
                  failureEvidence,
                  failure: error instanceof ExecutionAccountChanged ? undefined : failureAfterRetry(failure, failureEvidence, candidate.retry, Date.now()),
                  retry: undefined,
                }
              : candidate
          ),
        }
        if (resident.snapshot.requests.find((candidate) => candidate.id === request.id)?.failure === "auth")
          resident.snapshot = {
            ...resident.snapshot,
            requests: holdForSignIn(resident.snapshot.requests, this.access.signInHold(resident), request.id),
          }
        if (resident.snapshot.requests.find((candidate) => candidate.id === request.id)?.status === "held")
          dependencies.workspaceSnapshots?.abandonRun(request.id)
        else checkpoints.settle(resident, request.id)
        this.access.flush(resident)
      })
  }
}
