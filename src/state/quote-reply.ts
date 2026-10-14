import type { QuoteDetail } from "@/lib/context-detail"
import { threadReferenceId } from "@/lib/mentions"
import { activeAcp, type AcpState } from "@/state/acp-state"
import type { ThreadRef } from "@/lib/types"

/** What the resolution reads of the threads store: the thread on screen and the catalogue. */
export interface QuoteThreads {
  viewing: { ref: ThreadRef } | null
  threads: readonly ThreadRef[]
}

/** Which conversation a transcript shows: a live one by its key, or a stored one by its file. */
export interface QuoteSource {
  liveId?: string
  threadPath?: string
}

/** The conversation the composer's next send continues, routed the way `composer.tsx` routes it. */
function composerTarget(acp: AcpState, threads: Pick<QuoteThreads, "viewing">): { key?: string; path?: string } | null {
  const active = activeAcp(acp)
  const viewing = threads.viewing?.ref
  const viewingOwnsComposer = Boolean(viewing && viewing.path !== active?.threadPath)
  if (viewing && (active?.kind !== "live" || viewingOwnsComposer)) return { path: viewing.path }
  return active ? { key: active.key, path: active.threadPath } : null
}

/**
 * The conversation a quoted reply belongs to, when the composer will send
 * somewhere else: a stored thread read beside the live one, or a pane's
 * transcript while another conversation owns the composer. Null when the
 * quote is from the conversation the reply goes to, or when the transcript
 * names no conversation a reference could resolve (the built-in session, a
 * live start that has no native id yet).
 */
export function quoteConversation(
  source: QuoteSource,
  acp: AcpState,
  threads: QuoteThreads
): QuoteDetail["conversation"] | undefined {
  const live = source.liveId ? acp.conversations[source.liveId] : undefined
  const path = source.threadPath ?? live?.threadPath
  if (!live && !path) return undefined
  const target = composerTarget(acp, threads)
  const same = Boolean(
    target &&
      ((source.liveId !== undefined && target.key === source.liveId) || (path !== undefined && target.path === path))
  )
  if (same) return undefined
  const ref = path
    ? (threads.threads.find((entry) => entry.path === path) ??
      (threads.viewing?.ref.path === path ? threads.viewing.ref : undefined))
    : undefined
  if (ref) return named(ref.harness, threadReferenceId(ref), ref.title ?? live?.title)
  const nativeId = live?.kind === "live" ? live.session.nativeId : undefined
  if (!live || !nativeId) return undefined
  return named(live.harness, nativeId, live.title ?? (live.kind === "live" ? live.session.title : undefined))
}

function named(harness: string, id: string, title: string | undefined): NonNullable<QuoteDetail["conversation"]> {
  const conversation: NonNullable<QuoteDetail["conversation"]> = { harness, id }
  if (title) conversation.title = title
  return conversation
}
