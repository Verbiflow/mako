import { CopyIcon, DownloadIcon, EllipsisIcon, FileSymlinkIcon, FolderOpenIcon, ImageIcon } from "lucide-react"
import { toast } from "sonner"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { useTranscriptSource } from "@/components/transcript/source-context"
import { desktop } from "@/state/desktop"
import { useSession } from "@/state/session"
import { viewer } from "@/state/viewer"
import { copyImage, saveFile } from "@/lib/media-clipboard"
import { cn } from "@/lib/utils"
import type { FileContents } from "@/lib/types"

/**
 * What can be done with a picture or video the agent made: open it in a
 * tab, show it in the file manager, copy its path or the picture itself,
 * save a copy. Paths the answer gave relative show no file-manager row;
 * an inline attachment has no path at all.
 */
export function MediaActions({ file, name, path, className }: { file: FileContents; name: string; path?: string; className?: string }) {
  const source = useTranscriptSource()
  const fileManager = useSession((state) => state.machine.fileManager)
  const absolute = path && (path.startsWith("/") || path.startsWith("~/")) ? path : undefined
  const image = file.media === "image" || file.mimeType?.startsWith("image/")
  const url = file.previewUrl
  return (
    <Menu modal={false}>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${name}`}
          title="Actions"
          onClick={(event) => event.stopPropagation()}
          className={cn("pressable grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-fill-hover hover:text-foreground data-[state=open]:bg-fill-selected data-[state=open]:text-foreground", className)}
        >
          <EllipsisIcon className="size-4" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="min-w-44" onClick={(event) => event.stopPropagation()}>
        {path ? (
          <MenuItem onSelect={() => void viewer.open(path, undefined, source.threadPath, source.liveId)}>
            <FileSymlinkIcon className="size-3.5" />Open
          </MenuItem>
        ) : null}
        {absolute && fileManager ? (
          <MenuItem onSelect={() => void desktop.revealPath(absolute)}>
            <FolderOpenIcon className="size-3.5" />{fileManager === "finder" ? "Reveal in Finder" : "Show in folder"}
          </MenuItem>
        ) : null}
        {path ? (
          <MenuItem onSelect={() => void navigator.clipboard.writeText(path).then(() => toast("Path copied"))}>
            <CopyIcon className="size-3.5" />Copy path
          </MenuItem>
        ) : null}
        {path && url ? <MenuSeparator /> : null}
        {image && url ? (
          <MenuItem onSelect={() => void copyImage(url).then(() => toast("Image copied"), () => toast("This image couldn't be copied"))}>
            <ImageIcon className="size-3.5" />Copy image
          </MenuItem>
        ) : null}
        {url ? (
          <MenuItem onSelect={() => saveFile(url, name)}>
            <DownloadIcon className="size-3.5" />Save…
          </MenuItem>
        ) : null}
      </MenuContent>
    </Menu>
  )
}
