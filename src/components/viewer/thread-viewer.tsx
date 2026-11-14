import { useHarnessIdentity } from "@/lib/harness-label"
import { NativeRequestNotice } from "./native-request-notice"
import { useConversationScope } from "@/state/conversation-scope"
import { useEffect, useMemo, useState } from "react"
import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import { WorktreeOpening } from "@/components/viewer/worktree-opening"
import { KeptOpening } from "@/components/viewer/kept-opening"
import { keptSessionText } from "@/lib/kept-session"
import { rowThread, useThreadGroups } from "@/state/thread-groups"
import { useStartedWorktree } from "@/state/worktrees"
import { harnessLabel } from "@/components/rail/harness-meta"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Action } from "@/components/ui/kit"
import {
  sameThreadStatus,
  threadStatus,
  threads,
  useThreads,
} from "@/state/threads"
import type { ThreadRef } from "@/lib/types"
import type { ViewedThread } from "@/state/thread-state"
import { pendingThreadInput } from "@/lib/entry-messages"
import { createExchangeBuilder } from "./exchange-builder"
import { ShieldQuestionIcon } from "lucide-react"
import { Shimmer } from "@/components/ui/shimmer"
import { ConversationSkeleton } from "./conversation-skeleton"
import { CrewCard } from "./crew-card"
import { releasedExchanges } from "@/state/transcript-residency"

/**
 * A conversation from another harness, opened as a conversation.
 *
 * This takes the transcript's place in the chat column — not a modal, not a
 * popup — and renders through the same prompt cards, markdown prose, and
 * tool rows every native conversation uses, because a conversation is a
 * conversation and only the mark in the corner should say where it
 * happened. The one composer below routes to this session's own harness
 * while it is open; Escape gives the native chat back.
 */

/**
 * How long the conversation you left stays on screen while the one you
 * picked is read. Most reads land well inside it and the column goes straight
 * from one transcript to the next; a slow one gives way to the skeleton.
 */
const HOLD_PREVIOUS_MS = 240

/**
 * The transcript to paint: the thread itself once it is known, else the one
 * last shown while the next is still loading, for `HOLD_PREVIOUS_MS`.
 */
function useHeldThread(thread: ViewedThread | null, loading: ThreadRef | null): ViewedThread | null {
  const [last, setLast] = useState(thread)
  const [expired, setExpired] = useState<string | null>(null)
  if (thread && thread !== last) setLast(thread)
  const holding = !thread && loading !== null && last !== null && expired !== loading.path
  const holdingPath = holding ? loading.path : null
  useEffect(() => {
    if (!holdingPath) return
    const timer = setTimeout(() => setExpired(holdingPath), HOLD_PREVIOUS_MS)
    return () => clearTimeout(timer)
  }, [holdingPath])
  return thread ?? (holding ? last : null)
}

export function ThreadViewer() {
  const scope = useScopedHistory()
  const viewing = useThreads((state) => state.viewing)
  const globalOpening = useThreads((state) => state.opening)
  const thread = scope ? scope.thread : viewing
  const opening = scope ? (scope.thread ? null : { kind: "loading" as const, ref: scope.ref }) : globalOpening
  const busy = opening?.kind === "loading"
  const shown = useHeldThread(thread, busy ? opening.ref : null)

  useEffect(() => {
    if (scope || (!thread && !globalOpening)) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key === "Escape") {
        event.preventDefault()
        threads.closeViewer()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [globalOpening, scope, thread])

  // A failed read takes the column only when there is nothing of the conversation to show.
  const unread = opening?.kind === "failed" && thread?.ref.path !== opening.ref.path
  if (opening && (!shown || unread))
    return (
      <ThreadLoadingShell
        opening={opening.ref}
        error={opening.kind === "failed" ? opening.error : undefined}
      />
    )
  if (!shown) return null
  const held = shown !== thread

  return (
    <div
      aria-busy={busy || undefined}
      inert={held || undefined}
      className="flex min-h-0 flex-1 flex-col bg-surface"
    >
      <NativeRequestNotice path={shown.ref.path} />
      {opening?.kind === "failed" && !held ? <RefreshFailedLine opening={opening.ref} error={opening.error} /> : null}
      <Conversation key={shown.ref.path} thread={shown} held={held} />
    </div>
  )
}

/** The history a pane without focus shows, or null in the focused pane. */
function useScopedHistory() {
  const scope = useConversationScope()
  return scope?.kind === "history" ? scope : null
}

/**
 * Saved messages whose fresh read failed stay readable and sendable to; one
 * quiet line says they weren't refreshed, the reason under the pointer.
 */
function RefreshFailedLine({ opening, error }: { opening: ThreadRef; error: string }) {
  return (
    <p role="status" data-refresh-failed className="flex shrink-0 items-center gap-1 px-4 pt-2 text-label text-faint">
      <span title={error}>Couldn't refresh</span>
      <span aria-hidden>·</span>
      <button
        type="button"
        onClick={() => void threads.view(opening)}
        className="pressable text-muted-foreground transition-colors duration-100 hover:text-foreground"
      >
        Retry
      </button>
    </p>
  )
}

function ThreadLoadingShell({
  opening,
  error,
}: {
  opening: ThreadRef
  error?: string
}) {
  return (
    <div aria-busy={!error} className="flex min-h-0 flex-1 flex-col bg-surface">
      {error ? (
        <div role="alert" className="p-6 text-ui text-faint">
          <p className="font-medium text-foreground/90">
            Could not load this conversation
          </p>
          <p className="mt-1">{error}</p>
          <div className="mt-3 flex gap-2">
            <Action
              tone="outline"
              size="md"
              onClick={() => void threads.view(opening)}
            >
              Retry loading
            </Action>
            <Action
              tone="outline"
              size="md"
              onClick={() => threads.closeViewer()}
            >
              Close
            </Action>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <p role="status" className="sr-only">
            Loading the conversation…
          </p>
          <ConversationSkeleton />
        </div>
      )}
    </div>
  )
}

/**
 * The transcript, in the app's own rendering.
 *
 * Canonical entries convert to native messages and group into exchanges —
 * the same components, the same markdown, the same tool rows as any
 * conversation here.
 */
function Conversation({ thread, held }: { thread: ViewedThread; held: boolean }) {
  useHarnessIdentity()
  const scope = useScopedHistory()
  const globalRun = useThreads((state) => state.run)
  // The run in the store belongs to the thread being opened, not the one held.
  const run = scope || held ? null : globalRun
  const ref = thread.ref
  // Another thread's catalog event must not repaint this transcript: the
  // status is compared by its fields, not by the object each call allocates.
  const status = useThreads(
    (state) => threadStatus(ref, state),
    sameThreadStatus
  )
  const [buildExchanges] = useState(() => createExchangeBuilder())
  const exchanges = useMemo(
    () => releasedExchanges(buildExchanges(thread), thread.releasedTurns),
    [buildExchanges, thread]
  )

  const waitingForInput = pendingThreadInput(thread.entries) !== null
  const live =
    !waitingForInput &&
    (run?.status === "running" ||
      status?.kind === "working" ||
      status?.kind === "observed" ||
      status?.kind === "external-active")
  const lastExchangeId = exchanges.at(-1)?.id
  const worktree = useStartedWorktree(useThreadGroups((state) => rowThread(ref, state.threadOf)), ref.cwd)
  const kept = keptSessionText(ref)
  return (
    <ConversationTimeline
      source={{ threadPath: thread.ref.path, historyFrom: { blocks: 0, base: thread.pageStart } }}
      opening={worktree?.start ? <WorktreeOpening worktree={worktree} start={worktree.start} /> : kept ? <KeptOpening text={kept} /> : undefined}
      identity={thread.ref.path}
      exchanges={exchanges}
      streamingId={live ? lastExchangeId : undefined}
      interruptedId={run?.status === "stopped" ? lastExchangeId : undefined}
      failedId={
        run?.status === "failed" || status?.kind === "failed"
          ? lastExchangeId
          : undefined
      }
      hasEarlier={!scope && thread.hasEarlier}
      loadingEarlier={Boolean(thread.loadingEarlier)}
      onLoadEarlier={() => threads.loadEarlier()}
      empty={
        <p className="pt-12 text-center text-ui text-faint">
          This session has no readable conversation.
        </p>
      }
      footer={
        <>
        {waitingForInput ? (
          <div className="animate-enter flex items-center gap-2 px-0.5 text-ui text-attention">
            <ShieldQuestionIcon className="size-3.5 shrink-0" />
            <span>
              Waiting for your answer in {harnessLabel(thread.ref.harness)}.
              Reply in the client that owns this session.
            </span>
          </div>
        ) : live ? (
          <div className="animate-enter flex items-center gap-2 px-0.5 text-ui">
            <HarnessIcon
              harness={thread.ref.harness}
              className="animate-live size-3.5"
            />
            <Shimmer
              text={status?.kind === "observed"
                ? "Receiving session updates…"
                : `${harnessLabel(thread.ref.harness)} is working…`}
            />
          </div>
        ) : null}
        {/* An Apex's saved transcript, or one its session is starting from, keeps its Fins on screen. */}
        {thread.ref.threadId ? <CrewCard thread={thread.ref.threadId} /> : null}
        </>
      }
    />
  )
}

