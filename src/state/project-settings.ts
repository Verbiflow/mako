import { useMemo, type ComponentType } from "react"
import { toast } from "sonner"
import type { ProjectSettingsView } from "@mako/host/contracts/project-settings"
import { getMako, hasBridge } from "@/lib/bridge"
import { threadFolderKey, type FolderMap } from "@/lib/thread-folders"
import type { ThreadRef } from "@/lib/types"
import { desktop } from "@/state/desktop"
import { prefsStore, usePrefs } from "@/state/prefs"
import { createHook, createStore } from "@/state/store"
import { useThreads } from "@/state/thread-store"
import { useWorktrees } from "@/state/worktrees"

/** The Settings section for each project's own settings; its id is part of the `mako:settings` deep link. */
export const PROJECTS_SECTION = "projects"

/** Projects listed, the ones worked in most recently first. */
const LISTED = 40

/**
 * What every project shares, drawn in Settings › Projects above the list: the folder new projects are cloned into
 * belongs here once the Open project… flow has it. Each part is a component of its own, added to this list where it's
 * built.
 */
export const PROJECTS_DEFAULTS: readonly ComponentType[] = []

interface ProjectSettingsState {
  /** The project Settings › Projects shows, by its folder; none shows the list. */
  chosen?: string
}

export const projectSettingsStore = createStore<ProjectSettingsState>({})
export const useProjectSettingsChoice = createHook(projectSettingsStore)

/** Settings, open on one project's page, or on the list of them. */
export function openProjectSettings(root?: string): void {
  projectSettingsStore.set({ chosen: root })
  window.dispatchEvent(new CustomEvent("mako:settings", { detail: PROJECTS_SECTION }))
}

/** The folders the rail files Threads under, by when they were last worked in, newest first. */
export function projectRoots(refs: readonly ThreadRef[], folderMap: FolderMap): string[] {
  const latest = new Map<string, number>()
  for (const ref of refs) {
    if (ref.workspaceMissing) continue
    const root = threadFolderKey(ref, folderMap)
    if (!root || !root.startsWith("/")) continue
    const at = Date.parse(ref.updatedAt ?? ref.startedAt ?? "") || 0
    latest.set(root, Math.max(latest.get(root) ?? 0, at))
  }
  return [...latest].sort((a, b) => b[1] - a[1]).slice(0, LISTED).map(([root]) => root)
}

/** The projects the rail files Threads under, the ones worked in most recently first. */
export function useProjectRoots(): string[] {
  const refs = useThreads((state) => state.threads)
  const folderMap = useWorktrees((state) => state.folderMap)
  return useMemo(() => projectRoots(refs, folderMap), [refs, folderMap])
}

/** Every project: those the rail lists, and those the person hid from it, as Settings › Projects groups them. */
export function useProjectGroups(): { active: string[]; hidden: string[] } {
  const roots = useProjectRoots()
  const hidden = usePrefs((prefs) => prefs.hiddenProjects)
  return useMemo(() => ({ active: roots.filter((root) => !hidden.includes(root)), hidden }), [roots, hidden])
}

export function readProjectSettings(folder: string): Promise<ProjectSettingsView | null> {
  return hasBridge() ? getMako().projectSettings(folder) : Promise.resolve(null)
}

/** The branch new Threads in `folder` start from; null: Mako's own rule. Answers the project's settings after. */
export function saveProjectBase(folder: string, baseBranch: string | null): Promise<ProjectSettingsView> {
  return getMako().saveProjectSettings(folder, { baseBranch })
}

/**
 * Open settings file: the file where the host keeps the person's settings that follow them between devices
 * (`<user root>/preferences.json`, `PreferenceStore`), in their editor, as Settings › Editor chooses it. The window's
 * own layout and choices aren't in a file; they're the window's storage.
 */
export async function openSettingsFile(): Promise<void> {
  if (!hasBridge()) return
  try {
    const file = await getMako().preferencesFile()
    await desktop.openInEditor(file, prefsStore.get().externalEditor)
  } catch (error) {
    toast("The settings file didn't open", { description: error instanceof Error ? error.message : String(error) })
  }
}
