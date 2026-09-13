import type { LivePermissionRequest, LiveSessionState } from "@/lib/types"
import type { AcpBlock } from "@/lib/acp-blocks"
import { harnessLabel } from "@/lib/harness-label"
import { workspaceName } from "@/lib/format"
import {
  acpStore,
  updateAcpConversation,
  type LiveAcpConversation,
} from "@/state/acp-state"
import {
  liveSubjectIds,
  noteOutcome,
  retireSubject,
  subjectId,
  subjectWorkspace,
  type NotificationSubject,
} from "@/state/notifications"
import { setThreadAttention, setThreadRunning, threadsStore } from "@/state/threads"
import { describeProviderFailure } from "../../electron/contracts/provider-failure"
import { autoContinuePending } from "@/state/prompt-delivery"

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
export function lastReplyText(blocks: readonly AcpBlock[]): string {
  const parts: string[] = []
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!
    if (block.type === "user") break
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

function permissionDetail(permission: LivePermissionRequest): string {
  const question = permission.questions?.[0]
  if (question) return [question.header, question.question].filter(Boolean).join(": ")
  return permission.title
}

/** The permission each conversation was last asked about, to retire it once answered. */
const askedPermissions = new Map<string, string>()

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
    if (asked !== permission.id) {
      askedPermissions.set(conversation.key, permission.id)
      noteOutcome({
        kind: "ask",
        subject,
        marker: permission.id,
        detail: permissionDetail(permission),
        quiet,
      })
    }
    return
  }
  if (asked !== undefined) {
    askedPermissions.delete(conversation.key)
    for (const id of liveSubjectIds(conversation.key, conversation.threadPath))
      retireSubject(id, "ask")
  }
  if (session.status === "closed") {
    for (const id of liveSubjectIds(conversation.key, conversation.threadPath)) retireSubject(id)
    return
  }
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
      kind: "ready",
      subject,
      marker: `turn:${conversation.revision ?? conversation.updatedAt}`,
      detail: lastReplyText(conversation.blocks),
      quiet,
    })
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
