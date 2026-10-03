import { lazy, Suspense, useMemo, useState, useRef } from "react"
import { ChevronDownIcon, ExpandIcon } from "lucide-react"
import { FileTypeIcon } from "@/components/ui/file-type-icon"
import { ExpandedFilePreview } from "@/components/viewer/expanded-file-preview"
import { toast } from "sonner"
import { downloadInlineDocument, inlineDocument } from "@/lib/inline-document"
import { formatBytes } from "@/lib/attachments"
const RichFilePreview = lazy(
  () => import("@/components/viewer/rich-file-preview")
)

export function InlineDocumentAttachment({
  name,
  mimeType,
  data,
}: {
  name: string
  mimeType: string
  data: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [inlineHeight, setInlineHeight] = useState(0)
  const changeEnlarged = (value: boolean) => {
    if (value) setInlineHeight(body.current?.getBoundingClientRect().height ?? 0)
    setEnlarged(value)
  }
  const [open, setOpen] = useState(false)
  const [enlarged, setEnlarged] = useState(false)
  const [mode, setMode] = useState<"preview" | "source">("preview")
  const result = useMemo(() => {
    if (!open) return undefined
    try {
      return { file: inlineDocument({ name, mimeType, data }) }
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "This attachment could not be previewed.",
      }
    }
  }, [open, name, mimeType, data])
  return (
    <div
      ref={host}
      className="not-prose my-3 overflow-hidden rounded-xl border border-hairline bg-surface text-ui"
      data-inline-document={name}
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <FileTypeIcon path={name} mimeType={mimeType} className="size-4 shrink-0 text-muted-foreground" />
        <button
          type="button"
          className="pressable flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-label={`Preview ${name}`}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="truncate font-medium">{name}</span>
          <ChevronDownIcon
            aria-hidden
            className={`size-3.5 shrink-0 text-faint transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        {result?.file ? <button type="button" aria-label={`Expand ${name}`} title="Expand preview" onClick={() => changeEnlarged(true)} className="pressable rounded p-1 text-muted-foreground hover:bg-fill-hover">
          <ExpandIcon className="size-3.5" />
        </button> : null}
        <button
          type="button"
          className="pressable rounded px-2 py-1 text-label text-muted-foreground hover:bg-fill-hover"
          onClick={() => {
            try {
              downloadInlineDocument({ name, mimeType, data })
            } catch (error) {
              toast.error(
                error instanceof Error
                  ? error.message
                  : "This attachment could not be downloaded."
              )
            }
          }}
        >
          Download
        </button>
        {result?.file ? (
          <span className="text-label text-faint tabular-nums">
            {formatBytes(result.file.size)}
          </span>
        ) : null}
      </div>
      {open ? (
        <div className="border-t border-hairline">
          {result?.error ? (
            <p role="status" className="p-4 text-ui text-muted-foreground">
              {result.error}
            </p>
          ) : result?.file ? (
            <>
              {!result.file.binary ? (
                <div className="flex gap-1 border-b border-hairline px-3 py-1.5 text-label">
                  {(["preview", "source"] as const).map((value) => (
                    <button
                      key={value}
                      aria-pressed={mode === value}
                      onClick={() => setMode(value)}
                      className={`pressable rounded px-2 py-1 ${mode === value ? "bg-fill-selected text-foreground" : "text-faint hover:bg-fill-hover"}`}
                    >
                      {value === "preview" ? "Preview" : "Source"}
                    </button>
                  ))}
                </div>
              ) : null}
              <Suspense
                fallback={
                  <p role="status" className="p-4 text-faint">
                    Loading preview…
                  </p>
                }
              >
                {!enlarged ? <div ref={body}><RichFilePreview file={result.file} name={name} mode={mode} onExpand={() => changeEnlarged(true)} /></div> : <div style={{ height: inlineHeight }} aria-hidden />}
              </Suspense>
            </>
          ) : null}
        </div>
      ) : null}
      {result?.file ? <ExpandedFilePreview file={result.file} name={name} mode={mode} open={enlarged} onOpenChange={changeEnlarged} focusTarget={() => host.current?.querySelector<HTMLButtonElement>('button[title="Expand preview"]') ?? null} /> : null}
    </div>
  )
}
