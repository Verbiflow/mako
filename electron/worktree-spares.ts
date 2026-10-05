import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { lstat, mkdir, open, readFile, readdir, readlink, rename, rm, stat, statfs, symlink, unlink, writeFile } from "node:fs/promises"
import { basename, isAbsolute, join, relative } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { AppKeySchema } from "./contracts/thread-environments.js"
import { PROJECT_CHECKOUT_FILE } from "./contracts/thread-worktrees.js"
import { projectRepositories } from "./repository-discovery.js"
import { folderApp } from "./thread-environment.js"
import { CARRYING, CARRYING_STALE_MS, carryOutputs, isSpareCheckout, removeBelowAgents, SPARE_PREFIX, type CheckoutSetup } from "./worktree-carry.js"
import { git, PARALLEL_CHECKOUT } from "@mako/git"

/** Enough for two new Threads in a row without waiting; the one after that waits for a refill. */
export const SPARES_PER_PROJECT = 2
const MAX_SPARES = 6
/** A project nobody has started a worktree Thread in for a day gives its disk back. */
const IDLE_MS = 24 * 60 * 60_000
const MIN_FREE_BYTES = 10 * 1024 ** 3
/** A filling lock older than this belongs to a host that died mid-checkout. */
const FILL_LOCK_MS = 15 * 60_000
const LOCK_REASON = "Mako keeps this checkout ready for a new Thread"
/** While memory is short or a Thread installs or checks, a spare's install looks again this often, and gives up after an hour. */
const INSTALL_RETRY_MS = 15_000
const INSTALL_WAIT_MS = 60 * 60_000
const INSTALL_POLL_MS = 2_000
/** A claim, its move and an install starting or ending each take well under a second. */
const HOLD_WAIT_MS = 60_000

const SpareSchema = z.object({
  id: z.string().uuid(),
  repoRoot: z.string(),
  path: z.string(),
  /** The commit checked out; empty for a project folder's, whose `members` each name theirs. */
  base: z.string(),
  /** A project folder of several repositories: each one's worktree, at its place inside `path` as in the folder, and the commit there. */
  members: z.array(z.object({ repoRoot: z.string(), base: z.string() })).optional(),
  state: z.enum(["preparing", "ready"]),
  pid: z.number(),
  createdAt: z.number(),
  /** Install steps' outputs cloned in from the main checkout, with the digest of the inputs they fit. */
  outputs: z.array(z.object({ command: z.string(), inputs: z.array(z.string()), digest: z.string(), entries: z.array(z.string()) })).default([]),
  tookMs: z.number().optional(),
  /** The install steps it ran once ready, as its own app's prepare run: under way, or how that ended. */
  install: z.object({
    app: AppKeySchema,
    command: z.string(),
    /** What the steps read, so a claim at another commit knows whether a reset would change them under the run. */
    inputs: z.array(z.string()),
    state: z.enum(["running", "passed", "failed", "stopped"]),
    /** The host that records how it ends. */
    host: z.number(),
  }).optional(),
})
export type Spare = z.infer<typeof SpareSchema>

/** The commit a start wants a repository's worktree at. */
export interface SpareTarget { repoRoot: string; base: string }

/** The spare's worktrees as they are at `path`: the one of its repository, or one per repository of its project folder. */
function worktreesOf(spare: Pick<Spare, "repoRoot" | "path" | "base" | "members">, path = spare.path): Array<SpareTarget & { path: string }> {
  if (!spare.members) return [{ repoRoot: spare.repoRoot, base: spare.base, path }]
  return spare.members.map((member) => ({ ...member, path: join(path, relative(spare.repoRoot, member.repoRoot)) }))
}

/** Whether the spare mirrors what a start needs: one repository, or the same repositories of a project folder. */
function fits(spare: Spare, repositories: readonly string[] | undefined): boolean {
  if (!repositories || !spare.members) return !repositories && !spare.members
  const held = spare.members.map((member) => member.repoRoot).sort()
  return held.length === repositories.length && [...repositories].sort().every((repoRoot, index) => repoRoot === held[index])
}

/**
 * Ready spares in the order a claim takes them: installed or needing none,
 * then one installing, then one whose install hasn't started (`waiting`),
 * then one whose install ended without passing.
 */
function claimOrder(spare: Spare, waiting: boolean): number {
  if (spare.install?.state === "passed") return 0
  if (!spare.install) return waiting ? 2 : 0
  return spare.install.state === "running" ? 1 : 3
}

async function isLink(path: string): Promise<boolean> {
  return Boolean((await lstat(path).catch(() => undefined))?.isSymbolicLink())
}

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
 * worktrees (`.spare-…`), checked out and given the outputs of the recipe's
 * install steps in the background band. A project folder of several
 * repositories gets a folder mirroring it, with one such worktree of each
 * repository at its place. Hooks don't run while it's prepared;
 * the claim's `git checkout -b` runs them, as a fresh worktree would. Records
 * live in `spares/`, one file each, so the installed app and a development
 * host sharing this root see one pool: a claim renames the record, which
 * only one process can do.
 *
 * Once ready, a spare runs what of the install cloning didn't cover, as an
 * app of its own (`spareInstall`), one spare at a time, at the lowest
 * priority, and only while memory is plentiful and no Thread is installing
 * or checking. The checkout's install record goes with it to the Thread.
 * A claim while that install runs hands it over: its processes are paused
 * for the move, a link where the spare was keeps the paths they resolved
 * working, and the record names the run, so the Thread's start waits for it
 * instead of installing again.
 */
export class WorktreeSpares {
  private readonly root: string
  private readonly records: string
  private readonly trash: string
  private readonly projectFolder: (repoRoot: string) => string
  private readonly setup: CheckoutSetup | undefined
  private filling: Promise<void> = Promise.resolve()
  private installs: Promise<void> = Promise.resolve()
  /** Spares this host has queued an install or a follow for. */
  private readonly queued = new Set<string>()

  constructor(root: string, projectFolder: (repoRoot: string) => string, setup?: CheckoutSetup) {
    this.root = root
    this.records = join(root, "spares")
    this.trash = join(root, "trash")
    this.projectFolder = projectFolder
    this.setup = setup
  }

  /** A project is starting worktree Threads: keep its spares and top them up in the background. */
  async want(repoRoot: string): Promise<void> {
    await mkdir(this.records, { recursive: true, mode: 0o700 })
    await writeFile(this.wantedFile(repoRoot), String(Date.now()), { mode: 0o600 })
    this.filling = this.filling.then(() => this.fill(repoRoot)).catch(() => {})
  }

  /** Resolves once every requested fill has finished, and every install this host started or follows has ended. */
  async settled(): Promise<void> {
    await this.filling
    for (let installs = this.installs; ; installs = this.installs) {
      await installs
      if (installs === this.installs) return
    }
  }

  /**
   * Take a ready spare of `repoRoot`, or none; of a project folder, one
   * holding `repositories`, no more and no fewer. Only one caller anywhere
   * gets a given spare.
   */
  async claim(repoRoot: string, repositories?: readonly string[]): Promise<Spare | undefined> {
    const ready = (await this.list()).filter((spare) => spare.repoRoot === repoRoot && spare.state === "ready" && fits(spare, repositories))
      .sort((a, b) => claimOrder(a, this.queued.has(a.id)) - claimOrder(b, this.queued.has(b.id)) || a.createdAt - b.createdAt)
    for (const spare of ready) {
      const taken = await this.holding(spare.id, () => rename(this.file(spare.id), this.file(spare.id, "claimed")).then(() => true, () => false))
      if (!taken) continue
      const current = (await this.read(spare.id, "claimed")) ?? spare
      if (existsSync(current.path) && !(await isLink(current.path))) return current
      await rm(this.file(spare.id, "claimed"), { force: true })
    }
    return undefined
  }

  /**
   * Turn a claimed spare into the checkout at `path` on `branch`, each
   * worktree at its target's commit, with its install record. An install
   * still running goes with it, unless the claim's commits change what it
   * reads; then it stops, and the Thread's start installs.
   */
  async place(spare: Spare, path: string, branch: string, targets: readonly SpareTarget[]): Promise<void> {
    const installer = this.setup?.spareInstall
    await this.holding(spare.id, async () => {
      const install = spare.install
      let running = Boolean(install && installer && (await installer.settle(spare.path)) === "running")
      if (running && install && installer && !(await sameInputs(spare, targets, install.inputs))) {
        await installer.stop(install.app)
        await installer.settle(spare.path)
        running = false
      }
      const record = await this.setup?.prepared(spare.path)
      if (record && (record.pending || Object.keys(record.done).length)) {
        await this.setup!.savePrepared(path, running ? { ...record, link: spare.path } : record)
        await this.setup!.forgetPrepared?.(spare.path)
      }
      const handOver = running && install && installer
        ? (move: () => Promise<void>) => installer.paused(install.app, async () => {
            await move()
            await symlink(path, spare.path)
          })
        : undefined
      try {
        await placeSpare(spare, path, branch, targets, handOver)
      } catch (error) {
        // Never moved: the start checks out afresh at `path`, which the record doesn't describe.
        if (!existsSync(path)) await this.setup?.forgetPrepared?.(path)
        throw error
      }
    })
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
      if (orphaned || now - wanted > IDLE_MS || !existsSync(spare.path) || (await isLink(spare.path))) await this.discard(spare)
      else {
        kept.push(spare)
        // Its install outlived the host that followed it.
        if (spare.install?.state === "running" && !alive(spare.install.host)) this.queue(spare.id, () => this.adopt(spare.id))
      }
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
    for (const project of await readdir(this.root).catch(() => [])) {
      const staging = join(this.root, project, CARRYING)
      for (const name of await readdir(staging).catch(() => [])) {
        const path = join(staging, name)
        const age = now - ((await stat(path).catch(() => null))?.mtimeMs ?? now)
        if (age > CARRYING_STALE_MS) void removeBelowAgents(path)
      }
      // Links left where a claimed spare was: an install handed over that has ended is recorded for its Thread, which may not have started since.
      for (const name of await readdir(join(this.root, project)).catch(() => [])) {
        const link = join(this.root, project, name)
        if (!isSpareCheckout(name) || !(await isLink(link))) continue
        const target = await readlink(link).catch(() => "")
        const record = target ? await this.setup?.prepared(target).catch(() => undefined) : undefined
        if (record?.link === link && record.pending && (await this.setup?.spareInstall?.settle(target).catch(() => "running")) === "running") continue
        await unlink(link).catch(() => {})
      }
    }
    for (const name of await readdir(this.trash).catch(() => [])) void emptyTrash(join(this.trash, name))
    return kept
  }

  /** Spares as recorded, ready or being made, without giving any back. */
  recorded(): Promise<Spare[]> {
    return this.list()
  }

  /**
   * Remove a spare: its install stopped, moved aside at once, deleted in the
   * background band. A link where it was means a Thread has it now, with
   * whatever runs there.
   */
  async discard(spare: Spare): Promise<void> {
    await rm(this.file(spare.id), { force: true })
    await rm(this.file(spare.id, "claimed"), { force: true })
    if (await isLink(spare.path)) return
    const installer = this.setup?.spareInstall
    if (spare.install && installer) {
      await installer.stop(spare.install.app).catch(() => {})
      await installer.settle(spare.path).catch(() => {})
    }
    await this.setup?.forgetPrepared?.(spare.path).catch(() => {})
    if (!existsSync(spare.path)) {
      for (const worktree of worktreesOf(spare)) await git(worktree.repoRoot, ["worktree", "prune"]).catch(() => {})
    } else if (spare.members) await setAsideFolder(spare, this.trash)
    else await setAside(spare.repoRoot, spare.path, this.trash)
  }

  /**
   * `repoRoot` is a repository's top folder, or a project folder that isn't
   * one; a project's spare holds a worktree of each repository in it.
   */
  private async fill(repoRoot: string): Promise<void> {
    const project = existsSync(join(repoRoot, ".git")) ? undefined : await projectRepositories(repoRoot)
    if (project && "refusal" in project) return
    const repositories = project?.roots
    if ((repositories ?? [repoRoot]).some((repository) => existsSync(join(repository, ".gitmodules")))) return
    const release = await this.lockFilling(repoRoot)
    if (!release) return
    try {
      for (;;) {
        let spares = await this.sweep()
        // A project folder whose repositories changed since its spares were made: they mirror what it was. One claimed meanwhile is a Thread's.
        const stale = spares.filter((spare) => spare.repoRoot === repoRoot && spare.state === "ready" && !fits(spare, repositories))
        for (const spare of stale) await this.holding(spare.id, async () => { if (await this.read(spare.id)) await this.discard(spare) })
        spares = spares.filter((spare) => !stale.includes(spare))
        // Installs given up on while the machine was busy, stopped to make room, or never started by a host that stopped, go again.
        for (const spare of spares)
          if (spare.repoRoot === repoRoot && spare.state === "ready" && (!spare.install || spare.install.state === "stopped")) this.queue(spare.id, () => this.install(spare.id))
        if (spares.filter((spare) => spare.repoRoot === repoRoot).length >= SPARES_PER_PROJECT || spares.length >= MAX_SPARES) return
        const space = await statfs(this.projectFolder(repoRoot)).catch(() => statfs(repoRoot))
        if (space.bavail * space.bsize < MIN_FREE_BYTES) return
        await this.prepare(repoRoot, repositories)
      }
    } finally {
      await release()
    }
  }

  /** One install at a time in this host, behind the others; a spare already queued here isn't queued twice. */
  private queue(id: string, work: () => Promise<void>): void {
    if (!this.setup?.spareInstall || this.queued.has(id)) return
    this.queued.add(id)
    this.installs = this.installs.then(work).catch(() => {}).finally(() => this.queued.delete(id))
  }

  /** Starts the spare's install once the machine is quiet enough, then follows it to its end. */
  private async install(id: string): Promise<void> {
    const installer = this.setup?.spareInstall
    if (!installer) return
    const began = Date.now()
    for (;;) {
      const started = await this.holding(id, async () => {
        const spare = await this.read(id)
        if (!spare || spare.state !== "ready" || (spare.install && spare.install.state !== "stopped")) return undefined
        const app = folderApp(spare.path)
        const result = await installer.start(app, spare.path)
        if (result && result !== "wait") await this.save({ ...spare, install: { app, ...result, state: "running", host: process.pid } })
        return result
      })
      if (started === undefined) return
      if (started !== "wait") break
      if (Date.now() - began > INSTALL_WAIT_MS) return
      await delay(INSTALL_RETRY_MS)
    }
    await this.follow(id)
  }

  /** Follows an install whose host stopped. */
  private async adopt(id: string): Promise<void> {
    const taken = await this.holding(id, async () => {
      const spare = await this.read(id)
      if (spare?.install?.state !== "running" || alive(spare.install.host)) return false
      await this.save({ ...spare, install: { ...spare.install, host: process.pid } })
      return true
    })
    if (taken) await this.follow(id)
  }

  /**
   * Waits for the spare's install to end and records how, giving way when
   * memory runs out. Once a Thread has claimed it, the record went with
   * the checkout, and the link where it was says where to.
   */
  private async follow(id: string): Promise<void> {
    const installer = this.setup!.spareInstall!
    const first = await this.read(id)
    if (!first?.install) return
    const { path } = first
    for (;;) {
      await delay(INSTALL_POLL_MS)
      const over = await this.holding(id, async () => {
        const spare = await this.read(id)
        if (!spare?.install) {
          const moved = await readlink(path).catch(() => undefined)
          if (moved !== undefined) return (await installer.settle(moved)) !== "running"
          // Claimed, and not moved yet: the move leaves the link, or no install to follow.
          return !(await this.read(id, "claimed"))
        }
        if (spare.install.state !== "running") return true
        const gaveWay = await installer.critical()
        if (gaveWay) await installer.stop(spare.install.app)
        const state = await installer.settle(spare.path)
        if (state === "running") return false
        await this.save({ ...spare, install: { ...spare.install, state: gaveWay || state === "none" ? "stopped" : state } })
        return true
      })
      if (over) return
    }
  }

  /**
   * One change to a spare at a time, across every host sharing the pool:
   * a claim, its move, and its install starting or ending. A lock whose
   * holder has gone is taken over.
   */
  private async holding<T>(id: string, work: () => Promise<T>): Promise<T> {
    await mkdir(this.records, { recursive: true, mode: 0o700 })
    const path = this.file(id, "lock")
    const deadline = Date.now() + HOLD_WAIT_MS
    for (;;) {
      try {
        const handle = await open(path, "wx", 0o600)
        await handle.writeFile(String(process.pid))
        await handle.close()
        break
      } catch (error) {
        if (!z.object({ code: z.literal("EEXIST") }).safeParse(error).success) throw error
      }
      const holder = Number(await readFile(path, "utf8").catch(() => "0"))
      const age = Date.now() - ((await stat(path).catch(() => null))?.mtimeMs ?? Date.now())
      if (holder ? !alive(holder) : age > 5_000) {
        await rm(path, { force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error("Another Mako has been changing this spare checkout for a minute.")
      await delay(25)
    }
    try {
      return await work()
    } finally {
      await rm(path, { force: true })
    }
  }

  private async read(id: string, suffix: "json" | "claimed" = "json"): Promise<Spare | undefined> {
    const text = await readFile(this.file(id, suffix), "utf8").catch(() => undefined)
    if (text === undefined) return undefined
    try {
      return SpareSchema.safeParse(JSON.parse(text)).data
    } catch {
      return undefined
    }
  }

  private async prepare(repoRoot: string, repositories: readonly string[] | undefined): Promise<void> {
    const began = performance.now()
    const id = randomUUID()
    const head = (repository: string) => git(repository, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
    const members = repositories && await Promise.all(repositories.map(async (repository) => ({ repoRoot: repository, base: await head(repository) })))
    const folder = this.projectFolder(repoRoot)
    await mkdir(folder, { recursive: true, mode: 0o700 })
    let spare: Spare = {
      id,
      repoRoot,
      path: join(folder, `${SPARE_PREFIX}${id.slice(0, 8)}`),
      base: members ? "" : await head(repoRoot),
      ...(members && { members }),
      state: "preparing",
      pid: process.pid,
      createdAt: Date.now(),
      outputs: [],
    }
    await this.save(spare)
    try {
      if (members) {
        await mkdir(spare.path, { mode: 0o700 })
        // Names the project, so the spare reads its recipe as a Thread's checkout of it does.
        await writeFile(join(spare.path, PROJECT_CHECKOUT_FILE), `${JSON.stringify({ project: repoRoot })}\n`, { mode: 0o600 })
      }
      for (const worktree of worktreesOf(spare)) {
        await git(worktree.repoRoot, ["worktree", "add", "--detach", "--no-checkout", worktree.path, worktree.base], true)
        await git(worktree.repoRoot, ["worktree", "lock", "--reason", LOCK_REASON, worktree.path])
        await git(worktree.path, [...PARALLEL_CHECKOUT, "reset", "--hard", "-q", worktree.base], true)
      }
      const written = Date.now()
      // The record goes with the spare to its Thread's path (`place`).
      const recipe = await this.setup?.recipe(spare.path)
      const { carried } = await carryOutputs(repoRoot, spare.path, recipe?.prepare ?? [], this.setup, true)
      // Git trusts an index entry only when its file is older than the index,
      // to the second; entries written in the index's own second are re-read
      // by the next command, 80-180 ms for 2,000 files. Refreshing once that
      // second has passed moves the cost here, off the send.
      const pastSecond = Math.ceil((written + 1) / 1000) * 1000 - Date.now()
      if (pastSecond > 0) await delay(pastSecond)
      for (const worktree of worktreesOf(spare)) await git(worktree.path, ["update-index", "-q", "--refresh"], true).catch(() => {})
      spare = { ...spare, state: "ready", outputs: carried, tookMs: Math.round(performance.now() - began) }
      await this.save(spare)
    } catch (error) {
      await this.discard(spare)
      throw error
    }
    this.queue(id, () => this.install(id))
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
 * A project folder's spare: its folder moved into `trash` whole, each
 * repository told where its worktree went and that it's no longer kept,
 * then removed in the background band.
 */
async function setAsideFolder(spare: Spare, trash: string): Promise<void> {
  await mkdir(trash, { recursive: true, mode: 0o700 })
  const aside = join(trash, randomUUID())
  await rename(spare.path, aside)
  const worktrees = worktreesOf(spare, aside)
  for (const worktree of worktrees) {
    await git(worktree.repoRoot, ["worktree", "repair", worktree.path]).catch(() => {})
    await git(worktree.repoRoot, ["worktree", "unlock", worktree.path]).catch(() => {})
  }
  emptying.add(aside)
  void Promise.all(worktrees.map((worktree) => git(worktree.repoRoot, ["worktree", "remove", "-f", "-f", worktree.path], true).catch(() => {})))
    .then(() => removeBelowAgents(aside))
    .then(() => Promise.all(worktrees.map((worktree) => git(worktree.repoRoot, ["worktree", "prune"]))))
    .catch(() => {})
    .finally(() => emptying.delete(aside))
}

/**
 * Turn a claimed spare into the checkout at `path` on `branch`, which the
 * start has already created in each repository at its target's commit. The
 * reset writes only what changed since the spare was made. A project
 * folder's spare moves as one folder, each repository then told where its
 * worktree is. `around` wraps the move, for an install that goes on
 * running through it.
 */
export async function placeSpare(spare: Spare, path: string, branch: string, targets: readonly SpareTarget[], around?: (move: () => Promise<void>) => Promise<void>): Promise<void> {
  await Promise.all(worktreesOf(spare).map(async (worktree) => {
    const base = targets.find((target) => target.repoRoot === worktree.repoRoot)?.base
    if (!base) throw new Error(`${basename(worktree.repoRoot)} isn't one of the repositories this checkout starts`)
    if (worktree.base !== base) await git(worktree.path, [...PARALLEL_CHECKOUT, "reset", "--hard", "-q", base])
  }))
  const placed = worktreesOf(spare, path)
  const move = async () => {
    if (!spare.members) {
      await git(spare.repoRoot, ["worktree", "move", "-f", "-f", spare.path, path])
      return
    }
    await rename(spare.path, path)
    for (const worktree of placed) await git(worktree.repoRoot, ["worktree", "repair", worktree.path])
  }
  await (around ? around(move) : move())
  await Promise.all(placed.flatMap((worktree) => [
    git(worktree.repoRoot, ["worktree", "unlock", worktree.path]).catch(() => {}),
    git(worktree.path, ["checkout", "-q", branch]),
  ]))
}

/** Whether `inputs` are the same at the spare's commits and the targets', so the resets leave them as they are. */
async function sameInputs(spare: Spare, targets: readonly SpareTarget[], inputs: readonly string[]): Promise<boolean> {
  for (const worktree of worktreesOf(spare)) {
    const base = targets.find((target) => target.repoRoot === worktree.repoRoot)?.base
    if (!base) return false
    if (base === worktree.base) continue
    // A project folder's inputs are named by their place in it; each repository compares its own.
    const inside = relative(spare.repoRoot, worktree.repoRoot)
    const own = inputs.flatMap((input) => {
      const at = relative(inside, input)
      return at.startsWith("..") || isAbsolute(at) ? [] : [at || "."]
    })
    if (own.length && !(await git(worktree.repoRoot, ["diff", "--quiet", worktree.base, base, "--", ...own]).then(() => true, () => false))) return false
  }
  return true
}
