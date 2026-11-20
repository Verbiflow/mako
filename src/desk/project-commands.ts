import { registerCommand, registerCommands, type DeskCommand } from "@/extend/commands"
import { workspaceName } from "@/lib/format"
import { prefsStore } from "@/state/prefs"
import { openProjectSettings, openSettingsFile, projectRoots } from "@/state/project-settings"
import { threadsStore } from "@/state/thread-store"
import { worktreesStore } from "@/state/worktrees"

/** A per-project command's id starts with this; the palette lists them only for a query, as it does sessions. */
export const PROJECT_SETTINGS_COMMAND = "project-settings:"

const HOME = /^\/(?:Users|home)\/[^/]+(?=\/)/

/**
 * The palette's way into Settings: "Project settings: <name>" for every project the rail files Threads under or the
 * person hid from it, kept in step with that list, and "Open settings file".
 */
export function installProjectCommands(): () => void {
  const fixed = registerCommand({
    id: "view.settings-file",
    title: "Open settings file",
    section: "View",
    hint: "preferences.json, in your editor",
    keywords: "settings preferences json config file edit",
    run: openSettingsFile,
  })
  let listed = ""
  let read: readonly unknown[] = []
  let dispose: () => void = () => {}
  const sync = () => {
    // Read again only when what the list is made of changed, not on every change to those stores.
    const from = [threadsStore.get().threads, worktreesStore.get().folderMap, prefsStore.get().hiddenProjects]
    if (from.every((part, index) => part === read[index])) return
    read = from
    const roots = [...new Set([...projectRoots(threadsStore.get().threads, worktreesStore.get().folderMap), ...prefsStore.get().hiddenProjects])]
    const key = roots.join("\n")
    if (key === listed) return
    listed = key
    dispose()
    dispose = registerCommands(roots.map((root): DeskCommand => ({
      id: `${PROJECT_SETTINGS_COMMAND}${root}`,
      title: `Project settings: ${workspaceName(root)}`,
      section: "Workspace",
      hint: root.replace(HOME, "~"),
      keywords: "project settings base branch scripts environment repository",
      run: () => openProjectSettings(root),
    })))
  }
  sync()
  const stops = [threadsStore.subscribe(sync), worktreesStore.subscribe(sync), prefsStore.subscribe(sync)]
  return () => {
    for (const stop of stops) stop()
    dispose()
    fixed()
  }
}
