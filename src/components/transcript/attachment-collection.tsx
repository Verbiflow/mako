import type { AttachmentContent } from "@mako/sessions"
import { AssetPreviewCollection } from "@/components/viewer/asset-preview-collection"
import { TranscriptAttachment } from "./attachment"
import { InlineFilePreview } from "./file-preview"

/** Native blocks share the same collection as file links, regardless of harness. */
export function TranscriptAttachments({ attachments }: { attachments: AttachmentContent[] }) {
  if (attachments.length === 1) return <div data-copy-file={attachments[0].source.kind === "file" ? attachments[0].source.path : undefined}><TranscriptAttachment attachment={attachments[0]} /></div>
  return <AssetPreviewCollection items={attachments.map((attachment, index) => ({ id: attachment.id ?? `${index}:${attachment.name}`, name: attachment.name, mimeType: attachment.mimeType, path: attachment.source.kind === "file" ? attachment.source.path : undefined, attachment }))} render={item => <div data-copy-file={item.attachment.source.kind === "file" ? item.attachment.source.path : undefined}><TranscriptAttachment attachment={item.attachment} /></div>} />
}

/** A paragraph/list item remains a local group, including in the middle of a reply. */
export function FilePreviewCollection({ paths }: { paths: string[] }) {
  if (paths.length === 1) return <InlineFilePreview path={paths[0]} name={paths[0].split("/").at(-1) ?? paths[0]} />
  return <AssetPreviewCollection items={paths.map(path => ({ id: path, name: path.split("/").at(-1) ?? path, path }))} render={item => <InlineFilePreview path={item.path} name={item.name} initiallyOpen />} />
}
