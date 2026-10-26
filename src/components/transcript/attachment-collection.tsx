import type { AttachmentContent } from "@mako/sessions"
import { AssetPreviewCollection } from "@/components/viewer/asset-preview-collection"
import { TranscriptAttachment } from "./attachment"
import { InlineFilePreview } from "./file-preview"

/** Native blocks share the same collection as file links, regardless of harness. `captions`, by index: the agent's words for each (`show`); `open`: each drawn open from the start (`TranscriptAttachment`). */
export function TranscriptAttachments({ attachments, captions, open = false }: { attachments: AttachmentContent[]; captions?: readonly (string | undefined)[]; open?: boolean }) {
  if (attachments.length === 1) return <figure className="m-0" data-copy-file={attachments[0].source.kind === "file" ? attachments[0].source.path : undefined}><TranscriptAttachment attachment={attachments[0]} open={open} />{captions?.[0] ? <figcaption className="mt-1.5 text-ui text-muted-foreground">{captions[0]}</figcaption> : null}</figure>
  return <AssetPreviewCollection items={attachments.map((attachment, index) => ({ id: attachment.id ?? `${index}:${attachment.name}`, name: attachment.name, caption: captions?.[index], mimeType: attachment.mimeType, path: attachment.source.kind === "file" ? attachment.source.path : undefined, attachment }))} render={item => <div data-copy-file={item.attachment.source.kind === "file" ? item.attachment.source.path : undefined}><TranscriptAttachment attachment={item.attachment} open={open} /></div>} />
}

/** A paragraph/list item remains a local group, including in the middle of a reply. */
export function FilePreviewCollection({ paths }: { paths: string[] }) {
  if (paths.length === 1) return <InlineFilePreview path={paths[0]} name={paths[0].split("/").at(-1) ?? paths[0]} purpose="preview" />
  return <AssetPreviewCollection items={paths.map(path => ({ id: path, name: path.split("/").at(-1) ?? path, path }))} render={item => <InlineFilePreview path={item.path} name={item.name} initiallyOpen purpose="preview" />} />
}
