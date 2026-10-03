import { lazy, Suspense, useState, useRef } from "react"
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react"
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { FileTypeIcon } from "@/components/ui/file-type-icon"
import type { FileContents } from "@/lib/types"

const RichFilePreview = lazy(() => import("./rich-file-preview"))

/** A single expanded renderer; callers suspend the inline body while it is open. */
export function ExpandedFilePreview({ file, name, mode, open, onOpenChange, focusTarget, navigation, error, identity = name }: {
  file?: FileContents
  name: string
  identity?: string
  error?: string
  mode?: "preview" | "source"
  open: boolean
  onOpenChange(open: boolean): void
  focusTarget?(): HTMLElement | null
  navigation?: { index: number; count: number; previous(): void; next(): void }
}) {
  const returnFocus = useRef<HTMLElement>(null)
  const [view, setView] = useState({ open, identity, mode: mode ?? "preview" })
  if (view.open !== open || view.identity !== identity)
    setView({ open, identity, mode: open ? mode ?? "preview" : view.mode })
  const selectedMode = view.mode
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent overlayClassName="z-60" className="z-60 flex h-[min(76dvh,48rem)] w-[min(84vw,64rem)] max-w-none flex-col overflow-hidden p-0 asset-surface" onKeyDown={(event) => {
      if (!navigation || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const target = event.target
      // Document controls keep their own cursor, cell and playback shortcuts.
      if (!(target instanceof HTMLElement) || target.closest("input, textarea, select, video, audio, [contenteditable], [role=grid], canvas, iframe")) return
      if (event.key === "ArrowLeft" && navigation.index > 0) { event.preventDefault(); navigation.previous() }
      if (event.key === "ArrowRight" && navigation.index + 1 < navigation.count) { event.preventDefault(); navigation.next() }
    }} data-expanded-file-preview={name} onOpenAutoFocus={() => {
      const active = document.activeElement
      if (active instanceof HTMLElement) returnFocus.current = active.closest("[data-inline-file-preview], [data-inline-document]")?.querySelector<HTMLButtonElement>(`button[title="Expand preview"]`) ?? active
    }} onCloseAutoFocus={(event) => {
      event.preventDefault()
      const target = focusTarget?.() ?? returnFocus.current
      if (target?.isConnected) target.focus({ preventScroll: true })
    }}>
      <div className="flex min-w-0 shrink-0 items-center gap-3 border-b border-hairline px-4 py-3">
        <FileTypeIcon path={name} mimeType={file?.mimeType} className="size-4 shrink-0 text-muted-foreground" />
        <DialogTitle className="min-w-0 flex-1 truncate">{name}</DialogTitle>
        {file && !file.binary ? <div className="flex gap-1 text-label" aria-label="Document view">
          {(["preview", "source"] as const).map((value) => <button key={value} type="button" aria-pressed={selectedMode === value} onClick={() => setView({ open, identity, mode: value })} className={`pressable rounded-md px-2 py-1 ${selectedMode === value ? "bg-fill-selected text-foreground" : "text-muted-foreground hover:bg-fill-hover"}`}>{value === "preview" ? "Preview" : "Source"}</button>)}
        </div> : null}
        {navigation && navigation.count > 1 ? <div className="flex shrink-0 items-center gap-1 text-label">
          <button type="button" aria-label="Previous attachment" disabled={navigation.index === 0} onClick={navigation.previous} className="pressable p-1.5 text-muted-foreground hover:bg-fill-hover disabled:opacity-30"><ChevronLeftIcon className="size-4" /></button>
          <span className="px-1 tabular-nums text-faint">{navigation.index + 1} / {navigation.count}</span>
          <button type="button" aria-label="Next attachment" disabled={navigation.index + 1 === navigation.count} onClick={navigation.next} className="pressable p-1.5 text-muted-foreground hover:bg-fill-hover disabled:opacity-30"><ChevronRightIcon className="size-4" /></button>
        </div> : null}
        <DialogClose aria-label="Close preview" className="pressable rounded-md p-1.5 text-muted-foreground hover:bg-fill-hover hover:text-foreground">
          <XIcon className="size-4" />
        </DialogClose>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {open ? <Suspense fallback={<p role="status" className="p-4 text-ui text-faint">Loading preview…</p>}>
          {file ? <RichFilePreview key={identity} file={file} name={name} mode={selectedMode} expanded /> : <p role="status" className="p-4 text-ui text-faint">{error ?? `Reading ${name}…`}</p>}
        </Suspense> : null}
      </div>
    </DialogContent>
  </Dialog>
}
