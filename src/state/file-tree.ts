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

/** Reads in a row a model makes again when their answers mix two indexes, before it says so. */
const MIXED_READS = 3

/** One row of the tree as it's drawn. */
export type FileTreeRow =
  | { kind: "dir"; key: string; path: string; name: string; depth: number; files: number; changed: boolean; open: boolean }
  | { kind: "file"; key: string; path: string; name: string; depth: number; changed: boolean }
  /** An open folder whose listing hasn't come yet. */
  | { kind: "pending"; key: string; path: string; depth: number }
  /** A folder listed to its limit: the rest are a click away. */
  | { kind: "more"; key: string; path: string; depth: number; count: number }

export interface FileTreeState {
  /** The index the held listings came from (`FileFolders.epoch`): its versions mean nothing to another. */
  epoch?: string
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
  /** Each folder's listing with the epoch of the index that listed it: one of another epoch is never drawn. */
  #listings = new Map<string, { folder: FileFolder; epoch?: string }>()
  #limits = new Map<string, number>()
  #state: FileTreeState = { version: 0, total: 0, status: "loading" }
  #listeners = new Set<() => void>()
  #reading: Promise<void> | undefined
  #again = false
  /** Reads in a row whose answers came from two indexes. */
  #mixed = 0
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
      const held = this.#listings.get(path)
      const listing = held && held.epoch === this.#state.epoch ? held.folder : undefined
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
      // Drawing a failed tree reads nothing: it says it failed until it's retried or told something changed.
      if (this.#state.status !== "failed") queueMicrotask(() => this.refresh())
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

  /** The person asked to read the folder again after a failure: the mixed-answer count starts over. */
  retry(): void {
    this.#mixed = 0
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
    const epoch = this.#state.epoch
    const unheld = wanted.some((path) => this.#listings.get(path)?.epoch !== epoch || !this.#listings.has(path))
    // A folder past its limit is asked with its own; the rest share the default.
    const big = wanted.filter((path) => this.#limits.has(path))
    const usual = wanted.filter((path) => !this.#limits.has(path))
    try {
      const since = unheld ? undefined : this.#state.version || undefined
      const answers = (await Promise.all([
        usual.length ? this.source.folders(usual, { limit: FOLDER_LISTING_LIMIT, since, epoch }) : undefined,
        ...big.map((path) => this.source.folders([path], { limit: this.#limits.get(path), since, epoch })),
      ])).filter((answer) => answer !== undefined)
      // The answers of one read can come from two indexes while an owner is replaced (its host started again, or the
      // folder's index made anew): none of them is installed, everything held is let go, and the read is made again.
      const epochs = new Set(answers.map((answer) => answer.epoch))
      if (epochs.size > 1) {
        this.#listings.clear()
        this.#mixed += 1
        const giveUp = this.#mixed > MIXED_READS
        this.#state = { version: 0, total: this.#state.total, status: giveUp ? "failed" : "loading", ...(giveUp && { error: "This folder's files are answered by two hosts at once. Try again in a moment." }) }
        this.#again = !giveUp
        this.#publish()
        return
      }
      this.#mixed = 0
      const answeredBy = answers[0]?.epoch
      if (answeredBy !== epoch) this.#listings.clear()
      let changed = false
      // Answers of one epoch at different versions: the oldest is what's held, so the next read asks again for all.
      let version = answers.length ? Math.min(...answers.map((answer) => answer.version)) : this.#state.version
      let total = this.#state.total
      for (const answer of answers) {
        total = answer.total
        if (answer.unchanged) continue
        changed = true
        for (const folder of answer.folders) this.#listings.set(folder.path, { folder, epoch: answeredBy })
        for (const path of answer.missing) {
          this.#listings.delete(path)
          if (path) this.#wanted.delete(path)
        }
      }
      // Folders read at an older version than the newest answer are stale: read them again with it.
      if (changed && !unheld) for (const path of this.#listings.keys()) if (!wanted.includes(path)) this.#listings.delete(path)
      if (!answers.length) version = this.#state.version
      this.#state = { epoch: answeredBy, version, total, status: "ready" }
      this.#publish()
    } catch (error) {
      this.#state = { ...this.#state, status: this.#listings.size ? "ready" : "failed", error: error instanceof Error ? error.message : String(error) }
      this.#publish()
    }
  }

  /** Forget a folder that's closed, so a refresh doesn't keep asking for it. */
  close(path: string): void {
    for (const held of this.#wanted) if (held === path || held.startsWith(`${path}/`)) this.#wanted.delete(held)
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
