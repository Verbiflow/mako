import { useEffect, useRef, useState } from "react"
import { responseSections } from "@/lib/exchanges"
import { StreamFrames } from "@/lib/stream-frames"
import { acpConversations, type AcpConversation } from "@/state/acp-state"
import { useTranscriptSource } from "./source-context"

/** The part that draws a turn's last block, for the turn as it was counted then: its parts are numbered by its messages and blocks alone. */
let writingPart: { turn: string; id: string | undefined } | undefined

/**
 * The text being written in `conversation`, where `answer` is the part that draws it: the newest block of the newest
 * reply of the newest turn (what `ExchangePacer` reads as the answer growing). A reply's prose is drawn a text block
 * to a part (`responseSections`), and every part of a reply still being written is streaming, so the part is told by
 * its id, not by its words: a reply whose earlier paragraph reads "Done." would otherwise take a last block that
 * begins "Done. Next" for its own. The id is read from the turn's sections once for each count of the turn's
 * messages and of its last one's blocks: text arriving changes neither.
 */
export function writtenSoFar(conversation: Pick<AcpConversation, "key" | "projection"> | undefined, answer: string): string | undefined {
  const exchange = conversation?.projection?.exchanges.at(-1)
  const message = exchange?.response.at(-1)
  const block = message?.blocks.at(-1)
  if (!exchange || !message || block?.type !== "text" || message.role !== "assistant") return undefined
  if (answer !== message.id && !answer.startsWith(`${message.id}-part-`)) return undefined
  const turn = `${conversation?.key}\n${exchange.id}\n${exchange.response.length}\n${message.id}\n${message.blocks.length}`
  if (writingPart?.turn !== turn) {
    const last = responseSections(exchange.response).findLast((section) => section.kind === "prose")
    writingPart = { turn, id: last?.kind === "prose" && last.message.blocks[0] === block ? last.id : undefined }
  }
  return writingPart.id === answer ? block.text : undefined
}

/**
 * A streaming text as its prose paints it: the latest, at most once a frame (`StreamFrames`: the first change of a
 * burst at once, a pending paint kept through later changes, stopped only by unmount, and stopping forgets it was
 * pending). A frame is short while the piece a paint parses is small, and longer as it grows (`streamFrameMs`): the
 * prose says through `parsed` how much its last paint parsed, the piece being written where the text is cut into
 * pieces (`streamPieces`).
 *
 * A reply being written (`answer`, in a live conversation) takes its words from the conversation as they land, not
 * from the turn's own draws. The transcript draws a growing answer at a pace (`ExchangePacer`), because every draw
 * runs the timeline and the turn again; the words need none of that. Each batch, and each line said ahead of one, is
 * heard here outside React and only sets what the next paint shows, so nothing renders for a line: a paint renders
 * this prose alone, which parses only the piece being written (`streamPieces`). Text reaches the page a frame after
 * the window hears it, however long the answer has grown. `text`, what the turn last drew of this part, is behind
 * those words or equal to them; where it says something else (a rewrite), it is what's painted.
 */
export function useStreamedText(text: string, active: boolean, answer?: string) {
  const { liveId } = useTranscriptSource()
  const [shown, setShown] = useState(text)
  const [frames] = useState(() => new StreamFrames(setShown))
  /** The newest text handed to a paint: the turn's own is taken only when it says more, or something else. */
  const latest = useRef(text)
  /**
   * How much of the text the last paint parsed (`parsed`, told by the prose once it has cut its pieces), and how long
   * the text was then: the next paint parses about that much and what has come since, and waits by it.
   */
  const piece = useRef({ chars: text.length, of: text.length })
  const [paint] = useState(() => (next: string) => {
    latest.current = next
    frames.next(next, piece.current.chars + Math.max(0, next.length - piece.current.of))
  })
  const [parsed] = useState(() => (chars: number) => {
    piece.current = { chars, of: latest.current.length }
  })

  // A settled message renders its exact text with no delay. Adjusting during
  // render rather than in an effect avoids the extra pass a cascading setState
  // would cost on the frame the turn completes.
  if (!active && shown !== text) {
    setShown(text)
  }

  // Settled, a paint still pending would draw a streaming text over it.
  useEffect(() => {
    if (!active) {
      latest.current = text
      frames.stop()
    } else if (!latest.current.startsWith(text) || text.length > latest.current.length || latest.current === text) {
      paint(text)
    }
  }, [active, text, frames, paint])

  useEffect(() => {
    if (!active || !liveId || !answer) return
    return acpConversations.subscribe(liveId, () => {
      const live = writtenSoFar(acpConversations.get(liveId), answer)
      if (live === undefined || live.length <= latest.current.length || !live.startsWith(latest.current)) return
      paint(live)
    })
  }, [active, liveId, answer, paint])

  useEffect(() => () => frames.stop(), [frames])

  return { shown, parsed }
}
