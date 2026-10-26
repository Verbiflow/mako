import { useEffect, useState } from "react"
import { FileDiffIcon } from "lucide-react"
import { LineCounts } from "@/components/inspector/change-marks"
import { maybeWords, recordedTurnChanges, turnChangeSummary, turnChangeWords, type TurnChangeSummary } from "@/lib/turn-changes"
import { cn } from "@/lib/utils"
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
 * What the turn changed, under its answer: "Changed 4 files +120 −33 · 1
 * maybe yours · Review". Its numbers are the request's own record, which
 * the attribution journal counted once the turn ended (`LiveRequest.changes`):
 * only this thread's lines, the same live and reopened, and the same record
 * its file links and "changes made" read. Changes that only might be the
 * agent's (a save of the person's while it ran) are counted apart. A turn
 * from before Mako kept that record falls back to its checkpoints, read
 * once it nears the viewport. Review opens Changes on that turn, when its
 * checkpoints are there to show it.
 */
export function TurnChanges({ requestId }: { requestId: string | undefined }) {
  const { liveId } = useTranscriptSource()
  const request = useAcp((state) => {
    const live = liveId ? state.conversations[liveId] : undefined
    return live?.kind === "live" && requestId ? live.requests?.find((each) => each.id === requestId) : undefined
  })
  // The repository its checkpoints saved, when both sides were saved: what Review opens.
  const before = request?.snapshots?.before
  const workspace = before?.kind === "ready" && request?.snapshots?.after?.kind === "ready" ? before.snapshot.scope : null
  if (!liveId || !requestId || !request) return null
  const recorded = recordedTurnChanges(request.changes)
  if (recorded) return <TurnChangesRow summary={recorded} conversation={liveId} requestId={requestId} workspace={workspace} />
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

function TurnChangesRow({ summary, conversation, requestId, workspace }: { summary: TurnChangeSummary; conversation: string; requestId: string; workspace: string | null }) {
  if (summary.files === 0 && summary.maybe === 0) return null
  return (
    <div
      role="note"
      data-turn-changes={summary.files}
      data-turn-changes-maybe={summary.maybe || undefined}
      data-turn-changes-settling={summary.settling || undefined}
      title={summary.settling ? "Still settling: a change heard as the turn ended may yet be counted" : undefined}
      className="flex h-7 min-w-0 max-w-full items-center gap-2 text-ui"
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
      {summary.maybe > 0 ? (
        <>
          <span aria-hidden className="shrink-0 text-faint">·</span>
          <span
            data-turn-changes-maybe-label=""
            title="Changed while this turn ran, but nothing ties them to the agent: a save of yours or another app's fits as well. They aren't counted as the turn's."
            className="shrink-0 cursor-default text-faint"
          >
            {maybeWords(summary.maybe)}
          </span>
        </>
      ) : null}
      {workspace ? (
        <>
          <span aria-hidden className="shrink-0 text-faint">·</span>
          <button
            type="button"
            data-review-turn=""
            title="Review what this turn changed in Changes"
            onClick={() => {
              // The words the turn answered name it in the scope menu; read once, on the click.
              const live = acpStore.get().conversations[conversation]
              const request = live?.kind === "live" ? live.requests?.find((each) => each.id === requestId) : undefined
              const text = request ? (request.displayText ?? request.text) : ""
              reviewTurn(workspace, { conversation, requestId, prompt: text.replace(/\s+/g, " ").trim() })
            }}
            className="pressable -mx-1 shrink-0 rounded px-1 text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground focus-visible:text-foreground"
          >
            Review
          </button>
        </>
      ) : null}
    </div>
  )
}
