import type { ChildProcess } from "node:child_process"
import type { Dirent } from "node:fs"
import { lstat, mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { parseGitConfig } from "@mako/git"
import { mapLimit } from "@mako/protocol/map-limit"
import { closeHostChild, hostCommand, hostSpawn } from "../base/host-command.js"
import { findExecutable } from "../base/executable.js"
import { hostLog } from "../base/host-log.js"
import { onMac, onWindows } from "../base/platform.js"
import type { MethodTable } from "../base/methods.js"
import { windowsDevicePath, windowsSharePath } from "../contracts/local-folder.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import {
  CloneRequestSchema,
  CreateProjectRequestSchema,
  FolderBrowseRequestSchema,
  FoundCheckoutsRequestSchema,
  cloneNeedsSignIn,
  clonePercent,
  cloneStep,
  githubRepository,
  remoteLabel,
  type BrowsedFolder,
  type BrowsedPath,
  type CloneAccepted,
  type CloneProgress,
  type CloneRequest,
  type CreateProjectRequest,
  type FolderBrowse,
  type FolderBrowseRequest,
  type FoundCheckout,
  type FoundCheckouts,
  type FoundCheckoutsRequest,
} from "../contracts/projects.js"
import { localWords } from "@mako/protocol/computer-words"

/** Folders a typed path lists at most: more than a palette shows. */
const BROWSE_LIMIT = 60
/** How deep under home the scan looks: `~/code/org/repo` is three. */
const SCAN_DEPTH = 4
/** Folders the scan reads at once, and in all: a home of many projects is read in seconds, a huge one stops early. */
const SCAN_PARALLEL = 8
const SCAN_FOLDERS = 15_000
const SCAN_BUDGET_MS = 15_000
/** A scan answers from what it found until it's this old, then looks again while answering from it. */
const SCAN_FRESH_MS = 10 * 60_000
/** Checkouts a scan keeps, newest first. */
const FOUND_LIMIT = 200
/** Folders under home that macOS asks the person before anyone reads. */
const GUARDED = ["Desktop", "Documents", "Downloads"] as const
/** Never projects, and costly to walk: build output, dependencies, caches, the system's own. */
const SKIPPED = new Set([
  "node_modules", "bower_components", "vendor", "Pods", "DerivedData", "build", "dist", "out", "target",
  "venv", "__pycache__", "Library", "Applications", "Pictures", "Movies", "Music", "Public", "go", "OrbStack",
])
/** Created folders a new project's path may add below the folder that exists. */
const MAX_NEW_SEGMENTS = 3
/** Emits of one clone's progress at most this often. */
const PROGRESS_MS = 150

interface ScanResult {
  key: string
  at: number
  found: FoundCheckouts
}

interface RunningClone {
  request: CloneRequest
  path: string
  child: ChildProcess
  cancelled: boolean
}

/**
 * Whether `typed` is a whole path, which is all a new project or a chat's may be: from home (`~/`) or the root (`/`);
 * on Windows also `~\`, a drive (`C:\` or `C:/`) or a share (`\\server\share`).
 */
export function typedWholePath(typed: string, windows = onWindows()): boolean {
  if (typed.startsWith("/") || typed.startsWith("~/")) return windows ? !windowsDevicePath(typed) : true
  // `\\?\` and `\\.\` name devices and raw paths past Windows' own checks: never a project's.
  if (windows && windowsDevicePath(typed)) return false
  return windows && (typed.startsWith("~\\") || /^[a-zA-Z]:[\\/]/.test(typed) || /^\\\\[^\\]+\\[^\\]+/.test(typed))
}

// Which Windows paths are devices and shares: one rule, shared with the desktop's links (`contracts/local-folder.ts`).
export { windowsDevicePath, windowsSharePath }

/** What to write when a path isn't whole, in the platform's own words. */
export function wholePathAdvice(windows = onWindows()): string {
  return windows ? "starting with ~\\ or a drive such as C:\\" : "starting with ~/ or /"
}

/** A typed path without the slashes it ends in; on Windows its backslashes too, though never a drive's own (`C:\`). */
export function trimmedPath(typed: string, windows = onWindows()): string {
  if (!windows) return typed.replace(/\/+$/, "")
  const trimmed = typed.replace(/[\\/]+$/, "")
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed
}

/** Expands `~` and resolves `./` and `../` from `base`; any other path is taken as written. */
export function expandPath(text: string, home: string, base?: string): string {
  const trimmed = text.trim()
  if (trimmed === "~") return home
  if (trimmed.startsWith("~/") || (onWindows() && trimmed.startsWith("~\\"))) return resolve(home, trimmed.slice(2))
  if (isAbsolute(trimmed)) return resolve(trimmed)
  return resolve(base && isAbsolute(base) ? base : home, trimmed)
}

/** The folder a typed path lists, the start its names must have, and the path itself, resolved. */
export interface BrowseTarget {
  folder: string
  prefix: string
  path: string
}

/** What a typed path lists: after a slash, everything in the path itself. */
export function browseTarget(text: string, home: string, base?: string): BrowseTarget {
  const trimmed = text.trim()
  if (trimmed.endsWith("/") || (onWindows() && trimmed.endsWith("\\")) || trimmed === "~" || trimmed === "." || trimmed === "..") {
    const path = expandPath(trimmed, home, base)
    return { folder: path, prefix: "", path }
  }
  // The last part as typed: a resolved path would drop a lone "." someone typed to see dotfolders.
  const cut = onWindows() ? Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) : trimmed.lastIndexOf("/")
  const prefix = trimmed.slice(cut + 1)
  const folder = expandPath(cut < 0 ? "." : trimmed.slice(0, cut + 1), home, base)
  return { folder, prefix, path: join(folder, prefix) }
}

/** `owner/name` (or another host's address) of `origin` in a checkout's `.git/config`. */
async function originOf(gitDir: string): Promise<string | undefined> {
  const text = await readFile(join(gitDir, "config"), "utf8").catch(() => undefined)
  const url = text === undefined ? undefined : parseGitConfig(text).get("remote.origin.url")?.at(-1)
  return url ? remoteLabel(url) : undefined
}

async function branchOf(gitDir: string): Promise<string | undefined> {
  const head = await readFile(join(gitDir, "HEAD"), "utf8").catch(() => undefined)
  const match = head && /^ref: refs\/heads\/(.+)$/.exec(head.trim())
  return match ? match[1] : undefined
}

async function isFolder(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isDirectory(), () => false)
}

/** macOS turned the read away: a folder it guards that the person hasn't let Mako into. */
function refusedByMacOS(error: NodeJS.ErrnoException): boolean {
  return error.code === "EPERM" || error.code === "EACCES"
}

/**
 * The folders a person starts projects in: browsing a typed path, the checkouts under home, cloning from GitHub and
 * making a new folder. Clone and create write only below a folder that exists, resolved through its links, and only
 * the one folder they name.
 */
export class ProjectFolders {
  readonly #home: string
  readonly #emit: (event: HostEvent) => void
  #scan: ScanResult | undefined
  #scanning: Promise<FoundCheckouts> | undefined
  readonly #clones = new Map<string, RunningClone>()

  constructor({ emit, home = homedir() }: { emit: (event: HostEvent) => void; home?: string }) {
    this.#emit = emit
    this.#home = home
  }

  async browse(request: FolderBrowseRequest): Promise<FolderBrowse> {
    const { partialPath, base } = FolderBrowseRequestSchema.parse(request)
    const target = browseTarget(partialPath, this.#home, base)
    const showHidden = target.prefix.startsWith(".")
    const wanted = target.prefix.toLowerCase()
    let listed = true
    let names: Dirent[] = []
    try {
      // Typing isn't asking: a share's folders aren't listed as its path is typed, which would sign in to its server.
      if (onWindows() && (windowsSharePath(target.folder) || windowsDevicePath(target.folder))) throw new Error("not listed")
      names = await readdir(target.folder, { withFileTypes: true })
    } catch {
      listed = false
    }
    const candidates = names
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && (showHidden || !entry.name.startsWith(".")))
      .filter((entry) => entry.name.toLowerCase().startsWith(wanted) && entry.name !== target.prefix)
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }))
    const entries = await mapLimit(candidates.slice(0, BROWSE_LIMIT * 2), SCAN_PARALLEL, async (name): Promise<BrowsedFolder | undefined> => {
      const path = join(target.folder, name)
      if (!(await isFolder(path))) return undefined
      return { name, path, git: await isFolder(join(path, ".git")) }
    })
    return {
      home: this.#home,
      folder: target.folder,
      listed,
      entries: entries.filter((entry) => entry !== undefined).slice(0, BROWSE_LIMIT),
      exact: await this.#describe(target.path),
    }
  }

  async #describe(path: string): Promise<BrowsedPath> {
    const info = await stat(path).catch(() => undefined)
    if (!info) return { path, kind: "missing", git: false }
    if (!info.isDirectory()) return { path, kind: "file", git: false }
    const git = await isFolder(join(path, ".git"))
    const described: BrowsedPath = { path, kind: "folder", git }
    const repository = git ? await originOf(join(path, ".git")) : undefined
    if (repository && githubRepository(repository)) described.repository = repository
    return described
  }

  /** What the last scan found, at once; a scan starts when there's none for these folders or it has gone stale. */
  found(request: FoundCheckoutsRequest): FoundCheckouts {
    const { within } = FoundCheckoutsRequestSchema.parse(request)
    const guarded = GUARDED.map((name) => join(this.#home, name)).filter((path) => within.some((each) => each === path || each.startsWith(`${path}${sep}`)))
    const key = guarded.join("\n")
    const held = this.#scan?.key === key ? this.#scan : undefined
    if (!held || Date.now() - held.at > SCAN_FRESH_MS) this.#startScan(key, guarded)
    if (held) return held.found
    return { home: this.#home, state: "scanning", checkouts: this.#scan?.found.checkouts ?? [], skipped: [], refused: [] }
  }

  #startScan(key: string, guarded: string[]): void {
    if (this.#scanning) return
    this.#scanning = this.#walk(guarded)
      .then((found) => {
        this.#scan = { key, at: Date.now(), found }
        this.#emit({ type: "folders-found", found })
        return found
      })
      .catch((error: Error) => {
        hostLog("projects", "scan failed", { error: error.message })
        return { home: this.#home, state: "ready" as const, checkouts: [], skipped: [], refused: [] }
      })
      .finally(() => (this.#scanning = undefined))
  }

  /** The scan itself, for tests; `found` is what windows call. */
  async scan(within: string[] = []): Promise<FoundCheckouts> {
    return this.#walk(GUARDED.map((name) => join(this.#home, name)).filter((path) => within.includes(path)))
  }

  async #walk(guarded: string[]): Promise<FoundCheckouts> {
    const started = Date.now()
    const guardedRoots = onMac() ? GUARDED.map((name) => join(this.#home, name)) : []
    const skipped = guardedRoots.filter((path) => !guarded.includes(path))
    const refused: string[] = []
    const found: FoundCheckout[] = []
    let read = 0
    const queue: Array<{ path: string; depth: number }> = [{ path: this.#home, depth: 0 }]
    const visit = async ({ path, depth }: { path: string; depth: number }) => {
      if (read >= SCAN_FOLDERS || Date.now() - started > SCAN_BUDGET_MS) return
      read += 1
      let entries: Dirent[]
      try {
        entries = await readdir(path, { withFileTypes: true })
      } catch (error) {
        if (guardedRoots.includes(path) && error instanceof Error && refusedByMacOS(error)) refused.push(path)
        return
      }
      const git = entries.find((entry) => entry.name === ".git")
      if (git) {
        // A `.git` file is a linked worktree's or a submodule's: part of another project, never one of its own.
        if (git.isDirectory() && path !== this.#home) found.push(await this.#checkout(path))
        return
      }
      if (depth >= SCAN_DEPTH) return
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue
        const child = join(path, entry.name)
        if (skipped.includes(child) || child === join(this.#home, "Mako")) continue
        queue.push({ path: child, depth: depth + 1 })
      }
    }
    while (queue.length) await mapLimit(queue.splice(0, queue.length), SCAN_PARALLEL, visit)
    found.sort((a, b) => b.touchedAt - a.touchedAt)
    hostLog("projects", "scanned home for checkouts", { found: found.length, folders: read, ms: Date.now() - started, refused: refused.length })
    return { home: this.#home, state: "ready", checkouts: found.slice(0, FOUND_LIMIT), skipped, refused }
  }

  async #checkout(path: string): Promise<FoundCheckout> {
    const gitDir = join(path, ".git")
    const [remote, branch, index, head] = await Promise.all([
      originOf(gitDir),
      branchOf(gitDir),
      stat(join(gitDir, "index")).catch(() => undefined),
      stat(join(gitDir, "HEAD")).catch(() => undefined),
    ])
    const checkout: FoundCheckout = { path, name: basename(path), touchedAt: Math.max(index?.mtimeMs ?? 0, head?.mtimeMs ?? 0) }
    if (remote) checkout.remote = remote
    if (branch) checkout.branch = branch
    return checkout
  }

  /**
   * Clones a GitHub repository into `<into>/<name>` with the person's own Git and credentials, progress as
   * `project-clone` events. A repeated id answers as it did; one whose content differs is refused.
   */
  async clone(request: CloneRequest): Promise<CloneAccepted> {
    const parsed = CloneRequestSchema.parse(request)
    const repository = githubRepository(parsed.repository)
    if (!repository) throw new Error("That isn't a GitHub repository. Paste its address, or type owner/name.")
    const running = this.#clones.get(parsed.id)
    if (running) {
      if (running.request.repository !== parsed.repository || running.request.into !== parsed.into) throw new Error("This clone was already asked for with other details.")
      return { path: running.path, already: false }
    }
    const into = await this.#realFolder(expandPath(parsed.into, this.#home), "clone into")
    const path = join(into, repository.name)
    const label = `${repository.owner}/${repository.name}`
    const there = await this.#describe(path)
    if (there.kind !== "missing") {
      if (there.kind === "folder" && there.repository?.toLowerCase() === label.toLowerCase()) return { path, already: true }
      throw new Error(`${path} already exists. Clone into another folder.`)
    }
    const git = (await findExecutable("git")) ?? "git"
    const child = hostSpawn(git, ["clone", "--progress", `${repository.url}.git`, path], {
      cwd: into,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    })
    const clone: RunningClone = { request: parsed, path, child, cancelled: false }
    this.#clones.set(parsed.id, clone)
    const send = (state: CloneProgress["state"]) => this.#emit({ type: "project-clone", clone: { id: parsed.id, repository: label, path, state } })
    send({ kind: "cloning", phase: "Connecting" })
    let tail = ""
    let sentAt = 0
    let pending = ""
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-4096)
      const lines = (pending + chunk).split(/[\r\n]/)
      pending = lines.pop() ?? ""
      const step = lines.map(cloneStep).filter((each) => each !== undefined).at(-1)
      if (!step || Date.now() - sentAt < PROGRESS_MS) return
      sentAt = Date.now()
      send({ kind: "cloning", phase: step.phase, percent: clonePercent(step) })
    })
    child.once("error", (error) => {
      tail += `\n${error.message}`
    })
    child.once("close", (code) => {
      void (async () => {
        this.#clones.delete(parsed.id)
        if (clone.cancelled || code !== 0) await rm(path, { recursive: true, force: true }).catch(() => undefined)
        if (clone.cancelled) return send({ kind: "cancelled" })
        if (code === 0) {
          hostLog("projects", "cloned", { repository: label })
          return send({ kind: "done", path })
        }
        const signIn = cloneNeedsSignIn(tail)
        hostLog("projects", "clone failed", { repository: label, code: code ?? -1, signIn })
        const fatal = tail.split("\n").map((line) => line.trim()).filter((line) => /^(fatal|error):/.test(line)).at(-1)?.replace(/^(fatal|error):\s*/, "")
        send({
          kind: "failed",
          signIn,
          message: signIn
            ? localWords(`GitHub didn't let this Mac clone ${label}. If it's private, run gh auth login in Terminal, then try again.`)
            : `Git couldn't clone ${label}${fatal ? `: ${fatal}` : "."}`,
        })
      })()
    })
    return { path, already: false }
  }

  /** Stops a clone and removes what it wrote; a clone already over is left as it ended. */
  async cancelClone(id: string): Promise<void> {
    const clone = this.#clones.get(id)
    if (!clone) return
    clone.cancelled = true
    await closeHostChild(clone.child)
  }

  /**
   * Makes the folder `path` names, and a Git repository there when asked, below the nearest folder of it that
   * exists, resolved through its links; at most three new folders deep, and never over anything already there.
   */
  async create(request: CreateProjectRequest): Promise<{ path: string }> {
    const parsed = CreateProjectRequestSchema.parse(request)
    const typed = parsed.path.trim()
    if (typed.split(/[\\/]/).some((part) => part === ".." || part === ".")) throw new Error("Write the new project's whole path, without . or .. in it.")
    const path = expandPath(trimmedPath(typed), this.#home)
    if (!typedWholePath(typed)) throw new Error(`Write the new project's whole path, ${wholePathAdvice()}.`)
    const missing: string[] = []
    let existing = path
    while (!(await lstat(existing).then(() => true, () => false))) {
      missing.unshift(basename(existing))
      const parent = dirname(existing)
      if (parent === existing) break
      existing = parent
    }
    if (missing.length === 0) throw new Error(`${path} already exists. Open it, or pick another name.`)
    if (missing.length > MAX_NEW_SEGMENTS) throw new Error(`Mako makes at most ${MAX_NEW_SEGMENTS} new folders at once; ${existing} is the nearest that exists.`)
    if (missing.some((part) => !part || part.startsWith("."))) throw new Error("A new project's folder name can't start with a dot.")
    const parent = await this.#realFolder(existing, "make the project in")
    const created = join(parent, ...missing)
    await mkdir(created, { recursive: true })
    if (parsed.git) {
      const git = (await findExecutable("git")) ?? "git"
      await hostCommand(git, ["init", "--quiet"], { cwd: created, timeout: 20_000 })
    }
    hostLog("projects", "created a project folder", { git: parsed.git })
    return { path: created }
  }

  async #realFolder(path: string, purpose: string): Promise<string> {
    const real = await realpath(path).catch(() => undefined)
    if (!real || !(await isFolder(real))) throw new Error(localWords(`${path} isn't a folder on this Mac to ${purpose}.`))
    return real
  }
}

/** Browsing, the found checkouts, clones and new projects, for windows on this Mac. */
export function declareProjectMethods(methods: MethodTable, projects: ProjectFolders): void {
  methods.handle("mako:folders-browse", (request: FolderBrowseRequest): Promise<FolderBrowse> => projects.browse(request))
  methods.handle("mako:folders-found", (request: FoundCheckoutsRequest): FoundCheckouts => projects.found(request))
  methods.handle("mako:project-clone", (request: CloneRequest): Promise<CloneAccepted> => projects.clone(request))
  methods.handle("mako:project-clone-cancel", (id: string): Promise<void> => projects.cancelClone(id))
  methods.handle("mako:project-create", (request: CreateProjectRequest): Promise<{ path: string }> => projects.create(request))
}
