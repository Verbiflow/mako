import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import { z } from "zod"
import type { ThreadId } from "../contracts/thread-identity.js"
import type { ThreadWorktree, WorktreeRetentionReport, WorktreeRetentionSettings, WorktreeRetirement } from "../contracts/thread-worktrees.js"
import { PROJECT_CHECKOUT_FILE, worktreeCheckout } from "../contracts/thread-worktrees.js"

export const WORKTREE_RETENTION_MS = 60 * 60_000
export const MIN_RETIREMENT_PASS_MS = 10 * 60_000
type FetchPass = Map<string, Promise<void>>
export const WorktreeRetentionSettingsSchema = z.object({
  mode: z.enum(["preview", "packages", "checkout"]),
  days: z.number().int().min(0).max(3650),
  kept: z.array(z.string().min(1)).max(10_000),
}).strict()
export const DEFAULT_WORKTREE_RETENTION: WorktreeRetentionSettings = { mode: "preview", days: 7, kept: [] }

interface Deps {
  file: string
  root: string
  worktrees(): ThreadWorktree[]
  finished(thread: ThreadId): number | undefined
  using(path: string): Promise<string[]>
  /** A complete, bounded current-user open-file snapshot; unreadable means kept. */
  openFiles(): Promise<string[]>
  repository(worktree: ThreadWorktree, refresh: (common: string) => Promise<void>): Promise<{ head: string; blocked: string | null; remote: boolean; ignored: string[] }>
  fetch(common: string): Promise<void>
  remove(path: string): Promise<void>
  packagesRemoved(path: string): Promise<void>
  now?(): number
}

/** Installs and checkouts have independent guards. Removal remains opt-in. */
export class WorktreeRetention {
  readonly #deps: Deps
  #pass: Promise<WorktreeRetentionReport> | undefined
  #last: WorktreeRetentionReport | undefined
  #event: NodeJS.Timeout | undefined
  #closed = false
  #lastStart: number | undefined

  constructor(deps: Deps) { this.#deps = deps }

  async settings(): Promise<WorktreeRetentionSettings> {
    const text = await readFile(this.#deps.file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    return text === null ? { ...DEFAULT_WORKTREE_RETENTION, kept: [] } : WorktreeRetentionSettingsSchema.parse(JSON.parse(text))
  }

  async configure(value: WorktreeRetentionSettings): Promise<void> {
    const settings = WorktreeRetentionSettingsSchema.parse(value)
    await mkdir(dirname(this.#deps.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.#deps.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(settings), { mode: 0o600, flag: "wx" })
      await rename(temporary, this.#deps.file)
    } finally { await rm(temporary, { force: true }) }
  }

  last(): WorktreeRetentionReport | undefined { return this.#last }

  changed(): void {
    if (this.#event || this.#closed) return
    this.#event = setTimeout(() => {
      this.#event = undefined
      void this.run().catch(() => { /* Unknown guards keep their folders. */ })
    }, MIN_RETIREMENT_PASS_MS)
    this.#event.unref()
  }

  close(): void { this.#closed = true; clearTimeout(this.#event); this.#event = undefined }

  /** Read-only: checkout proof uses refs as of their last fetch, never fetching or pruning here. */
  async preview(): Promise<WorktreeRetentionReport> {
    return this.#preview(await this.settings(), new Map(), true, false)
  }

  async #preview(settings: WorktreeRetentionSettings, fetches: FetchPass, checkout: boolean, refresh: boolean): Promise<WorktreeRetentionReport> {
    const rows = this.#deps.worktrees()
    const groups = new Map<string, ThreadWorktree[]>()
    for (const row of rows) {
      const path = worktreeCheckout(row)
      groups.set(path, [...groups.get(path) ?? [], row])
    }
    // Keep the rejection observed for every row without pretending an incomplete snapshot is empty.
    const open = await this.#deps.openFiles().then(paths => ({ paths }), () => null)
    const checkouts: WorktreeRetirement[] = []
    for (const [path, members] of groups) checkouts.push(await this.#inspect(path, members, rows, settings, fetches, checkout, open?.paths, refresh))
    checkouts.sort((a, b) => a.path.localeCompare(b.path))
    return { settings, everyMs: WORKTREE_RETENTION_MS, minimumPassMs: MIN_RETIREMENT_PASS_MS, repositoryFetches: fetches.size, at: this.#now(), checkouts }
  }

  run(): Promise<WorktreeRetentionReport> {
    this.#pass ??= this.#run().finally(() => { this.#pass = undefined })
    return this.#pass
  }

  async #run(): Promise<WorktreeRetentionReport> {
    const settings = await this.settings()
    const empty: WorktreeRetentionReport = { settings, everyMs: WORKTREE_RETENTION_MS, minimumPassMs: MIN_RETIREMENT_PASS_MS, repositoryFetches: 0, at: this.#now(), checkouts: [] }
    if (settings.mode === "preview" || this.#closed) return empty
    if (this.#lastStart !== undefined && this.#now() - this.#lastStart < MIN_RETIREMENT_PASS_MS) return this.#last ?? empty
    this.#lastStart = this.#now()
    const fetches: FetchPass = new Map()
    const report = await this.#preview(settings, fetches, settings.mode === "checkout", true)
    const lockPath = `${this.#deps.file}.lock`
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
    const lock = await mkdir(lockPath, { mode: 0o700 }).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return false
      throw error
    })
    if (!lock) {
      for (const row of report.checkouts) if (!row.skip) row.skip = "Another retirement owns the store, or its previous owner needs review."
      this.#last = report
      return report
    }
    const identity = await lstat(lockPath)
    for (const planned of report.checkouts) {
      if (planned.skip) continue
      const current = async (checkout: boolean) => {
        if (this.#closed) throw new Error("The host is stopping; retirement was cancelled.")
        const settings = await this.settings()
        const rows = this.#deps.worktrees()
        const members = rows.filter(row => worktreeCheckout(row) === planned.path)
        const open = await this.#deps.openFiles()
        const row = members.length ? await this.#inspect(planned.path, members, rows, settings, fetches, checkout, open) : undefined
        if (settings.mode !== report.settings.mode || !row || row.skip || JSON.stringify(row.owners) !== JSON.stringify(planned.owners))
          throw new Error("The checkout's retirement conditions changed; it was kept.")
        return row
      }
      try {
        if (!planned.packageSkip) for (const packages of planned.packageIdentities) {
          const row = await current(false)
          if (row.packageSkip || !row.packageIdentities.some(p => p.path === packages.path && p.device === packages.device && p.inode === packages.inode))
            throw new Error("The package folder changed; it was kept.")
          const aside = join(dirname(packages.path), `.retired-packages-${randomUUID()}`)
          await rename(packages.path, aside)
          await this.#deps.packagesRemoved(planned.path)
          await rm(aside, { recursive: true })
        }
        if (report.settings.mode === "checkout" && !planned.checkoutSkip) {
          const row = await current(true)
          if (row.checkoutSkip || JSON.stringify(row.heads) !== JSON.stringify(planned.heads)) throw new Error(row.checkoutSkip ?? "The repository changed during inspection.")
          await this.#deps.remove(planned.path)
        }
      } catch (error) {
        planned.skip = error instanceof Error ? error.message : "Retirement could not finish; the checkout was kept."
      }
    }
    const current = await lstat(lockPath)
    if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("The retirement claim changed; it was retained.")
    await rmdir(lockPath)
    report.repositoryFetches = fetches.size
    this.#last = report
    return report
  }

  #fetch(pass: FetchPass, common: string): Promise<void> {
    const held = pass.get(common)
    if (held) return held
    const work = Promise.resolve().then(() => this.#deps.fetch(common))
    pass.set(common, work)
    return work
  }

  async #inspect(path: string, members: ThreadWorktree[], rows: ThreadWorktree[], settings: WorktreeRetentionSettings, fetches: FetchPass, checkout: boolean, open: string[] | undefined, refresh = true): Promise<WorktreeRetirement> {
    const first = members[0]!
    const result: WorktreeRetirement = { path, thread: first.thread, branch: first.branch, heads: [], packages: [], packageIdentities: [], packageSkip: null, checkoutSkip: null, owners: members.map(({ path, thread, createdAt }) => ({ path, thread, createdAt })), skip: null }
    try {
      if (!inside(this.#deps.root, path) || await realpath(path) !== path) throw new Error("The checkout is outside its owned root or uses a link.")
      if (settings.kept.some(kept => kept === path || inside(kept, path))) throw new Error("Explicitly kept.")
      if (rows.some(row => row.thread !== first.thread && (worktreeCheckout(row) === path || inside(path, row.path) || inside(worktreeCheckout(row), path)))) throw new Error("Shared with another Thread.")
      if (this.#deps.finished(first.thread) === undefined) throw new Error("The Thread is not finished, or its state is unknown.")
      if (!open) throw new Error("Open-file state is unavailable.")
      if (open.some(file => file === path || inside(path, file)) || (await this.#deps.using(path)).length) throw new Error("A process, provider, terminal or app still has the checkout open.")
      const cutoff = this.#now() - settings.days * 86_400_000
      let recent = false
      let visited = 0
      const walk = async (folder: string): Promise<void> => {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          if (++visited > 50_000) throw new Error("The checkout is too large to inspect in one pass; it was kept.")
          if (entry.name === ".git") continue
          const file = join(folder, entry.name)
          const install = entry.name === "node_modules" || (entry.name === ".venv" && await lstat(join(file, "pyvenv.cfg")).then(info => info.isFile(), () => false))
          if (install) {
            if (!entry.isDirectory() || await realpath(file) !== file) throw new Error("Installed packages use a shared or linked folder.")
            const info = await lstat(file)
            result.packages.push(file)
            result.packageIdentities.push({ path: file, device: info.dev, inode: info.ino })
            continue
          }
          const inRepository = members.some(member => inside(member.path, file) || (entry.isDirectory() && (member.path === file || inside(file, member.path))))
          let marker = false
          if (!inRepository && entry.isFile() && file === join(path, PROJECT_CHECKOUT_FILE)) {
            const expected = `${JSON.stringify({ project: first.project })}\n`
            marker = (await lstat(file)).size === Buffer.byteLength(expected) && await readFile(file, "utf8") === expected
          }
          if (!inRepository && !marker) result.checkoutSkip = "Files outside the repositories keep this project checkout."
          if (!entry.isSymbolicLink()) {
            if (entry.isDirectory()) await walk(file)
            else if ((await lstat(file)).mtimeMs > cutoff) recent = true
          }
        }
      }
      try { await walk(path) } catch (error) {
        result.packageSkip = error instanceof Error ? error.message : "Installed package folders could not be inspected."
        result.checkoutSkip ??= result.packageSkip
      }
      const privateIgnored = (member: ThreadWorktree, entries: string[]) => entries.some(entry => !result.packages.some(packages => packages === join(member.path, entry.replace(/\/$/, "")) || inside(packages, join(member.path, entry))))
      // No Git calls, fetches or quiet-period tests gate package reclamation.
      if (checkout && !result.checkoutSkip) {
        try {
          for (const member of members) {
            if (member.path !== path && !inside(path, member.path)) throw new Error("A repository is outside its checkout.")
            if (await realpath(member.path) !== member.path) throw new Error("A repository uses a link.")
            const facts = await this.#deps.repository(member, common => refresh ? this.#fetch(fetches, common) : Promise.resolve())
            result.heads.push(facts.head)
            if (facts.blocked) throw new Error(facts.blocked)
            if (!facts.remote) throw new Error("Its current HEAD is not reachable from a fetched remote ref.")
            if (privateIgnored(member, facts.ignored))
              throw new Error("Ignored private files or folders keep this checkout.")
          }
          for (const [index, member] of members.entries()) {
            const facts = await this.#deps.repository(member, common => refresh ? this.#fetch(fetches, common) : Promise.resolve())
            if (facts.blocked || !facts.remote || privateIgnored(member, facts.ignored) || facts.head !== result.heads[index]) throw new Error("The repository changed during inspection.")
          }
          if ((this.#deps.finished(first.thread) ?? Infinity) > cutoff) throw new Error(`The Thread finished within ${settings.days} days.`)
          if (recent || members.some(member => member.createdAt > cutoff)) throw new Error(`The checkout changed within ${settings.days} days.`)
        } catch (error) { result.checkoutSkip = error instanceof Error ? error.message : "The checkout's Git state is unavailable." }
      }
      if (!checkout) result.checkoutSkip ??= "Checkout removal was not requested."
      if ((await this.#deps.using(path)).length || this.#deps.finished(first.thread) === undefined) throw new Error("The Thread resumed while its retirement was checked.")
      const current = this.#deps.worktrees().filter(row => worktreeCheckout(row) === path)
      if (JSON.stringify(current) !== JSON.stringify(members)) throw new Error("The checkout's ownership changed.")
    } catch (error) { result.skip = error instanceof Error ? error.message : "A retirement guard could not be read." }
    return result
  }

  #now(): number { return (this.#deps.now ?? Date.now)() }
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path)
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !part.startsWith(sep)
}
