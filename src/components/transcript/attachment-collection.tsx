import type { AttachmentContent } from "@mako/sessions"
import { AssetPreviewCollection } from "@/components/viewer/asset-preview-collection"
import type { MediaSize } from "@/components/viewer/media-tile-layout"
import { TranscriptAttachment } from "./attachment"
import { InlineFilePreview } from "./file-preview"

/**
 * Native blocks share the same collection as file links, regardless of
 * harness. `captions`, by index: the agent's words for each (`show`);
 * `sizes`, by index: each picture's pixels where known before it loads, so
 * its place is held; `caption`: the words for them all, under them; `open`:
 * each drawn open from the start (`TranscriptAttachment`).
 */
export function TranscriptAttachments({ attachments, captions, sizes, caption, open = false }: { attachments: AttachmentContent[]; captions?: readonly (string | undefined)[]; sizes?: readonly (MediaSize | undefined)[]; caption?: string; open?: boolean }) {
  const below = caption ? <figcaption className="text-ui text-muted-foreground">{caption}</figcaption> : null
  if (attachments.length === 1) {
    const words = captions?.[0] ?? caption
    return <figure className="m-0 flex flex-col gap-2" data-copy-file={attachments[0].source.kind === "file" ? attachments[0].source.path : undefined}><TranscriptAttachment attachment={attachments[0]} size={sizes?.[0]} open={open} />{words ? <figcaption className="text-ui text-muted-foreground">{words}</figcaption> : null}</figure>
  }
  const collection = <AssetPreviewCollection className={below ? "my-0" : undefined} items={attachments.map((attachment, index) => ({ id: attachment.id ?? `${index}:${attachment.name}`, name: attachment.name, caption: captions?.[index], mimeType: attachment.mimeType, path: attachment.source.kind === "file" ? attachment.source.path : undefined, size: sizes?.[index], attachment }))} render={item => <div data-copy-file={item.attachment.source.kind === "file" ? item.attachment.source.path : undefined}><TranscriptAttachment attachment={item.attachment} size={item.size} open={open} /></div>} />
  return below ? <figure className="m-0 flex flex-col gap-2">{collection}{below}</figure> : collection
}

/** A paragraph/list item remains a local group, including in the middle of a reply. */
export function FilePreviewCollection({ paths }: { paths: string[] }) {
  if (paths.length === 1) return <InlineFilePreview path={paths[0]} name={paths[0].split("/").at(-1) ?? paths[0]} purpose="preview" />
  return <AssetPreviewCollection items={paths.map(path => ({ id: path, name: path.split("/").at(-1) ?? path, path }))} render={item => <InlineFilePreview path={item.path} name={item.name} initiallyOpen purpose="preview" />} />
}
