import { memo, useMemo } from "react"
import type { MediaCandidate } from "@mako/sessions/turn-media"
import type { Exchange } from "@/lib/exchanges"
import { mediaAttachment, shelfMedia } from "@/lib/media-shelf"
import { mediaCheck, useMediaAnswers } from "@/state/turn-media"
import { TranscriptAttachments } from "./attachment-collection"
import { useVisible } from "./use-visible"

/**
 * The media a turn made that its answer doesn't already show: screenshots
 * a command saved, a recording, a page it wrote, an image a tool returned
 * inside a folded row. Read from the turn's records (`callMedia`), so the
 * same live and saved, and filled as calls finish while the turn runs.
 * Nothing is asked of the host until the turn is near the screen.
 */
export const MediaShelf = memo(function MediaShelf({ exchange }: { exchange: Exchange }) {
  const media = useMemo(() => shelfMedia(exchange), [exchange])
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
  if (!shown.attachments.length) return null
  return (
    <section aria-label={label ?? "Media"} className="flex flex-col gap-2 [&_[data-asset-collection]]:my-0">
      {label ? <p className="text-label text-faint">{label}</p> : null}
      <TranscriptAttachments attachments={shown.attachments} captions={captioned ? shown.captions : undefined} open />
    </section>
  )
}
