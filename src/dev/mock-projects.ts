import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import {
  clonePercent,
  githubRepository,
  type BrowsedFolder,
  type CloneAccepted,
  type CloneRequest,
  type CloneState,
  type CreateProjectRequest,
  type FolderBrowse,
  type FolderBrowseRequest,
  type FoundCheckouts,
  type FoundCheckoutsRequest,
} from "@mako/host/contracts/projects"

const HOME = "/Users/you"

interface MockFolder {
  git?: boolean
  remote?: string
  branch?: string
  touched?: number
}

/**
 * A home folder for Open project in the mock desk: the fixture's projects, a few checkouts Mako hasn't seen, and
 * clones that report progress as Git's does. `?found=refused` has macOS keep the scan out of Documents;
 * `?found=slow` keeps the scan going for two seconds.
 */
export function mockProjects(emit: (event: HostEvent) => void) {
  const params = new URLSearchParams(globalThis.location?.search)
  const hour = 3_600_000
  const folders = new Map<string, MockFolder>([
    [HOME, {}],
    [`${HOME}/api`, { git: true, remote: "acme/api", branch: "billing-webhook-retries", touched: Date.now() - 2 * hour }],
    [`${HOME}/mako`, { git: true, remote: "acme/mako", branch: "main", touched: Date.now() - hour }],
    [`${HOME}/site`, { git: true, remote: "acme/site", branch: "pricing-table", touched: Date.now() - 20 * hour }],
    [`${HOME}/code`, {}],
    [`${HOME}/code/harbor`, { git: true, remote: "you/harbor", branch: "main", touched: Date.now() - 3 * hour }],
    [`${HOME}/code/lantern`, { git: true, remote: "acme/lantern", branch: "release-2.4", touched: Date.now() - 26 * hour }],
    [`${HOME}/code/lantern/docs`, {}],
    [`${HOME}/code/lantern/src`, {}],
    [`${HOME}/code/ocean-ui`, { git: true, remote: "acme/ocean-ui", branch: "main", touched: Date.now() - 50 * hour }],
    [`${HOME}/code/dotfiles`, { git: true, branch: "main", touched: Date.now() - 400 * hour }],
    [`${HOME}/code/notes`, {}],
    [`${HOME}/code/scratch`, {}],
    [`${HOME}/Desktop`, {}],
    [`${HOME}/Documents`, {}],
    [`${HOME}/Downloads`, {}],
    [`${HOME}/Mako`, {}],
    [`${HOME}/Mako/Chats`, {}],
    [`${HOME}/.config`, {}],
  ])
  const clones = new Map<string, ReturnType<typeof setTimeout>>()

  const expand = (text: string, base = HOME) => {
    const trimmed = text.trim()
    const joined = trimmed === "~" ? HOME : trimmed.startsWith("~/") ? `${HOME}/${trimmed.slice(2)}` : trimmed.startsWith("/") ? trimmed : `${base}/${trimmed}`
    const parts: string[] = []
    for (const part of joined.split("/")) {
      if (!part || part === ".") continue
      if (part === "..") parts.pop()
      else parts.push(part)
    }
    return `/${parts.join("/")}`
  }
  const children = (folder: string) => [...folders.keys()].filter((path) => path !== folder && path.startsWith(`${folder === "/" ? "" : folder}/`) && !path.slice(folder.length + 1).includes("/"))
  const describe = (path: string) => {
    const folder = folders.get(path)
    if (!folder) return { path, kind: "missing" as const, git: false }
    return { path, kind: "folder" as const, git: Boolean(folder.git), repository: folder.remote }
  }
  const found = (within: string[]): FoundCheckouts => {
    const guarded = ["Desktop", "Documents", "Downloads"].map((name) => `${HOME}/${name}`)
    const refused = params.get("found") === "refused" ? [`${HOME}/Documents`] : []
    return {
      home: HOME,
      state: "ready",
      checkouts: [...folders]
        .filter(([, folder]) => folder.git)
        .map(([path, folder]) => ({ path, name: path.split("/").at(-1) ?? path, remote: folder.remote, branch: folder.branch, touchedAt: folder.touched ?? 0 }))
        .sort((a, b) => b.touchedAt - a.touchedAt),
      skipped: refused.length ? [] : guarded.filter((path) => !within.includes(path)),
      refused,
    }
  }
  let scanned = false

  return {
    browseFolders: async ({ partialPath, base }: FolderBrowseRequest): Promise<FolderBrowse> => {
      const path = expand(partialPath, base)
      const after = partialPath.trim().endsWith("/") || partialPath.trim() === "~"
      const folder = after ? path : path.split("/").slice(0, -1).join("/") || "/"
      const prefix = after ? "" : (path.split("/").at(-1) ?? "")
      const entries: BrowsedFolder[] = children(folder)
        .map((child) => ({ name: child.split("/").at(-1) ?? child, path: child, git: Boolean(folders.get(child)?.git) }))
        .filter((entry) => (prefix.startsWith(".") || !entry.name.startsWith(".")) && entry.name.toLowerCase().startsWith(prefix.toLowerCase()) && entry.name !== prefix)
        .sort((a, b) => a.name.localeCompare(b.name))
      return { home: HOME, folder, listed: folders.has(folder), entries, exact: describe(path) }
    },
    foundCheckouts: async ({ within }: FoundCheckoutsRequest): Promise<FoundCheckouts> => {
      if (!scanned) {
        scanned = true
        setTimeout(() => emit({ type: "folders-found", found: found(within) }), params.get("found") === "slow" ? 2_000 : 300)
        return { home: HOME, state: "scanning", checkouts: [], skipped: [], refused: [] }
      }
      return found(within)
    },
    cloneProject: async ({ id, repository, into }: CloneRequest): Promise<CloneAccepted> => {
      const parsed = githubRepository(repository)
      if (!parsed) throw new Error("That isn't a GitHub repository. Paste its address, or type owner/name.")
      const label = `${parsed.owner}/${parsed.name}`
      const path = `${into}/${parsed.name}`
      const there = folders.get(path)
      if (there?.remote === label) return { path, already: true }
      if (there) throw new Error(`${path} already exists. Clone into another folder.`)
      const steps = [
        ...[0, 50, 100].map((percent) => ({ phase: "Counting objects", percent })),
        ...Array.from({ length: 21 }, (_, at) => ({ phase: "Receiving objects", percent: at * 5 })),
        ...[0, 50, 100].map((percent) => ({ phase: "Resolving deltas", percent })),
      ]
      const refuse = parsed.name.includes("private")
      let at = 0
      const send = (state: CloneState) =>
        emit({ type: "project-clone", clone: { id, repository: label, path, state } })
      const tick = () => {
        if (refuse && at === 4) {
          clones.delete(id)
          return send({ kind: "failed", signIn: true, message: `GitHub didn't let this Mac clone ${label}. If it's private, run gh auth login in Terminal, then try again.` })
        }
        const step = steps[at++]
        if (!step) {
          clones.delete(id)
          folders.set(path, { git: true, remote: label, branch: "main", touched: Date.now() })
          return send({ kind: "done", path })
        }
        send({ kind: "cloning", phase: step.phase, percent: clonePercent(step) })
        clones.set(id, setTimeout(tick, 150))
      }
      clones.set(id, setTimeout(tick, 100))
      return { path, already: false }
    },
    cancelClone: async (id: string) => {
      clearTimeout(clones.get(id))
      clones.delete(id)
    },
    createProject: async ({ path, git }: CreateProjectRequest) => {
      const full = expand(path)
      if (folders.has(full)) throw new Error(`${full} already exists. Open it, or pick another name.`)
      folders.set(full, { git, touched: Date.now() })
      return { path: full }
    },
  }
}
