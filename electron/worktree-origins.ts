import { randomUUID } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import type { LinkedCheckout } from "./contracts/checkout-heads.js"
import { gitDirPointer, pointedCheckout, spelledLike } from "./checkout-heads.js"

/** Worktrees remembered after they're gone, at most; the ones seen longest ago go first. */
const REMEMBERED = 2_000
/** A folder that isn't there is looked for again after this long. */
const MISSING_RECHECK_MS = 60_000
const SAVE_DELAY_MS = 1_000
/** A worktree still in use has its sighting written again this often, so trimming keeps it. */
const RESIGHT_MS = 24 * 60 * 60_000

/** Claude Code keeps its worktrees inside the repository, so the path names whose they are. */
const CLAUDE_WORKTREE = /^(.+)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+/

interface Remembered {
  repoRoot: string
  seenAt: number
}

const plain = (path: string) => (path.startsWith("/private/") ? path.slice("/private".length) : path)
const inside = (folder: string, path: string) => plain(path) === plain(folder) || plain(path).startsWith(`${plain(folder)}/`)

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim()
  } catch {
    return null
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const RememberedFileSchema = z.object({ worktrees: z.record(z.string(), z.unknown()) })
const RememberedSchema = z.object({ repoRoot: z.string(), seenAt: z.number() })

function parseRemembered(text: string | null): Map<string, Remembered> {
  const found = new Map<string, Remembered>()
  if (!text) return found
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A torn file starts the memory over; worktrees on disk are found again.
    return found
  }
  const file = RememberedFileSchema.safeParse(parsed)
  if (!file.success) return found
  for (const [path, value] of Object.entries(file.data.worktrees)) {
    const entry = RememberedSchema.safeParse(value)
    if (entry.success) found.set(path, { repoRoot: entry.data.repoRoot, seenAt: entry.data.seenAt })
  }
  return found
}

/**
 * Which linked Git worktree a session's folder is in, and whose repository
 * that is, whichever tool made it: an agent's `git worktree add`, a
 * harness's worktree mode, the user's, Mako's own. The host puts the answer
 * on every session it serves, so the window files a worktree's sessions
 * under their project from the first list, in every view, without asking
 * about each folder.
 *
 * A folder is read once: a stat of `.git` per directory up the tree until
 * one answers, and two small reads for a worktree. Worktrees are remembered
 * in `file`, shared by every host of this user, so the sessions of a
 * worktree that was since removed still file under its project.
 */
export class WorktreeOrigins {
  private readonly file: string
  private readonly directories = new Map<string, LinkedCheckout | null>()
  private readonly missing = new Map<string, { at: number; found: LinkedCheckout | null }>()
  private readonly remembered: Map<string, Remembered>
  private saving: ReturnType<typeof setTimeout> | null = null

  constructor(file: string) {
    this.file = file
    this.remembered = parseRemembered(readText(file))
  }

  /** The worktree holding `folder`, or undefined for a main checkout, no repository, or a folder never known as a worktree. */
  of(folder: string): LinkedCheckout | undefined {
    const known = this.directories.get(folder)
    if (known !== undefined) return known ?? undefined
    const gone = this.missing.get(folder)
    if (gone && Date.now() - gone.at < MISSING_RECHECK_MS) return gone.found ?? undefined
    if (!isDirectory(folder)) {
      const found = this.recalled(folder)
      this.missing.set(folder, { at: Date.now(), found })
      return found ?? undefined
    }
    this.missing.delete(folder)
    return this.located(folder) ?? undefined
  }

  /** Writes what's pending now; for a host that is quitting. */
  async flush(): Promise<void> {
    if (!this.saving) return
    clearTimeout(this.saving)
    this.saving = null
    await this.save()
  }

  private located(folder: string): LinkedCheckout | null {
    const walked: string[] = []
    let found: LinkedCheckout | null = null
    for (let dir = resolve(folder); ; dir = dirname(dir)) {
      const known = this.directories.get(dir)
      if (known !== undefined) {
        found = known
        break
      }
      walked.push(dir)
      const dotGit = join(dir, ".git")
      let isFile = false
      try {
        const info = statSync(dotGit)
        if (info.isDirectory()) break
        isFile = info.isFile()
      } catch {
        // No .git here; its parent may have one.
      }
      if (isFile) {
        const gitDir = gitDirPointer(dir, readText(dotGit))
        found = gitDir ? (pointedCheckout(dir, gitDir, readText(join(gitDir, "commondir"))).linked ?? null) : null
        if (found) this.remember(found)
        break
      }
      if (dirname(dir) === dir) break
    }
    for (const dir of walked) this.directories.set(dir, found)
    return found
  }

  /** A folder that's gone: the worktree it was in when some host last saw it, spelled as the folder is, or Claude's layout. */
  private recalled(folder: string): LinkedCheckout | null {
    for (const [path, { repoRoot }] of this.remembered)
      if (inside(path, folder)) return { path: spelledLike(path, folder), repoRoot: spelledLike(repoRoot, folder) }
    const claude = CLAUDE_WORKTREE.exec(folder)
    return claude ? { path: claude[0], repoRoot: claude[1] } : null
  }

  private remember(linked: LinkedCheckout): void {
    const before = this.remembered.get(linked.path)
    const now = Date.now()
    if (before?.repoRoot === linked.repoRoot && now - before.seenAt < RESIGHT_MS) return
    this.remembered.set(linked.path, { repoRoot: linked.repoRoot, seenAt: now })
    this.saving ??= setTimeout(() => {
      this.saving = null
      void this.save()
    }, SAVE_DELAY_MS)
    this.saving.unref?.()
  }

  /** Merged with what other hosts wrote since, newest sighting winning, then trimmed. */
  private async save(): Promise<void> {
    const onDisk = parseRemembered(await readFile(this.file, "utf8").catch(() => null))
    for (const [path, entry] of onDisk) {
      const mine = this.remembered.get(path)
      if (!mine || mine.seenAt < entry.seenAt) this.remembered.set(path, entry)
    }
    const kept = [...this.remembered].sort((a, b) => b[1].seenAt - a[1].seenAt).slice(0, REMEMBERED)
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(temporary, JSON.stringify({ worktrees: Object.fromEntries(kept) }), { mode: 0o600 })
      await rename(temporary, this.file)
    } catch {
      // Unsaved, the worktrees are still known in memory and found again on disk.
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
