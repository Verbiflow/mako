import { useEffect, useState, type ReactNode } from "react"
import { CheckIcon, CopyIcon, TriangleAlertIcon } from "lucide-react"
import type { KeptLines, TurnUndoFile, TurnUndoKept, TurnUndoLeft, TurnUndoPreview, TurnUndoResult, TurnUndoScope } from "@mako/host/contracts/turn-review"
import { LineCounts } from "@/components/inspector/change-marks"
import { FileTypeIcon } from "@/components/ui/file-type-icon"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Action, IconAction } from "@/components/ui/kit"
import { lineWords } from "@/lib/turn-writers"
import { acp } from "@/state/acp"

type State =
  | { kind: "loading" }
  | { kind: "ready"; preview: TurnUndoPreview }
  | { kind: "undoing"; preview: TurnUndoPreview }
  | { kind: "done"; preview: TurnUndoPreview; result: TurnUndoResult }
  | { kind: "error"; message: string; preview?: TurnUndoPreview }

/**
 * Undo one turn, or every change of the Thread, keeping everyone else's
 * lines. The preview groups the files three ways: what the undo takes back
 * (the scope's own lines, out; lines it removed, back), what it keeps
 * (yours and other threads' lines), and stretches it can't split, left as
 * they are and named. Rewind stays the way to put the whole workspace back.
 */
export function TurnUndoDialog({ conversation, scope, prompt, open, onOpenChange, onUndone }: {
  conversation: string
  scope: TurnUndoScope
  /** The words the turn answered, under the title. */
  prompt?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onUndone?: (result: TurnUndoResult) => void
}) {
  const [state, setState] = useState<State>({ kind: "loading" })
  const turn = scope.kind === "turn"
  const scopeKey = turn ? scope.requestId : "thread"

  useEffect(() => {
    if (!open) return
    let current = true
    queueMicrotask(() => setState({ kind: "loading" }))
    void acp.turnUndoPreview(conversation, turn ? { kind: "turn", requestId: scopeKey } : { kind: "thread" }).then(
      (preview) => { if (current) setState({ kind: "ready", preview }) },
      (error: Error) => { if (current) setState({ kind: "error", message: error.message }) },
    )
    return () => { current = false }
  }, [open, conversation, turn, scopeKey])

  const undo = async () => {
    if (state.kind !== "ready") return
    const { preview } = state
    setState({ kind: "undoing", preview })
    try {
      const result = await acp.turnUndo(conversation, preview.scope, preview.token)
      setState({ kind: "done", preview, result })
      onUndone?.(result)
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : String(error), preview })
    }
  }

  const preview = state.kind === "loading" ? undefined : state.preview
  const busy = state.kind === "undoing"
  const whose = turn ? "this turn's" : "this thread's"
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="flex max-h-[min(640px,85vh)] max-w-[560px] flex-col overflow-hidden p-0">
        <div className="shrink-0 px-5 pt-5 pb-3">
          <DialogTitle>{turn ? "Undo this turn" : "Undo this thread's changes"}</DialogTitle>
          <p className="mt-1 truncate text-ui text-muted-foreground" title={prompt}>
            {state.kind === "done" ? doneWords(state.result, whose) : prompt ? `“${prompt}”` : `Takes ${whose} lines out of the files as they are now.`}
          </p>
        </div>
        <div data-turn-undo={state.kind} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-4">
          {state.kind === "loading" ? <p className="text-ui text-faint">Reading whose each line is…</p> : null}
          {state.kind === "error" ? <Notice tone="error">{state.message}</Notice> : null}
          {preview?.refused && state.kind !== "done" ? <Notice tone="caution">{preview.refused}</Notice> : null}
          {preview ? <Groups preview={preview} whose={whose} done={state.kind === "done"} /> : null}
          {state.kind === "done" && state.result.backup ? <Backup name={state.result.backup} /> : null}
        </div>
        <div className="flex shrink-0 items-center gap-3 border-t border-hairline px-5 py-3">
          <p className="min-w-0 flex-1 text-label text-faint">
            {state.kind === "done" ? "Nothing else in the checkout changed." : "The checkout is kept first, as a Git ref, for 14 days. Rewind puts the whole workspace back instead."}
          </p>
          {state.kind === "done" ? (
            <Action tone="solid" onClick={() => onOpenChange(false)}>Done</Action>
          ) : (
            <>
              <Action tone="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Action>
              <Action tone="solid" data-turn-undo-confirm="" disabled={state.kind !== "ready" || !state.preview.undo.length || Boolean(state.preview.refused)} onClick={() => void undo()}>
                {busy ? "Undoing…" : undoWords(preview?.undo.length ?? 0)}
              </Action>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

const undoWords = (files: number) => (files ? `Undo ${files === 1 ? "1 file" : `${files.toLocaleString()} files`}` : "Undo")

function doneWords(result: TurnUndoResult, whose: string): string {
  if (!result.files) return `Nothing of ${whose} was left to take out.`
  return `Took ${whose} lines out of ${result.files === 1 ? "1 file" : `${result.files.toLocaleString()} files`}.`
}

function Notice({ tone, children }: { tone: "caution" | "error"; children: ReactNode }) {
  return (
    <p role={tone === "error" ? "alert" : "status"} className={tone === "error" ? "flex items-start gap-2 rounded-lg bg-negative/10 px-3 py-2 text-ui text-negative" : "flex items-start gap-2 rounded-lg bg-caution/12 px-3 py-2 text-ui text-foreground"}>
      <TriangleAlertIcon className={tone === "error" ? "mt-0.5 size-3.5 shrink-0" : "mt-0.5 size-3.5 shrink-0 text-caution"} />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

function Groups({ preview, whose, done }: { preview: TurnUndoPreview; whose: string; done: boolean }) {
  const nothing = !preview.undo.length && !preview.kept.length && !preview.left.length
  if (nothing) return <p className="text-ui text-faint">{`Nothing of ${whose} is left in the files to undo.`}</p>
  return (
    <>
      {preview.undo.length ? (
        <Group title={done ? "Undone" : "Undo"} detail={`${whose} lines`} count={preview.undo.length}>
          {preview.undo.map((file) => <UndoRow key={file.path} file={file} done={done} />)}
        </Group>
      ) : null}
      {preview.kept.length ? (
        <Group title="Kept" detail="yours and other threads' lines" count={preview.kept.length}>
          {preview.kept.map((file) => <KeptRow key={file.path} file={file} />)}
        </Group>
      ) : null}
      {preview.left.length ? (
        <Group title="Can't split" detail={done ? "left as they were" : "left whole"} count={preview.left.length}>
          {preview.left.map((left, index) => <LeftRow key={`${left.path}:${left.lines?.start ?? "file"}:${index}`} left={left} />)}
        </Group>
      ) : null}
    </>
  )
}

function Group({ title, detail, count, children }: { title: string; detail: string; count: number; children: ReactNode }) {
  return (
    <section className="space-y-1.5" data-undo-group={title}>
      <h3 className="flex items-baseline gap-1.5 text-label">
        <span className="font-medium text-foreground">{title}</span>
        <span className="text-faint">{detail}</span>
        <span className="tabular ml-auto text-faint">{count === 1 ? "1 file" : `${count} ${title === "Can't split" ? "stretches" : "files"}`}</span>
      </h3>
      <ul className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-surface">{children}</ul>
    </section>
  )
}

function Path({ path, suffix }: { path: string; suffix?: string }) {
  const slash = path.lastIndexOf("/")
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <FileTypeIcon path={path} className="size-3.5 shrink-0 text-faint/80" />
      <span className="min-w-0 truncate text-ui" title={path}>
        <span className="text-faint">{slash > 0 ? path.slice(0, slash + 1) : ""}</span>
        <span className="text-foreground">{path.slice(slash + 1)}</span>
        {suffix ? <span className="tabular text-faint">{suffix}</span> : null}
      </span>
    </span>
  )
}

function UndoRow({ file, done }: { file: TurnUndoFile; done: boolean }) {
  const back = `${done ? "Moved back" : "Back"} to ${file.from?.split("/").pop() ?? "its old name"}`
  const what = file.kind === "remove" ? (done ? "Removed the file" : "Removes the file") : file.kind === "restore" ? (done ? "Put the file back" : "Puts the file back") : file.kind === "rename" ? back : null
  return (
    <li className="flex h-8 items-center gap-3 px-3" data-undo-file={file.path}>
      <Path path={file.path} />
      {what ? <span className="shrink-0 text-label text-muted-foreground">{what}</span> : null}
      <LineCounts insertions={file.restores} deletions={file.removes} />
    </li>
  )
}

/** "2 lines yours · 1 another thread's". */
function keptWords(kept: KeptLines): string {
  const parts = [
    kept.person ? `${lineWords(kept.person)} yours` : "",
    kept.other ? `${lineWords(kept.other)} another thread's` : "",
    kept.thread ? `${lineWords(kept.thread)} from another turn` : "",
    kept.maybe ? `${lineWords(kept.maybe)} maybe yours` : "",
    kept.unknown ? `${lineWords(kept.unknown)} nobody's named` : "",
  ].filter(Boolean)
  return parts.join(" · ")
}

function KeptRow({ file }: { file: TurnUndoKept }) {
  const why = file.why === "maybe" ? "Only lines that might be this turn's" : file.why === "rewritten" ? "Rewritten since by someone else" : null
  return (
    <li className="flex h-8 items-center gap-3 px-3" data-kept-file={file.path}>
      <Path path={file.path} />
      <span className="shrink-0 truncate text-label text-muted-foreground">{why ?? keptWords(file.kept)}</span>
    </li>
  )
}

const LEFT_REASONS = {
  "edited-since": "Edited on top of these lines since",
  "line-restored-by-another-writer": "A line it removed was put back by another writer",
  "whole-file-changed-since": "Changed since, and it can't be split by line",
  "content-not-kept": "Its version before isn't kept",
} satisfies Record<TurnUndoLeft["reason"], string>

function LeftRow({ left }: { left: TurnUndoLeft }) {
  const lines = left.lines && left.lines.length ? `:${left.lines.start}${left.lines.length > 1 ? `–${left.lines.start + left.lines.length - 1}` : ""}` : undefined
  const by = left.by.map((writer) => (writer === "person" ? "you" : writer === "other" ? "another thread" : writer === "maybe" ? "maybe this thread" : writer === "thread" ? "another turn" : "someone")).join(", ")
  return (
    <li className="flex min-h-8 items-center gap-3 px-3 py-1.5" data-left-file={left.path}>
      <Path path={left.path} suffix={lines} />
      <span className="shrink-0 text-right text-label text-muted-foreground">
        {LEFT_REASONS[left.reason]}
        {by ? <span className="text-faint">{` · by ${by}`}</span> : null}
      </span>
    </li>
  )
}

function Backup({ name }: { name: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2 rounded-lg border border-hairline bg-surface px-3 py-2">
      <span className="shrink-0 text-label text-faint">Kept before the undo</span>
      <code className="min-w-0 flex-1 truncate font-mono text-code text-muted-foreground" title={name}>{name}</code>
      <IconAction label={copied ? "Copied" : "Copy the ref"} size="xs" onClick={() => void navigator.clipboard.writeText(name).then(() => setCopied(true))}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </IconAction>
    </div>
  )
}
