import { FileIndexCore, FOLDER_LISTING_LIMIT, type FileFindResults, type FileFolder, type FileFolders, type FileFoldersOptions, type FileGrepOptions, type FileGrepResults } from "@mako/host/contracts/file-index"
import { getMako } from "@/lib/bridge"

/**
 * The Files view's data, React-free: one model per place whose files are shown, holding the folders the tree has
 * open as their host listed them, a folder at a time.
 *
 * Where the files are is a `FilesSource`: this window's workspace on its own host (which answers a cloud Thread's
 * folder from that Thread's machine), or a conversation's folder on whichever computer runs it, for the web and the
 * phone. A host older than these calls is read once with `listFiles` and answered here by the same index.
 */

export interface FilesSource {
  /** Which files: a workspace's folder, or a conversation. A model is kept per key. */
  key: string
  folders(paths: string[], options?: FileFoldersOptions): Promise<FileFolders>
  find(query: string, limit?: number): Promise<FileFindResults>
  grep(query: string, options?: FileGrepOptions): Promise<FileGrepResults>
}

/** This window's workspace, on its host. */
export function workspaceFiles(cwd: string): FilesSource {
  let local: Promise<FileIndexCore> | undefined
  /** The host refused the index's calls: an older host, read once with `listFiles` and answered here. */
  const fallback = (): Promise<FileIndexCore> => {
    local ??= getMako().listFiles().then((files) => new FileIndexCore(files.map((file) => file.path)))
    local.catch(() => {
      local = undefined
    })
    return local
  }
  return {
    key: `workspace:${cwd}`,
    folders: (paths, options) => (local ? local.then((core) => core.folders(paths, options)) : getMako().filesFolders(paths, options).catch(() => fallback().then((core) => core.folders(paths, options)))),
    find: (query, limit) => (local ? local.then((core) => core.find(query, limit)) : getMako().filesFind(query, limit).catch(() => fallback().then((core) => core.find(query, limit)))),
    grep: (query, options) => getMako().filesGrep(query, options),
  }
}

/** A conversation's folder, on the computer that runs it. */
export function conversationFiles(conversation: string): FilesSource {
  return {
    key: `conversation:${conversation}`,
    folders: (paths, options) => getMako().liveFilesFolders(conversation, paths, options),
    find: (query, limit) => getMako().liveFilesFind(conversation, query, limit),
    grep: (query, options) => getMako().liveFilesGrep(conversation, query, options),
  }
}

/** One row of the tree as it's drawn. */
export type FileTreeRow =
  | { kind: "dir"; key: string; path: string; name: string; depth: number; files: number; changed: boolean; open: boolean }
  | { kind: "file"; key: string; path: string; name: string; depth: number; changed: boolean }
  /** An open folder whose listing hasn't come yet. */
  | { kind: "pending"; key: string; path: string; depth: number }
  /** A folder listed to its limit: the rest are a click away. */
  | { kind: "more"; key: string; path: string; depth: number; count: number }

export interface FileTreeState {
  version: number
  /** Files the whole index holds. */
  total: number
  status: "loading" | "ready" | "failed"
  error?: string
}

/**
 * The folders one source has listed, and the rows they make for a set of open folders. Every read asks for the open
 * folders at once and says which version it holds, so a refresh with nothing changed is one small answer.
 */
export class FileTreeModel {
  readonly source: FilesSource
  #listings = new Map<string, FileFolder>()
  #limits = new Map<string, number>()
  #state: FileTreeState = { version: 0, total: 0, status: "loading" }
  #listeners = new Set<() => void>()
  #reading: Promise<void> | undefined
  #again = false
  #wanted = new Set<string>([""])
  /** Bumped by every change to what's held, for React's snapshot. */
  #revision = 0

  constructor(source: FilesSource) {
    this.source = source
  }

  get state(): FileTreeState {
    return this.#state
  }

  get revision(): number {
    return this.#revision
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** The rows for these open folders; asks for any open folder not held yet. */
  rows(open: ReadonlySet<string>): FileTreeRow[] {
    const rows: FileTreeRow[] = []
    const missing: string[] = []
    const walk = (path: string, depth: number) => {
      const listing = this.#listings.get(path)
      if (!listing) {
        missing.push(path)
        rows.push({ kind: "pending", key: `${path}\0pending`, path, depth })
        return
      }
      for (const folder of listing.folders) {
        const isOpen = open.has(folder.path)
        rows.push({ kind: "dir", key: folder.path, path: folder.path, name: folder.name, depth, files: folder.files, changed: folder.changed, open: isOpen })
        if (isOpen) walk(folder.path, depth + 1)
      }
      for (const file of listing.files) {
        const filePath = listing.path ? `${listing.path}/${file.name}` : file.name
        rows.push({ kind: "file", key: filePath, path: filePath, name: file.name, depth, changed: file.changed })
      }
      if (listing.more > 0) rows.push({ kind: "more", key: `${path}\0more`, path, depth, count: listing.more })
    }
    walk("", 0)
    if (missing.length) {
      for (const path of missing) this.#wanted.add(path)
      queueMicrotask(() => this.refresh())
    } else {
      for (const path of open) this.#wanted.add(path)
    }
    return rows
  }

  /** Lists a folder past its limit. */
  showAll(path: string): void {
    this.#limits.set(path, Number.MAX_SAFE_INTEGER)
    this.#listings.delete(path)
    this.#wanted.add(path)
    this.#publish()
    this.refresh()
  }

  /** Reads what's wanted again; only what changed since the version held comes back. */
  refresh(): void {
    if (this.#reading) {
      this.#again = true
      return
    }
    this.#reading = this.#read().finally(() => {
      this.#reading = undefined
      if (this.#again) {
        this.#again = false
        this.refresh()
      }
    })
  }

  async #read(): Promise<void> {
    const wanted = [...this.#wanted]
    const unheld = wanted.some((path) => !this.#listings.has(path))
    // A folder past its limit is asked with its own; the rest share the default.
    const big = wanted.filter((path) => this.#limits.has(path))
    const usual = wanted.filter((path) => !this.#limits.has(path))
    try {
      const since = unheld ? undefined : this.#state.version || undefined
      const answers = await Promise.all([
        usual.length ? this.source.folders(usual, { limit: FOLDER_LISTING_LIMIT, since }) : undefined,
        ...big.map((path) => this.source.folders([path], { limit: this.#limits.get(path), since })),
      ])
      let changed = false
      let version = this.#state.version
      let total = this.#state.total
      for (const answer of answers) {
        if (!answer) continue
        version = answer.version
        total = answer.total
        if (answer.unchanged) continue
        changed = true
        for (const folder of answer.folders) this.#listings.set(folder.path, folder)
        for (const path of answer.missing) {
          this.#listings.delete(path)
          if (path) this.#wanted.delete(path)
        }
      }
      // Folders read at an older version than the newest answer are stale: read them again with it.
      if (changed && !unheld) for (const path of this.#listings.keys()) if (!wanted.includes(path)) this.#listings.delete(path)
      this.#state = { version, total, status: "ready" }
      this.#publish()
    } catch (error) {
      this.#state = { ...this.#state, status: this.#listings.size ? "ready" : "failed", error: error instanceof Error ? error.message : String(error) }
      this.#publish()
    }
  }

  /** Forget a folder that's closed, so a refresh doesn't keep asking for it. */
  close(path: string): void {
    for (const held of [...this.#wanted]) if (held === path || held.startsWith(`${path}/`)) this.#wanted.delete(held)
  }

  #publish(): void {
    this.#revision += 1
    for (const listener of this.#listeners) listener()
  }
}

/** Models by source, so a pane that comes back finds what it had. */
export class FileTreeModels {
  readonly #models = new Map<string, FileTreeModel>()

  of(source: FilesSource): FileTreeModel {
    const held = this.#models.get(source.key)
    if (held) return held
    const model = new FileTreeModel(source)
    this.#models.set(source.key, model)
    if (this.#models.size > 8) {
      const oldest = this.#models.keys().next().value
      if (oldest !== undefined) this.#models.delete(oldest)
    }
    return model
  }
}

export const fileTreeModels = new FileTreeModels()
