import { useRef, useState, type DragEvent, type ReactNode } from "react"
import { FolderOpenIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { takeDrop } from "@/state/open-project"
import { useCanChooseFolder } from "@/state/session"

/** Whether a drag carries files from outside the window: Finder's folders and files, not a row being dragged. */
function carriesFiles(event: DragEvent): boolean {
  return [...event.dataTransfer.types].includes("Files")
}

/**
 * A place a folder dragged from Finder opens as a project: the rail, the empty stage. While one is over it, the
 * place says what the drop does. A drop something inside took first (the composer's attach) is left to it.
 */
export function FolderDrop({ children, className, ...rest }: { children: ReactNode; className?: string } & Record<`data-${string}`, string | boolean | undefined>) {
  const enabled = useCanChooseFolder()
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  if (!enabled) return <div className={className} {...rest}>{children}</div>
  return (
    <div
      {...rest}
      className={cn("relative", className)}
      onDragEnter={(event) => {
        if (!carriesFiles(event) || event.defaultPrevented) return
        depth.current += 1
        setOver(true)
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event) || event.defaultPrevented) {
          if (event.defaultPrevented) setOver(false)
          return
        }
        event.preventDefault()
        event.dataTransfer.dropEffect = "copy"
      }}
      onDrop={(event) => {
        depth.current = 0
        setOver(false)
        if (event.defaultPrevented || !carriesFiles(event)) return
        const items = [...event.dataTransfer.items].flatMap((item) => {
          const file = item.kind === "file" ? item.getAsFile() : null
          return file ? [{ file, folder: item.webkitGetAsEntry()?.isDirectory ?? false }] : []
        })
        if (takeDrop(items)) event.preventDefault()
      }}
    >
      {children}
      {over ? (
        <div data-folder-drop aria-live="polite" className="pointer-events-none absolute inset-1.5 z-30 flex items-center justify-center bg-background/70">
          <span className="flex items-center gap-2 bg-raised px-3 py-2 text-ui text-foreground">
            <FolderOpenIcon className="size-3.5 text-faint" aria-hidden />
            Drop to open as a project
          </span>
        </div>
      ) : null}
    </div>
  )
}
