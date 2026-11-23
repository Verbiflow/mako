import { useEffect } from "react"
import { getMako, hasBridge } from "@/lib/bridge"
import { readProjectSettings } from "@/state/project-settings"
import { createHook, createStore } from "@/state/store"
import { windowRoutesStore } from "@/state/window-routes"

/**
 * A project's avatar on the rail: its GitHub owner's public picture when its `origin` is on GitHub, else none (the
 * rail draws the monogram). The window asks once per folder for the project's repository (`cloud` in its settings),
 * then the host for that owner's picture (`mako:repo-avatar`), which the host fetches from GitHub's public avatar
 * address and keeps on disk, so it's asked of GitHub once and shown offline after. Only the owner's name leaves the
 * Mac; a failure is a monogram, never a notice.
 */
interface RepoAvatars {
  /** By folder: the picture as a data URL, null for none, absent while unasked. */
  byFolder: Record<string, string | null>
}

export const repoAvatarsStore = createStore<RepoAvatars>({ byFolder: {} })
const useRepoAvatars = createHook(repoAvatarsStore)

const asked = new Set<string>()
/** By owner, so the projects of one owner ask the host once. */
const byOwner = new Map<string, Promise<string | undefined>>()

/** The owner of `owner/name`, when it's a GitHub login: letters, digits and single hyphens, at most 39. */
export function githubOwner(repository: string | null | undefined): string | undefined {
  const owner = repository?.split("/")[0]
  return owner && /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(owner) ? owner : undefined
}

async function resolve(folder: string): Promise<void> {
  let image: string | null = null
  try {
    const owner = githubOwner((await readProjectSettings(folder))?.cloud)
    if (owner) {
      let pending = byOwner.get(owner)
      if (!pending) {
        pending = getMako().repoAvatar(owner)
        byOwner.set(owner, pending)
      }
      image = (await pending) ?? null
    }
  } catch {
    image = null
  }
  repoAvatarsStore.set((state) => ({ byFolder: { ...state.byFolder, [folder]: image } }))
}

/** Asks for `folder`'s avatar once in this window. A window that routes holds no project of its own to ask about. */
export function askRepoAvatar(folder: string): void {
  if (asked.has(folder) || !hasBridge() || windowRoutesStore.get().routes) return
  asked.add(folder)
  void resolve(folder)
}

export function useRepoAvatar(folder: string): string | undefined {
  useEffect(() => askRepoAvatar(folder), [folder])
  // One owner's picture on several projects tells none of them apart: only a project alone under its owner wears it.
  return useRepoAvatars((state) => {
    const image = state.byFolder[folder]
    if (!image) return undefined
    for (const other in state.byFolder) if (other !== folder && state.byFolder[other] === image) return undefined
    return image
  })
}
