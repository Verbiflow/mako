import { XIcon } from "lucide-react"
import { FileTypeIcon } from "@/components/ui/file-type-icon"
import { useState } from "react"
import { diagnosticFormat } from "../../../electron/contracts/file-preview"
import type { Attachment } from "@/lib/attachments"
import { formatBytes } from "@/lib/attachments"
import { InlineFilePreview } from "@/components/transcript/file-preview"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

export function FilePreviewTile({
  item,
  onRemove,
}: {
  item: Attachment
  onRemove(id: string): void
}) {
  const diagnostic = diagnosticFormat(item.name)
  const [open, setOpen] = useState(false)
  return (
    <div className="group relative shrink-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Show ${item.name}`}
            className="pressable flex h-14 w-60 items-center gap-3 overflow-hidden rounded-lg bg-raised px-3 text-left ring-1 ring-hairline ring-inset hover:ring-border focus-visible:outline focus-visible:outline-ring"
          >
            <FileTypeIcon path={item.name} mimeType={item.mimeType} className="size-5 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block truncate text-ui font-medium">
                {item.name}
              </span>
              <span className="block text-label text-faint">
                {diagnostic ? "Diagnostic file" : "Document"} ·{" "}
                {formatBytes(item.size)}
              </span>
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="max-h-[70vh] w-[min(48rem,calc(100vw-2rem))] overflow-auto p-0 [&>[data-inline-file-preview]]:my-0 [&>[data-inline-file-preview]]:border-0"
        >
          {open ? item.stagedPath ? (
            <InlineFilePreview
              path={item.stagedPath}
              name={item.name}
              mimeType={item.mimeType}
              initiallyOpen
            />
          ) : (
            <p className="p-3 text-ui text-faint">
              {item.error ?? "Adding file…"}
            </p>
          ) : null}
        </PopoverContent>
      </Popover>
      <button
        type="button"
        aria-label={`Remove ${item.name}`}
        onClick={() => onRemove(item.id)}
        className="pressable absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-popover text-faint opacity-0 shadow-[var(--elevation-floating)] group-hover:opacity-100 focus-visible:opacity-100"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}
