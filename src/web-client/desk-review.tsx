import { useEffect, useMemo, useRef, useState } from "react"
import { XIcon } from "lucide-react"
import type { GitFile } from "@mako/host/contracts/git-workspace-search"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import { countedChanges, turnFilesIn } from "@mako/host/contracts/turn-changes"
import { CommentTargetContext, type CommentTarget } from "@/components/inspector/comment-target"
import { ReviewBar } from "@/components/inspector/review"
import { ScopePicker, TurnReview, type TurnReads } from "@/components/inspector/review-stream"
import { IconAction } from "@/components/ui/kit"
import { recordRoots } from "@/lib/turn-changes"
import { acp, useAcp } from "@/state/acp"
import { turnWords } from "@/state/prompt-delivery"
import type { TurnScope } from "@/state/review-scope"
import { hunksReader, type HunksKey } from "./review-data"
import { changedRequests, hunksDiff, hunksWriters } from "./review-model"
import { openReview, type ReviewOpen } from "./review-open"

/*
 * Changes in a laptop's browser: the desktop's own review of a turn
 * (`TurnReview`: its scope menu of turns, its counts, Only this thread's
 * lines, Undo this turn with its preview, every file in one scroll with
 * picked lines and gutter comments going into the composer), read from the
 * Session's own computer through the account in the bounded stretches a
 * phone reads, kept on this device. Keyboard first, as the desk is: J and K
 * between files, Shift-click for a range of lines, Escape back to the
 * conversation.
 */

const NO_REQUESTS: readonly LiveRequest[] = []

/** The files of a turn in one repository: from its record at once, or for a turn from before the record, asked of its owner. */
function useTurnFiles(conversation: string, request: LiveRequest | undefined, cwd: string | undefined): { root: string; files: readonly GitFile[] } | null | undefined {
  const record = countedChanges(request?.changes)
  const listed = useMemo(() => {
    if (!record) return undefined
    // The repository the Session works in, where the record names one there; its first otherwise.
    const hint = recordRoots(request?.changes).find((root) => cwd === root || cwd?.startsWith(`${root}/`))
    return turnFilesIn(record, hint)
  }, [record, request?.changes, cwd])
  const [read, setRead] = useState<{ id: string; files: { root: string; files: readonly GitFile[] } | null }>()
  const requestId = request?.id
  useEffect(() => {
    if (record || !requestId) return
    let current = true
    void acp.turnChanges(conversation, requestId).then(
      (turn) => current && setRead({ id: requestId, files: turn }),
      () => current && setRead({ id: requestId, files: null })
    )
    return () => {
      current = false
    }
  }, [conversation, requestId, record])
  if (listed) return listed
  return read && read.id === requestId ? read.files : undefined
}

export function DeskReview({ open, onClose }: { open: ReviewOpen; onClose: () => void }) {
  const { conversation } = open
  const requests = useAcp((state) => {
    const live = state.conversations[conversation]
    return live?.kind === "live" ? (live.requests ?? NO_REQUESTS) : NO_REQUESTS
  })
  const cwd = useAcp((state) => {
    const live = state.conversations[conversation]
    return live?.kind === "live" ? live.session.cwd : undefined
  })
  const changed = useMemo(() => changedRequests(requests), [requests])
  // The turn asked for; Changes from the Thread's menu, or a turn with nothing to review, opens on the newest that has some.
  const asked = open.scope.kind === "turn" ? open.scope.requestId : undefined
  const request = changed.find((each) => each.id === asked) ?? changed.at(-1)
  const turn = useTurnFiles(conversation, request, cwd)
  const scope = useMemo((): TurnScope | undefined => (request ? { kind: "turn", conversation, requestId: request.id, prompt: turnWords(requests, request) } : undefined), [conversation, request, requests])
  const record = countedChanges(request?.changes)
  const reads = useMemo(() => (scope ? turnReads(scope, record?.journal ?? "", record?.through ?? 0, record ? record.state === "settled" : true) : undefined), [scope, record])
  const target = useMemo((): CommentTarget => ({ conversation, cwd }), [conversation, cwd])
  const pane = useRef<HTMLElement>(null)

  // Open, the stream has the keys: J and K walk its files at once.
  const ready = Boolean(turn)
  useEffect(() => {
    if (!ready) return
    const frame = requestAnimationFrame(() => pane.current?.querySelector<HTMLElement>("[data-review-stream]")?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [ready, scope?.requestId])

  // Escape is back to the conversation, from anywhere in the review (or nowhere, once a field it held has gone), unless
  // a field, a menu or a dialog of the review's own takes it first.
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target instanceof Element ? event.target : null
      if (target && target !== document.body && !pane.current?.contains(target)) return
      if (target?.closest("input, textarea, select, [contenteditable=true], [role=menu], [role=dialog], [role=listbox]")) return
      event.preventDefault()
      close.current()
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("main textarea:not([readonly]):not([disabled])")?.focus())
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const picker = scope && turn ? <ScopePicker scope={scope} workspace={turn.root} turnsOnly onChoose={(next) => next.kind === "turn" && openReview({ conversation, scope: { kind: "turn", requestId: next.requestId } })} /> : null
  return (
    <section ref={pane} aria-label="Changes" data-desk-review={conversation} tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface outline-none">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline pr-2 pl-3">
        <h2 className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">Changes</h2>
        <IconAction label="Close changes" keys={["Esc"]} onClick={onClose}>
          <XIcon />
        </IconAction>
      </div>
      <CommentTargetContext.Provider value={target}>
        {!request ? (
          <p role="status" className="p-3 text-label text-faint">
            No turn of this Session changed a file yet.
          </p>
        ) : turn === undefined ? (
          <p role="status" className="p-3 text-label text-faint">
            Reading…
          </p>
        ) : turn === null || !scope || !reads ? (
          <p role="status" className="p-3 text-label text-faint">
            That turn's changes couldn't be read.
          </p>
        ) : (
          <>
            <TurnReview key={scope.requestId} scope={scope} files={turn.files} workspace={turn.root} reads={reads} picker={picker} />
            <ReviewBar workspace={turn.root} />
          </>
        )}
      </CommentTargetContext.Provider>
    </section>
  )
}

/**
 * A turn's diffs as the desk's review reads them, from the bounded read a phone makes (`mako:live-turn-hunks`, kept by
 * record in memory and on this device): one read answers a file's diff and its writers. Only this thread's lines is
 * asked of the owner as the desk asks it, both versions whole.
 */
function turnReads(scope: TurnScope, journal: string, through: number, settled: boolean): TurnReads {
  const key = (path: string): HunksKey => ({ conversation: scope.conversation, requestId: scope.requestId, path, journal, through, settled })
  return {
    diff: async (path, only) => (only ? acp.turnDiff(scope.conversation, scope.requestId, path, { only }) : hunksDiff(await hunksReader.read(key(path)))),
    writers: async (path) => hunksWriters(await hunksReader.read(key(path))),
  }
}
