import { useEffect, useMemo, useState } from "react"
import { TriangleAlertIcon, XIcon } from "lucide-react"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { listedOwner } from "@mako/host/contracts/listed-conversations"
import type { TurnUndoPreview, TurnUndoResult, TurnUndoScope } from "@mako/host/contracts/turn-review"
import { LineCounts } from "@/components/inspector/change-marks"
import { lineWords } from "@/lib/turn-writers"
import { cn } from "@/lib/utils"
import { acp } from "@/state/acp"
import { useWebClient } from "./client"
import { webHarnessLabel } from "./labels"
import { sendMessage } from "./outbox"
import { commentDetails, commentWords, fileWords, rangeLabel, splitPath } from "./review-model"
import type { CommentAsk } from "./review-diff"
import { addReviewNotes, dropReviewNote, noteLabel, sendWithReviewNotes, useReviewNotes } from "./review-notes"
import { Sheet, SheetScroll } from "./sheet"
import { addSession } from "./start"

/** What a comment on a turn's lines is compared against, as the desk's turn review names it. */
const TURN_BASE = "the start of that turn"

/**
 * A comment on the lines picked: the lines as the diff showed them, and a field for what should change. It goes into
 * the Session's next message as a "comment on lines" chip, the desk's own; nothing is sent from here.
 */
export function CommentSheet({ ask, conversation, onDone }: { ask: CommentAsk; conversation: string; onDone: () => void }) {
  const [open, setOpen] = useState(true)
  const [words, setWords] = useState("")
  const details = useMemo(() => commentDetails({ path: ask.path, base: TURN_BASE, view: ask.view, from: ask.from, to: ask.to, comment: "" }), [ask])
  const rows = useMemo(() => {
    const [first, last] = ask.from.hunk < ask.to.hunk || (ask.from.hunk === ask.to.hunk && ask.from.row <= ask.to.row) ? [ask.from, ask.to] : [ask.to, ask.from]
    return ask.view.hunks.slice(first.hunk, last.hunk + 1).flatMap((hunk, offset) => hunk.rows.slice(offset === 0 ? first.row : 0, first.hunk + offset === last.hunk ? last.row + 1 : undefined))
  }, [ask])
  // The lines as they read, without the indent they share: a phone's width goes to the code.
  const indent = useMemo(() => Math.min(...rows.filter((row) => row.text.trim()).map((row) => /^\s*/u.exec(row.text)![0].length), 80) || 0, [rows])
  const close = () => setOpen(false)
  const add = () => {
    const made = commentDetails({ path: ask.path, base: TURN_BASE, view: ask.view, from: ask.from, to: ask.to, comment: words })
    addReviewNotes(conversation, made)
    close()
  }
  return (
    <Sheet open={open} onDismiss={close} label={`Comment on ${rangeLabel(details)}`}>
      <ClosedAfter open={open} onClosed={onDone} />
      <h3 className="web-sheet-title">{`Comment on ${rangeLabel(details)}`}</h3>
      <SheetScroll className="flex flex-col gap-3 px-4 pb-[calc(env(safe-area-inset-bottom)+12px)]">
        <div className="rv-quote web-scroll" aria-label="The lines">
          {rows.slice(0, 40).map((row, index) => (
            <div key={index} className="rv-quote-row" data-kind={row.kind === "+" ? "add" : row.kind === "-" ? "remove" : "same"}>
              <span className="rv-quote-number">{row.kind === "-" ? row.old : row.new}</span>
              <span className="rv-quote-text">{row.text.slice(indent) || " "}</span>
            </div>
          ))}
          {rows.length > 40 ? <p className="px-3 py-1 text-label text-faint">{`and ${lineWords(rows.length - 40)} more`}</p> : null}
        </div>
        <textarea
          // A comment is what the sheet is for: the keyboard comes up with it.
          autoFocus
          aria-label="Comment"
          className="web-field rv-comment-field"
          rows={3}
          placeholder="What should change here?"
          value={words}
          onChange={(event) => setWords(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) add()
          }}
        />
        <p className="text-label text-faint">Goes into your next message to this Session, with these lines. Nothing is sent by itself.</p>
        <div className="flex justify-end gap-2">
          <button type="button" className="web-quiet-button" onClick={close}>
            Cancel
          </button>
          <button type="button" className="web-button" data-add-comment="" disabled={!words.trim()} onClick={add}>
            Add comment
          </button>
        </div>
      </SheetScroll>
    </Sheet>
  )
}

/** Unmounts the sheet's parent state once the sheet has left on its own path. */
function ClosedAfter({ open, onClosed }: { open: boolean; onClosed: () => void }) {
  useEffect(() => {
    if (open) return
    const timer = window.setTimeout(onClosed, 260)
    return () => clearTimeout(timer)
  }, [open, onClosed])
  return null
}

/**
 * Finish review: the comments written, with a message if the person wants one, sent together to this Session, or
 * started in a new Session of the Thread with the same harness and access. Queued if this Session is at work.
 */
export function FinishSheet({ open, conversation, row, harness, mode, running, onDismiss, onSent }: {
  open: boolean
  conversation: string
  row: ListedSession
  harness: string | undefined
  mode: string | undefined
  running: boolean
  onDismiss: () => void
  onSent: () => void
}) {
  const client = useWebClient()
  const notes = useReviewNotes(conversation)
  const [words, setWords] = useState("")
  const [where, setWhere] = useState<"here" | "new">("here")
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const files = new Set(notes.map((note) => note.detail.path)).size
  const name = webHarnessLabel(harness ?? row.harness)
  const canStartNew = Boolean(row.folder) && Boolean(row.thread)
  const send = async () => {
    if (!notes.length || sending) return
    setSending(true)
    setFailure(undefined)
    const count = notes.length
    const owner = listedOwner(row)
    try {
      // The comments leave only once the message carrying them was taken; a refusal keeps every one.
      const request = crypto.randomUUID()
      await sendWithReviewNotes(conversation, request, words, async (text) => {
        if (where === "here") {
          const went = await sendMessage({ conversation, ...(owner.kind === "cloud" && { cloudThread: owner.threadId }) }, request, text, [])
          if (!went) throw new Error("The Session didn't take the message. Try again in a moment.")
          return true
        }
        await addSession(client.gateway, client.deviceId, owner.kind === "cloud" ? { kind: "cloud", threadId: owner.threadId } : { kind: "mac", deviceId: owner.deviceId }, {
          thread: row.thread,
          folder: row.folder!,
          harness: harness ?? row.harness,
          model: undefined,
          mode,
          message: { text, attachments: [], title: `Review: ${commentWords(count)}` },
        })
        return true
      })
      setWords("")
      onSent()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }
  return (
    <Sheet open={open} onDismiss={onDismiss} label="Finish review">
      <h3 className="web-sheet-title">Finish review</h3>
      <p className="web-sheet-note">{`${commentWords(notes.length)} on ${fileWords(files)}`}</p>
      <SheetScroll className="flex min-h-0 flex-1 flex-col gap-3 px-4">
        <textarea aria-label="Words with the comments" className="web-field rv-comment-field" rows={3} placeholder="Anything to say with them? (optional)" value={words} onChange={(event) => setWords(event.target.value)} />
        <ul className="rv-notes" aria-label="Comments">
          {notes.map((note) => (
            <li key={note.id} className="rv-note-row" data-note="">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-label text-muted-foreground">{noteLabel(note)}</span>
                <span className="line-clamp-2 text-ui text-foreground">{note.detail.comment}</span>
              </span>
              <button type="button" aria-label={`Remove the comment on ${noteLabel(note)}`} className="web-icon-button" onClick={() => dropReviewNote(conversation, note.id)}>
                <XIcon className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      </SheetScroll>
      <div className="rv-finish-foot">
        <div role="radiogroup" aria-label="Send to" className="rv-scopes rv-scopes-inline">
          <button type="button" role="radio" aria-checked={where === "here"} className="rv-scope" onClick={() => setWhere("here")}>
            This Session
          </button>
          <button type="button" role="radio" aria-checked={where === "new"} disabled={!canStartNew} className="rv-scope" onClick={() => setWhere("new")}>
            A new Session
          </button>
        </div>
        {failure ? (
          <p role="alert" className="text-label text-negative">
            {failure}
          </p>
        ) : null}
        <button type="button" className="web-button w-full" data-send-review="" disabled={!notes.length || sending} onClick={() => void send()}>
          {sending ? "Sending…" : where === "new" ? `Start ${name} with ${commentWords(notes.length)}` : running ? `Queue ${commentWords(notes.length)} for ${name}` : `Send ${commentWords(notes.length)} to ${name}`}
        </button>
      </div>
    </Sheet>
  )
}

type UndoState =
  | { kind: "loading" }
  | { kind: "ready"; preview: TurnUndoPreview }
  | { kind: "undoing"; preview: TurnUndoPreview }
  | { kind: "done"; preview: TurnUndoPreview; result: TurnUndoResult }
  | { kind: "error"; message: string; preview?: TurnUndoPreview }

/**
 * Undo this turn (or every change of the Thread), as a Mac's: the preview first, read from the journal on the
 * Session's own computer, then the undo with the preview's token, which that computer refuses while an agent works
 * in the checkout or when the files changed since the preview. It takes the turn's own lines out and keeps
 * everyone else's; the checkout is kept as a Git ref first.
 */
export function UndoSheet({ conversation, scope, words, running, onDismiss }: { conversation: string; scope: TurnUndoScope; words: string | undefined; running: boolean; onDismiss: () => void }) {
  const [open, setOpen] = useState(true)
  const [state, setState] = useState<UndoState>({ kind: "loading" })
  const turn = scope.kind === "turn"
  const requestId = scope.kind === "turn" ? scope.requestId : undefined
  useEffect(() => {
    let current = true
    void acp.turnUndoPreview(conversation, requestId ? { kind: "turn", requestId } : { kind: "thread" }).then(
      (preview) => current && setState({ kind: "ready", preview }),
      (error: Error) => current && setState({ kind: "error", message: error.message })
    )
    return () => {
      current = false
    }
  }, [conversation, requestId])
  const undo = async () => {
    if (state.kind !== "ready") return
    const { preview } = state
    setState({ kind: "undoing", preview })
    try {
      setState({ kind: "done", preview, result: await acp.turnUndo(conversation, preview.scope, preview.token) })
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : String(error), preview })
    }
  }
  const preview = state.kind === "loading" ? undefined : state.preview
  const busy = state.kind === "undoing"
  // The computer that runs the Session says why it can't now; until it answers, an agent at work here is reason enough.
  const refused = preview?.refused ?? (running ? "An agent is working in this checkout. Undo once it finishes." : undefined)
  const whose = turn ? "this turn's" : "this Thread's"
  const close = () => {
    if (!busy) setOpen(false)
  }
  return (
    <Sheet open={open} onDismiss={close} label={turn ? "Undo this turn" : "Undo every change of this Thread"}>
      <ClosedAfter open={open} onClosed={onDismiss} />
      <h3 className="web-sheet-title">{turn ? "Undo this turn" : "Undo every change of this Thread"}</h3>
      <p className="web-sheet-note">{state.kind === "done" ? doneWords(state.result, whose) : words ? `“${words}”` : `Takes ${whose} lines out of the files as they are now, and keeps everyone else’s.`}</p>
      <SheetScroll className="flex min-h-0 flex-1 flex-col gap-4 px-4" >
        <div data-turn-undo={state.kind} className="contents">
          {state.kind === "loading" ? <p className="text-ui text-faint">Reading whose each line is…</p> : null}
          {state.kind === "error" ? <Notice tone="error">{state.message}</Notice> : null}
          {refused && state.kind !== "done" ? <Notice tone="caution">{refused}</Notice> : null}
          {preview ? <UndoGroups preview={preview} whose={whose} done={state.kind === "done"} /> : null}
          {state.kind === "done" && state.result.backup ? <p className="text-label text-faint">{`The checkout from before is kept as ${state.result.backup} for 14 days.`}</p> : null}
        </div>
      </SheetScroll>
      <div className="rv-finish-foot">
        <p className="text-label text-faint">{state.kind === "done" ? "Nothing else in the checkout changed." : "The checkout is kept first, as a Git ref, for 14 days."}</p>
        {state.kind === "done" ? (
          <button type="button" className="web-button w-full" onClick={close}>
            Done
          </button>
        ) : (
          <button type="button" className="web-button web-button-negative w-full" data-turn-undo-confirm="" disabled={state.kind !== "ready" || !state.preview.undo.length || Boolean(refused)} onClick={() => void undo()}>
            {busy ? "Undoing…" : preview?.undo.length ? `Undo ${fileWords(preview.undo.length)}` : "Undo"}
          </button>
        )}
      </div>
    </Sheet>
  )
}

/** "2 lines yours · 1 another Thread's", as the desk's undo says them. */
function keptWords(kept: TurnUndoPreview["kept"][number]["kept"]): string {
  return [
    kept.person ? `${lineWords(kept.person)} yours` : "",
    kept.other ? `${lineWords(kept.other)} another Thread's` : "",
    kept.thread ? `${lineWords(kept.thread)} from another turn` : "",
    kept.maybe ? `${lineWords(kept.maybe)} not sure whose` : "",
    kept.unknown ? `${lineWords(kept.unknown)} nobody's named` : "",
  ].filter(Boolean).join(" · ")
}

function doneWords(result: TurnUndoResult, whose: string): string {
  if (!result.files) return `Nothing of ${whose} was left to take out.`
  return `Took ${whose} lines out of ${fileWords(result.files)}.`
}

function Notice({ tone, children }: { tone: "caution" | "error"; children: string }) {
  return (
    <p role={tone === "error" ? "alert" : "status"} className={cn("flex items-start gap-2 rounded-xl px-3 py-2.5 text-ui", tone === "error" ? "bg-negative/10 text-negative" : "bg-caution/12 text-foreground")}>
      <TriangleAlertIcon aria-hidden className={cn("mt-1 size-3.5 shrink-0", tone === "caution" && "text-caution")} />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

function UndoGroups({ preview, whose, done }: { preview: TurnUndoPreview; whose: string; done: boolean }) {
  if (!preview.undo.length && !preview.kept.length && !preview.left.length) return <p className="text-ui text-faint">{`Nothing of ${whose} is left in the files to undo.`}</p>
  return (
    <>
      {preview.undo.length ? (
        <UndoGroup title={done ? "Undone" : "Undo"} detail={`${whose} lines`}>
          {preview.undo.map((file) => (
            <li key={file.path} className="rv-undo-row" data-undo-file={file.path}>
              <UndoPath path={file.path} />
              {file.kind === "remove" ? <span className="text-label text-muted-foreground">{done ? "Removed" : "Removes it"}</span> : file.kind === "restore" ? <span className="text-label text-muted-foreground">{done ? "Put back" : "Puts it back"}</span> : null}
              <LineCounts insertions={file.restores} deletions={file.removes} />
            </li>
          ))}
        </UndoGroup>
      ) : null}
      {preview.kept.length ? (
        <UndoGroup title="Kept" detail={`lines that aren't ${whose} for sure`}>
          {preview.kept.map((file) => (
            <li key={file.path} className="rv-undo-row" data-kept-file={file.path}>
              <UndoPath path={file.path} />
              <span className="shrink-0 text-label text-muted-foreground">{file.why === "rewritten" ? "Rewritten since" : file.why === "maybe" ? "Not sure whose" : keptWords(file.kept)}</span>
            </li>
          ))}
        </UndoGroup>
      ) : null}
      {preview.left.length ? (
        <UndoGroup title="Can't split" detail={done ? "left as they were" : "left whole"}>
          {preview.left.map((left, index) => (
            <li key={`${left.path}:${left.lines?.start ?? "file"}:${index}`} className="rv-undo-row">
              <UndoPath path={left.path} />
              <span className="shrink-0 text-label text-muted-foreground">{left.lines ? `${lineWords(left.lines.length)} from line ${left.lines.start}` : "The whole file"}</span>
            </li>
          ))}
        </UndoGroup>
      ) : null}
    </>
  )
}

function UndoGroup({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5" data-undo-group={title}>
      <h4 className="flex items-baseline gap-1.5 text-label">
        <span className="font-medium text-foreground">{title}</span>
        <span className="text-faint">{detail}</span>
      </h4>
      <ul className="rv-undo-list">{children}</ul>
    </section>
  )
}

function UndoPath({ path }: { path: string }) {
  const { folder, name } = splitPath(path)
  return (
    <span className="rv-path min-w-0 flex-1" title={path}>
      {folder ? <span className="rv-folder"><bdi>{folder}</bdi></span> : null}
      <span className="rv-name">{name}</span>
    </span>
  )
}
