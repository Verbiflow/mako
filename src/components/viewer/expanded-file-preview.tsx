import { lazy, Suspense, useState, useRef } from "react"
import { XIcon } from "lucide-react"
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { FileTypeIcon } from "@/components/ui/file-type-icon"
import type { FileContents } from "@/lib/types"

const RichFilePreview = lazy(() => import("./rich-file-preview"))

/** A single expanded renderer; callers suspend the inline body while it is open. */
export function ExpandedFilePreview({ file, name, mode, open, onOpenChange, focusTarget }: {
  file: FileContents
  name: string
  mode?: "preview" | "source"
  open: boolean
  onOpenChange(open: boolean): void
  focusTarget?(): HTMLElement | null
}) {
  const returnFocus = useRef<HTMLElement>(null)
  const [selectedMode, setSelectedMode] = useState(mode ?? "preview")
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent overlayClassName="z-60" className="z-60 flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col overflow-hidden p-0" data-expanded-file-preview={name} onOpenAutoFocus={() => {
      const active = document.activeElement
      if (active instanceof HTMLElement) returnFocus.current = active.closest("[data-inline-file-preview], [data-inline-document]")?.querySelector<HTMLButtonElement>(`button[title="Expand preview"]`) ?? active
    }} onCloseAutoFocus={(event) => {
      event.preventDefault()
      const target = focusTarget?.() ?? returnFocus.current
      if (target?.isConnected) target.focus({ preventScroll: true })
    }}>
      <div className="flex min-w-0 shrink-0 items-center gap-3 border-b border-hairline px-4 py-3">
        <FileTypeIcon path={name} mimeType={file.mimeType} className="size-4 shrink-0 text-muted-foreground" />
        <DialogTitle className="min-w-0 flex-1 truncate">{name}</DialogTitle>
        {!file.binary ? <div className="flex gap-1 text-label" aria-label="Document view">
          {(["preview", "source"] as const).map((value) => <button key={value} type="button" aria-pressed={selectedMode === value} onClick={() => setSelectedMode(value)} className={`pressable rounded-md px-2 py-1 ${selectedMode === value ? "bg-fill-selected text-foreground" : "text-muted-foreground hover:bg-fill-hover"}`}>{value === "preview" ? "Preview" : "Source"}</button>)}
        </div> : null}
        <DialogClose aria-label="Close preview" className="pressable rounded-md p-1.5 text-muted-foreground hover:bg-fill-hover hover:text-foreground">
          <XIcon className="size-4" />
        </DialogClose>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {open ? <Suspense fallback={<p role="status" className="p-4 text-ui text-faint">Loading preview…</p>}>
          <RichFilePreview file={file} name={name} mode={selectedMode} expanded />
        </Suspense> : null}
      </div>
    </DialogContent>
  </Dialog>
}
