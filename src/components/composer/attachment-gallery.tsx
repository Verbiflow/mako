import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { Attachment } from "@/lib/attachments"
import type { FileContents } from "@/lib/types"
import { readTranscriptFile } from "@/state/transcript-media"
import { useTranscriptSource } from "@/components/transcript/source-context"
import { AssetPreviewContext, type AssetView } from "@/components/viewer/asset-preview-context"
import { ExpandedFilePreview } from "@/components/viewer/expanded-file-preview"

/** Keeps composer thumbnails/popovers, with a single expanded owner for the draft. */
export function AttachmentGallery({ items, render }: { items: Attachment[]; render(item: Attachment): ReactNode }) {
  const host = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<string>()
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState<{ id: string; file?: FileContents; mode: AssetView; error?: string }>()
  const index = items.findIndex(item => item.id === selected)
  const item = items[index]
  const context = useTranscriptSource()
  useEffect(() => {
    if (!open || !item || ready?.id === item.id && ready.file) return
    let current = true
    const publish = (file: FileContents) => { if (current) setReady({ id: item.id, file, mode: "preview" }) }
    if (item.stagedPath) {
      void readTranscriptFile({ path: item.stagedPath, liveId: context.liveId, threadPath: context.threadPath }).then(publish, () => { if (current) setReady({ id: item.id, mode: "preview", error: "This file could not be read. Reattach it to try again." }) })
    } else if (item.text !== undefined) publish({ path: item.name, contents: item.text, mimeType: item.mimeType, binary: false, truncated: false, size: item.size ?? new TextEncoder().encode(item.text).length })
    else if (item.preview || item.data) publish({ path: item.name, contents: "", previewUrl: item.preview ?? `data:${item.mimeType};base64,${item.data}`, mimeType: item.mimeType, binary: true, truncated: false, size: item.size ?? 0 })
    return () => { current = false }
  }, [open, item, context.liveId, context.threadPath, ready?.id, ready?.file])
  const resolved = useCallback((id: string, file: FileContents | undefined, mode: AssetView) => {
    setReady(previous => previous?.id === id && previous.file === file && previous.mode === mode ? previous : { id, file, mode })
  }, [])
  const current = ready?.id === item?.id ? ready : undefined
  return <div ref={host} className="contents">
    {items.map(asset => <GalleryItem key={asset.id} item={asset} open={open} select={setSelected} setOpen={setOpen} resolved={resolved}>{render(asset)}</GalleryItem>)}
    <ExpandedFilePreview file={current?.file} error={current?.error ?? item?.error} identity={item?.id} name={item?.name ?? "Attachment"} mode={current?.mode} open={open && !!item} onOpenChange={setOpen} navigation={item ? { index, count: items.length, previous: () => setSelected(items[index - 1]?.id), next: () => setSelected(items[index + 1]?.id) } : undefined} focusTarget={() => {
      const selectedTile = [...(host.current?.querySelectorAll<HTMLElement>('[data-draft-asset]') ?? [])].find(node => node.dataset.draftAsset === item?.id)
      return selectedTile?.querySelector<HTMLButtonElement>('button[data-slot="popover-trigger"]') ?? null
    }} />
  </div>
}

function GalleryItem({ item, open, select, setOpen, resolved, children }: {
  item: Attachment; open: boolean; select(id: string): void; setOpen(open: boolean): void
  resolved(id: string, file: FileContents | undefined, mode: AssetView): void
  children: ReactNode
}) {
  const report = useCallback((file: FileContents | undefined, mode: AssetView) => resolved(item.id, file, mode), [item.id, resolved])
  const owner = useMemo(() => ({ enlarged: open, setEnlarged: setOpen, resolved: report }), [open, setOpen, report])
  return <AssetPreviewContext value={owner}><div data-draft-asset={item.id} className="contents" onClickCapture={() => select(item.id)}>{children}</div></AssetPreviewContext>
}
