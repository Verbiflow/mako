import { randomUUID } from "node:crypto"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { controlNote } from "../base/control-launch.js"
import { ExecutionAccountChanged, ExecutionIdentityMismatch, HandoffRefused, heldSubmission, TurnInProgressError, type PromptDispatch } from "../harnesses/index.js"
import { digestAsks } from "../contracts/agents.js"
import { FRONT_DOOR_GUIDANCE } from "../contracts/agent-tools.js"
import { foldedSeparator, JOINED_CHARS, JOINED_MAX, type FoldedBy, type LiveRequest, type LiveSnapshot } from "../contracts/live-conversations.js"
import { APEX_NOTE_MARK } from "../contracts/children.js"
import { promptFingerprint } from "./live-assets.js"
import { quietSwitch } from "../contracts/conversation-control.js"
import { retireQuestionsForInput } from "../contracts/live-questions.js"
import { nativePromptReference } from "../contracts/native-prompt-identity.js"
import { advancePromptDelivery, type PromptDelivery, type PromptDeliveryEvidence } from "../contracts/prompt-delivery.js"
import { failureAfterRetry, transientCause, waitsAgain } from "../contracts/delivery-retry.js"
import { nextInLine } from "../contracts/request-hold.js"
import { ASK_EVERY_MS, DIGEST_WAITS, WAKES_PER_MINUTE, DIGEST_RESTART_HINT } from "../contracts/children.js"
import type { NativePromptIdentityCapability } from "../contracts/native-prompt-identity.js"
import { classifyProviderFailure, failureEvidenceOf } from "../contracts/provider-failure.js"
import { SessionBusyError } from "../contracts/session-hold.js"
import { holdForSignIn } from "../contracts/sign-in-hold.js"
import { checkoutAccount, pendingInterruption, TurnSteps } from "./interrupted-turn.js"
import { checkoutSince } from "../base/checkout-since.js"
import { cutAccount } from "./cut-account.js"
import { heardBy, standingLines } from "./control-cadence.js"
import type { LiveActions } from "./live-actions.js"
import type { LiveCheckpoints } from "./live-checkpoints.js"
import { contextPrompt } from "./live-context.js"
import type { LiveAccess, Resident } from "./live-runtime.js"
import { liveStages } from "./live-stages.js"
import { stagedCall, stagedWait } from "../base/live-steps.js"
import type { LiveTransfers } from "./live-transfers.js"
import { baseUnread } from "./base-source.js"
import { turnStart, usageMark } from "./live-settlement.js"
import { captureNativeHistory, transcriptHolds, digestReceipt } from "./native-history.js"
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

/** A conversation's control once an Apex's roster went again after its harness forgot it (`rosterForgotten`). */
function withoutRosterForgotten(control: ConversationControl): ConversationControl {
  const rest = { ...control }
  delete rest.rosterForgotten
  return rest
}

/** When a message was admitted, as its conversation counts: its `admissionOrder`, else its time. */
function admitted(request: LiveRequest): number {
  return request.admissionOrder ?? request.createdAt ?? 0
}

/** Mako's own notes that go with the turn they wait for: a pull request's outcome, a wait that fired. */
const FOLDED_SERVICES = new Set(["pull-watch", "turn-wait"])

/** Who wrote a message that can go with others: the person, an agent by its Session, Mako, or Fins' news (a digest). */
type Sender = { kind: "person" } | { kind: "agent"; session: string } | { kind: "mako" } | { kind: "fins" }

function senderOf(request: LiveRequest): Sender | undefined {
  if (request.digest) return { kind: "fins" }
  if (!request.actor || request.actor.kind === "person") return { kind: "person" }
  if (request.actor.kind === "agent") return { kind: "agent", session: request.actor.session }
  return FOLDED_SERVICES.has(request.actor.name) ? { kind: "mako" } : undefined
}

/** Whether a message is the person's own. */
function personal(request: LiveRequest): boolean {
  return senderOf(request)?.kind === "person"
}

/** Words and a sender, nothing else: no hold, no edit, no command, nothing it sends or settles of its own. */
function plain(request: LiveRequest): boolean {
  return senderOf(request) !== undefined && !request.pause && !request.editing && !request.retry && !request.continues && !request.signIn &&
    !request.accountSwitch && !request.review && !request.verbatim && !request.ownerCheck && !request.goal && request.displayText === undefined &&
    !request.joinedInto && !request.interruption &&
    // Folded once already, it carries what it carries; and another Apex's message is owed its own reply.
    !request.joined?.length && !request.text.includes(APEX_NOTE_MARK)
}

/** A digest held only for its burst's window (`DIGEST_WAITS`): a turn that goes now takes it along. */
function windowedDigest(request: LiveRequest): boolean {
  return request.status === "held" && request.wake?.after === DIGEST_WAITS && !request.digest?.resting
}

/**
 * Fins' news never sent: one tried before (sent, or resting after a limit) goes again alone, as its own retry and
 * receipt say (`delivery-retry.ts`, rule 15).
 */
function freshNews(request: LiveRequest): boolean {
  return request.digest === undefined || (request.digest.sentAt === undefined && !request.digest.resting && !request.digest.heard)
}

/** A message that can go inside another's turn: waiting only for its turn (a digest, or its window), with nothing attached. */
function joins(request: LiveRequest): boolean {
  return plain(request) && freshNews(request) && (request.status === "queued" ? !request.wake : Boolean(request.digest) && windowedDigest(request)) &&
    !request.attachments.length && !request.grants?.length
}

/** A turn of several messages: the row that carries it, as it is now and with the words it goes with, and the queue as it leaves. */
export interface FoldPlan {
  carrier: LiveRequest
  request: LiveRequest
  requests: LiveRequest[]
}

/**
 * `next`, about to go, with what waits for a turn around it, as one turn (`docs/delivery-queue.md`, rule 16): a Fin back
 * from a long turn, or an Apex the person wrote to while its Fins reported, reads everything said since at once, not a
 * message a turn (land-2, 2026-11-16: ten of its Apex's messages, ten turns, the newest read last; a pull request's
 * outcome and a wait's note a turn each besides). Behind `next`, while nothing else stands between them (another agent,
 * a second message from the person, a paused or edited message, one with attachments or a different `notification`, one
 * `admits` refuses), go one agent's plain messages, Mako's notes (`FOLDED_SERVICES`), the person's message and Fins'
 * news, a digest waiting for the turn or for its window, the one ahead of `next` too. The person's message is never
 * folded into another's: it carries the turn, its words first, and the rest follow in their order, each under a line
 * saying who and when. Without it the first that isn't a digest carries the turn; a digest never does, so one that goes
 * alone keeps its own receipt (rule 15). Within `JOINED_MAX` and `JOINED_CHARS`; each folded message is canceled with
 * `joinedInto`, its ID kept in `joined`. Undefined when none fold.
 */
export function foldQueued(requests: readonly LiveRequest[], next: LiveRequest, admits: (request: LiveRequest) => boolean = () => true): FoldPlan | undefined {
  if (next.status !== "queued" || next.wake || !plain(next) || !freshNews(next)) return undefined
  // A person's message may bring what it attaches and grants: it carries the turn. Anyone else's goes alone with them.
  if (!personal(next) && (next.attachments.length || next.grants?.length)) return undefined
  const at = requests.indexOf(next)
  const line: LiveRequest[] = [...requests.slice(0, at).filter((request) => joins(request) && request.digest !== undefined && admits(request)).slice(-1), next]
  let agent: string | undefined
  let person = false
  let digests = 0
  let length = 0
  const fits = (request: LiveRequest): boolean => {
    const by = senderOf(request)
    if (!by || Boolean(request.notification) !== Boolean(next.notification)) return false
    // One person's message, carrying it; one digest; one agent's words: another agent's message is its own turn.
    if (by.kind === "person" && person) return false
    if (by.kind === "fins" && digests) return false
    if (by.kind === "agent" && agent !== undefined && by.session !== agent) return false
    if (line.length > JOINED_MAX || length + request.text.length > JOINED_CHARS) return false
    if (by.kind === "person") person = true
    if (by.kind === "fins") digests += 1
    if (by.kind === "agent") agent = by.session
    length += request.text.length
    return true
  }
  if (!fits(next)) return undefined
  // What's ahead of `next` is a digest waiting out its window, taken only if it fits beside `next`.
  if (line.length > 1 && !fits(line[0]!)) line.shift()
  for (const request of requests.slice(at + 1)) {
    if (request.status !== "queued" && request.status !== "held") continue
    if (request.status === "held" && !windowedDigest(request)) break
    if (!joins(request)) break
    // A note whose wait no longer holds (`Agents.admits`) goes alone, to be refused there.
    if (!admits(request)) break
    // Only what came after it: one that went ahead of older messages (an interrupt's) goes alone, and they follow it.
    // Fins' news says what's new whenever it was gathered.
    if (!request.digest && admitted(request) <= admitted(next)) break
    if (!fits(request)) break
    line.push(request)
  }
  const carrier = line.find(personal) ?? line.find((request) => !request.digest)
  if (!carrier || line.length < 2) return undefined
  const rest = line.filter((request) => request !== carrier)
  const by = (request: LiveRequest, index: number): FoldedBy => {
    const sender = senderOf(request)
    if (sender?.kind === "mako") return "mako"
    if (sender?.kind === "fins") return "fins"
    const before = [carrier, ...rest.slice(0, index)]
    return sender?.kind === "agent" && before.some((each) => { const was = senderOf(each); return was?.kind === "agent" && was.session === sender.session }) ? "same" : "agent"
  }
  const text = carrier.text + rest.map((request, index) => `${foldedSeparator(by(request, index), request.createdAt ?? Date.now())}${request.text}`).join("")
  const joined = rest.map((request) => ({ id: request.id, at: request.createdAt ?? Date.now() }))
  const request: LiveRequest = { ...carrier, text, joined, inputDigest: promptFingerprint(text, carrier.attachments, carrier.tuning) }
  const gone = new Set(rest.map((each) => each.id))
  return {
    carrier,
    request,
    requests: requests.map((each) => each === carrier ? request : gone.has(each.id) ? { ...each, status: "canceled" as const, joinedInto: carrier.id } : each),
  }
}

/**
 * The fold `foldQueued` worked out, written as the handoff commits: the carrier, as it stands now, takes the words and
 * `joined` it went with, and each folded message still queued as it was then is canceled into it (`joinedInto`). One
 * the person removed, paused or edited meanwhile keeps their change; its words went with the turn regardless.
 */
function commitFold(requests: readonly LiveRequest[], carrier: string, folded: LiveRequest, planned: readonly LiveRequest[]): LiveRequest[] {
  const then = new Map(planned.filter((each) => each.joinedInto === carrier).map((each) => [each.id, each]))
  return requests.map((each) => {
    if (each.id === carrier) return { ...each, text: folded.text, joined: folded.joined, inputDigest: folded.inputDigest }
    const as = then.get(each.id)
    if (!as) return each
    return stillWaiting(each, as.text) ? { ...each, status: "canceled" as const, joinedInto: carrier } : each
  })
}

/** Whether a message folded into a turn still waits as it was when the fold was planned: unsent, unchanged, not paused. */
function stillWaiting(request: LiveRequest | undefined, text: string): boolean {
  return request !== undefined && (request.status === "queued" || (Boolean(request.digest) && windowedDigest(request))) && !request.editing && !request.pause && request.text === text
}

/**
 * Whether the harness's own transcript shows the Fin's brief `briefId` (`transcriptHolds`): under the message id it
 * was sent with, where the harness keeps that, or by its "You're fin:" line, which the brief sent again carries too. A
 * digest is known by native identity alone. Missing or unreadable evidence is unknown, never non-receipt.
 */
async function briefInTranscript(snapshot: LiveSnapshot, control: ConversationControl, briefId: string, history: (path: string, before?: number) => Promise<ThreadPage | null>, identity: (provider: string) => NativePromptIdentityCapability | undefined): Promise<"present" | "absent" | "unknown"> {
  const brief = snapshot.requests.find((request) => request.id === briefId)
  const bindingId = brief?.nativeDelivery?.bindingId ?? control.activeBindingId
  const binding = control.bindings.find((binding) => binding.id === bindingId)
  const path = binding?.path
  const capability = binding && identity(binding.provider)
  if (!brief) return "unknown"
  if (brief.digest) {
    const known = digestReceipt(null, binding, brief, capability)
    if (known !== "unknown") return known
  }
  if (!path) return "unknown"
  const page = await captureNativeHistory(path, history).catch((error) => {
    hostWarn("live", "a harness's transcript couldn't be read to see whether it had a Fin's brief", { conversation: snapshot.session.id, error: errorMessage({ error }) })
    return null
  })
  // A digest has no line of its own: any of them could be in what the Thread was told before, so only its id proves it.
  const marker = brief.digest ? "" : brief.text.split("\n").find((line) => line.includes("You're fin:")) ?? ""
  return brief.digest ? digestReceipt(page, binding, brief, capability)
    : page && transcriptHolds(page.entries, { attemptId: brief.nativeDelivery?.attemptId, marker }) ? "present" : "unknown"
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
    // A digest its harness refused before taking it (`not-accepted`) woke nobody: it keeps when it was tried, and isn't
    // counted, or its own next try would wait out the minute it never spent.
    const recent = resident.snapshot.requests.flatMap((candidate) => {
      const at = candidate.digest?.sentAt
      const refused = candidate.nativeDelivery?.evidence.kind === "not-accepted"
      return at !== undefined && at > now - MINUTE_MS && !refused ? [{ at, asks: digestAsks(candidate.digest!.notices) }] : []
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
    // Nor while an access change is on its way to the harness: `setMode` drains again once it answers.
    if (resident.modeChanging) return
    // Queued work stays queued, not held: cancelling a move starts it again.
    if (!this.access.moves.executes(resident)) return
    // Nor while this Mac checks with its account after it was away: its Session may have continued in the cloud.
    if (this.access.moves.ownerCheck(resident, true) !== undefined) return this.holdForOwner(resident)
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
    const queued = nextQueued(resident.snapshot)
    if (!queued) return
    // A switch's own message goes on its destination, once the switch has committed.
    if (queued.id === transfer?.input.id) return
    if (queued.digest && this.overBudget(resident, queued)) return
    if (this.leaveRemovedFolder(resident)) return
    if (queued.accountSwitch) {
      void this.access.switchAccount(resident, queued).catch((error) => {
        hostWarn("live", "account switch failed", { conversation: resident.snapshot.session.id, error: errorMessage({ error }) })
      })
      return
    }
    // What waits for a turn around it goes with it, as one turn, carried by the person's message where there is one: its
    // words are sent now, and the journal folds the rows only as the handoff commits (`report`), so a send that goes no
    // further leaves every row as it was. A switch's own message carries nothing here: it goes on its destination.
    const plan = foldQueued(resident.snapshot.requests, queued, (each) => dependencies.agents?.()?.admits?.(resident.snapshot.session.id, each) !== false)
    const folded = plan && plan.carrier.id !== transfer?.input.id ? plan : undefined
    const request = folded?.carrier ?? queued
    const sends = folded?.request.text ?? request.text
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
    const text = request.displayText ?? resident.displayPrompt ?? sends
    resident.displayPrompt = undefined
    // A request held back behind a turn the provider was still running
    // already shows its message from that attempt.
    const shown = request.nativeDelivery?.evidence.kind === "not-accepted"
    const drawn: Extract<Resident["updates"][number], { kind: "user" }> | undefined = !shown && (text || request.attachments.length) ? {
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
      } : undefined
    // A folded send draws its prompt as the handoff commits the fold, in the same write: one that goes no further (a
    // Stop, a note withdrawn meanwhile, which sends it again worked out anew) drew nothing, so nothing is drawn twice.
    if (drawn && !folded) resident.updates.push(drawn)
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
    if (liveStages.heard) liveStages.publish({ stage: "dispatching", conversation: resident.snapshot.session.id, request: request.id })
    const generation = resident.generation
    // Whether this prompt carries an Apex's roster after its harness forgot it (`rosterForgotten`): the handoff clears
    // the flag in the write that records it sent, so a send that goes no further leaves it for the next.
    let rosterWent = false
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
      // Each note it was to carry is admitted again here, as its own send would be: one withdrawn since the fold was
      // planned sends the carrier back to the queue, to be worked out again without it (and refused there alone).
      if (handoff && folded?.requests.some((planned) => planned.joinedInto === request.id && dependencies.agents?.()?.admits?.(resident.snapshot.session.id, resident.snapshot.requests.find((each) => each.id === planned.id) ?? planned) === false))
        throw new HandoffRefused("refold")
      // So is Fins' news that changed meanwhile (a notice joined it, or one was withdrawn): it goes as it is now.
      if (handoff && folded?.requests.some((planned) => planned.joinedInto === request.id && planned.digest && !stillWaiting(resident.snapshot.requests.find((each) => each.id === planned.id), planned.text)))
        throw new HandoffRefused("refold")
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
      const beforeFold = resident.snapshot.requests
      const control = this.access.control(resident)
      const rosterCleared = handoff && rosterWent && control.rosterForgotten === true
      resident.snapshot = {
        ...resident.snapshot,
        requests: resident.snapshot.requests.map((item) =>
          item === target ? { ...item, nativePrompt: prompt, nativeDelivery: { ...delivery, evidence: next } } : item
        ),
        ...rosterCleared && { control: withoutRosterForgotten(control) },
      }
      // The handoff commits the fold with the send, in the one write: the carrier takes the words it sends and the
      // messages folded into it leave the queue, each pointing at it. One the person changed meanwhile stays as it is.
      if (handoff && folded) {
        resident.snapshot = { ...resident.snapshot, requests: commitFold(resident.snapshot.requests, request.id, folded.request, folded.requests) }
        if (drawn) resident.updates.push(drawn)
        hostLog("live", "messages went as one turn", { conversation: resident.snapshot.session.id, request: request.id, joined: folded.request.joined?.length ?? 0 })
      }
      // Unwritten, the handoff didn't happen: the request reads as it did, prepared, so no later write says it was sent;
      // nor was anything folded into it.
      const unsent = () => {
        if (folded && drawn) resident.updates = resident.updates.filter((update) => update !== drawn)
        if (rosterCleared) resident.snapshot = { ...resident.snapshot, control: { ...this.access.control(resident), rosterForgotten: true } }
        const was = new Map(beforeFold.map((item) => [item.id, item]))
        resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map((item) => (item.id === request.id ? target : folded && was.has(item.id) && item.joinedInto === request.id ? was.get(item.id)! : item)) }
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
      if (handoff) {
        const agents = dependencies.agents?.()
        agents?.inputDelivered?.(resident.snapshot.session.id, request, "turn")
        // Each message folded into it reached it too, as its own sender's (rule 13): an Apex's words a Mako note
        // carried answer what the Apex has heard, and Fins' news answers nothing.
        for (const each of resident.snapshot.requests) if (each.joinedInto === request.id) agents?.inputDelivered?.(resident.snapshot.session.id, each, "turn")
      }
      if (liveStages.heard) liveStages.publish({ stage: "delivery", conversation: resident.snapshot.session.id, request: request.id, evidence: next.kind })
    }
    const drewIt = !shown && Boolean(text || request.attachments.length)
    const dispatch: PromptDispatch = { operationId: request.id, attemptId, report, ...text && { shown: text }, ...drewIt && { shownAt: toldAt } }
    const cwd = resident.snapshot.session.cwd
    // The checkpoint may hold the message up to ten seconds, and its admission reads nothing of the checkpoint: begun
    // now, those reads are over, or shared, when the message is admitted as it goes. What the message says is put
    // together only then: its notices are marked as told and its note's cadence written as they are read, and what
    // moved in the checkout is read as of the send.
    if (bindingId) driver.admitAhead?.(bindingId)
    void checkpoints
      .prompt(resident, current, async () => {
        const active = this.access.control(resident).activeBindingId
        if (review) return review.run(active, review.target, request.tuning, dispatch)
        // A Fin's brief carried again: a Continue goes in its place when the harness's own transcript shows the brief.
        // Read now, in its place in the queue, and sent through the same handoff and Stop as any message.
        const sourceBrief = request.continues?.brief ? resident.snapshot.requests.find(item => item.id === request.continues!.brief) : undefined
        const receipt = sourceBrief ? await briefInTranscript(resident.snapshot, this.access.control(resident), sourceBrief.id, dependencies.history, provider => dependencies.driver(provider)?.nativePromptIdentity) : undefined
        // A digest steered into the turn this continues whose receipt is unknown fails closed as a crashed digest does
        // (rule 15): never sent again, and the turn that goes on hears that reports may have arrived around the restart.
        // So does one folded into the turn a crash cut (`joinedInto`): its words went with that turn, whoever's it was.
        const steeredDigest = request.continues && (this.access.control(resident).actions?.some((action) =>
          action.input.kind === "steer-queued" && action.input.requestId === request.continues!.requestId && action.state.kind === "uncertain" &&
          Boolean(resident.snapshot.requests.find((item) => item.id === (action.input.kind === "steer-queued" ? action.input.queuedRequestId : ""))?.digest)) ||
          (request.continues.reason === "host-crashed" && resident.snapshot.requests.some((item) => item.joinedInto === request.continues!.requestId && item.digest)))
        const said = sourceBrief?.digest && receipt !== "absent"
          ? `${continueTurnPrompt("host-crashed", "mako")}\n\n${DIGEST_RESTART_HINT}`
          : receipt === "present" ? continueTurnPrompt("host-crashed", "mako") : sends
        const words = steeredDigest && !said.includes(DIGEST_RESTART_HINT) ? `${said}\n\n${DIGEST_RESTART_HINT}` : said
        // A continuation says what moved since the cut, read here too, so nothing crosses the read (`TurnContinuation.since`).
        const since = request.continues?.since
        const moved = since !== undefined ? await cutAccount(cwd, since, request.continues!.reason, Date.now()).catch(() => undefined) : undefined
        const toldSince = told?.since
        const checkout = toldSince !== undefined ? checkoutAccount(await stagedWait(resident.snapshot.session.id, "interruption account", () => checkoutSince(cwd, toldSince)).catch(() => [])) : undefined
        const apex = !asWritten && (dependencies.agents?.()?.isApex(resident.snapshot.session.id) ?? false)
        const instructions = asWritten || !dependencies.controlInstructions ? undefined : await dependencies.controlInstructions(active, resident.snapshot.session.id, { role: apex ? "apex" : "thread" })
        const rules = asWritten ? {} : (dependencies.agents?.()?.ruleLines(resident.snapshot.session.id) ?? {})
        const person = !request.actor || request.actor.kind === "person"
        // What the transcript this prompt goes into holds of Mako's note (`heardBy`): this process's own record, else the
        // journal's for the same native session. One that holds none (new, compacted, rewound) hears every Fin described
        // again, not named as unchanged.
        const binding = this.access.control(resident).bindings.find((item) => item.id === active)
        const nativeId = binding?.nativeId ?? resident.snapshot.session.nativeId
        const heard = heardBy(resident.controlSaid, this.access.control(resident).noteHeard, {
          bindingId: active, generation: resident.bindingGenerations.get(active) ?? 0, nativeId, cwd,
        })
        const heardNote = heard !== undefined
        // A compaction or rewind since the note last went: the roster rides this prompt, whatever it is, once.
        const forgot = !asWritten && this.access.control(resident).rosterForgotten === true
        rosterWent = forgot
        // Service-only turns need no routing paragraph. Once heard, keep its key through service turns, without repeating it.
        const guidance = apex && (person || heard?.lines.has("front-door-guidance"))
          ? `For messages from the person:\n${FRONT_DOOR_GUIDANCE.join("\n")}` : undefined
        const standing = instructions || Object.keys(rules).length || guidance
          ? standingLines(heard, { bindingId: active, generation: resident.bindingGenerations.get(active) ?? 0, ...nativeId !== undefined && { nativeId } }, { ...instructions?.standing, ...rules, "front-door-guidance": guidance })
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
            ...(dependencies.agents?.()?.frontDoor(resident.snapshot.session.id, request, false, !heardNote, forgot) ?? []),
          ]),
          current.context.reduce((text, manifest) => contextPrompt(manifest, text, dependencies.harnessLabel), moved ? `${words}\n\n${moved}` : words),
        ].filter(Boolean).join("\n\n")
        if (liveStages.heard) liveStages.publish({ stage: "assembled", conversation: resident.snapshot.session.id, request: request.id, chars: text.length })
        // Where writes are held the message went ahead of its checkpoint; one whose submission runs the person's
        // code by itself waits for it here, as it is worded and before it is admitted.
        const held = heldSubmission(dependencies.writeHolds, driver.firstWrite?.submitRuns, active, text)
        if (held) await stagedWait(resident.snapshot.session.id, "held submission", () => held)
        return stagedCall(resident.snapshot.session.id, "driver.prompt", () => driver.prompt(active, text, request.attachments, request.tuning, dispatch))
      })
      .catch(async (error) => {
        // The harness may not have heard the note: the next prompt carries what the transcript is known to lack (the
        // journal's `noteHeard`, written only once a model answered), the roster this one carried too.
        resident.controlSaid = undefined
        if (rosterWent && generation === resident.generation) resident.snapshot = { ...resident.snapshot, control: { ...this.access.control(resident), rosterForgotten: true } }
        report({ kind: "uncertain", reason: errorMessage({ error }) })
        const target = resident.snapshot.requests.find(
          (candidate) =>
            candidate.id === request.id && candidate.status === "dispatching"
        )
        if (generation !== resident.generation || !target) return
        // Refused at its handoff, so never sent: it waits, held, and a Stop's mark on it keeps it the Stop's. One whose
        // reason went away is canceled, never to go.
        if (error instanceof HandoffRefused) {
          const status = error.why === "withdrawn" ? "canceled" : error.why === "refold" ? "queued" : "held"
          resident.snapshot = { ...resident.snapshot, requests: resident.snapshot.requests.map((candidate) =>
            // Refolded, it goes again as never sent: no delivery of its own was attempted, and it drew nothing.
            candidate === target ? { ...candidate, status, error: undefined, snapshots: undefined, ...status === "queued" && { nativeDelivery: undefined, nativePrompt: undefined } } : candidate) }
          dependencies.workspaceSnapshots?.abandonRun(request.id)
          hostWarn("live", "a message went no further than its handoff", { conversation: resident.snapshot.session.id, request: request.id, why: error.why })
          try {
            this.access.flush(resident)
          } catch (failure) {
            this.access.storageFailed(resident, { error: failure })
            return
          }
          // A canceled one is out of the line, and what waited behind it goes now: no turn is running to drain it at
          // its end, so a Fin read as working for hours with its Apex's messages queued behind a canceled note
          // (send-modes, 2026-11-15). One held keeps its place, and the ones behind it wait with it.
          if (status === "canceled" || status === "queued") this.drain(resident)
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
            failureEvidence,
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
