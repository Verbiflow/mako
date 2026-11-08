/**
 * A folder's files, held in memory for the Files view: the tree a folder at a time, and names found as they're typed.
 *
 * The host keeps one per folder a window browses and changes it path by path as its watcher hears them
 * (`workspaces/file-index.ts`), so nothing reads the whole folder again for a keystroke or an expanded folder. It is
 * pure, so a window whose host is older than these calls builds one from `mako:list-files` and answers itself the
 * same way.
 *
 * Paths are relative to the index's root, `/`-separated, without a leading `./`.
 */
import type { FileMatches } from "./git-workspace-search.js"

/** A folder in a listing, folded through any chain of folders that each hold one folder and nothing else. */
export interface FileFolderEntry {
  /** What the row shows: `src` or, folded, `src/components/rail`. */
  name: string
  /** The innermost folder of the chain: the one whose listing opens under it. */
  path: string
  /** Files at or below it. */
  files: number
  /** Whether a file below it is changed in Git. */
  changed: boolean
}

export interface FileEntry {
  name: string
  changed: boolean
}

/** One folder's entries: folders first, then files, each in name order. */
export interface FileFolder {
  /** Its path from the root; `""` is the root. */
  path: string
  folders: FileFolderEntry[]
  files: FileEntry[]
  /** Entries past the listing's limit, left out. */
  more: number
}

/** The folders a window asked for, as the index holds them now. */
export interface FileFolders {
  /**
   * Which index answered: one per index a host builds for a folder, new with every host and every new index. A
   * version means something only within its epoch, so a window holding another epoch's listings drops them all.
   */
  epoch: string
  /** Changes with every change to the index: a window holding this version of this epoch holds what the index does. */
  version: number
  /** Files in the whole index. */
  total: number
  /** Asked for and held. A folder that isn't one any more is in `missing`. */
  folders: FileFolder[]
  missing: string[]
  /** The index holds the version the window said it has: nothing else is sent. */
  unchanged?: boolean
}

export interface FileFindHit {
  path: string
  /** The path's characters the query matched, for drawing them. */
  at: number[]
}

/** Files whose names match a query, best first. */
export interface FileFindResults {
  query: string
  version: number
  /** Every file that matches, of which `hits` are the best. */
  total: number
  hits: FileFindHit[]
  /** How long the index took, in milliseconds. */
  ms: number
}

export interface FileFoldersOptions {
  /** Entries listed per folder at most; `FOLDER_LISTING_LIMIT` unless asked for more. */
  limit?: number
  /** The version the window holds: when it's still the index's, in the same epoch, only `unchanged` comes back. */
  since?: number
  /** The epoch the window's `since` is of; a version without one is never taken as current. */
  epoch?: string
}

/** How a search for text inside files reads its query. */
export interface FileGrepOptions {
  regex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
  /** Matching lines wanted at most: the search stops once it has them, so a common word answers at once. */
  limit?: number
}

/** Lines inside files that hold the query, by file in path order. */
export interface FileGrepResults {
  query: string
  files: FileMatches[]
  /** Matching lines listed. */
  total: number
  /** The search stopped at its limit: there are more. */
  more: boolean
  ms: number
  /** The query itself was the problem, such as a pattern that doesn't parse. */
  error?: string
}

/** The most entries one folder lists unless asked for more. */
export const FOLDER_LISTING_LIMIT = 2_000

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

class Folder {
  readonly name: string
  readonly path: string
  readonly parent: Folder | undefined
  readonly folders = new Map<string, Folder>()
  readonly files = new Set<string>()
  /** Files at or below. */
  count = 0
  #sortedFolders: Folder[] | undefined
  #sortedFiles: string[] | undefined

  constructor(name: string, path: string, parent: Folder | undefined) {
    this.name = name
    this.path = path
    this.parent = parent
  }

  touched(): void {
    this.#sortedFolders = undefined
    this.#sortedFiles = undefined
  }

  sortedFolders(): Folder[] {
    this.#sortedFolders ??= [...this.folders.values()].sort((left, right) => collator.compare(left.name, right.name))
    return this.#sortedFolders
  }

  sortedFiles(): string[] {
    this.#sortedFiles ??= [...this.files].sort(collator.compare)
    return this.#sortedFiles
  }
}

/** Each character's bit in a path's mask: letters their own, digits four, separators and the rest two more. */
function bitOf(code: number): number {
  if (code >= 97 && code <= 122) return 1 << (code - 97)
  if (code >= 65 && code <= 90) return 1 << (code - 65)
  if (code >= 48 && code <= 57) return 1 << (26 + ((code - 48) & 3))
  if (code === 47 || code === 46) return 1 << 30
  return 1 << 31
}

function maskOf(text: string): number {
  let mask = 0
  for (let index = 0; index < text.length; index += 1) mask |= bitOf(text.charCodeAt(index))
  return mask
}

/** A character that starts a word: the first, one after a separator, or an uppercase letter after a lowercase one. */
function startsWord(path: string, lower: string, at: number): boolean {
  if (at === 0) return true
  const before = lower.charCodeAt(at - 1)
  if (before === 47 || before === 45 || before === 95 || before === 46 || before === 32) return true
  const code = path.charCodeAt(at)
  const previous = path.charCodeAt(at - 1)
  return code >= 65 && code <= 90 && previous >= 97 && previous <= 122
}

/**
 * How well `term` matches `lower` between `from` and its end, or -1: the tightest window that holds the term in order
 * (found forward, then tightened backward), scored by its characters, the words they start, the runs they make and the
 * gaps between them.
 */
function matchScore(term: string, path: string, lower: string, from: number, base: number): number {
  const length = lower.length
  let cursor = from
  let end = -1
  for (let index = 0; index < term.length; index += 1) {
    const at = lower.indexOf(term[index]!, cursor)
    if (at < 0) return -1
    end = at
    cursor = at + 1
  }
  let start = end
  for (let index = term.length - 1, at = end; index >= 0; index -= 1) {
    at = lower.lastIndexOf(term[index]!, at)
    start = at
    at -= 1
  }
  let score = 0
  let previous = -2
  let run = 0
  cursor = start
  for (let index = 0; index < term.length; index += 1) {
    const at = lower.indexOf(term[index]!, cursor)
    score += 16
    if (at === previous + 1) {
      run += 1
      score += 8 + Math.min(run, 6) * 4
    } else {
      run = 0
      if (previous >= 0) score -= Math.min(at - previous - 1, 6)
    }
    if (startsWord(path, lower, at)) score += at === base ? 24 : 14
    previous = at
    cursor = at + 1
  }
  // A short window and a short path are what someone typing means; both only break ties.
  return score * 64 - Math.min(end - start, 48) * 2 - Math.min(length, 256) / 8
}

/** The tightest window holding `term` in order from `from`: its length, or -1. */
function windowOf(term: string, lower: string, from: number): number {
  let cursor = from
  let end = -1
  for (let index = 0; index < term.length; index += 1) {
    end = lower.indexOf(term[index]!, cursor)
    if (end < 0) return -1
    cursor = end + 1
  }
  let at = end
  for (let index = term.length - 1; index >= 0; index -= 1) at = lower.lastIndexOf(term[index]!, at) - 1
  return end - at
}

/**
 * `term` against a path: in its file name if it can be, which is how people search, else across its folders. A name
 * that holds it closely outweighs anything across folders, and one that starts with it or is it more still; letters
 * strewn through a name count for less than the word whole in a folder.
 */
function termScore(term: string, path: string, lower: string, base: number): number {
  const across = matchScore(term, path, lower, 0, base)
  if (across < 0 || lower.length - base < term.length) return across
  const named = matchScore(term, path, lower, base, base)
  if (named < 0) return across
  const name = lower.length - base
  const tight = windowOf(term, lower, base) <= term.length + 1
  const exact = name === term.length || lower.charCodeAt(base + term.length) === 46
  const bonus = !tight ? 2_048 : 65_536 + (lower.startsWith(term, base) ? (exact ? 32_768 : 16_384) : 0)
  return Math.max(across, named + bonus)
}

/** The characters `termScore` scored, by the same windows. */
function termIndices(term: string, path: string, lower: string, base: number, into: Set<number>): void {
  const named = lower.length - base >= term.length ? matchScore(term, path, lower, base, base) : -1
  const from = named >= 0 && (windowOf(term, lower, base) <= term.length + 1 || named + 2_048 >= matchScore(term, path, lower, 0, base)) ? base : 0
  let cursor = from
  let end = -1
  for (const char of term) {
    end = lower.indexOf(char, cursor)
    cursor = end + 1
  }
  let start = end
  for (let index = term.length - 1, at = end; index >= 0; index -= 1) {
    at = lower.lastIndexOf(term[index]!, at)
    start = at
    at -= 1
  }
  cursor = start
  for (const char of term) {
    const at = lower.indexOf(char, cursor)
    into.add(at)
    cursor = at + 1
  }
}

/** A query as terms: words apart are each found, in any order. */
function termsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/** The best `limit` of what's offered, kept as a heap whose top is the worst kept. */
class Best {
  readonly #limit: number
  readonly #ids: number[] = []
  readonly #scores: number[] = []

  constructor(limit: number) {
    this.#limit = limit
  }

  offer(id: number, score: number): void {
    const ids = this.#ids
    const scores = this.#scores
    if (ids.length < this.#limit) {
      ids.push(id)
      scores.push(score)
      let at = ids.length - 1
      while (at > 0) {
        const up = (at - 1) >> 1
        if (scores[up]! <= scores[at]!) break
        this.#swap(at, up)
        at = up
      }
      return
    }
    if (this.#limit === 0 || score <= scores[0]!) return
    ids[0] = id
    scores[0] = score
    let at = 0
    for (;;) {
      const left = at * 2 + 1
      const right = left + 1
      let low = at
      if (left < ids.length && scores[left]! < scores[low]!) low = left
      if (right < ids.length && scores[right]! < scores[low]!) low = right
      if (low === at) break
      this.#swap(at, low)
      at = low
    }
  }

  #swap(left: number, right: number): void {
    const ids = this.#ids
    const scores = this.#scores
    ;[ids[left], ids[right]] = [ids[right]!, ids[left]!]
    ;[scores[left], scores[right]] = [scores[right]!, scores[left]!]
  }

  /** Best first. */
  sorted(): Array<{ id: number; score: number }> {
    return this.#ids.map((id, index) => ({ id, score: this.#scores[index]! })).sort((left, right) => right.score - left.score)
  }
}

export class FileIndexCore {
  readonly #root = new Folder("", "", undefined)
  readonly #ids = new Map<string, number>()
  readonly #paths: Array<string | undefined> = []
  readonly #lower: string[] = []
  readonly #masks: number[] = []
  readonly #bases: number[] = []
  readonly #free: number[] = []
  #changed = new Set<string>()
  #changedFolders = new Set<string>()
  #version = 0
  /** The last query's matches, which the next query that only extends it searches instead of everything. */
  #narrowed: { query: string; version: number; ids: Int32Array } | undefined

  /**
   * `after`: the version of the index this one replaces, so versions climb across a rebuild. `epoch`: which index this
   * is, kept by its owner across rebuilds of one folder's index and new with every owner, so a window holding a
   * version of another index (another host, one started again) never reads as current.
   */
  readonly epoch: string

  constructor(paths: Iterable<string> = [], after = 0, epoch: string = globalThis.crypto.randomUUID()) {
    for (const path of paths) this.#insert(path)
    this.#version = after + 1
    this.epoch = epoch
  }

  get version(): number {
    return this.#version
  }

  get size(): number {
    return this.#ids.size
  }

  has(path: string): boolean {
    return this.#ids.has(path)
  }

  /** Whether `path` is a folder that holds files. */
  isFolder(path: string): boolean {
    return path === "" || this.#folder(path) !== undefined
  }

  /** Every path, in no order. */
  paths(): string[] {
    return [...this.#ids.keys()]
  }

  /** The files at or below a folder. */
  filesUnder(path: string): string[] {
    const folder = this.#folder(path)
    if (!folder) return []
    const out: string[] = []
    const walk = (at: Folder) => {
      for (const name of at.files) out.push(at.path ? `${at.path}/${name}` : name)
      for (const child of at.folders.values()) walk(child)
    }
    walk(folder)
    return out
  }

  add(path: string): boolean {
    if (!path || this.#ids.has(path)) return false
    this.#insert(path)
    this.#bump()
    return true
  }

  remove(path: string): boolean {
    const id = this.#ids.get(path)
    if (id === undefined) return false
    this.#ids.delete(path)
    this.#paths[id] = undefined
    this.#free.push(id)
    const slash = path.lastIndexOf("/")
    let folder = slash < 0 ? this.#root : this.#folder(path.slice(0, slash))
    folder?.files.delete(path.slice(slash + 1))
    folder?.touched()
    while (folder) {
      folder.count -= 1
      const parent: Folder | undefined = folder.parent
      if (parent && folder.count === 0) {
        parent.folders.delete(folder.name)
        parent.touched()
      }
      folder = parent
    }
    this.#bump()
    return true
  }

  /** Which files Git calls changed: their rows and every folder above them are marked. */
  setChanged(paths: Iterable<string>): boolean {
    const next = new Set(paths)
    if (next.size === this.#changed.size && [...next].every((path) => this.#changed.has(path))) return false
    this.#changed = next
    const folders = new Set<string>()
    for (const path of next) {
      for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1)) folders.add(path.slice(0, slash))
    }
    this.#changedFolders = folders
    this.#bump()
    return true
  }

  /** One folder's entries, or undefined when it isn't one. */
  folder(path: string, limit = FOLDER_LISTING_LIMIT): FileFolder | undefined {
    const folder = path === "" ? this.#root : this.#folder(path)
    if (!folder) return undefined
    const folders: FileFolderEntry[] = []
    const files: FileEntry[] = []
    const sortedFolders = folder.sortedFolders()
    const sortedFiles = folder.sortedFiles()
    const shown = Math.min(limit, sortedFolders.length + sortedFiles.length)
    for (const child of sortedFolders) {
      if (folders.length >= shown) break
      let cursor = child
      let name = child.name
      while (cursor.files.size === 0 && cursor.folders.size === 1) {
        const only: Folder = cursor.folders.values().next().value!
        name = `${name}/${only.name}`
        cursor = only
      }
      folders.push({ name, path: cursor.path, files: cursor.count, changed: this.#changedFolders.has(cursor.path) })
    }
    for (const name of sortedFiles) {
      if (folders.length + files.length >= shown) break
      files.push({ name, changed: this.#changed.has(folder.path ? `${folder.path}/${name}` : name) })
    }
    return { path: folder.path, folders, files, more: sortedFolders.length + sortedFiles.length - shown }
  }

  /** Several folders at once, as a window asks for what it has open. */
  folders(paths: readonly string[], options: FileFoldersOptions = {}): FileFolders {
    if (options.since === this.#version && options.epoch === this.epoch) return { epoch: this.epoch, version: this.#version, total: this.size, folders: [], missing: [], unchanged: true }
    const folders: FileFolder[] = []
    const missing: string[] = []
    for (const path of paths) {
      const listed = this.folder(path, options.limit)
      if (listed) folders.push(listed)
      else missing.push(path)
    }
    return { epoch: this.epoch, version: this.#version, total: this.size, folders, missing }
  }

  /**
   * The files whose paths hold the query's characters in order, best first: a file name over a folder's, a word's
   * start or a run over scattered letters. Each word of the query is found on its own.
   */
  find(query: string, limit = 200): FileFindResults {
    const started = performance.now()
    const terms = termsOf(query)
    const normalized = terms.join(" ")
    if (!terms.length) return { query, version: this.#version, total: 0, hits: [], ms: 0 }
    let wanted = 0
    for (const term of terms) wanted |= maskOf(term)
    const narrowed = this.#narrowed
    const candidates = narrowed && narrowed.version === this.#version && normalized.startsWith(narrowed.query) ? narrowed.ids : undefined
    const matched: number[] = []
    const best = new Best(limit)
    const consider = (id: number) => {
      const path = this.#paths[id]
      if (path === undefined || (this.#masks[id]! & wanted) !== wanted) return
      const lower = this.#lower[id]!
      const base = this.#bases[id]!
      let score = 0
      for (const term of terms) {
        const one = termScore(term, path, lower, base)
        if (one < 0) return
        score += one
      }
      matched.push(id)
      best.offer(id, score)
    }
    if (candidates) for (const id of candidates) consider(id)
    else for (let id = 0; id < this.#paths.length; id += 1) consider(id)
    this.#narrowed = { query: normalized, version: this.#version, ids: Int32Array.from(matched) }
    // Letters strewn across a long path are a match, but not one anyone typing meant while closer ones exist.
    const ranked = best.sorted()
    const top = ranked[0]?.score ?? 0
    const close = ranked.filter(({ score }) => score >= top * 0.3)
    const hits = (close.length >= 5 ? close : ranked).map(({ id }) => {
      const path = this.#paths[id]!
      const at = new Set<number>()
      for (const term of terms) termIndices(term, path, this.#lower[id]!, this.#bases[id]!, at)
      return { path, at: [...at].sort((left, right) => left - right) }
    })
    return { query, version: this.#version, total: matched.length, hits, ms: performance.now() - started }
  }

  #bump(): void {
    this.#version += 1
    this.#narrowed = undefined
  }

  #folder(path: string): Folder | undefined {
    let folder: Folder | undefined = this.#root
    let from = 0
    while (folder && from <= path.length) {
      const slash = path.indexOf("/", from)
      const name = slash < 0 ? path.slice(from) : path.slice(from, slash)
      folder = folder.folders.get(name)
      if (slash < 0) break
      from = slash + 1
    }
    return folder
  }

  #insert(path: string): void {
    const id = this.#free.pop() ?? this.#paths.length
    const lower = path.toLowerCase()
    const slash = path.lastIndexOf("/")
    this.#ids.set(path, id)
    this.#paths[id] = path
    this.#lower[id] = lower
    this.#masks[id] = maskOf(lower)
    this.#bases[id] = slash + 1
    let folder = this.#root
    folder.count += 1
    let from = 0
    for (let next = path.indexOf("/"); next >= 0; next = path.indexOf("/", from)) {
      const name = path.slice(from, next)
      let child = folder.folders.get(name)
      if (!child) {
        child = new Folder(name, path.slice(0, next), folder)
        folder.folders.set(name, child)
        folder.touched()
      }
      folder = child
      folder.count += 1
      from = next + 1
    }
    folder.files.add(path.slice(from))
    folder.touched()
  }
}
