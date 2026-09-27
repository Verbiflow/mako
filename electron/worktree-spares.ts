import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { carryDependencies, lockDigest, removeBelowAgents } from "./worktree-dependencies.js"
import { git, PARALLEL_CHECKOUT } from "./worktree-git.js"

/** Enough for two new Threads in a row without waiting; the one after that waits for a refill. */
export const SPARES_PER_PROJECT = 2
const MAX_SPARES = 6
/** A project nobody has started a worktree Thread in for a day gives its disk back. */
const IDLE_MS = 24 * 60 * 60_000
const MIN_FREE_BYTES = 10 * 1024 ** 3
/** A filling lock older than this belongs to a host that died mid-checkout. */
const FILL_LOCK_MS = 15 * 60_000
const LOCK_REASON = "Mako keeps this checkout ready for a new Thread"

const SpareSchema = z.object({
  id: z.string().uuid(),
  repoRoot: z.string(),
  path: z.string(),
  /** The commit checked out. */
  base: z.string(),
  state: z.enum(["preparing", "ready"]),
  pid: z.number(),
  createdAt: z.number(),
  /** `lockDigest` of the main checkout when its dependencies were cloned in. */
  lock: z.string(),
  dependencies: z.array(z.string()),
  tookMs: z.number().optional(),
})
export type Spare = z.infer<typeof SpareSchema>

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

/**
 * Checkouts made ahead of time for projects that start Threads in worktrees,
 * so a first send takes one instead of waiting for `git worktree add`.
 *
 * A spare is a detached, locked worktree beside the project's Thread
 * worktrees (`.spare-…`), checked out and given the main checkout's
 * dependencies in the background band. Hooks don't run while it's prepared;
 * the claim's `git checkout -b` runs them, as a fresh worktree would. Records
 * live in `spares/`, one file each, so the installed app and a development
 * host sharing this root see one pool: a claim renames the record, which
 * only one process can do.
 */
export class WorktreeSpares {
  private readonly records: string
  private readonly trash: string
  private readonly projectFolder: (repoRoot: string) => string
  private filling: Promise<void> = Promise.resolve()

  constructor(root: string, projectFolder: (repoRoot: string) => string) {
    this.records = join(root, "spares")
    this.trash = join(root, "trash")
    this.projectFolder = projectFolder
  }

  /** A project is starting worktree Threads: keep its spares and top them up in the background. */
  async want(repoRoot: string): Promise<void> {
    await mkdir(this.records, { recursive: true, mode: 0o700 })
    await writeFile(this.wantedFile(repoRoot), String(Date.now()), { mode: 0o600 })
    this.filling = this.filling.then(() => this.fill(repoRoot)).catch(() => {})
  }

  /** Resolves once every requested fill has finished. */
  settled(): Promise<void> {
    return this.filling
  }

  /** Take a ready spare of `repoRoot`, or none. Only one caller anywhere gets a given spare. */
  async claim(repoRoot: string): Promise<Spare | undefined> {
    const ready = (await this.list()).filter((spare) => spare.repoRoot === repoRoot && spare.state === "ready").sort((a, b) => a.createdAt - b.createdAt)
    for (const spare of ready) {
      try {
        await rename(this.file(spare.id), this.file(spare.id, "claimed"))
      } catch {
        continue
      }
      if (existsSync(spare.path)) return spare
      await rm(this.file(spare.id, "claimed"), { force: true })
    }
    return undefined
  }

  /** The claimed spare is a Thread's worktree now. */
  async used(spare: Spare): Promise<void> {
    await rm(this.file(spare.id, "claimed"), { force: true })
  }

  /** Ready and preparing spares, after giving back what's idle, orphaned or half-made by a host that died. */
  async sweep(): Promise<Spare[]> {
    const now = Date.now()
    const kept: Spare[] = []
    for (const spare of await this.list(true)) {
      const orphaned = spare.state === "preparing" && !alive(spare.pid)
      const wanted = Number(await readFile(this.wantedFile(spare.repoRoot), "utf8").catch(() => "0")) || spare.createdAt
      if (orphaned || now - wanted > IDLE_MS || !existsSync(spare.path)) await this.discard(spare)
      else kept.push(spare)
    }
    for (const name of await readdir(this.records).catch(() => [])) {
      if (!name.endsWith(".claimed")) continue
      const path = join(this.records, name)
      const claimed = SpareSchema.safeParse(await readFile(path, "utf8").then(JSON.parse).catch(() => null)).data
      const age = now - ((await stat(path).catch(() => null))?.mtimeMs ?? now)
      // A claim finishes in seconds; one this old stopped with its host, before or after the move.
      if (claimed && age > FILL_LOCK_MS) {
        if (existsSync(claimed.path)) await this.discard(claimed)
        await rm(path, { force: true })
      }
    }
    for (const name of await readdir(this.trash).catch(() => [])) void emptyTrash(join(this.trash, name))
    return kept
  }

  /** Remove a spare: moved aside at once, deleted in the background band. */
  async discard(spare: Spare): Promise<void> {
    await rm(this.file(spare.id), { force: true })
    await rm(this.file(spare.id, "claimed"), { force: true })
    if (existsSync(spare.path)) await setAside(spare.repoRoot, spare.path, this.trash)
    else await git(spare.repoRoot, ["worktree", "prune"]).catch(() => {})
  }

  private async fill(repoRoot: string): Promise<void> {
    if (existsSync(join(repoRoot, ".gitmodules"))) return
    const release = await this.lockFilling(repoRoot)
    if (!release) return
    try {
      for (;;) {
        const spares = await this.sweep()
        if (spares.filter((spare) => spare.repoRoot === repoRoot).length >= SPARES_PER_PROJECT || spares.length >= MAX_SPARES) return
        const space = await statfs(this.projectFolder(repoRoot)).catch(() => statfs(repoRoot))
        if (space.bavail * space.bsize < MIN_FREE_BYTES) return
        await this.prepare(repoRoot)
      }
    } finally {
      await release()
    }
  }

  private async prepare(repoRoot: string): Promise<void> {
    const began = performance.now()
    const id = randomUUID()
    const base = await git(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
    const folder = this.projectFolder(repoRoot)
    await mkdir(folder, { recursive: true, mode: 0o700 })
    let spare: Spare = {
      id,
      repoRoot,
      path: join(folder, `.spare-${id.slice(0, 8)}`),
      base,
      state: "preparing",
      pid: process.pid,
      createdAt: Date.now(),
      lock: "",
      dependencies: [],
    }
    await this.save(spare)
    try {
      await git(repoRoot, ["worktree", "add", "--detach", "--no-checkout", spare.path, base], true)
      await git(repoRoot, ["worktree", "lock", "--reason", LOCK_REASON, spare.path])
      await git(spare.path, [...PARALLEL_CHECKOUT, "reset", "--hard", "-q", base], true)
      const written = Date.now()
      const lock = await lockDigest(repoRoot)
      const { carried } = await carryDependencies(repoRoot, spare.path, true)
      // Git trusts an index entry only when its file is older than the index,
      // to the second; entries written in the index's own second are re-read
      // by the next command, 80-180 ms for 2,000 files. Refreshing once that
      // second has passed moves the cost here, off the send.
      const pastSecond = Math.ceil((written + 1) / 1000) * 1000 - Date.now()
      if (pastSecond > 0) await delay(pastSecond)
      await git(spare.path, ["update-index", "-q", "--refresh"], true).catch(() => {})
      spare = { ...spare, state: "ready", lock, dependencies: carried, tookMs: Math.round(performance.now() - began) }
      await this.save(spare)
    } catch (error) {
      await this.discard(spare)
      throw error
    }
  }

  /** One host fills a project at a time; a lock left by a host that died is taken over. */
  private async lockFilling(repoRoot: string): Promise<(() => Promise<void>) | undefined> {
    await mkdir(this.records, { recursive: true, mode: 0o700 })
    const path = join(this.records, `${basename(this.projectFolder(repoRoot))}.filling`)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx", 0o600)
        await handle.writeFile(String(process.pid))
        await handle.close()
        return () => rm(path, { force: true })
      } catch {
        const holder = Number(await readFile(path, "utf8").catch(() => "0"))
        const age = Date.now() - ((await stat(path).catch(() => null))?.mtimeMs ?? 0)
        if (holder && alive(holder) && age < FILL_LOCK_MS) return undefined
        await rm(path, { force: true })
      }
    }
    return undefined
  }

  /** `prune` deletes records that aren't a spare (a write cut short, another version's shape). */
  private async list(prune = false): Promise<Spare[]> {
    const spares: Spare[] = []
    for (const name of await readdir(this.records).catch(() => [])) {
      if (!name.endsWith(".json")) continue
      const text = await readFile(join(this.records, name), "utf8").catch(() => null)
      if (text === null) continue
      const parsed = SpareSchema.safeParse((() => {
        try {
          return JSON.parse(text)
        } catch {
          return null
        }
      })())
      if (parsed.success) spares.push(parsed.data)
      else if (prune) await rm(join(this.records, name), { force: true })
    }
    return spares
  }

  private wantedFile(repoRoot: string): string {
    return join(this.records, `${basename(this.projectFolder(repoRoot))}.wanted`)
  }

  private file(id: string, suffix = "json"): string {
    return join(this.records, `${id}.${suffix}`)
  }

  private async save(spare: Spare): Promise<void> {
    await mkdir(this.records, { recursive: true, mode: 0o700 })
    const pending = join(this.records, `${spare.id}.${randomUUID()}.tmp`)
    await writeFile(pending, JSON.stringify(spare), { mode: 0o600 })
    await rename(pending, this.file(spare.id))
  }
}

const emptying = new Set<string>()

function emptyTrash(path: string): Promise<void> {
  if (emptying.has(path)) return Promise.resolve()
  emptying.add(path)
  return removeBelowAgents(path).finally(() => emptying.delete(path))
}

/**
 * Remove a worktree without waiting on its files: Git moves it into `trash`
 * (a rename, and Git's own records follow), then deletes it in the
 * background band. Callers check first that nothing uncommitted is lost.
 */
export async function setAside(repoRoot: string, path: string, trash: string): Promise<void> {
  await mkdir(trash, { recursive: true, mode: 0o700 })
  const aside = join(trash, randomUUID())
  const moved = await git(repoRoot, ["worktree", "move", "-f", "-f", path, aside]).then(() => true, () => false)
  const target = moved ? aside : path
  // Frees its branch now rather than when the delete finishes, so it can be checked out elsewhere at once.
  const commit = await git(target, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "")
  if (commit) await git(target, ["update-ref", "--no-deref", "HEAD", commit]).catch(() => {})
  emptying.add(target)
  void git(repoRoot, ["worktree", "remove", "-f", "-f", target], true)
    .catch(() => removeBelowAgents(target).then(() => git(repoRoot, ["worktree", "prune"])))
    .catch(() => {})
    .finally(() => emptying.delete(target))
}

/**
 * Turn a claimed spare into the worktree at `path` on a new `branch` from
 * `base`. The reset writes only what changed since the spare was made.
 */
export async function placeSpare(spare: Spare, path: string, branch: string, base: string): Promise<void> {
  if (spare.base !== base) await git(spare.path, [...PARALLEL_CHECKOUT, "reset", "--hard", "-q", base])
  await git(spare.repoRoot, ["worktree", "move", "-f", "-f", spare.path, path])
  await Promise.all([git(spare.repoRoot, ["worktree", "unlock", path]).catch(() => {}), git(path, ["checkout", "-q", "-b", branch])])
}
