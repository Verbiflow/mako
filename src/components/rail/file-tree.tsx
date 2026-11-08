import { useCallback, useMemo } from "react"
import { FolderIcon } from "lucide-react"
import { FilesBrowser } from "@/components/files/files-browser"
import { Blank } from "@/components/ui/kit"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { workspaceFiles } from "@/state/file-tree"
import { setPref, usePrefs } from "@/state/prefs"
import { useSession } from "@/state/session"
import { viewer, useViewer } from "@/state/viewer"

/**
 * The project, as a tree, in the right sidebar's Files.
 *
 * Its files come from the host's index of the workspace (`mako:files-folders`), a folder at a time, so a folder of
 * fifty thousand files opens as fast as one of five; the same field finds a file by name as it's typed and the lines
 * that mention the query a moment later. A cloud Thread's folder is answered by its machine.
 */
export function FileTree() {
  const focus = useWorkspaceFocus()
  const openDirs = usePrefs((prefs) => prefs.openDirs)
  const active = useViewer((state) => state.path)
  // Git's view of the folder moves with every change the watcher hears: the open folders are read again then.
  const gitChanged = useSession((state) => state.git)
  const source = useMemo(() => (focus.cwd ? workspaceFiles(focus.cwd) : undefined), [focus.cwd])
  const open = useMemo(() => new Set(openDirs), [openDirs])
  const onOpenChange = useCallback((next: string[]) => setPref("openDirs", next), [])
  const onOpenFile = useCallback((path: string, line?: number) => void viewer.open(path, line), [])
  const onMention = useCallback((path: string) => window.dispatchEvent(new CustomEvent("mako:insert", { detail: `@${path} ` })), [])

  if (!focus.ready || !source) {
    return <Blank icon={<FolderIcon />} title="Opening the project's files" body={focus.cwd} />
  }
  return (
    <FilesBrowser
      key={source.key}
      source={source}
      open={open}
      onOpenChange={onOpenChange}
      active={active}
      onOpenFile={onOpenFile}
      onMention={onMention}
      changed={gitChanged}
    />
  )
}
