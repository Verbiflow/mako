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
  notificationsStore,
  retireNotice,
  retireSubject,
  subjectId,
  subjectWorkspace,
  type NotificationSubject,
} from "@/state/notifications"
import type { NotificationKind } from "@/lib/notification-text"
import { setThreadAttention, setThreadRunning, threadsStore } from "@/state/threads"
import { describeProviderFailure } from "@mako/host/contracts/provider-failure"
import { autoContinuePending } from "@/state/prompt-delivery"
import { signInPause } from "@mako/host/contracts/sign-in-hold"
import { asks, requestWaiting, type Waiting } from "@mako/host/contracts/notifications"
import { bareCommand } from "@mako/sessions/tool-identity"
import { askWords, finAskWaiting, rosterChildren } from "@mako/host/contracts/children"
import { personAsks, type PersonAsk } from "@/state/fin-asks"

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

/** The permission each conversation was last asked about, to retire it once answered. */
const askedPermissions = new Map<string, string>()
/** The sign-out each conversation was last announced for, by when it began. */
const announcedSignIns = new Map<string, number>()

/** A session paused on a sign-out waits on the person, like a question; it hasn't failed. */
function signedOutDetail(conversation: LiveAcpConversation): string {
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
  const asked = askedPermissions.get(conversation.key)
  if (permission) {
    // A Fin's ask is said on its Apex once it's the person's (`noteFinAsks`): one its Apex answers is never theirs.
    if (asked !== permission.id && !conversation.parent) {
      askedPermissions.set(conversation.key, permission.id)
      const waiting = permissionWaiting(permission)
      noteOutcome({
        kind: waiting.for,
        subject,
        marker: permission.id,
        detail: waiting.line,
        quiet,
      })
    }
    return
  }
  if (asked !== undefined) {
    askedPermissions.delete(conversation.key)
    // Its own approval's notice alone: a Fin's ask said on the same subject is its own to take back (`noteFinAsks`).
    const subjects = new Set(liveSubjectIds(conversation.key, conversation.threadPath))
    for (const item of notificationsStore.get().items)
      if (!item.seen && subjects.has(item.subject.id) && item.id.endsWith(`:${asked}`)) retireNotice(item.id)
  }
  if (session.status === "closed") {
    for (const id of liveSubjectIds(conversation.key, conversation.threadPath)) retireSubject(id)
    return
  }
  const pause = signInPause(conversation.requests ?? [])
  if (pause) {
    if (announcedSignIns.get(conversation.key) !== pause.hold.at) {
      announcedSignIns.set(conversation.key, pause.hold.at)
      noteOutcome({ kind: "needs-you", subject, marker: `sign-in:${pause.hold.at}`, detail: signedOutDetail(conversation), quiet })
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
  if (previous.waitingOn && conversation.waitingOn !== previous.waitingOn)
    for (const id of ids) retireSubject(id, "asks")
  if (conversation.session.status === "running" && !conversation.waitingOn && previous.session.status !== "running")
    for (const id of ids) retireSubject(id)
  if (!attention) return
  noteOutcome({
    kind: attention.kind,
    subject: liveSubject(conversation),
    marker: attention.key,
    detail: asks(attention.kind) ? conversation.waitingOn : undefined,
  })
}

/**
 * An ask said to the person: where (its subject and kind, which with its id name its notification), and the asks its
 * notification was shown over. The attention centre shows one unseen ask a subject and kind (`noteOutcome`), so a newer
 * ask covers an older one's notification while both are open.
 */
type SaidAsk = { subject: NotificationSubject; kind: NotificationKind; over: string[] }

/**
 * Each Apex Thread's Fins' asks said to the person so far, by Fin and ask: kept by the Thread, so each is taken back by
 * its own state whichever of its Sessions said it, held here or not.
 */
const announcedFinAsks = new Map<string, Map<string, SaidAsk>>()

/** The Thread a conversation's Fins are said for: its Thread, else the conversation alone. */
const asksKey = (conversation: Pick<LiveAcpConversation, "key" | "threadId">) => conversation.threadId ?? conversation.key

/** The notification an ask was said as. */
const noticeOf = (id: string, said: SaidAsk) => `${said.subject.id}:${said.kind}:fin:${id}`

/** The asks of a conversation's Thread's Fins that are the person's, as they stand (`conversationRoster`), by id. */
function openFinAsks(conversation: LiveAcpConversation) {
  const asks = personAsks(rosterChildren(conversationRoster(acpStore.get(), conversation)))
  return new Map(asks.map((ask) => [`${ask.fin}:${ask.ask.id}`, ask]))
}

/** Says one ask, over whatever ask of its Thread shows on its subject now, which it then covers. */
function sayFinAsk(said: Map<string, SaidAsk>, id: string, ask: PersonAsk, subject: NotificationSubject, quiet: boolean): void {
  const words = finAskWaiting(ask.ask, ask.title, askWords(ask))
  const shown = new Set(notificationsStore.get().items.filter((item) => !item.seen && item.subject.id === subject.id && item.kind === words.for).map((item) => item.id))
  const over = [...said].flatMap(([other, at]) => (shown.has(noticeOf(other, at)) ? [other, ...at.over] : []))
  for (const other of over) said.get(other)?.over.splice(0)
  noteOutcome({ kind: words.for, subject, marker: `fin:${id}`, detail: words.line, quiet })
  said.set(id, { subject, kind: words.for, over })
}

/**
 * Takes back each ask said for the conversation's Thread that its Fins no longer have open, by the ask's own state as
 * the Thread's Fins stand now, its own notification alone, whichever Session said it and wherever it heard the answer:
 * a batch (`noteFinAsks`) or a snapshot read in recovery, a gap or a Session this window didn't hold
 * (`applyLiveSnapshot`). An ask still open that one answered was shown over comes back, quietly, as the newest of them,
 * or passes to whatever shows there now. Nothing else is said: a snapshot's quiet history isn't announced again.
 */
export function retireAnsweredFinAsks(conversation: LiveAcpConversation): void {
  const said = announcedFinAsks.get(asksKey(conversation))
  if (!said) return
  const open = openFinAsks(conversation)
  for (const [id, at] of [...said]) {
    if (open.has(id) || !said.has(id)) continue
    said.delete(id)
    retireNotice(noticeOf(id, at))
    const waiting = at.over.filter((other) => open.has(other) && said.has(other))
    if (!waiting.length) continue
    // Whatever ask of the Thread shows on its subject now covers them; with none, the newest comes back over the rest.
    const shown = notificationsStore.get().items.find((item) => !item.seen && item.subject.id === at.subject.id && item.kind === at.kind)
    const holder = shown && [...said].find(([other, each]) => noticeOf(other, each) === shown.id)
    if (holder) {
      holder[1].over.push(...waiting)
      continue
    }
    const newest = waiting.at(-1)!
    said.delete(newest)
    sayFinAsk(said, newest, open.get(newest)!, at.subject, true)
    said.get(newest)!.over.push(...waiting.slice(0, -1))
  }
  if (!said.size) announcedFinAsks.delete(asksKey(conversation))
}

/**
 * What an Apex's Fins ask the person, said on the Apex as its own ask would
 * be: once per ask for its Thread, the Fin's name before its line, and taken
 * back from the attention centre once each is answered, on this device or
 * another (`retireAnsweredFinAsks`). Its Thread's Fins as they stand
 * (`conversationRoster`): only its newest Session hears an ask answered
 * (`finReaders`), so one an older Session said is taken back all the same.
 */
export function noteFinAsks(conversation: LiveAcpConversation, quiet = false): void {
  retireAnsweredFinAsks(conversation)
  const key = asksKey(conversation)
  const said = announcedFinAsks.get(key) ?? new Map<string, SaidAsk>()
  for (const [id, ask] of openFinAsks(conversation)) if (!said.has(id)) sayFinAsk(said, id, ask, liveSubject(conversation), quiet)
  if (said.size) announcedFinAsks.set(key, said)
}

export function syncThreadStatus(
  conversation: LiveAcpConversation,
  previousStatus: LiveSessionState["status"],
  previousPath?: string,
  origin: "event" | "hydrate" = "event"
): void {
  const { session, threadPath, queued } = conversation
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
      autoContinuePending(conversation.requests)
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
  if (session.status === "running" || autoContinuePending(conversation.requests)) {
    setThreadAttention(threadPath, null)
    return
  }
  const pause = signInPause(conversation.requests ?? [])
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
