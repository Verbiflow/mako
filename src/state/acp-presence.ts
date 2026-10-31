import type { AcpState } from "@/state/acp-state"
import type { ThreadPurposeKind } from "@mako/host/contracts/thread-purposes"
import { autoContinuePending } from "@/state/prompt-delivery"
import { signInPause } from "@mako/host/contracts/sign-in-hold"
import { backgroundWork } from "@mako/host/contracts/background-work"

export interface AcpPresence {
  key: string
  harness: string
  nativeId?: string
  cwd: string
  createdAt: number
  title?: string
  nativePaths?: string[]
  threadPath?: string
  threadId?: string
  sessionId?: string
  /** What Mako is starting this Thread for, before the host has recorded it. */
  purpose?: ThreadPurposeKind
  /** `background`: the turn ended and the provider still runs work it will wake on. */
  status: "starting" | "ready" | "running" | "background" | "needs-permission" | "failed"
  /** What the session waits on while `background`. */
  background?: number
  /** Where it runs when not on this Mac, in words ("Studio", "a cloud machine"). */
  elsewhere?: string
  /** What a conversation on another device waits on there, in a line ("Approve: npm test"). */
  waitingOn?: string
  /** Its Thread's name as the device it runs on has it, when it runs elsewhere. */
  threadTitle?: string
  /** When the device it runs on was last heard from, while the account can't hear it. */
  quietSince?: number
  /** When it last moved, for a conversation listed from another device (`LiveSummary.movedAt`). */
  movedAt?: number
  /** The project folder its owner's rail files it under, for one listed from another device (`ListedRail.project`). */
  workspace?: string
  /** The Thread worktree's branch it works on there. */
  worktreeBranch?: string
  /** The agents it ran in before its current one, oldest first. */
  lineage?: readonly string[]
}

export function selectAcpPresence(state: AcpState): AcpPresence[] {
  return Object.values(state.conversations)
    .flatMap((conversation) => {
      if (conversation.kind === "starting") {
        const presence: AcpPresence = {
          key: conversation.key,
          harness: conversation.harness,
          cwd: conversation.cwd,
          createdAt: conversation.createdAt,
          title: conversation.title,
          threadPath: conversation.threadPath,
          nativePaths: conversation.nativePaths,
          threadId: conversation.threadId,
          sessionId: conversation.sessionId,
          status: "starting",
        }
        if (conversation.purpose) presence.purpose = conversation.purpose
        return [presence]
      }
      if (conversation.session.status === "closed") return []
      // Listed from another device and not opened here: the account's list says what its ended turn waits on.
      const listedBackground = conversation.session.connection === "hibernated" ? conversation.rail?.background : undefined
      const work = backgroundWork(conversation.session, conversation.nativeAgents) ?? (listedBackground ? { count: listedBackground } : null)
      const presence: AcpPresence = {
        key: conversation.key,
        harness: conversation.harness,
        nativeId: conversation.session.nativeId,
        cwd: conversation.cwd,
        createdAt: conversation.createdAt,
        title: conversation.title,
        threadPath: conversation.threadPath,
        nativePaths: conversation.nativePaths,
        threadId: conversation.threadId,
        sessionId: conversation.sessionId,
        // A dropped connection Mako is about to continue itself is a working
        // row, not a failed one: the send is seconds away. Work paused on a
        // sign-out waits on the person, as a question does.
        status:
          (conversation.permission && conversation.session.status !== "failed") ||
          // Waiting on a person on the device it runs on: they're needed here too.
          Boolean(conversation.waitingOn) ||
          (conversation.session.status !== "running" && signInPause(conversation.requests ?? []))
            ? "needs-permission"
            : conversation.session.status === "failed" && autoContinuePending(conversation.requests)
              ? "running"
              : conversation.session.status === "failed" && conversation.failureSeen
                ? "ready"
                : work && conversation.session.status === "ready"
                  ? "background"
                  : conversation.session.status,
      }
      if (presence.status === "background" && work) presence.background = work.count
      if (conversation.elsewhere) presence.elsewhere = conversation.elsewhere
      if (conversation.waitingOn) presence.waitingOn = conversation.waitingOn
      if (conversation.threadTitle) presence.threadTitle = conversation.threadTitle
      if (conversation.quietSince !== undefined) presence.quietSince = conversation.quietSince
      if (conversation.movedAt !== undefined) presence.movedAt = conversation.movedAt
      const rail = conversation.rail
      if (rail?.project) presence.workspace = rail.project.folder
      if (rail?.worktree) presence.worktreeBranch = rail.worktree.branch
      if (rail?.lineage) presence.lineage = rail.lineage
      return [presence]
    })
    .sort((left, right) => right.createdAt - left.createdAt)
}

export function sameAcpPresence(
  left: AcpPresence[],
  right: AcpPresence[]
): boolean {
  return (
    left.length === right.length &&
    left.every((presence, index) => {
      const candidate = right[index]
      return (
        candidate?.key === presence.key &&
        candidate.harness === presence.harness &&
        candidate.nativeId === presence.nativeId &&
        candidate.cwd === presence.cwd &&
        candidate.createdAt === presence.createdAt &&
        candidate.title === presence.title &&
        candidate.threadPath === presence.threadPath &&
        candidate.threadId === presence.threadId &&
        candidate.sessionId === presence.sessionId &&
        candidate.purpose === presence.purpose &&
        (candidate.nativePaths ?? []).join("\0") ===
          (presence.nativePaths ?? []).join("\0") &&
        candidate.status === presence.status &&
        candidate.elsewhere === presence.elsewhere &&
        candidate.waitingOn === presence.waitingOn &&
        candidate.threadTitle === presence.threadTitle &&
        candidate.quietSince === presence.quietSince &&
        candidate.movedAt === presence.movedAt &&
        candidate.workspace === presence.workspace &&
        candidate.worktreeBranch === presence.worktreeBranch &&
        candidate.lineage === presence.lineage &&
        candidate.background === presence.background
      )
    })
  )
}

/** The native sessions a conversation stands for. */
export type SessionOwner = Pick<AcpPresence, "harness" | "nativeId" | "title" | "threadPath" | "nativePaths">

/**
 * Every conversation's native sessions, closed ones included: a conversation
 * that has ended still stands for each session it moved through, so a move
 * across harnesses stays one row after the app restarts.
 */
export function selectSessionOwners(state: AcpState): SessionOwner[] {
  return Object.values(state.conversations).map((conversation) => ({
    harness: conversation.harness,
    nativeId: conversation.kind === "live" ? conversation.session.nativeId : undefined,
    title: conversation.title,
    threadPath: conversation.threadPath,
    nativePaths: conversation.nativePaths,
  }))
}

export function sameSessionOwners(left: SessionOwner[], right: SessionOwner[]): boolean {
  return (
    left.length === right.length &&
    left.every((owner, index) => {
      const candidate = right[index]
      return (
        candidate?.harness === owner.harness &&
        candidate.nativeId === owner.nativeId &&
        candidate.title === owner.title &&
        candidate.threadPath === owner.threadPath &&
        (candidate.nativePaths ?? []).join("\0") === (owner.nativePaths ?? []).join("\0")
      )
    })
  )
}

/** Preserve native references while choosing one row for an app-owned conversation. */
export function canonicalThreadRefs<T extends { path: string; harness?: string; nativeId?: string; identity?: string; title?: string }>(
  refs: T[],
  conversations: SessionOwner[],
  pinned: string[]
): T[] {
  const paths = new Set(refs.map((ref) => ref.path))
  const byIdentity = new Map<string, string[]>()
  const identityOf = new Map<string, string>()
  for (const ref of refs) {
    if (!ref.nativeId || !ref.harness) continue
    const key = JSON.stringify([ref.harness, ref.identity ?? ref.nativeId])
    const aliases = byIdentity.get(key) ?? []
    aliases.push(ref.path)
    byIdentity.set(key, aliases)
    identityOf.set(ref.path, key)
  }
  const hidden = new Set<string>()
  const titles = new Map<string, string>()
  for (const conversation of conversations) {
    // Rows are aliases of a conversation when they share the catalog identity
    // of a row it recorded. Two stores can share a native ID (a Cursor agent
    // and its `chats/` copy) and still be two sessions; the native ID decides
    // only when none of the conversation's paths is catalogued.
    const own = [
      ...(conversation.nativePaths ?? []),
      ...(conversation.threadPath ? [conversation.threadPath] : []),
    ].filter((path) => paths.has(path))
    const identities = own.length
      ? own.flatMap((path) => identityOf.get(path) ?? [])
      : [JSON.stringify([conversation.harness, conversation.nativeId])]
    const aliases = [...new Set([
      ...own,
      ...identities.flatMap((key) => byIdentity.get(key) ?? []),
    ])]
    const representative =
      aliases.find((path) => pinned.includes(path)) ??
      (conversation.threadPath && paths.has(conversation.threadPath)
        ? conversation.threadPath
        : aliases[0])
    for (const path of aliases) if (path !== representative) hidden.add(path)
    // A conversation that moved between sessions keeps its own name: the
    // store each move wrote titles its file from the replayed first prompt.
    if (conversation.title && representative && new Set(own).size > 1)
      titles.set(representative, conversation.title)
  }
  return refs.flatMap((ref) => {
    if (hidden.has(ref.path)) return []
    const title = titles.get(ref.path)
    return [title ? { ...ref, title } : ref]
  })
}
