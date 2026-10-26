import { memo, useMemo } from "react"
import type { AttachmentContent } from "@mako/sessions"
import type { MediaCandidate } from "@mako/sessions/turn-media"
import { visualAsset } from "@/components/viewer/media-tile-layout"
import type { Exchange } from "@/lib/exchanges"
import { mediaAttachment, shelfMedia } from "@/lib/media-shelf"
import { useAcp } from "@/state/acp"
import { mediaCheck, useMediaAnswers } from "@/state/turn-media"
import { TranscriptAttachments } from "./attachment-collection"
import { useTranscriptSource } from "./source-context"
import { useVisible } from "./use-visible"

/**
 * The media a turn made that its answer doesn't already show: screenshots
 * a command saved, a recording, a page it wrote, an image a tool returned
 * inside a folded row. Read from the turn's records (`callMedia`), so the
 * same live and saved, and filled as calls finish while the turn runs.
 * Nothing is asked of the host until the turn is near the screen.
 */
export const MediaShelf = memo(function MediaShelf({ exchange }: { exchange: Exchange }) {
  const { liveId } = useTranscriptSource()
  const requestId = exchange.prompt?.requestId
  // The turn's record of changes: every file it left, however it wrote it, the same live and reopened.
  const changes = useAcp((state) => {
    const live = liveId ? state.conversations[liveId] : undefined
    return live?.kind === "live" && requestId ? live.requests?.find((each) => each.id === requestId)?.changes : undefined
  })
  const media = useMemo(() => shelfMedia(exchange, changes), [exchange, changes])
  const { ref, visible } = useVisible()
  if (!media.length) return null
  return (
    <div ref={ref} data-media-shelf className="mt-3">
      {visible ? <ConfirmedMedia media={media} label="Made in this turn" /> : null}
    </div>
  )
})

/**
 * What the agent put in front of the person with `show`, where it called it:
 * its heading, then each file with the agent's caption.
 */
export const ShownMedia = memo(function ShownMedia({ media }: { media: readonly MediaCandidate[] }) {
  const { ref, visible } = useVisible()
  const title = media.find((candidate) => candidate.title)?.title
  return (
    <div ref={ref} data-shown-media>
      {visible ? <ConfirmedMedia media={media} label={title} captioned /> : null}
    </div>
  )
})

function ConfirmedMedia({ media, label, captioned }: { media: readonly MediaCandidate[]; label?: string; captioned?: boolean }) {
  const checks = useMemo(() => media.map(mediaCheck), [media])
  const answers = useMediaAnswers(checks)
  const shown = useMemo(() => {
    const attachments = []
    const captions: (string | undefined)[] = []
    for (const [index, candidate] of media.entries()) {
      const attachment = mediaAttachment(candidate, answers[index])
      if (!attachment) continue
      attachments.push(attachment)
      captions.push(candidate.caption)
    }
    return { attachments, captions }
  }, [media, answers])
  const groups = useMemo(() => drawnGroups(shown.attachments, shown.captions), [shown])
  if (!shown.attachments.length) return null
  return (
    <section aria-label={label ?? "Media"} className="flex flex-col gap-2 [&_[data-asset-collection]]:my-0">
      {label ? <p className="text-label text-faint">{label}</p> : null}
      {groups.map((group) => (
        <TranscriptAttachments key={group.attachments[0]!.id ?? group.attachments[0]!.name} attachments={group.attachments} captions={captioned ? group.captions : undefined} open />
      ))}
    </section>
  )
}

/**
 * The media as it is drawn: pictures and videos together, as their grid,
 * then each page, document or recording of sound open on its own. Mixed in
 * one collection they would be a row of closed chips, and the person would
 * see none of what the turn made without a click.
 */
interface DrawnGroup {
  attachments: AttachmentContent[]
  captions: (string | undefined)[]
}

function drawnGroups(attachments: readonly AttachmentContent[], captions: readonly (string | undefined)[]): DrawnGroup[] {
  const visual: DrawnGroup = { attachments: [], captions: [] }
  const others: DrawnGroup[] = []
  attachments.forEach((attachment, index) => {
    const asset = { id: attachment.id ?? attachment.name, name: attachment.name, mimeType: attachment.mimeType, path: attachment.source.kind === "file" ? attachment.source.path : undefined }
    if (visualAsset(asset)) {
      visual.attachments.push(attachment)
      visual.captions.push(captions[index])
    } else others.push({ attachments: [attachment], captions: [captions[index]] })
  })
  return visual.attachments.length ? [visual, ...others] : others
}
