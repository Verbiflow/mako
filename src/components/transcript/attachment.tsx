import { useAssetPreview } from "@/components/viewer/asset-preview-context"
import type { ReactNode } from "react"
import { useMemo } from "react"
import { InlineFilePreview } from "./file-preview"
import { InlineDocumentAttachment } from "./inline-document-attachment"
import {
  diagnosticFormat,
  filePreviewFormat,
  officeFormat,
} from "../../../electron/contracts/file-preview"
import type { AttachmentContent } from "@mako/sessions"
import { MediaPreview, MediaUnavailable } from "./media-preview"

export function TranscriptAttachment({
  attachment,
}: {
  attachment: AttachmentContent
}) {
  const { source, name, mimeType } = attachment
  const binaryFile = useMemo(() => ({ path: name, contents: "", previewUrl: source.kind === "inline" ? `data:${mimeType};base64,${source.data}` : source.kind === "url" ? source.url : undefined, mimeType, binary: true, truncated: false, size: 0 }), [source, name, mimeType])
  if (source.kind === "unavailable")
    return <MediaUnavailable name={name} reason={source.reason} />

  if (source.kind === "file")
    return (
      <InlineFilePreview path={source.path} name={name} mimeType={mimeType} />
    )

  if (/^(?:image|audio|video)\//i.test(mimeType))
    return <MediaPreview attachment={attachment} />
  const format = filePreviewFormat(name, mimeType)
  if (
    source.kind === "inline" &&
    (format === "markdown" ||
      format === "html" ||
      format === "table" ||
      format === "text" ||
      diagnosticFormat(name))
  )
    return (
      <InlineDocumentAttachment
        name={name}
        mimeType={mimeType}
        data={source.data}
      />
    )
  const url =
    source.kind === "inline"
      ? `data:${mimeType};base64,${source.data}`
      : source.url
  const office = officeFormat(name, mimeType)
  if (office && (source.kind === "inline" || /^https?:/i.test(url)))
    return (
      <InlineFilePreview path={name} name={name} mimeType={mimeType} initiallyOpen sizeKnown={false} resolvedFile={binaryFile} />
    )
  const safe =
    /^(?:https?:|data:(?:image|audio|video)\/|data:application\/pdf;base64,)/i.test(
      url
    )
  if (source.kind === "inline" && !safe)
    return (
      <AttachmentDownload>
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
      </AttachmentDownload>
    )
  if (mimeType === "application/pdf" && safe)
    return (
      <InlineFilePreview path={name} name={name} mimeType={mimeType} initiallyOpen sizeKnown={false} resolvedFile={binaryFile} />
    )
  if (!safe)
    return (
      <MediaUnavailable
        name={name}
        reason="This link type can't be previewed"
      />
    )
  return (
    <AttachmentDownload>
    <a
      href={url}
      download={name}
      target="_blank"
      rel="noreferrer"
      className="text-ui underline"
    >
      {name}
    </a>
    </AttachmentDownload>
  )
}

function AttachmentDownload({ children }: { children: ReactNode }) {
  useAssetPreview(undefined, "preview", "No inline preview for this format. Close the gallery to open or download the file.")
  return children
}
