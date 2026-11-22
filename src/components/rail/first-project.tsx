import { useEffect } from "react"
import { DownloadIcon, FolderGit2Icon, FolderOpenIcon } from "lucide-react"
import { Keys } from "@/components/ui/kit"
import { formatChord } from "@/extend/commands"
import { tildePath } from "@/lib/project-query"
import { loadFound, newFound, openProject, openProjectPalette, useOpenProject, useRecentProjects } from "@/state/open-project"
import { localWords } from "@mako/protocol/computer-words"

/** Found checkouts the empty rail offers. */
const OFFERED = 3

/**
 * The rail before any Thread: where to start, with the projects already on this Mac first, so the first project is
 * one click from a folder the person works in, never a trip through Finder.
 */
export function FirstProject() {
  const found = useOpenProject((state) => state.found)
  const home = useOpenProject((state) => state.home)
  const recent = useRecentProjects()
  useEffect(() => {
    void loadFound()
  }, [])
  const offered = newFound(found?.checkouts ?? [], recent).slice(0, OFFERED)
  const row = "pressable group flex h-9 w-full items-center gap-2.5 px-2.5 text-left text-ui text-muted-foreground transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
  return (
    <div data-first-project className="flex flex-col items-center gap-2 px-3 py-10 text-center">
      <div className="mb-1 flex size-8 items-center justify-center bg-raised text-faint [&_svg]:size-4">
        <FolderOpenIcon />
      </div>
      <p className="text-ui font-medium text-foreground">Open a project to start</p>
      <p className="max-w-[30ch] text-ui leading-relaxed text-faint">{localWords("Pick a folder you already work in. Mako finds the ones on this Mac.")}</p>
      <div className="mt-3 flex w-full flex-col gap-0.5">
        {offered.map((checkout) => (
          <button key={checkout.path} type="button" data-first-project-found={checkout.path} onClick={() => void openProject(checkout.path)} title={tildePath(checkout.path, home)} className={row}>
            <FolderGit2Icon className="size-3.5 shrink-0 text-faint group-hover:text-foreground/80" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{checkout.name}</span>
            <span className="shrink-0 text-label text-faint group-hover:text-foreground">Open</span>
          </button>
        ))}
        {found?.state === "scanning" && offered.length === 0 ? <p className="flex h-9 items-center px-2.5 text-label text-faint">{localWords("Looking for projects on this Mac…")}</p> : null}
        <button type="button" onClick={() => openProjectPalette()} className={row}>
          <FolderOpenIcon className="size-3.5 shrink-0 text-faint group-hover:text-foreground/80" aria-hidden />
          <span className="min-w-0 flex-1 truncate">Open project…</span>
          <Keys keys={formatChord("mod+o")} />
        </button>
        <button type="button" onClick={() => openProjectPalette({ mode: "clone" })} className={row}>
          <DownloadIcon className="size-3.5 shrink-0 text-faint group-hover:text-foreground/80" aria-hidden />
          <span className="min-w-0 flex-1 truncate">Clone from GitHub…</span>
        </button>
      </div>
    </div>
  )
}
