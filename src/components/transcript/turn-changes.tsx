import { useEffect, useState } from "react"
import { FileDiffIcon } from "lucide-react"
import { LineCounts } from "@/components/inspector/change-marks"
import { turnChangeSummary, turnChangeWords, type TurnChangeSummary } from "@/lib/turn-changes"
import { acp, useAcp } from "@/state/acp"
import { acpStore } from "@/state/acp-state"
import { reviewTurn } from "@/state/review-scope"
import { useTranscriptSource } from "./source-context"
import { useVisible } from "./use-visible"

/** Turns whose changes stay held; a finished turn's never change, so each is read once while it's held. */
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
 * What the turn changed, under its answer: "Changed 4 files +120 −33 ·
 * Review". Only a live turn with checkpoints either side of it has this to
 * say; saved history and a turn without them draw nothing. The files are
 * read when the line nears the reading viewport, and the line takes its one
 * row only once they are, so a turn that changed nothing never grows.
 * Review opens Changes on that turn.
 */
export function TurnChanges({ requestId }: { requestId: string | undefined }) {
  const { liveId } = useTranscriptSource()
  // The repository its checkpoints saved, when both sides were saved: one string, so a token moves nothing here.
  const workspace = useAcp((state) => {
    const live = liveId ? state.conversations[liveId] : undefined
    const snapshots = live?.kind === "live" && requestId ? live.requests?.find((request) => request.id === requestId)?.snapshots : undefined
    return snapshots?.before.kind === "ready" && snapshots.after?.kind === "ready" ? snapshots.before.snapshot.scope : null
  })
  if (!liveId || !requestId || !workspace) return null
  // Mounted once the checkpoints are, so the line watches the viewport from its first frame.
  return <TurnChangesLine key={`${liveId}\0${requestId}`} conversation={liveId} requestId={requestId} workspace={workspace} />
}

function TurnChangesLine({ conversation, requestId, workspace }: { conversation: string; requestId: string; workspace: string }) {
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
      {summary && summary.files > 0 ? (
        <div role="note" className="flex h-7 min-w-0 max-w-full items-center gap-2 text-ui">
          <FileDiffIcon aria-hidden className="size-3.5 shrink-0 text-faint" />
          <span className="min-w-0 truncate text-muted-foreground">{turnChangeWords(summary.files)}</span>
          <LineCounts insertions={summary.insertions} deletions={summary.deletions} />
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
        </div>
      ) : null}
    </div>
  )
}
