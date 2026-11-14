import type { LivePermissionRequest, LiveSessionState, LiveSummary } from "@/lib/types"
import type { Entry } from "@mako/sessions/entries"
import { harnessLabel } from "@/lib/harness-label"
import { workspaceName } from "@/lib/format"
import {
  acpStore,
  conversationRoster,
  updateAcpConversation,
  type LiveAcpConversation,
} from "@/state/acp-state"
import {
  liveSubjectIds,
  noteOutcome,
  noticeId,
  retireNotice,
  retargetNotice,
  retireSubject,
  subjectId,
  subjectWorkspace,
  type NotificationSubject,
} from "@/state/notifications"
import { setThreadAttention, setThreadRunning, threadsStore } from "@/state/threads"
import { describeProviderFailure } from "@mako/host/contracts/provider-failure"
import { autoContinuePending } from "@/state/prompt-delivery"
import { signInPause, signInResuming } from "@mako/host/contracts/sign-in-hold"
import { agentAskLine } from "@mako/host/contracts/agent-asks"
import { agentAskOf } from "@/state/agent-asks"
import { asks, requestWaiting, type Waiting } from "@mako/host/contracts/notifications"
import { bareCommand } from "@mako/sessions/tool-identity"
import { askWords, finAskWaiting, rosterChildren } from "@mako/host/contracts/children"
import { personAsks } from "@/state/fin-asks"

export function updateLive(
  id: string,
  update: (conversation: LiveAcpConversation) => LiveAcpConversation
): LiveAcpConversation | null {
  const next = updateAcpConversation(id, (conversation) =>
    conversation.kind === "live" ? update(conversation) : conversation
  )
  return next?.kind === "live" ? next : null
}

export function activeIs(id: string): boolean {
  return acpStore.get().activeKey === id
}

/** A live conversation's notification identity: its thread once bound, else its key. */
export function liveSubject(conversation: LiveAcpConversation): NotificationSubject {
  const target = conversation.threadPath
    ? { kind: "thread" as const, path: conversation.threadPath }
    : { kind: "live" as const, key: conversation.key }
  return {
    id: subjectId(target),
    target,
    title:
      conversation.title ?? conversation.session.title ?? workspaceName(conversation.cwd),
    agent: harnessLabel(conversation.harness),
    workspace: subjectWorkspace(conversation.cwd),
  }
}

/** The agent's last reply: the text blocks since the last prompt, in order. */
export function lastReplyText(blocks: readonly Entry[]): string {
  const parts: string[] = []
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!
    if (block.type === "user" || block.type === "provider-turn") break
    if (block.type === "text") parts.push(block.text)
  }
  return parts.toReversed().join("\n\n")
}

/**
 * The banner's one line for a failed run: the host's verdict on the newest
 * failed request, named for the provider, rather than the provider's raw text
 * (which for a rejected transcript is a JSON error body).
 */
function failureDetail(conversation: LiveAcpConversation): string | undefined {
  // A dropped connection settles its request as interrupted, not failed, and
  // still carries the kind that names the connection.
  const kind = conversation.requests?.findLast((request) => request.failure !== undefined)?.failure
  return kind && kind !== "unknown"
    ? describeProviderFailure(kind, harnessLabel(conversation.harness)).title
    : undefined
}

/** What a permission asks, as every surface says it: a question even when asked as one, else an approval. */
function permissionWaiting(permission: LivePermissionRequest): Waiting {
  return requestWaiting(permission, bareCommand)
}

/**
 * The asks each conversation said itself, by what each is (its provider or agent ask's id, a sign-out's start), with the notice it
 * was said as: each is taken back by that notice alone once it no longer waits (`retireNotice`), whatever else waits on
 * the same subject, its Fins' asks included.
 */
const announcedOwnAsks = new Map<string, string>()
const announcedSignIns = new Map<string, { generation: string; notice: string; subject: NotificationSubject; cohort?: string }>()

function retireSignIn(key: string): void {
  const previous = announcedSignIns.get(key)
  announcedSignIns.delete(key)
  if (!previous) return
  const sibling = [...announcedSignIns.values()].find(entry => entry.notice === previous.notice)
  if (sibling) retargetNotice(previous.notice, sibling.subject)
  else retireNotice(previous.notice)
}
/** What a Session another device runs last asked here (`noteListedOutcome`), by the notice it was said as. */
const listedAsks = new Map<string, string>()

/** A session paused on a sign-out waits on the person, like a question; it hasn't failed. */
function signedOutDetail(conversation: LiveAcpConversation): string {
  const pause = signInPause(conversation.requests ?? [])
  if (pause?.hold.ready) return `${harnessLabel(conversation.harness)} signed in again. Resume when you want this work to continue.`
  if (pause?.hold.verification !== undefined && !conversation.requests?.some(request => request.signIn && request.pause === "stop"))
    return `${harnessLabel(conversation.harness)} signed out. Sign in once in Settings; held work resumes automatically.`
  return `${harnessLabel(conversation.harness)} signed out. Sign in again, then Resume.`
}

/**
 * Turn a status transition into an outcome for the attention centre. This
 * runs before the thread-path checks below because an unbound live session
 * still finishes, asks, and fails; its key is its identity until then.
 */
function noteLiveOutcome(
  conversation: LiveAcpConversation,
  previousStatus: LiveSessionState["status"],
  quiet: boolean
): void {
  const { session, permission, queued } = conversation
  const subject = liveSubject(conversation)
  const busy = session.status === "running" || session.status === "starting"
  const wasBusy = previousStatus === "running" || previousStatus === "starting"
  if (busy && !wasBusy)
    for (const id of liveSubjectIds(conversation.key, conversation.threadPath)) retireSubject(id)
  // A provider's permission or the agent's tool ask: retire only the notice for the ask that stopped waiting.
  // A Fin's ask is announced on its Apex once it belongs to the person (`noteFinAsks`).
  const agentAsk = agentAskOf(conversation)
  const own = permission ?? agentAsk
  const waiting = permission ? permissionWaiting(permission) : agentAsk ? { for: "needs-you" as const, line: agentAskLine(agentAsk.want) } : undefined
  const notice = own && waiting ? noticeId(subject, waiting.for, own.id) : undefined
  const asked = announcedOwnAsks.get(conversation.key)
  if (asked && asked !== notice) {
    announcedOwnAsks.delete(conversation.key)
    retireNotice(asked)
  }
  if (own && waiting && notice && asked !== notice && !conversation.parent) {
    announcedOwnAsks.set(conversation.key, notice)
    noteOutcome({ kind: waiting.for, subject, marker: own.id, detail: waiting.line, quiet })
  }
  const heldSignIn = signInPause(conversation.requests ?? [])
  const pause = own || heldSignIn?.hold.ready ? undefined : heldSignIn
  const signIn = announcedSignIns.get(conversation.key)
  const signInGeneration = pause && (pause.hold.id ?? String(pause.hold.at))
  if (signIn && signIn.generation !== signInGeneration) retireSignIn(conversation.key)
  if (own) return
  if (session.status === "closed") {
    retireSignIn(conversation.key)
    for (const id of liveSubjectIds(conversation.key, conversation.threadPath)) retireSubject(id)
    return
  }
  if (heldSignIn?.hold.ready) return
  if (pause) {
    if (signIn?.generation !== signInGeneration) {
      // One account owns one sign-in notice while any member still waits.
      const cohort = pause.hold.verification !== undefined
        ? JSON.stringify([pause.hold.harness, pause.hold.account]) : undefined
      const peer = cohort ? [...announcedSignIns.values()].find(entry => entry.cohort === cohort) : undefined
      const marker = `sign-in:${signInGeneration}`
      const notice = peer?.notice ?? noticeId(subject, "needs-you", marker)
      announcedSignIns.set(conversation.key, { generation: signInGeneration!, notice, subject, ...(cohort && { cohort }) })
      if (!peer) noteOutcome({ kind: "needs-you", subject, marker, detail: signedOutDetail(conversation), quiet })
    }
    return
  }
  // A Fin's turn ends into its report, which its Apex hears and tells the
  // person of; only what waits on the person (above) is theirs to hear here.
  if (conversation.parent) return
  // A drop Mako is about to continue itself is not an outcome yet: the thread
  // is running again in seconds, and a banner for it would be noise. If the
  // continuation drops too, that second failure announces itself.
  if (session.status === "failed" && previousStatus !== "failed" && !autoContinuePending(conversation.requests))
    noteOutcome({
      kind: "failed",
      subject,
      marker: `failed:${conversation.revision ?? conversation.updatedAt}`,
      detail: failureDetail(conversation) ?? session.error,
      quiet,
    })
  if (
    previousStatus === "running" &&
    session.status === "ready" &&
    queued.length === 0 &&
    !/(?:cancel|interrupt|abort)/i.test(session.lastStop ?? "")
  )
    noteOutcome({
      kind: "finished",
      subject,
      marker: `turn:${conversation.revision ?? conversation.updatedAt}`,
      detail: lastReplyText(conversation.blocks),
      quiet,
    })
}

/**
 * Another device's Session as the account lists it here, unopened: what its
 * change says is read by the host with the account's own rule and key
 * (`LiveSummary.attention`, `attentionFact`), so this Mac tells the person
 * what their phone would, under the same words. An ask answered anywhere, or
 * the Session back at work, retires what it said.
 */
export function noteListedOutcome(
  previous: LiveAcpConversation,
  conversation: LiveAcpConversation,
  attention: LiveSummary["attention"]
): void {
  const ids = liveSubjectIds(conversation.key, conversation.threadPath)
  // What it asked, answered or asked otherwise since, goes by its notice alone.
  const asked = listedAsks.get(conversation.key)
  if (asked && conversation.waitingOn !== previous.waitingOn) {
    listedAsks.delete(conversation.key)
    retireNotice(asked)
  }
  if (conversation.session.status === "running" && !conversation.waitingOn && previous.session.status !== "running")
    for (const id of ids) retireSubject(id)
  if (!attention) return
  const subject = liveSubject(conversation)
  noteOutcome({
    kind: attention.kind,
    subject,
    marker: attention.key,
    detail: asks(attention.kind) ? conversation.waitingOn : undefined,
  })
  if (asks(attention.kind)) listedAsks.set(conversation.key, noticeId(subject, attention.kind, attention.key))
}

/**
 * Each Apex Thread's Fins' asks said to the person so far, by Fin and ask, with the notice each was said as: kept by the
 * Thread, so each is taken back by its own state whichever of its Sessions said it, held here or not.
 */
const announcedFinAsks = new Map<string, Map<string, string>>()

/** The Thread a conversation's Fins are said for: its Thread, else the conversation alone. */
const asksKey = (conversation: Pick<LiveAcpConversation, "key" | "threadId">) => conversation.threadId ?? conversation.key

/** The asks of a conversation's Thread's Fins that are the person's, as they stand (`conversationRoster`), by id. */
function openFinAsks(conversation: LiveAcpConversation) {
  const asks = personAsks(rosterChildren(conversationRoster(acpStore.get(), conversation)))
  return new Map(asks.map((ask) => [`${ask.fin}:${ask.ask.id}`, ask]))
}

/**
 * What an Apex's Fins ask the person, each said once for its Thread, the Fin's name before its line, and each taken back
 * by its own notice once its Fins no longer ask it, on this device or another: whichever of the Thread's Sessions said
 * it and wherever the answer is heard, a batch or a snapshot read in recovery (a gap, a Session this window didn't hold).
 * Its Thread's Fins as they stand (`conversationRoster`), since only its newest Session hears them move (`finReaders`).
 * An ask still open that a snapshot shows unsaid (it came while this window held none of the Thread) is said quietly.
 */
export function noteFinAsks(conversation: LiveAcpConversation, quiet = false): void {
  const key = asksKey(conversation)
  const said = announcedFinAsks.get(key) ?? new Map<string, string>()
  const open = openFinAsks(conversation)
  for (const [id, notice] of said) {
    if (open.has(id)) continue
    said.delete(id)
    retireNotice(notice)
  }
  const subject = liveSubject(conversation)
  for (const [id, ask] of open) {
    if (said.has(id)) continue
    const words = finAskWaiting(ask.ask, ask.title, askWords(ask))
    const marker = `fin:${id}`
    noteOutcome({ kind: words.for, subject, marker, detail: words.line, quiet })
    said.set(id, noticeId(subject, words.for, marker))
  }
  if (said.size) announcedFinAsks.set(key, said)
  else announcedFinAsks.delete(key)
}

export function syncThreadStatus(
  conversation: LiveAcpConversation,
  previousStatus: LiveSessionState["status"],
  previousPath?: string,
  origin: "event" | "hydrate" = "event"
): void {
  const { session, threadPath, queued } = conversation
  const pause = signInPause(conversation.requests ?? [])
  const resuming = session.status !== "closed" && signInResuming(pause, conversation.requests ?? [])
  noteLiveOutcome(conversation, previousStatus, origin === "hydrate")
  if (previousPath && previousPath !== threadPath) {
    setThreadRunning(previousPath, false)
    setThreadAttention(previousPath, null)
  }
  if (!threadPath) return
  setThreadRunning(
    threadPath,
    session.status === "running" ||
      session.status === "starting" ||
      autoContinuePending(conversation.requests) || resuming
  )
  if (session.status === "closed") {
    setThreadAttention(threadPath, null)
    return
  }
  if (conversation.permission) {
    setThreadAttention(threadPath, {
      kind: "needs-permission",
      since: Date.now(),
      detail: conversation.permission.title,
    })
    return
  }
  if (session.status === "running" || autoContinuePending(conversation.requests) || pause?.hold.ready) {
    setThreadAttention(threadPath, null)
    return
  }
  if (pause) {
    setThreadAttention(threadPath, { kind: "needs-permission", since: pause.hold.at, detail: signedOutDetail(conversation) })
    return
  }
  // A failure is recorded once, when it happens or when a failed session
  // first gets a thread to wear it on, and not for the conversation on
  // screen: you watched it. A later batch on a session that stays failed (a
  // title, a control change) must not re-arm a mark you have opened and
  // cleared, and `threadStatus` no longer reads the mark from the session's
  // own status, so this record is the whole of what the rail shows.
  if (session.status === "failed") {
    if (previousStatus !== "failed" || previousPath !== threadPath)
      setThreadAttention(
        threadPath,
        activeIs(session.id)
          ? null
          : { kind: "failed", at: Date.now(), detail: session.error }
      )
    return
  }
  // Ready with no permission pending means an earlier ask was answered and a
  // failure recovered from, so those marks stand down. An unread answer does
  // not: only opening the thread or the next turn clears it. This once
  // cleared everything on every ready batch, and a finished session keeps
  // sending them — a mode the agent reports, a setting acknowledged, a
  // request settling — so the mark was painted by one batch and wiped by
  // the next, and a row finished behind your back showed only its time.
  const current = threadsStore.get().attention[threadPath]
  if (current && current.kind !== "review") setThreadAttention(threadPath, null)
  if (
    previousStatus === "running" &&
    session.status === "ready" &&
    queued.length === 0
  ) {
    setThreadAttention(
      threadPath,
      activeIs(session.id)
        ? null
        : { kind: "review", at: Date.now(), unread: true }
    )
  }
}
