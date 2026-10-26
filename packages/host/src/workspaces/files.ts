import type { Git } from "@mako/git"
import { diagnosticFormat, officeFormat } from "../contracts/file-preview.js"
import { fileContentType, mediaForContentType } from "./file-media.js"
import type { ArtifactPreviews } from "./artifact-previews.js"
import { fileIdentity, filePreviewUrl } from "./file-previews.js"
import { mediaDimensions } from "./media-dimensions.js"
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import type { FileContents, FileReadPurpose, StagedFile, WorkspaceFile } from "../contracts/git-workspace-search.js"
import { WorkspaceGit } from "../git/index.js"
import { workspaceWrites } from "../base/workspace-writes.js"

/**
 * The most of a file the viewer will render.
 *
 * Two megabytes is far past any source file and far short of what freezes a
 * renderer. Above it the head is shown and the viewer says the rest was cut.
 */
const FILE_VIEW_LIMIT = 2_000_000
type ConversationDataDir = () => Promise<string | undefined>
/**
 * `preview`: the read is for a preview the transcript shows unasked (an
 * embed, a path an answer names). Outside the Thread's folders only what a
 * preview is for (pictures, video, audio, pages, PDFs) is read; anything
 * else comes back `withheld`, so an answer's `![](~/.ssh/id_rsa)` stays a
 * link rather than a key on screen.
 */
type FileReadOptions = { relativeTo: "cwd"; dataDir?: ConversationDataDir; preview?: boolean }
/** Larger than this on its longer side, a picture gets a thumbnail for grid tiles; smaller, the tile draws it. */
const THUMBNAIL_ABOVE = 960

/** The `@` picker re-queries per keystroke; the file set does not move that fast. */
const FILE_CACHE_MS = 5_000

/** Ceilings for the non-git walk, so a stray home directory cannot hang the picker. */
const WALK_MAX_DEPTH = 8
const WALK_MAX_FILES = 20_000
const WALK_SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "vendor",
  "Pods",
  ".turbo",
  "coverage",
])

export class WorkspaceFiles {
  private cwdValue: string
  private fileCache: { at: number; files: WorkspaceFile[] } | null = null
  private fileLoad: { cwd: string; promise: Promise<WorkspaceFile[]> } | undefined
  private readonly git: WorkspaceGit
  private readonly previews: ArtifactPreviews

  constructor(cwd: string, git: WorkspaceGit, previews: ArtifactPreviews) {
    this.cwdValue = cwd
    this.git = git
    this.previews = previews
  }

  get cwd(): string {
    return this.cwdValue
  }

  setCwd(cwd: string) {
    this.cwdValue = cwd
    this.fileCache = null
  }

  /**
   * The workspace file list backing the composer's `@` picker.
   *
   * `git ls-files` is the right source: it already respects .gitignore, so we
   * never walk node_modules. The result is cached for a few seconds because
   * the picker re-queries on every keystroke and the file set does not move
   * that fast.
   */
  async list(): Promise<WorkspaceFile[]> {
    if (this.fileCache && Date.now() - this.fileCache.at < FILE_CACHE_MS)
      return this.fileCache.files
    if (this.fileLoad?.cwd === this.cwdValue) return this.fileLoad.promise
    const load = { cwd: this.cwdValue, promise: this.loadList() }
    this.fileLoad = load
    try {
      return await load.promise
    } finally {
      if (this.fileLoad === load) this.fileLoad = undefined
    }
  }

  private async loadList(): Promise<WorkspaceFile[]> {
    for (;;) {
      const now = Date.now()
      if (this.fileCache && now - this.fileCache.at < FILE_CACHE_MS)
        return this.fileCache.files

      const cwd = this.cwdValue
      const gitPaths = await this.git.listFiles()
      const paths = gitPaths
        ? gitPaths
        : // Not a repo: a bounded walk, skipping the usual heavy directories.
          await walkWorkspace(cwd, cwd, 0, (dir) => this.git.at(dir).listFiles())
      const status = await this.git.status().catch(() => null)
      const changed = new Set(
        status?.files.map((file) =>
          status.root ? relative(cwd, join(status.root, file.path)) : file.path
        ) ?? []
      )
      const files = paths
        .sort((a, b) => a.localeCompare(b))
        .map((path) => (changed.has(path) ? { path, changed: true } : { path }))

      if (this.cwdValue !== cwd) continue
      this.fileCache = { at: now, files }
      return files
    }
  }

  /** Create a user-named text artifact without overwriting any existing path. */
  async createText(
    expectedCwd: string,
    path: string,
    text: string
  ): Promise<string> {
    const cwd = this.cwdValue
    if (expectedCwd !== cwd)
      throw new Error(
        "The active workspace changed. Open the plan's workspace and try again."
      )
    if (!path.trim() || isAbsolute(path))
      throw new Error("Use a path relative to this workspace.")
    if (Buffer.byteLength(text, "utf8") > 1_000_000)
      throw new Error("The text exceeds the 1 MB save limit.")
    const root = await realpath(cwd)
    const requested = resolve(root, path)
    const parent = await realpath(dirname(requested))
    const relativeParent = relative(root, parent)
    if (
      relativeParent === ".." ||
      relativeParent.startsWith(`..${sep}`) ||
      isAbsolute(relativeParent)
    )
      throw new Error("The file must stay inside this workspace.")
    if (this.cwdValue !== cwd)
      throw new Error(
        "The active workspace changed. Try again in the original workspace."
      )
    const target = join(parent, basename(requested))
    const startedAt = Date.now()
    try {
      const file = await open(target, "wx", 0o600)
      try {
        await file.writeFile(text, "utf8")
      } finally {
        await file.close()
        // The person wrote it, through Mako: never an agent's.
        workspaceWrites.publish({ kind: "editor", operation: "save from Mako", paths: [target], startedAt, endedAt: Date.now() })
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        throw new Error(
          "A file already exists at this path. Choose another name.",
          { cause: error }
        )
      throw error
    }
    this.fileCache = null
    return target
  }

  /**
   * Write an attachment the model cannot take inline into a scratch directory
   * inside the agent dir, and return its path. Engine-owned tools can then reach
   * it, which is the difference between "attach anything" and pretending
   * to.
   */
  async stage(name: string, base64: string): Promise<StagedFile> {
    const dir = join(homedir(), ".mako", "attachments")
    await mkdir(dir, { recursive: true })
    // Keep the original name legible but collision-free, and never let a name
    // escape the directory it is written into.
    const safe = name.replace(/[/\\]/g, "_").slice(0, 120) || "attachment"
    const stamp = `${Date.now().toString(36)}-${Math.round(Math.random() * 1e6).toString(36)}`
    const target = join(dir, `${stamp}-${safe}`)
    const bytes = Buffer.from(base64, "base64")
    await writeFile(target, bytes)
    return { path: target, name: safe, size: bytes.byteLength }
  }

  /**
   * Stage by copying from where the file already is. Drag-and-drop and the
   * file picker know the OS path, so the fast route is a filesystem copy in
   * this process — a 200MB video costs one clonefile-ish copy, not a
   * 270MB base64 string marshalled across the IPC boundary.
   */
  async stagePath(sourcePath: string): Promise<StagedFile> {
    const dir = join(homedir(), ".mako", "attachments")
    await mkdir(dir, { recursive: true })
    const name = sourcePath.split("/").pop() ?? "attachment"
    const safe = name.replace(/[/\\]/g, "_").slice(0, 120) || "attachment"
    const stamp = `${Date.now().toString(36)}-${Math.round(Math.random() * 1e6).toString(36)}`
    const target = join(dir, `${stamp}-${safe}`)
    await copyFile(sourcePath, target)
    const info = await stat(target)
    return { path: target, name: safe, size: info.size }
  }

  /**
   * Read a workspace file for the viewer.
   *
   * Two guards, both about not hanging the window on something it cannot show
   * anyway: a byte ceiling, because a 40MB log renders as a frozen tab, and a
   * NUL check, because a binary opened as text is a screenful of noise that
   * takes longer to draw than to read. Both are reported rather than silently
   * applied — a truncated file that does not say so is a lie about the code.
   */
  async read(requested: string, options?: FileReadOptions): Promise<FileContents> {
    const { absolute, path } = await this.locate(requested, options)
    const info = await stat(absolute)
    if (info.isDirectory()) throw new Error(`${path} is a directory`)
    const prefixFile = await open(absolute, "r")
    const prefix = Buffer.alloc(Math.min(info.size, 4096))
    try {
      await prefixFile.read(prefix, 0, prefix.length, 0)
    } finally {
      await prefixFile.close()
    }
    const mimeType = await fileContentType(path, prefix)
    const media = mediaForContentType(mimeType)
    const page = mimeType === "text/html"
    if (options?.preview && !(media && media.media !== "spreadsheet") && !page && !(await this.inside(absolute, options.dataDir)))
      return { path, contents: "", size: info.size, binary: false, truncated: false, mimeType, withheld: "It's outside this Thread's folders, so it isn't previewed. Open it to read it." }
    const identity = fileIdentity(info)
    const diagnostic = diagnosticFormat(path)
    if (diagnostic)
      return {
        path,
        diagnostic,
        contents: prefix.toString("utf8"),
        size: info.size,
        binary: false,
        truncated: info.size > prefix.length,
        mimeType: "application/json",
        previewUrl: filePreviewUrl(absolute, identity),
      }
    if (media || officeFormat(path, mimeType) || prefix.includes(0)) {
      const previewUrl = filePreviewUrl(absolute, identity)
      const visual = media?.media === "image" || media?.media === "video"
      const size = visual ? await this.dimensions(absolute, prefix, info.size, mimeType) : undefined
      const large = size && Math.max(size.width, size.height) > THUMBNAIL_ABOVE && mimeType !== "image/svg+xml" && mimeType !== "image/gif"
      return {
        path,
        contents: "",
        size: info.size,
        binary: true,
        truncated: false,
        media: media?.media,
        mimeType,
        previewUrl,
        ...size,
        ...(media?.media === "video" && { posterUrl: `${previewUrl}?rendition=poster` }),
        ...(media?.media === "image" && large && { thumbnailUrl: `${previewUrl}?rendition=thumbnail` }),
      }
    }

    const handle = await open(absolute, "r")
    try {
      const length = Math.min(info.size, FILE_VIEW_LIMIT)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, 0)
      // A NUL byte in the first few KB is the same heuristic git uses, and it
      // is right far more often than sniffing extensions.
      if (buffer.subarray(0, 8000).includes(0)) {
        return {
          path,
          contents: "",
          size: info.size,
          binary: true,
          truncated: false,
          mimeType,
          previewUrl: filePreviewUrl(absolute, identity),
        }
      }
      const contents = buffer.toString("utf8")
      const preview = this.previews.of(path)
      const artifactPreview: FileContents["artifactPreview"] = preview
        ? info.size > FILE_VIEW_LIMIT
          ? {
              kind: "unavailable",
              name: preview.name,
              reason: "This file exceeds the preview size limit",
            }
          : await this.previews.document(preview, contents).then(
              (html) => ({ kind: "html" as const, name: preview.name, html }),
              () => ({
                kind: "unavailable" as const,
                name: preview.name,
                reason:
                  "This artifact uses content or components the preview cannot render. Its source is available.",
              })
            )
        : undefined
      return {
        path,
        contents,
        size: info.size,
        binary: false,
        truncated: info.size > FILE_VIEW_LIMIT,
        artifactPreview,
        // A page is shown by URL, so it loads the styles, scripts and pictures beside it.
        ...(page && { mimeType, previewUrl: filePreviewUrl(absolute, identity, { folder: true }) }),
      }
    } finally {
      await handle.close()
    }
  }

  /** Whether `absolute` sits in the folders this conversation works in: its checkout, its folder, or its Thread's data folder. */
  private async inside(absolute: string, dataDir?: ConversationDataDir): Promise<boolean> {
    const roots = [this.cwdValue, await this.git.root().catch(() => null), await dataDir?.()]
    const real = await realpath(absolute).catch(() => absolute)
    for (const root of roots) {
      if (!root) continue
      const folder = await realpath(resolve(root)).catch(() => resolve(root))
      if (real === folder || real.startsWith(folder + sep)) return true
    }
    return false
  }

  private async dimensions(absolute: string, prefix: Buffer, size: number, mimeType: string | undefined) {
    const file = await open(absolute, "r")
    try {
      return await mediaDimensions(file, prefix, size, mimeType)
    } finally {
      await file.close()
    }
  }

  /**
   * The file a request names.
   *
   * The path is tried against the workspace root first. When that misses, a
   * relative request is treated as a *name* and matched by suffix against the
   * tracked file list, because that is what it usually is: an answer writes
   * `use-row-flip.ts` in prose, the transcript turns any inline code that
   * looks like a filename into a link (`inlineFileTarget`), and the file is
   * three directories down. Resolving the name against the root produced
   * `ENOENT … '/Users/you/project/use-row-flip.ts'` — a path the reader never
   * typed, about a file that does exist.
   *
   * One match is the answer. Several or none is a sentence naming what was
   * looked for, never a stat error. Absolute requests are taken literally:
   * `/tmp/report.md` means that file or nothing.
   */
  private async locate(
    requested: string,
    options?: FileReadOptions
  ): Promise<{ absolute: string; path: string }> {
    const relativeTo = options?.relativeTo
    const absolute = relativeTo === "cwd" && !isAbsolute(requested) && !requested.startsWith("~/")
      ? await realpath(resolve(this.cwdValue, requested)).catch(() => resolve(this.cwdValue, requested))
      : await this.resolvePath(requested)
    const found = await stat(absolute).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return false
        throw error
      }
    )
    if (found) return { absolute, path: requested }
    if (isAbsolute(requested) || requested.startsWith("~/") ||
      (relativeTo === "cwd" && (requested.startsWith("./") || requested.startsWith("../"))))
      throw new Error(`No file at ${requested}`)
    // Agents also write into MAKO_THREAD_DATA_DIR and cite its relative path.
    // Only the owner's exact path is tried, before the project's suffix index;
    // never walk data folders or let a relative traversal select another owner.
    const dataDir = await options?.dataDir?.()
    if (dataDir) {
      const root = resolve(dataDir)
      const candidate = resolve(root, requested)
      if (candidate.startsWith(`${root}${sep}`)) {
        const present = await stat(candidate).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return false
          throw error
        })
        if (present) return { absolute: candidate, path: candidate }
      }
    }
    const matches = await this.matchByName(requested)
    const only = matches[0]
    if (only && matches.length === 1)
      return { absolute: await this.resolvePath(only), path: only }
    if (matches.length === 0)
      throw new Error(`No file named ${requested} in this project`)
    const shown = matches.slice(0, 4).join(", ")
    throw new Error(
      `${matches.length} files are named ${requested} — ${shown}${matches.length > 4 ? ", and more" : ""}. Open it by its full path.`
    )
  }

  /** Tracked files whose path is, or ends with, the requested name. */
  private async matchByName(requested: string): Promise<string[]> {
    const wanted = requested.replaceAll("\\", "/").replace(/^\.\//, "")
    if (!wanted || wanted.startsWith("../")) return []
    const files = await this.list().catch(() => [])
    const suffix = `/${wanted}`
    return files
      .map((file) => file.path)
      .filter((path) => path === wanted || path.endsWith(suffix))
  }

  /**
   * Absolute path for a workspace-relative or absolute one, for read/open.
   *
   * Relative paths resolve against the git root (or the cwd); absolute paths
   * are taken as given. There is deliberately no containment check: an agent
   * writes reports to `/tmp`, scripts to `~/bin` and screenshots to the
   * Desktop, then links them from its answer, and every caller here is the
   * user's own desk reading the user's own files. Refusing those opens once
   * meant a linked file the agent had just created could not be viewed.
   */
  async resolvePath(path: string): Promise<string> {
    if (isAbsolute(path) || path.startsWith("~/")) {
      const absolute = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path)
      return realpath(absolute).catch(() => absolute)
    }
    const lexicalRoot = resolve((await this.git.root()) ?? this.cwdValue)
    const root = await realpath(lexicalRoot).catch(() => lexicalRoot)
    const lexical = path.startsWith("~/")
      ? resolve(homedir(), path.slice(2))
      : resolve(root, path)
    return realpath(lexical).catch(() => lexical)
  }
}

/** Reads files a conversation names, sharing short-lived indexes across reply cards without sharing mutable active-workspace state. */
export class ConversationFiles {
  private readonly git: Git
  private readonly previews: ArtifactPreviews
  private readonly held = new Map<string, { files: WorkspaceFiles; at: number }>()

  constructor(git: Git, previews: ArtifactPreviews) {
    this.git = git
    this.previews = previews
  }

  read(cwd: string, path: string, dataDir?: ConversationDataDir, purpose?: FileReadPurpose): Promise<FileContents> {
    const key = resolve(cwd)
    const now = Date.now()
    for (const [folder, held] of this.held)
      if (now - held.at >= FILE_CACHE_MS) this.held.delete(folder)
    const held = this.held.get(key) ?? { files: new WorkspaceFiles(key, new WorkspaceGit(this.git, key), this.previews), at: now }
    held.at = now
    this.held.delete(key)
    this.held.set(key, held)
    if (this.held.size > 8) {
      const oldest = this.held.keys().next().value
      if (oldest !== undefined) this.held.delete(oldest)
    }
    return held.files.read(path, { relativeTo: "cwd", dataDir, preview: purpose === "preview" })
  }
}

export async function readText(path: string): Promise<string | null> {
  try {
    const contents = await readFile(path)
    if (contents.includes(0)) return null
    return contents.toString("utf8")
  } catch {
    return null
  }
}

export async function walkWorkspace(
  root: string,
  dir: string,
  depth: number,
  listRepository?: (dir: string) => Promise<string[] | null>
): Promise<string[]> {
  if (depth > WALK_MAX_DEPTH) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  // A workspace can contain several repositories. Use each repository's own
  // ignore-aware index instead of spending the walk budget on ignored output.
  if (depth > 0 && listRepository && entries.some((entry) => entry.name === ".git")) {
    const paths = await listRepository(dir)
    if (paths) return paths.slice(0, WALK_MAX_FILES).map((path) => relative(root, join(dir, path)))
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith(".") || WALK_SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walkWorkspace(root, full, depth + 1, listRepository)))
    } else if (entry.isFile()) {
      out.push(relative(root, full))
    }
    if (out.length > WALK_MAX_FILES) break
  }
  return out.slice(0, WALK_MAX_FILES)
}
