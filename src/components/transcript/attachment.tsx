import type { AttachmentContent } from "@mako/sessions"
import { MediaPreview, MediaUnavailable } from "./media-preview"
import { viewer } from "@/state/viewer"
import { useTranscriptSource } from "./source-context"

export function TranscriptAttachment({
  attachment,
}: {
  attachment: AttachmentContent
}) {
  const context = useTranscriptSource()
  const { source, name, mimeType } = attachment
  if (source.kind === "unavailable")
    return <MediaUnavailable name={name} reason={source.reason} />

  if (/^(?:image|audio|video)\//i.test(mimeType))
    return <MediaPreview attachment={attachment} />
  if (source.kind === "file")
    return (
      <button
        className="pressable rounded border border-hairline px-2 py-1 text-ui text-foreground"
        onClick={() =>
          void viewer.open(
            source.path,
            undefined,
            context.threadPath,
            context.liveId
          )
        }
      >
        {name}
      </button>
    )
  const url =
    source.kind === "inline"
      ? `data:${mimeType};base64,${source.data}`
      : source.url
  const safe =
    /^(?:https?:|data:(?:image|audio|video)\/|data:application\/pdf;base64,)/i.test(
      url
    )
  if (source.kind === "inline" && !safe)
    return (
      <button
        className="pressable text-ui underline"
        onClick={() => {
          const bytes = Uint8Array.from(atob(source.data), (character) =>
            character.charCodeAt(0)
          )
          const href = URL.createObjectURL(
            new Blob([bytes], { type: mimeType })
          )
          const link = document.createElement("a")
          link.href = href
          link.download = name
          link.click()
          setTimeout(() => URL.revokeObjectURL(href), 1000)
        }}
      >
        Download {name}
      </button>
    )
  if (!safe)
    return (
      <MediaUnavailable name={name} reason="This link type can't be previewed" />
    )
  return (
    <a
      href={url}
      download={name}
      target="_blank"
      rel="noreferrer"
      className="text-ui underline"
    >
      {name}
    </a>
  )
}
