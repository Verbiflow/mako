import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { ChevronLeftIcon, ChevronRightIcon, MessageSquareIcon, Undo2Icon } from "lucide-react"
import { countedChanges } from "@mako/host/contracts/turn-changes"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import type { TurnUndoScope } from "@mako/host/contracts/turn-review"
import { LineCounts, UnsureCount } from "@/components/inspector/change-marks"
import { getMako } from "@/lib/bridge"
import { anyUnsure, recordedTurnChanges, turnChangeSummary, type TurnChangeSummary } from "@/lib/turn-changes"
import { undoneWords } from "@/lib/turn-undone"
import { cn } from "@/lib/utils"
import { useAcp } from "@/state/acp"
import type { AcpState } from "@/state/acp-state"
import { turnWords } from "@/state/prompt-delivery"
import { useAccountList } from "./account-list"
import { webHarnessLabel } from "./labels"
import { useSyncing } from "./syncing"
import { FileCard, type CommentAsk } from "./review-diff"
import { changedRequests, reviewFiles, fileWords, turnWordsCount, commentWords, type ReviewFile } from "./review-model"
import { openReview, type ReviewOpen, type ReviewScope } from "./review-open"
import { useReviewNotes } from "./review-notes"
import { CommentSheet, FinishSheet, UndoSheet } from "./review-sheets"
import { useSessionDiagnosis } from "./thread-trouble"
import { useThread } from "./use-thread"
import type { WebSession } from "./threads"

/*
 * Changes, on a phone and a tablet: what a turn changed,
 * or every turn of the Thread, read from the record each turn keeps
 * (`LiveRequest.changes`), so its counts are the turn line's own. A turn's
 * files are cards, each with its diff in stretches read from the Session's
 * owner through the gateway; a line tapped (or a range, held then tapped)
 * takes a comment into the Session's next message; "Finish review" sends
 * them. The turn can be undone from here, as on a Mac, with the same preview.
 */

/** A turn with something to review, in the order the Session took them. */
interface ReviewTurn {
  request: LiveRequest
  /** Its place among the turns that changed something, 1-based. */
  number: number
  words: string
  summary: TurnChangeSummary
}

const NO_REQUESTS: readonly LiveRequest[] = []

/** A Session's turns with changes, and what its review needs to know of it as it stands. */
interface SessionTurns {
  turns: ReviewTurn[]
  running: boolean
  cwd: string | undefined
  harness: string | undefined
  /** Its access mode, which a new Session from Finish review starts in. */
  mode: string | undefined
}

function useTurns(conversation: string): SessionTurns {
  // Each a value of its own, so a streamed token, which changes the session's object, redraws none of this.
  const live = (state: AcpState) => {
    const found = state.conversations[conversation]
    return found?.kind === "live" ? found : undefined
  }
  const requests = useAcp((state) => live(state)?.requests ?? NO_REQUESTS)
  const running = useAcp((state) => live(state)?.session.status === "running" || live(state)?.session.status === "starting")
  const cwd = useAcp((state) => live(state)?.session.cwd)
  const harness = useAcp((state) => live(state)?.session.harness)
  const mode = useAcp((state) => live(state)?.session.currentMode ?? undefined)
  const turns = useMemo(
    () => changedRequests(requests).map((request, index): ReviewTurn => ({ request, number: index + 1, words: turnWords(requests, request), summary: recordedTurnChanges(request.changes) ?? turnChangeSummary([]) })),
    [requests]
  )
  return { turns, running, cwd, harness, mode }
}

export function ReviewScreen({ open, onClose }: { open: ReviewOpen; onClose: () => void }) {
  const { conversation } = open
  const { turns, running, cwd, harness, mode } = useTurns(conversation)
  const row = useAccountList((state) => state.rows.find((each) => each.conversation === conversation))
  const syncing = useSyncing((state) => state.conversation === conversation)
  const notes = useReviewNotes(conversation)
  // Each ask its own sheet: one asked while the last leaves opens fresh, and the last one's leaving doesn't close it.
  const [asking, setAsking] = useState<{ ask: CommentAsk; id: number } | null>(null)
  const [finishing, setFinishing] = useState(false)
  const [undoing, setUndoing] = useState<TurnUndoScope | null>(null)
  const scope = open.scope
  const choose = (next: ReviewScope) => openReview({ conversation, scope: next })
  const current = scope.kind === "turn" ? turns.find((turn) => turn.request.id === scope.requestId) : undefined
  // The turn asked for isn't one with changes (yet): the newest that has some.
  const turn = scope.kind === "turn" ? (current ?? turns.at(-1)) : undefined
  const onComment = useCallback((ask: CommentAsk) => setAsking((now) => ({ ask, id: (now?.id ?? 0) + 1 })), [])
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [scope.kind, turn?.request.id])

  const title = scope.kind === "thread" ? "Changes in this Thread" : turn ? `Turn ${turn.number} of ${turns.length}` : "Changes"
  return (
    <div className="rv-screen" data-scope={scope.kind} role="region" aria-label="Changes">
      <header className="rv-bar">
        <button type="button" aria-label="Back to the Thread" onClick={onClose} className="web-icon-button">
          <ChevronLeftIcon className="size-6" strokeWidth={2} />
        </button>
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-ui font-semibold">{title}</h1>
          {scope.kind === "turn" && turn?.words ? <p className="truncate text-label text-faint">“{turn.words}”</p> : row?.threadTitle ? <p className="truncate text-label text-faint">{row.threadTitle}</p> : null}
        </div>
        {scope.kind === "turn" && turns.length > 1 && turn ? (
          <div className="flex shrink-0 items-center">
            <button type="button" aria-label="Earlier turn" disabled={turn.number <= 1} onClick={() => choose({ kind: "turn", requestId: turns[turn.number - 2]!.request.id })} className="web-icon-button">
              <ChevronLeftIcon className="size-5" />
            </button>
            <button type="button" aria-label="Later turn" disabled={turn.number >= turns.length} onClick={() => choose({ kind: "turn", requestId: turns[turn.number]!.request.id })} className="web-icon-button">
              <ChevronRightIcon className="size-5" />
            </button>
          </div>
        ) : null}
      </header>
      <div role="tablist" aria-label="What to review" className="rv-scopes">
        <button type="button" role="tab" aria-selected={scope.kind === "turn"} disabled={!turns.length} onClick={() => turn && choose({ kind: "turn", requestId: turn.request.id })} className="rv-scope">
          This turn
        </button>
        <button type="button" role="tab" aria-selected={scope.kind === "thread"} onClick={() => choose({ kind: "thread" })} className="rv-scope">
          This Thread
        </button>
      </div>
      <div ref={scroller} className="rv-scroll web-scroll" data-review-scroll="">
        {scope.kind === "thread" ? (
          <ThreadTurns turns={turns} running={running} syncing={syncing} onTurn={(requestId) => choose({ kind: "turn", requestId })} onUndo={() => setUndoing({ kind: "thread" })} />
        ) : turn ? (
          <TurnChanges
            key={turn.request.id}
            conversation={conversation}
            turn={turn}
            cwd={cwd}
            syncing={syncing}
            notes={notes.length}
            onComment={onComment}
            onUndo={() => setUndoing({ kind: "turn", requestId: turn.request.id })}
          />
        ) : (
          <p className="rv-empty">{running ? "Nothing changed yet. Changes show here once a turn ends." : "No turn of this Session changed a file."}</p>
        )}
      </div>
      {notes.length ? (
        <div className="rv-finish">
          <button type="button" className="rv-finish-button" data-finish-review="" onClick={() => setFinishing(true)}>
            <MessageSquareIcon aria-hidden className="size-4" />
            <span className="min-w-0 flex-1 truncate text-left">{commentWords(notes.length)} for {webHarnessLabel(harness ?? row?.harness ?? "")}</span>
            <span className="font-medium text-foreground">Finish review</span>
          </button>
        </div>
      ) : null}
      {asking ? <CommentSheet key={asking.id} ask={asking.ask} conversation={conversation} onDone={() => setAsking((now) => (now?.id === asking.id ? null : now))} /> : null}
      {row ? (
        <FinishSheet open={finishing} conversation={conversation} row={row} harness={harness} mode={mode} running={running} onDismiss={() => setFinishing(false)} onSent={() => {
          setFinishing(false)
          onClose()
        }} />
      ) : null}
      {undoing ? <UndoSheet conversation={conversation} scope={undoing} words={undoing.kind === "turn" ? turn?.words : undefined} running={running} onDismiss={() => setUndoing(null)} /> : null}
    </div>
  )
}

/** One turn: its counts as its line says them, Undo, and each file it changed. */
function TurnChanges({ conversation, turn, cwd, syncing, notes, onComment, onUndo }: {
  conversation: string
  turn: ReviewTurn
  cwd: string | undefined
  syncing: boolean
  notes: number
  onComment: (ask: CommentAsk) => void
  onUndo: () => void
}) {
  const record = countedChanges(turn.request.changes)
  const read = useTurnFiles(conversation, turn.request)
  const files = read?.kind === "files" ? read.files : undefined
  const viewed = useViewed(conversation, turn.request.id)
  const requestId = turn.request.id
  const onViewed = useCallback((path: string, on: boolean) => setViewed(conversation, requestId, path, on), [conversation, requestId])
  const settled = record ? record.state === "settled" : true
  const through = record?.through ?? 0
  const summary = files && !record ? turnChangeSummary(files.map((file) => ({ insertions: file.added, deletions: file.removed }))) : turn.summary
  // Every card is counted: a file with only lines not sure whose is one, its lines in the count beside.
  const cards = (files?.length ?? record?.files.length ?? summary.files) + (record?.more ?? 0)
  const undone = turn.request.undone
  const updating = syncing || !settled
  return (
    <>
      <section className="rv-summary" aria-label="Summary" data-turn-summary="">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-medium text-foreground">{cards ? `${fileWords(cards)} changed` : "No changes for sure"}</span>
          <LineCounts insertions={summary.insertions} deletions={summary.deletions} className="text-ui" />
          {anyUnsure(summary.unsure) ? <UnsureCount unsure={summary.unsure} className="text-label" /> : null}
          {updating ? (
            <span role="status" className="text-label text-faint">
              Updating…
            </span>
          ) : null}
        </p>
        {undone ? (
          <p data-undone="" className="text-label text-muted-foreground">
            {undoneWords(undone)}
          </p>
        ) : record && summary.files ? (
          <button type="button" data-undo-turn="" onClick={onUndo} className="rv-quiet">
            <Undo2Icon aria-hidden className="size-4" />
            Undo this turn
          </button>
        ) : null}
        {notes ? null : <p className="text-label text-faint">Tap a line to comment on it; hold one, then tap another, for a range.</p>}
      </section>
      {read === undefined ? <p className="rv-empty">Reading the turn’s files…</p> : read.kind === "failed" ? <ReadFailure conversation={conversation} message={read.message} /> : null}
      {files?.map((file, index) => (
        <FileCard
          key={file.path}
          index={index}
          file={file}
          conversation={conversation}
          requestId={turn.request.id}
          journal={record?.journal ?? ""}
          through={through}
          settled={settled}
          cwd={cwd}
          viewed={viewed.has(file.path)}
          onViewed={onViewed}
          onComment={onComment}
        />
      ))}
      {record?.more ? <p className="rv-empty">{`${fileWords(record.more)} more past what a turn’s record lists.`}</p> : null}
    </>
  )
}

type TurnFiles = { kind: "files"; files: ReviewFile[] } | { kind: "failed"; message: string }

/** A turn's files: its record's, at once; a turn from before the record, its checkpoints', read from its owner. */
function useTurnFiles(conversation: string, request: LiveRequest): TurnFiles | undefined {
  const record = countedChanges(request.changes)
  const listed = useMemo((): TurnFiles | undefined => (record ? { kind: "files", files: reviewFiles(record) } : undefined), [record])
  const [read, setRead] = useState<TurnFiles | undefined>(undefined)
  useEffect(() => {
    if (record) return
    let current = true
    void getMako()
      .liveTurnChanges(conversation, request.id)
      .then(
        (turn) => current && setRead({ kind: "files", files: turn.files.map((file) => ({ path: file.path, absolute: `${turn.root}/${file.path}`, kind: file.status === "added" ? "create" : file.status === "deleted" ? "delete" : "modify", added: file.insertions, removed: file.deletions, unsure: 0 })) }),
        (error: Error) => current && setRead({ kind: "failed", message: error.message })
      )
    return () => {
      current = false
    }
  }, [conversation, request.id, record])
  return listed ?? read
}

/**
 * Why a turn's files couldn't be read: the owner's own words, and where the Session's reach diagnosis puts the
 * trouble, when it has found any, rather than a guess at the computer being off.
 */
function ReadFailure({ conversation, message }: { conversation: string; message: string }) {
  const threadId = useAccountList((state) => state.rows.find((each) => each.conversation === conversation)?.thread ?? "")
  const session = useThread(threadId)?.sessions.find((each) => each.row.conversation === conversation)
  return (
    <div className="rv-empty" role="alert">
      <p>{`This turn’s changes couldn’t be read: ${message.replace(/\.$/u, "")}.`}</p>
      {session ? <Diagnosed session={session} /> : null}
    </div>
  )
}

function Diagnosed({ session }: { session: WebSession }) {
  const diagnosis = useSessionDiagnosis(session)
  return diagnosis ? <p className="mt-1.5 text-label text-faint">{diagnosis.detail ? `${diagnosis.headline} · ${diagnosis.detail}` : diagnosis.headline}</p> : null
}

/** Every turn of this Session that changed something, newest first, each opening its own changes. */
function ThreadTurns({ turns, running, syncing, onTurn, onUndo }: { turns: readonly ReviewTurn[]; running: boolean; syncing: boolean; onTurn: (requestId: string) => void; onUndo: () => void }) {
  const total = useMemo(() => {
    const files = new Set<string>()
    let added = 0
    let removed = 0
    let lines = false
    for (const turn of turns) {
      for (const file of countedChanges(turn.request.changes)?.files ?? []) if (file.own !== undefined) files.add(file.path)
      if (turn.summary.insertions !== null || turn.summary.deletions !== null) lines = true
      added += turn.summary.insertions ?? 0
      removed += turn.summary.deletions ?? 0
    }
    return { files: files.size, added: lines ? added : null, removed: lines ? removed : null }
  }, [turns])
  if (!turns.length) return <p className="rv-empty">{running ? "Nothing changed yet. Changes show here once a turn ends." : "No turn of this Session changed a file."}</p>
  return (
    <>
      <section className="rv-summary" aria-label="Summary" data-thread-summary="">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-medium text-foreground">
            {fileWords(total.files)} changed across {turnWordsCount(turns.length)}
          </span>
          <LineCounts insertions={total.added} deletions={total.removed} className="text-ui" />
          {syncing ? (
            <span role="status" className="text-label text-faint">
              Updating…
            </span>
          ) : null}
        </p>
      </section>
      <ol className="rv-turns" aria-label="Turns">
        {[...turns].reverse().map((turn) => (
          <li key={turn.request.id}>
            <button type="button" className="rv-turn" data-turn={turn.request.id} onClick={() => onTurn(turn.request.id)}>
              <span className="rv-turn-number">{`Turn ${turn.number}`}</span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 text-ui text-foreground">{turn.words || "A turn with no words of its own"}</span>
                <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-label text-faint">
                  <span>{fileWords(turn.summary.files)}</span>
                  <LineCounts insertions={turn.summary.insertions} deletions={turn.summary.deletions} />
                  {turn.request.undone ? <span className="text-muted-foreground">Undone</span> : null}
                </span>
              </span>
              <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-faint" />
            </button>
          </li>
        ))}
      </ol>
      <div className="rv-thread-foot">
        <button type="button" data-undo-thread="" onClick={onUndo} className={cn("rv-quiet")}>
          <Undo2Icon aria-hidden className="size-4" />
          Undo every change of this Thread
        </button>
      </div>
    </>
  )
}

/*
 * Files marked Viewed, per turn: kept on this browser, so a review picked up
 * later starts where it was left. A file whose turn is counted again (a
 * different record) is new again.
 */
const VIEWED = "mako:web:viewed:"
const viewedListeners = new Set<() => void>()

function viewedKey(conversation: string, requestId: string): string {
  return `${VIEWED}${conversation}:${requestId}`
}

const ViewedSchema = z.array(z.string()).catch([])

function readViewed(conversation: string, requestId: string): Set<string> {
  try {
    return new Set(ViewedSchema.parse(JSON.parse(localStorage.getItem(viewedKey(conversation, requestId)) ?? "[]")))
  } catch {
    return new Set()
  }
}

function setViewed(conversation: string, requestId: string, path: string, on: boolean): void {
  const paths = readViewed(conversation, requestId)
  if (on) paths.add(path)
  else paths.delete(path)
  try {
    if (paths.size) localStorage.setItem(viewedKey(conversation, requestId), JSON.stringify([...paths]))
    else localStorage.removeItem(viewedKey(conversation, requestId))
  } catch {
    // Not kept past this page.
  }
  for (const listener of viewedListeners) listener()
}

function useViewed(conversation: string, requestId: string): Set<string> {
  const [paths, setPaths] = useState(() => readViewed(conversation, requestId))
  useEffect(() => {
    const changed = () => setPaths(readViewed(conversation, requestId))
    changed()
    viewedListeners.add(changed)
    return () => {
      viewedListeners.delete(changed)
    }
  }, [conversation, requestId])
  return paths
}
