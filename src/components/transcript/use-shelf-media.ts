import { useMemo } from "react"
import type { MediaCandidate } from "@mako/sessions/turn-media"
import type { Exchange } from "@/lib/exchanges"
import { shelfMedia } from "@/lib/media-shelf"
import { useAcp } from "@/state/acp"
import { useTranscriptSource } from "./source-context"

/**
 * The media a turn made that its answer doesn't already show: screenshots
 * a command saved, a recording, a page it wrote, an image a tool returned
 * inside a folded row. Read from the turn's records (`callMedia`) and its
 * record of changes, so the same live and saved, and filled as calls
 * finish while the turn runs. The exchange draws each where it was made
 * (`placeMadeMedia`).
 */
export function useShelfMedia(exchange: Exchange): MediaCandidate[] {
  const { liveId } = useTranscriptSource()
  const requestId = exchange.prompt?.requestId
  // The turn's record of changes: every file it left, however it wrote it, the same live and reopened.
  const changes = useAcp((state) => {
    const live = liveId ? state.conversations[liveId] : undefined
    return live?.kind === "live" && requestId ? live.requests?.find((each) => each.id === requestId)?.changes : undefined
  })
  return useMemo(() => shelfMedia(exchange, changes), [exchange, changes])
}
