import { providerHost } from "./providers/index.js"
import { filePreviewUrl } from "./file-previews.js"
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
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import type { FileContents, StagedFile, WorkspaceFile } from "./shared.js"
import type { WorkspaceGit } from "./host-git.js"

/**
 * The most of a file the viewer will render.
 *
 * Two megabytes is far past any source file and far short of what freezes a
 * renderer. Above it the head is shown and the viewer says the rest was cut.
 */
const FILE_VIEW_LIMIT = 2_000_000

interface MediaType {
  media: NonNullable<FileContents["media"]>
  mimeType: string
}

const MEDIA_TYPES = {
  ".avif": { media: "image", mimeType: "image/avif" },
  ".gif": { media: "image", mimeType: "image/gif" },
  ".jpeg": { media: "image", mimeType: "image/jpeg" },
  ".jpg": { media: "image", mimeType: "image/jpeg" },
  ".png": { media: "image", mimeType: "image/png" },
  ".svg": { media: "image", mimeType: "image/svg+xml" },
  ".webp": { media: "image", mimeType: "image/webp" },
  ".pdf": { media: "pdf", mimeType: "application/pdf" },
  ".mp3": { media: "audio", mimeType: "audio/mpeg" },
  ".wav": { media: "audio", mimeType: "audio/wav" },
  ".ogg": { media: "audio", mimeType: "audio/ogg" },
  ".flac": { media: "audio", mimeType: "audio/flac" },
  ".m4a": { media: "audio", mimeType: "audio/mp4" },
  ".mp4": { media: "video", mimeType: "video/mp4" },
  ".mov": { media: "video", mimeType: "video/quicktime" },
  ".webm": { media: "video", mimeType: "video/webm" },
  ".xlsx": {
    media: "spreadsheet",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  ".xls": { media: "spreadsheet", mimeType: "application/vnd.ms-excel" },
  ".numbers": {
    media: "spreadsheet",
    mimeType: "application/vnd.apple.numbers",
  },
} satisfies Record<string, MediaType>

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
  private readonly git: WorkspaceGit

  constructor(cwd: string, git: WorkspaceGit) {
    this.cwdValue = cwd
    this.git = git
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
    for (;;) {
      const now = Date.now()
      if (this.fileCache && now - this.fileCache.at < FILE_CACHE_MS)
        return this.fileCache.files

      const cwd = this.cwdValue
      const gitPaths = await this.git.listFiles()
      const paths = gitPaths
        ? gitPaths
        : // Not a repo: a bounded walk, skipping the usual heavy directories.
          await walkWorkspace(cwd, cwd, 0)
      const changed = new Set(
        (await this.git.status().catch(() => null))?.files.map(
          (file) => file.path
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
    try {
      const file = await open(target, "wx", 0o600)
      try {
        await file.writeFile(text, "utf8")
      } finally {
        await file.close()
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
  async read(requested: string): Promise<FileContents> {
    const { absolute, path } = await this.locate(requested)
    const info = await stat(absolute)
    if (info.isDirectory()) throw new Error(`${path} is a directory`)
    const extension = extname(path).toLowerCase()
    const media = Object.entries(MEDIA_TYPES).find(
      ([candidate]) => candidate === extension
    )?.[1]
    if (media) {
      return {
        path,
        contents: "",
        size: info.size,
        binary: true,
        truncated: false,
        media: media.media,
        mimeType: media.mimeType,
        previewUrl: filePreviewUrl(absolute),
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
        }
      }
      const contents = buffer.toString("utf8")
      const preview = providerHost.artifactPreviews
        .list()
        .find((reader) => reader.matches(path))
      const artifactPreview: FileContents["artifactPreview"] = preview
        ? info.size > FILE_VIEW_LIMIT
          ? {
              kind: "unavailable",
              reason: "This file exceeds the preview size limit",
            }
          : await preview.render(contents).then(
              (html) => ({ kind: "html" as const, html }),
              () => ({
                kind: "unavailable" as const,
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
      }
    } finally {
      await handle.close()
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
    requested: string
  ): Promise<{ absolute: string; path: string }> {
    const absolute = await this.resolvePath(requested)
    const found = await stat(absolute).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return false
        throw error
      }
    )
    if (found) return { absolute, path: requested }
    if (isAbsolute(requested)) throw new Error(`No file at ${requested}`)
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
    const lexicalRoot = resolve((await this.git.root()) ?? this.cwdValue)
    const root = await realpath(lexicalRoot).catch(() => lexicalRoot)
    const lexical = resolve(root, path)
    return realpath(lexical).catch(() => lexical)
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
  depth: number
): Promise<string[]> {
  if (depth > WALK_MAX_DEPTH) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith(".") || WALK_SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walkWorkspace(root, full, depth + 1)))
    } else if (entry.isFile()) {
      out.push(relative(root, full))
    }
    if (out.length > WALK_MAX_FILES) break
  }
  return out
}
