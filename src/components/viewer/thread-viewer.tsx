import { NativeRequestNotice } from "./native-request-notice"
import { useEffect, useMemo, useState } from "react"
import { ConversationTimeline } from "@/components/transcript/conversation-timeline"
import { harnessLabel } from "@/components/rail/harness-meta"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Action, IconAction } from "@/components/ui/kit"
import {
  sameThreadStatus,
  setComposerHarness,
  threadStatus,
  threads,
  useThreads,
  type ThreadStatus,
} from "@/state/threads"
import { LEAD_EXCHANGE_ID, type Exchange as ExchangeData } from "@/lib/exchanges"
import type { ThreadRef } from "@/lib/types"
import type { ViewedThread } from "@/state/thread-state"
import { pendingThreadInput, threadToMessages } from "@/lib/foreign-thread"
import {
  ArrowRightLeftIcon,
  CheckIcon,
  Loader2Icon,
  RadioIcon,
  ShieldQuestionIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"

function sameOptionalStatus(left: ThreadStatus | null, right: ThreadStatus | null): boolean {
  return left === right || (left !== null && right !== null && sameThreadStatus(left, right))
}

/**
 * A conversation from another harness, opened as a conversation.
 *
 * This takes the transcript's place in the chat column — not a modal, not a
 * popup — and renders through the same prompt cards, markdown prose, and
 * tool rows every native conversation uses, because a conversation is a
 * conversation and only the mark in the corner should say where it
 * happened. The one composer below routes to this session's own harness
 * while it is open; the header holds ownership and agent controls. X or Escape
 * gives the native chat back.
 */

interface ExchangeCache {
  path: string | null
  revision: number
  count: number
  exchanges: ExchangeData[]
  entryToExchange: number[]
}

function emptyExchangeCache(
  path: string | null = null,
  revision = 0
): ExchangeCache {
  return {
    path,
    revision,
    count: 0,
    exchanges: [],
    entryToExchange: [],
  }
}

/**
 * One conversation's incremental exchange builder.
 *
 * The closure is owned by a single Conversation instance. Repeated calls with
 * the same input are idempotent, while an append converts only the new suffix
 * and a streamed replacement rebuilds only the exchange containing the edit.
 */
function createExchangeBuilder() {
  let built = emptyExchangeCache()

  return (thread: ViewedThread | null): ExchangeData[] => {
    if (!thread) {
      built = emptyExchangeCache()
      return built.exchanges
    }

    const { entries } = thread
    const revision = thread.streamRevision ?? 0
    if (built.path !== thread.ref.path || entries.length < built.count) {
      built = emptyExchangeCache(thread.ref.path, revision)
    } else if (built.revision !== revision) {
      const replaceFrom = thread.streamReplaceFrom ?? 0
      const exchangeIndex = built.entryToExchange[replaceFrom] ?? 0
      let entryStart = replaceFrom
      while (
        entryStart > 0 &&
        built.entryToExchange[entryStart - 1] === exchangeIndex
      ) {
        entryStart -= 1
      }
      built = {
        path: thread.ref.path,
        revision,
        count: entryStart,
        exchanges: built.exchanges.slice(0, exchangeIndex),
        entryToExchange: built.entryToExchange.slice(0, entryStart),
      }
    }

    if (entries.length === built.count) return built.exchanges

    let next = built.exchanges
    const entryToExchange = [...built.entryToExchange]
    for (
      let entryIndex = built.count;
      entryIndex < entries.length;
      entryIndex += 1
    ) {
      const fresh = threadToMessages(
        [entries[entryIndex]!],
        thread.pageStart + entryIndex,
        thread.ref.harness
      )
      for (const message of fresh) {
        if (message.role === "user") {
          next = [
            ...next,
            {
              id: message.id,
              prompt: message,
              response: [],
              system: [],
              timestamp: message.timestamp,
            },
          ]
          continue
        }

        const last = next.at(-1)
        if (!last) {
          next = [
            message.role === "system"
              ? {
                  id: LEAD_EXCHANGE_ID,
                  response: [],
                  system: [message],
                  timestamp: message.timestamp,
                }
              : {
                  id: LEAD_EXCHANGE_ID,
                  response: [message],
                  system: [],
                  timestamp: message.timestamp,
                },
          ]
          continue
        }

        const grown =
          message.role === "system"
            ? { ...last, system: [...last.system, message] }
            : { ...last, response: [...last.response, message] }
        next = [...next.slice(0, -1), grown]
      }
      entryToExchange[entryIndex] = Math.max(0, next.length - 1)
    }

    built = {
      path: thread.ref.path,
      revision,
      count: entries.length,
      exchanges: next,
      entryToExchange,
    }
    return next
  }
}

export function ThreadViewer() {
  const thread = useThreads((state) => state.viewing)
  const opening = useThreads((state) => state.opening)
  const busy = opening?.kind === "loading"

  useEffect(() => {
    if (!thread && !busy) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key === "Escape") {
        event.preventDefault()
        threads.closeViewer()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [busy, thread])

  if (opening && (!thread || opening.kind === "failed"))
    return (
      <ThreadLoadingShell
        opening={opening.ref}
        error={opening.kind === "failed" ? opening.error : undefined}
      />
    )
  if (!thread) return null

  return (
    <div
      aria-busy={busy || undefined}
      className="animate-enter flex min-h-0 flex-1 flex-col bg-surface"
    >
      <SessionBar />
      <NativeRequestNotice path={thread.ref.path} />
      <Conversation key={thread.ref.path} />
    </div>
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
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-3.5">
        {opening ? (
          <HarnessIcon harness={opening.harness} className="size-3.5" />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui font-medium text-foreground/90">
            {opening?.title ?? "Conversation"}
          </p>
          <p role="status" className="text-label text-faint">
            {error ? "Could not load this conversation" : "Loading messages…"}
          </p>
        </div>
        <IconAction
          label="Close session"
          side="bottom"
          size="xs"
          onClick={() => threads.closeViewer()}
        >
          <XIcon />
        </IconAction>
      </div>
      {error ? (
        <div role="alert" className="p-6 text-ui text-faint">
          <p>{error}</p>
          <Action
            tone="outline"
            size="md"
            className="mt-3"
            onClick={() => void threads.view(opening)}
          >
            Retry loading
          </Action>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="mx-auto flex h-full w-full max-w-content flex-col justify-end gap-8 px-6 py-8">
            <div className="ml-auto flex w-2/3 flex-col items-end gap-2">
              <span className="skeleton h-3 w-3/4 rounded" />
              <span className="skeleton h-3 w-1/2 rounded" />
            </div>
            <div className="flex w-5/6 flex-col gap-2">
              <span className="skeleton h-3 w-full rounded" />
              <span className="skeleton h-3 w-11/12 rounded" />
              <span className="skeleton h-3 w-2/3 rounded" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SessionBar() {
  const thread = useThreads((state) => state.viewing)
  const syncing = useThreads((state) => state.opening?.kind === "loading")
  const sessionStatus = useThreads(
    (state) => (thread ? threadStatus(thread.ref, state) : null),
    sameOptionalStatus
  )
  if (!thread || !sessionStatus) return null
  const openElsewhere =
    sessionStatus.kind === "external-open" ||
    sessionStatus.kind === "external-active"
  const waitingForInput = pendingThreadInput(thread.entries) !== null
  const provider = harnessLabel(thread.ref.harness)
  const status = waitingForInput
    ? `Waiting for input in ${provider}`
    : statusLabel(
        sessionStatus,
        thread.ref.archived === true,
        // Open elsewhere names where: the provider's own app, or the other
        // Mako host that has the session live.
        sessionStatus.kind === "external-open" ? harnessLabel(sessionStatus.app) : provider,
        thread.ref.resumeUnavailable
      )
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-3.5">
      <HarnessIcon harness={thread.ref.harness} className="size-3.5" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui font-medium text-foreground/90">
          {thread.ref.title ?? "Untitled session"}
        </p>
        <p className="flex items-center gap-1 truncate text-label text-faint">
          <SessionStatusIcon status={sessionStatus} waiting={waitingForInput} />
          {status}
        </p>
      </div>
      {syncing ? (
        <span role="status" className="shrink-0 text-label text-faint">
          Syncing messages…
        </span>
      ) : null}
      <Action
        size="xs"
        aria-label={`Continue with ${harnessLabel(thread.ref.harness)}`}
        title={
          thread.ref.resumeUnavailable ??
          (openElsewhere
            ? `Starts a new ${harnessLabel(thread.ref.harness)} session here; the session open elsewhere stays unchanged`
            : `Resume with ${harnessLabel(thread.ref.harness)}`)
        }
        onClick={() => {
          setComposerHarness(thread.ref.harness)
          window.dispatchEvent(new CustomEvent("mako:focus-composer"))
        }}
      >
        Continue here
      </Action>
      <Action
        size="xs"
        aria-label="Change the agent for the next message"
        title="Continue in a new session; this one stays unchanged"
        onClick={() => window.dispatchEvent(new CustomEvent("mako:pick-agent"))}
      >
        <ArrowRightLeftIcon />
        Change agent…
      </Action>
      <IconAction
        label="Close session"
        side="bottom"
        size="xs"
        onClick={() => threads.closeViewer()}
      >
        <XIcon />
      </IconAction>
    </div>
  )
}

function statusLabel(
  status: ThreadStatus,
  archived: boolean,
  provider: string,
  resumeUnavailable?: string
): string {
  switch (status.kind) {
    case "working":
      return status.detail ?? "Working"
    case "needs-permission":
      return status.detail ? `Needs input · ${status.detail}` : "Needs input"
    case "failed":
      return status.detail ? `Failed · ${status.detail}` : "Failed"
    case "review":
      return status.unread ? "Finished · ready for review" : "Ready for review"
    case "observed":
      return "Live activity"
    case "external-open":
      return `Open in ${provider}`
    case "external-active":
      return `Live in ${status.app ?? provider}`
    case "idle":
      return archived
        ? "Archived history"
        : resumeUnavailable
          ? "Read-only native history"
          : "Ready to resume"
  }
}

function SessionStatusIcon({
  status,
  waiting,
}: {
  status: ThreadStatus
  waiting?: boolean
}) {
  if (waiting)
    return <ShieldQuestionIcon className="size-3 shrink-0 text-caution" />
  switch (status.kind) {
    case "working":
      return (
        <Loader2Icon className="size-3 shrink-0 animate-spin text-ember/80" />
      )
    case "needs-permission":
      return <ShieldQuestionIcon className="size-3 shrink-0 text-caution" />
    case "failed":
      return <TriangleAlertIcon className="size-3 shrink-0 text-negative" />
    case "review":
      return <CheckIcon className="size-3 shrink-0 text-positive" />
    case "observed":
    case "external-active":
      return <RadioIcon className="size-3 shrink-0" />
    case "external-open":
    case "idle":
      return null
  }
}

/**
 * The transcript, in the app's own rendering.
 *
 * Canonical entries convert to native messages and group into exchanges —
 * the same components, the same markdown, the same tool rows as any
 * conversation here.
 */
function Conversation() {
  const thread = useThreads((state) => state.viewing)
  const run = useThreads((state) => state.run)
  // Another thread's catalog event must not repaint this transcript: the
  // status is compared by its fields, not by the object each call allocates.
  const status = useThreads(
    (state) => (state.viewing ? threadStatus(state.viewing.ref, state) : null),
    sameOptionalStatus
  )
  const [buildExchanges] = useState(() => createExchangeBuilder())
  const exchanges = useMemo(
    () => buildExchanges(thread),
    [buildExchanges, thread]
  )
  if (!thread) return null

  const waitingForInput = pendingThreadInput(thread.entries) !== null
  const live =
    !waitingForInput &&
    (run?.status === "running" ||
      status?.kind === "working" ||
      status?.kind === "observed" ||
      status?.kind === "external-active")
  const lastExchangeId = exchanges.at(-1)?.id
  return (
    <ConversationTimeline
      source={{ threadPath: thread.ref.path }}
      identity={thread.ref.path}
      exchanges={exchanges}
      streamingId={live ? lastExchangeId : undefined}
      interruptedId={run?.status === "stopped" ? lastExchangeId : undefined}
      failedId={
        run?.status === "failed" || status?.kind === "failed"
          ? lastExchangeId
          : undefined
      }
      hasEarlier={thread.hasEarlier}
      loadingEarlier={thread.loadingEarlier}
      onLoadEarlier={() => threads.loadEarlier()}
      empty={
        <p className="pt-12 text-center text-ui text-faint">
          This session has no readable conversation.
        </p>
      }
      footer={
        waitingForInput ? (
          <div className="animate-enter flex items-center gap-2 px-0.5 text-ui text-caution">
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
            <span className="shimmer">
              {status?.kind === "observed"
                ? "Receiving session updates…"
                : `${harnessLabel(thread.ref.harness)} is working…`}
            </span>
          </div>
        ) : null
      }
    />
  )
}
