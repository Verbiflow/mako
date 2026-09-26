import type { AcpState } from "@/state/acp-state"
import { autoContinuePending } from "@/state/prompt-delivery"

export interface AcpPresence {
  key: string
  harness: string
  nativeId?: string
  cwd: string
  createdAt: number
  title?: string
  nativePaths?: string[]
  threadPath?: string
  status: "starting" | "ready" | "running" | "needs-permission" | "failed"
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
          status: "starting",
        }
        return [presence]
      }
      if (conversation.session.status === "closed") return []
      const presence: AcpPresence = {
        key: conversation.key,
        harness: conversation.harness,
        nativeId: conversation.session.nativeId,
        cwd: conversation.cwd,
        createdAt: conversation.createdAt,
        title: conversation.title,
        threadPath: conversation.threadPath,
        nativePaths: conversation.nativePaths,
        // A dropped connection Mako is about to continue itself is a working
        // row, not a failed one: the send is seconds away.
        status:
          conversation.permission && conversation.session.status !== "failed"
            ? "needs-permission"
            : conversation.session.status === "failed" && autoContinuePending(conversation.requests)
              ? "running"
              : conversation.session.status === "failed" && conversation.failureSeen
                ? "ready"
                : conversation.session.status,
      }
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
        (candidate.nativePaths ?? []).join("\0") ===
          (presence.nativePaths ?? []).join("\0") &&
        candidate.status === presence.status
      )
    })
  )
}

/** Preserve native references while choosing one row for an app-owned conversation. */
export function canonicalThreadRefs<T extends { path: string; harness?: string; nativeId?: string; identity?: string }>(
  refs: T[],
  conversations: AcpPresence[],
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
  }
  return refs.filter((ref) => !hidden.has(ref.path))
}
