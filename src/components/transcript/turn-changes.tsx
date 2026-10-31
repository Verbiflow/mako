import { useEffect, useState } from "react"
import { FileDiffIcon } from "lucide-react"
import { LineCounts, UnsureCount } from "@/components/inspector/change-marks"
import type { TurnUndone } from "@mako/host/contracts/turn-review"
import { TurnUndoDialog } from "@/components/inspector/turn-undo"
import { anyUnsure, recordRoots, recordedTurnChanges, turnChangeSummary, turnChangeWords, type TurnChangeSummary } from "@/lib/turn-changes"
import { undoneWords } from "@/lib/turn-undone"
import { cn } from "@/lib/utils"
import { turnWords } from "@/state/prompt-delivery"
import { acp, useAcp } from "@/state/acp"
import { acpStore } from "@/state/acp-state"
import { reviewTurn } from "@/state/review-scope"
import { useTranscriptSource } from "./source-context"
import { useVisible } from "./use-visible"

/** Turns from before the journal counted them, whose changes stay held; a finished turn's never change, so each is read once while it's held. */
const HELD_TURNS = 200
const settled = new Map<string, TurnChangeSummary>()
const reading = new Map<string, Promise<TurnChangeSummary | null>>()

function remember(key: string, summary: TurnChangeSummary) {
  settled.delete(key)
  settled.set(key, summary)
  while (settled.size > HELD_TURNS) {
    const oldest = settled.keys().next().value
    if (oldest === undefined) break
    settled.delete(oldest)
  }
}

/**
 * One read per turn however many rows ask. A failed read isn't kept: the
 * line stays away, and the next mount (the host back, the row scrolled in
 * again) asks again.
 */
function readTurn(conversation: string, requestId: string, key: string): Promise<TurnChangeSummary | null> {
  const held = reading.get(key)
  if (held) return held
  const read = acp.turnChanges(conversation, requestId).then(
    (turn) => {
      const summary = turnChangeSummary(turn.files)
      remember(key, summary)
      return summary
    },
    () => null
  ).finally(() => reading.delete(key))
  reading.set(key, read)
  return read
}

/**
 * What the turn changed, under its answer: "Changed 4 files +120 −33 · 2
 * lines not sure whose · Review · Undo". Its numbers are the request's own record, which
 * the attribution journal counted once the turn ended (`LiveRequest.changes`):
 * only this thread's lines, the same live and reopened, and the same record
 * its file links and "changes made" read. Changes that only might be the
 * agent's (a save of the person's while it ran) are counted apart, "not
 * sure whose", as Changes › Turn counts them. Once undone it says so, from
 * the same request (`LiveRequest.undone`), and offers no second undo. A turn
 * from before Mako kept that record falls back to its checkpoints, read
 * once it nears the viewport. Review opens Changes on that turn, from its
 * checkpoints or, without them, from the journal the record was counted
 * from; Undo takes the turn's own lines back out and keeps everyone else's.
 */
export function TurnChanges({ requestId }: { requestId: string | undefined }) {
  const { liveId } = useTranscriptSource()
  const request = useAcp((state) => {
    const live = liveId ? state.conversations[liveId] : undefined
    return live?.kind === "live" && requestId ? live.requests?.find((each) => each.id === requestId) : undefined
  })
  // The repository its checkpoints saved, when both sides were saved; else the one its record names: what Review opens.
  const before = request?.snapshots?.before
  const saved = before?.kind === "ready" && request?.snapshots?.after?.kind === "ready" ? before.snapshot.scope : null
  if (!liveId || !requestId || !request) return null
  const recorded = recordedTurnChanges(request.changes)
  if (recorded) return <TurnChangesRow summary={recorded} conversation={liveId} requestId={requestId} workspace={saved ?? recordRoots(request.changes)[0] ?? null} undoable undone={request.undone} />
  const workspace = saved
  // A count on its way, or none to make: nothing to read from the checkpoints.
  if (request.changes || !workspace) return null
  // Mounted once the checkpoints are, so the line watches the viewport from its first frame.
  return <CheckpointTurnChanges key={`${liveId}\0${requestId}`} conversation={liveId} requestId={requestId} workspace={workspace} />
}

/** An older turn's line, from the checkpoints either side of it. */
function CheckpointTurnChanges({ conversation, requestId, workspace }: { conversation: string; requestId: string; workspace: string }) {
  const key = `${conversation}\0${requestId}`
  const { ref, visible } = useVisible()
  const [read, setRead] = useState<TurnChangeSummary | null>(null)
  const summary = settled.get(key) ?? read

  useEffect(() => {
    if (!visible || settled.has(key)) return
    let current = true
    void readTurn(conversation, requestId, key).then((next) => {
      if (current) setRead(next)
    })
    return () => {
      current = false
    }
  }, [visible, key, conversation, requestId])

  return (
    <div ref={ref} data-turn-changes={summary ? summary.files : undefined}>
      {summary ? <TurnChangesRow summary={summary} conversation={conversation} requestId={requestId} workspace={workspace} /> : null}
    </div>
  )
}

/** The words the turn answered, read once, on a click: they name it in the scope menu and the undo. */
function promptOf(conversation: string, requestId: string): string {
  const live = acpStore.get().conversations[conversation]
  const request = live?.kind === "live" ? live.requests?.find((each) => each.id === requestId) : undefined
  return live?.kind === "live" && request ? turnWords(live.requests ?? [], request) : ""
}

function TurnChangesRow({ summary, conversation, requestId, workspace, undoable = false, undone }: { summary: TurnChangeSummary; conversation: string; requestId: string; workspace: string | null; undoable?: boolean; undone?: TurnUndone }) {
  const [undo, setUndo] = useState<string | null>(null)
  if (summary.files === 0 && !anyUnsure(summary.unsure)) return null
  return (
    <div
      role="note"
      data-turn-changes={summary.files}
      data-turn-changes-unsure={anyUnsure(summary.unsure) || undefined}
      data-turn-undone={undone ? "" : undefined}
      data-turn-changes-settling={summary.settling || undefined}
      title={summary.settling ? "Still settling: a change heard as the turn ended may yet be counted" : undefined}
      className="flex min-h-7 min-w-0 max-w-full flex-wrap items-center gap-x-2 text-ui"
    >
      <FileDiffIcon aria-hidden className="size-3.5 shrink-0 text-faint" />
      {summary.files > 0 ? (
        <>
          <span className="min-w-0 truncate text-muted-foreground">{turnChangeWords(summary.files)}</span>
          <LineCounts insertions={summary.insertions} deletions={summary.deletions} className={cn("transition-opacity duration-200", summary.settling && "opacity-60")} />
        </>
      ) : (
        <span className="min-w-0 truncate text-muted-foreground">No changes for sure</span>
      )}
      {anyUnsure(summary.unsure) ? (
        <>
          <span aria-hidden className="shrink-0 text-faint">·</span>
          <UnsureCount unsure={summary.unsure} className="shrink-0" />
        </>
      ) : null}
      {workspace ? (
        <>
          <span aria-hidden className="shrink-0 text-faint">·</span>
          <button
            type="button"
            data-review-turn=""
            title="Review what this turn changed in Changes"
            onClick={() => reviewTurn(workspace, { conversation, requestId, prompt: promptOf(conversation, requestId) })}
            className="pressable -mx-1 shrink-0 rounded px-1 text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground focus-visible:text-foreground"
          >
            Review
          </button>
        </>
      ) : null}
      {undone ? (
        <>
          <span aria-hidden className="shrink-0 text-faint">·</span>
          <span data-undone="" title={undoneWords(undone)} className="shrink-0 cursor-default text-muted-foreground">Undone</span>
        </>
      ) : undoable && summary.files > 0 ? (
        <>
          <span aria-hidden className="shrink-0 text-faint">·</span>
          <button
            type="button"
            data-undo-turn=""
            title="Take this turn's lines back out, keeping yours and other threads'"
            onClick={() => setUndo(promptOf(conversation, requestId))}
            className="pressable -mx-1 shrink-0 rounded px-1 text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground focus-visible:text-foreground"
          >
            Undo
          </button>
          {undo !== null ? <TurnUndoDialog conversation={conversation} scope={{ kind: "turn", requestId }} prompt={undo} open onOpenChange={(open) => { if (!open) setUndo(null) }} /> : null}
        </>
      ) : null}
    </div>
  )
}
