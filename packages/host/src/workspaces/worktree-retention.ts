import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import { z } from "zod"
import type { ThreadId } from "../contracts/thread-identity.js"
import type { ThreadWorktree, WorktreeRetentionReport, WorktreeRetentionSettings, WorktreeRetirement } from "../contracts/thread-worktrees.js"
import { worktreeCheckout } from "../contracts/thread-worktrees.js"

export const WORKTREE_RETENTION_MS = 60 * 60_000
export const WorktreeRetentionSettingsSchema = z.object({
  mode: z.enum(["preview", "packages", "checkout"]),
  days: z.number().int().min(0).max(3650),
  kept: z.array(z.string().min(1)).max(10_000),
}).strict()
export const DEFAULT_WORKTREE_RETENTION: WorktreeRetentionSettings = { mode: "preview", days: 7, kept: [] }

interface Deps {
  file: string
  root: string
  /** Recorded worktrees only; listing must not attach, detach or repair them. */
  worktrees(): ThreadWorktree[]
  finished(thread: ThreadId): number | undefined
  /** A fresh read, including terminals and apps; unreadable state throws. */
  using(path: string): Promise<string[]>
  /** Clean Git state, branch tip and exact-head merged/closed-PR proof. */
  repository(worktree: ThreadWorktree): Promise<{ head: string; blocked: string | null; landed: boolean }>
  remove(path: string): Promise<void>
  packagesRemoved(path: string): Promise<void>
  now?(): number
}

/** Hourly and event-driven retirement. Every pass previews unless the person explicitly enables removal. */
export class WorktreeRetention {
  readonly #deps: Deps
  #pass: Promise<WorktreeRetentionReport> | undefined
  #last: WorktreeRetentionReport | undefined
  #event: NodeJS.Timeout | undefined
  #closed = false

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

  /** Coalesce turn, archive, PR and settings events; never do a Git pass for every message in a burst. */
  changed(): void {
    if (this.#event || this.#closed) return
    this.#event = setTimeout(() => {
      this.#event = undefined
      void this.run().catch(() => { /* A failed guard leaves the checkout for the next scheduled pass. */ })
    }, 60_000)
    this.#event.unref()
  }

  close(): void { this.#closed = true; clearTimeout(this.#event); this.#event = undefined }

  /** Settings and the audit CLI always use preview, regardless of the saved mode. */
  async preview(): Promise<WorktreeRetentionReport> {
    const settings = await this.settings()
    const rows = this.#deps.worktrees()
    const groups = new Map<string, ThreadWorktree[]>()
    for (const row of rows) {
      const checkout = worktreeCheckout(row)
      groups.set(checkout, [...groups.get(checkout) ?? [], row])
    }
    const checkouts: WorktreeRetirement[] = []
    for (const [path, members] of groups) checkouts.push(await this.#inspect(path, members, rows, settings))
    return { settings, everyMs: WORKTREE_RETENTION_MS, at: this.#now(), checkouts }
  }

  run(): Promise<WorktreeRetentionReport> {
    this.#pass ??= this.#run().finally(() => { this.#pass = undefined })
    return this.#pass
  }

  async #run(): Promise<WorktreeRetentionReport> {
    const report = await this.preview()
    if (report.settings.mode === "preview" || this.#closed) { this.#last = report; return report }
    // Profiles sharing the Thread store share this claim too. A crashed owner leaves it closed for review;
    // elapsed time or a numeric PID never authorizes stealing it.
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
    // An unexpected pass failure retains the claim for review; it cannot release indeterminate ownership.
    for (const planned of report.checkouts) {
      if (planned.skip) continue
      // Re-read settings, lifecycle, users, paths and Git after the preview and before each mutation.
      const current = async () => {
        if (this.#closed) throw new Error("The host is stopping; retirement was cancelled.")
        const settings = await this.settings()
        const rows = this.#deps.worktrees()
        const members = rows.filter((row) => worktreeCheckout(row) === planned.path)
        const row = members.length ? await this.#inspect(planned.path, members, rows, settings) : undefined
        if (settings.mode !== report.settings.mode || !row || row.skip || JSON.stringify(row.owners) !== JSON.stringify(planned.owners) || JSON.stringify(row.heads) !== JSON.stringify(planned.heads))
          throw new Error("The checkout's retirement conditions changed; it was kept.")
        return row
      }
      try {
        for (const packages of planned.packages) {
          const row = await current()
          if (!row.packages.includes(packages)) throw new Error("The package folder changed; it was kept.")
          // Rename first: a failed removal cannot leave half an install at its old name.
          const aside = join(dirname(packages), `.retired-packages-${randomUUID()}`)
          await rename(packages, aside)
          await this.#deps.packagesRemoved(planned.path)
          await rm(aside, { recursive: true })
        }
        if (report.settings.mode === "checkout") {
          await current()
          await this.#deps.remove(planned.path)
        }
      } catch (error) {
        planned.skip = error instanceof Error ? error.message : "Retirement could not finish; the checkout was kept."
      }
    }
    const current = await lstat(lockPath)
    if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("The retirement claim changed; it was retained.")
    await rmdir(lockPath)
    this.#last = report
    return report
  }

  async #inspect(path: string, members: ThreadWorktree[], rows: ThreadWorktree[], settings: WorktreeRetentionSettings): Promise<WorktreeRetirement> {
    const first = members[0]!
    const result: WorktreeRetirement = { path, thread: first.thread, branch: first.branch, heads: [], packages: [], owners: members.map(({ path, thread, createdAt }) => ({ path, thread, createdAt })), skip: null }
    try {
      if (!inside(this.#deps.root, path) || await realpath(path) !== path) throw new Error("The checkout is outside its owned root or uses a link.")
      if (settings.kept.some((kept) => kept === path || inside(kept, path))) throw new Error("Explicitly kept.")
      if (rows.some((row) => row.thread !== first.thread && (worktreeCheckout(row) === path || inside(path, row.path) || inside(worktreeCheckout(row), path)))) throw new Error("Shared with another Thread.")
      if (this.#deps.finished(first.thread) === undefined) throw new Error("The Thread is active or its finished state is unknown.")
      if ((await this.#deps.using(path)).length) throw new Error("A provider, terminal or app still uses the checkout.")
      const cutoff = this.#now() - settings.days * 86_400_000
      for (const member of members) {
        if (!inside(path, member.path) && member.path !== path) throw new Error("A repository is outside its checkout.")
        if (await realpath(member.path) !== member.path) throw new Error("A repository uses a link.")
        const facts = await this.#deps.repository(member)
        result.heads.push(facts.head)
        if (facts.blocked) throw new Error(facts.blocked)
        if (!facts.landed) throw new Error("Its current branch is not merged and has no closed pull request at this exact head.")
      }
      let recent = false
      let visited = 0
      // Never follow links or walk installed packages. A changed install is expendable; edited sources are not.
      const walk = async (folder: string): Promise<void> => {
        const entries = await readdir(folder, { withFileTypes: true })
        for (const entry of entries) {
          if (++visited > 50_000) throw new Error("The checkout is too large to inspect in one pass; it was kept.")
          if (entry.name === ".git") continue
          const file = join(folder, entry.name)
          if (entry.name === "node_modules") {
            if (!entry.isDirectory() || await realpath(file) !== file) throw new Error("Installed packages use a shared or linked folder.")
            result.packages.push(file)
          } else if (!entry.isSymbolicLink()) {
            const info = await lstat(file)
            if (info.mtimeMs > cutoff) recent = true
            if (entry.isDirectory()) await walk(file)
          }
        }
      }
      await walk(path)
      for (const [index, member] of members.entries()) {
        const facts = await this.#deps.repository(member)
        if (facts.blocked || !facts.landed || facts.head !== result.heads[index]) throw new Error("The repository changed during inspection.")
      }
      if ((await this.#deps.using(path)).length || this.#deps.finished(first.thread) === undefined) throw new Error("The Thread resumed while its retirement was checked.")
      const current = this.#deps.worktrees().filter((row) => worktreeCheckout(row) === path)
      if (JSON.stringify(current) !== JSON.stringify(members)) throw new Error("The checkout's ownership changed.")
      if ((this.#deps.finished(first.thread) ?? Infinity) > cutoff) throw new Error(`The Thread finished within ${settings.days} days.`)
      if (recent || members.some((member) => member.createdAt > cutoff)) throw new Error(`The checkout changed within ${settings.days} days.`)
    } catch (error) {
      result.skip = error instanceof Error ? error.message : "A retirement guard could not be read."
    }
    return result
  }

  #now(): number { return (this.#deps.now ?? Date.now)() }
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path)
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !part.startsWith(sep)
}
