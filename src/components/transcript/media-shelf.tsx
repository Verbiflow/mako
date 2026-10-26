import { memo, useMemo } from "react"
import type { AttachmentContent } from "@mako/sessions"
import type { MediaCandidate } from "@mako/sessions/turn-media"
import { visualAsset, type MediaSize } from "@/components/viewer/media-tile-layout"
import { mediaAttachment, mediaSize } from "@/lib/media-shelf"
import { mediaCheck, useMediaAnswers } from "@/state/turn-media"
import { TranscriptAttachments } from "./attachment-collection"
import { useVisible } from "./use-visible"

/**
 * Media in the conversation, where the turn made it or the agent showed
 * it: pictures and videos as themselves, a page as the page, each caption
 * under what it captions. No heading: it reads as part of the answer. The
 * host is asked about nothing until it is near the screen; what it already
 * answered draws at once, so a turn scrolled back into view holds its place.
 */
export const TurnMedia = memo(function TurnMedia({ media, shown }: { media: readonly MediaCandidate[]; shown?: boolean }) {
  const { ref, visible } = useVisible()
  const checks = useMemo(() => media.map(mediaCheck), [media])
  const answers = useMediaAnswers(checks, visible)
  const groups = useMemo(() => {
    const drawn: Drawn[] = []
    for (const [index, candidate] of media.entries()) {
      const attachment = mediaAttachment(candidate, answers[index])
      if (attachment) drawn.push({ attachment, caption: shown ? candidate.caption : undefined, size: mediaSize(answers[index]) })
    }
    // `show`'s heading reads as the caption of what it showed when nothing has its own.
    const title = shown && !drawn.some((each) => each.caption) ? media.find((candidate) => candidate.title)?.title : undefined
    return drawnGroups(drawn, title)
  }, [media, answers, shown])
  return (
    // Its label is for a screen reader only: on screen it reads as part of the answer.
    <div ref={ref} role="group" aria-label={shown ? "Shown by the agent" : "Made in this turn"} data-turn-media={shown ? "shown" : "made"} className="flex flex-col gap-4 empty:-mt-4 [&_[data-asset-collection]]:my-0 [&_[data-inline-file-preview]]:my-0">
      {groups.map((group) => (
        <TranscriptAttachments
          key={group.items[0]!.attachment.id ?? group.items[0]!.attachment.name}
          attachments={group.items.map((each) => each.attachment)}
          captions={group.items.some((each) => each.caption) ? group.items.map((each) => each.caption) : undefined}
          sizes={group.items.map((each) => each.size)}
          caption={group.caption}
          open
        />
      ))}
    </div>
  )
}, (before, after) => before.shown === after.shown && sameMedia(before.media, after.media))

/**
 * Whether two readings of a turn's media say the same: a streaming turn
 * reads them again with each token, as new objects, and a token must not
 * redraw what it made.
 */
function sameMedia(before: readonly MediaCandidate[], after: readonly MediaCandidate[]): boolean {
  return before === after || (before.length === after.length && before.every((candidate, index) => {
    const other = after[index]!
    return candidate.key === other.key && candidate.callId === other.callId && candidate.evidence === other.evidence && candidate.digest === other.digest
      && candidate.caption === other.caption && candidate.title === other.title && candidate.attachment === other.attachment
      && candidate.startedAt === other.startedAt && candidate.endedAt === other.endedAt
  }))
}

interface Drawn {
  attachment: AttachmentContent
  caption?: string
  size?: MediaSize
}

interface DrawnGroup {
  items: Drawn[]
  caption?: string
}

/**
 * The media as it is drawn, in the order the turn made it: pictures and
 * videos together where the first of them stands, as one picture or a
 * grid, and each page, document or recording of sound open on its own. Mixed in one collection they would be a row of closed chips, and the
 * person would see none of what the turn made without a click. `caption`
 * goes under the first group.
 */
function drawnGroups(drawn: readonly Drawn[], caption: string | undefined): DrawnGroup[] {
  const groups: DrawnGroup[] = []
  let visual: DrawnGroup | undefined
  for (const each of drawn) {
    const { attachment } = each
    const asset = { id: attachment.id ?? attachment.name, name: attachment.name, mimeType: attachment.mimeType, path: attachment.source.kind === "file" ? attachment.source.path : undefined }
    if (!visualAsset(asset)) groups.push({ items: [each] })
    else if (visual) visual.items.push(each)
    else groups.push((visual = { items: [each] }))
  }
  if (groups[0] && caption) groups[0].caption = caption
  return groups
}
