import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import { z } from "zod"
import type { ThreadId } from "../contracts/thread-identity.js"
import type { ReclaimItem } from "../contracts/storage.js"
import type { ThreadWorktree, WorktreeRetentionReport, WorktreeRetentionSettings, WorktreeRetirement } from "../contracts/thread-worktrees.js"
import { PROJECT_CHECKOUT_FILE, worktreeCheckout } from "../contracts/thread-worktrees.js"

export const WORKTREE_RETENTION_MS = 60 * 60_000
export const MIN_RETIREMENT_PASS_MS = 10 * 60_000
type FetchPass = Map<string, Promise<void>>
export const WorktreeRetentionSettingsSchema = z.lazy(() => z.object({
  mode: z.enum(["preview", "packages", "checkout"]),
  days: z.number().int().min(0).max(3650),
  kept: z.array(z.string().min(1)).max(10_000),
}).strict())
export const DEFAULT_WORKTREE_RETENTION: WorktreeRetentionSettings = { mode: "preview", days: 7, kept: [] }
/**
 * Whether the worktrees of Fins closed as finished are kept, in a file of its own beside the settings: a build from
 * before it reads the settings strictly and writes them whole, so a member added there would stop it reading them and
 * be dropped by its next save, turning removal back on. Absent, they're retired.
 */
const FinishedFinsSchema = z.object({ keep: z.boolean() })
/** Why a finished Fin's checkout of several repositories stays: only one repository's worktree is made again by itself. */
const SEVERAL_REPOSITORIES = "A checkout of several repositories isn't made again by itself, so a finished Fin's is kept."

interface Deps {
  file: string
  root: string
  worktrees(): ThreadWorktree[]
  finished(thread: ThreadId): number | undefined
  /**
   * Whether a Thread is a Fin whose edge Mako closed as finished (`closedFinished`): its checkout is retired without
   * the person choosing removal. Without it no checkout is, as before.
   */
  closedFinished?(thread: ThreadId): boolean
  /**
   * Every Session of the Thread archived: its one repository's worktree is retired by default too, under the same guards
   * and with the same record, so a message after it's brought back makes the worktree again.
   */
  archived?(thread: ThreadId): boolean
  title?(thread: ThreadId): string | undefined
  using(path: string): Promise<string[]>
  /** A complete, bounded current-user open-file snapshot; unreadable means kept. */
  openFiles(): Promise<string[]>
  repository(worktree: ThreadWorktree, refresh: (common: string) => Promise<void>): Promise<{ head: string; blocked: string | null; remote: boolean; ignored: string[] }>
  fetch(common: string): Promise<void>
  /**
   * `finished`: one repository's worktree retired from under a Fin closed as finished or an archived Thread, so what it
   * was is kept to make it again. `person`: the person chose this checkout's removal in Settings › Storage.
   */
  remove(path: string, finished: boolean, person?: boolean): Promise<void>
  packagesRemoved(path: string): Promise<void>
  now?(): number
}

/**
 * Installs and checkouts have independent guards. Removal remains opt-in, but for the checkout of a Fin closed as
 * finished, which goes by default under every guard a checkout's removal has: on 2026-11-17 no settings file had ever
 * chosen removal, and 37 worktrees belonged to Fins that finished over a week before.
 */
export class WorktreeRetention {
  readonly store = "worktrees"
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
    const settings = text === null ? { ...DEFAULT_WORKTREE_RETENTION, kept: [] } : WorktreeRetentionSettingsSchema.parse(JSON.parse(text))
    const fins = await readFile(this.#finsFile(), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    // Unreadable, it throws, and nothing is removed: a setting that may say keep is never read as remove.
    return fins !== null && FinishedFinsSchema.parse(JSON.parse(fins)).keep ? { ...settings, finishedFins: false } : settings
  }

  async configure(value: WorktreeRetentionSettings): Promise<void> {
    const { finishedFins, ...rest } = value
    const settings = WorktreeRetentionSettingsSchema.parse(rest)
    await mkdir(dirname(this.#deps.file), { recursive: true, mode: 0o700 })
    // The keep goes first: a save cut short between the two leaves more kept, never less.
    if (finishedFins === false) await this.#write(this.#finsFile(), JSON.stringify(FinishedFinsSchema.parse({ keep: true })))
    await this.#write(this.#deps.file, JSON.stringify(settings))
    if (finishedFins !== false) await rm(this.#finsFile(), { force: true })
  }

  #finsFile(): string {
    return `${this.#deps.file.replace(/\.json$/, "")}-fins.json`
  }

  async #write(file: string, text: string): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" })
      await rename(temporary, file)
    } finally { await rm(temporary, { force: true }) }
  }

  /** Whether this pass retires a checkout for its Thread being a Fin closed as finished, or archived. */
  #finished(settings: WorktreeRetentionSettings, thread: ThreadId): boolean {
    return settings.finishedFins !== false && (this.#deps.closedFinished?.(thread) === true || this.#deps.archived?.(thread) === true)
  }

  /**
   * Settings › Storage's rows, judged as if the person had chosen removal, without fetching: `now` where Mako retires it
   * by itself (a finished Fin's or an archived Thread's one worktree, clean, pushed and quiet), `approve` where only the
   * person's choice is missing, `keep` with the guard that holds it otherwise.
   */
  async items(): Promise<ReclaimItem[]> {
    const settings = await this.settings()
    const report = await this.#preview({ ...settings, mode: "checkout" }, new Map(), true, false)
    const rows = this.#deps.worktrees()
    return report.checkouts.map((row) => {
      const member = rows.find((candidate) => candidate.path === row.path) ?? rows.find((candidate) => worktreeCheckout(candidate) === row.path)
      const verdict = this.#verdict(row)
      return {
        id: `worktrees:${row.path}`, store: "worktrees", path: row.path, label: this.#deps.title?.(row.thread) ?? row.branch ?? row.path.slice(row.path.lastIndexOf(sep) + 1),
        thread: row.thread, project: member?.project.slice(member.project.lastIndexOf(sep) + 1), bytes: null,
        ...(member?.createdAt !== undefined && { usedAt: this.#deps.finished(row.thread) ?? member.createdAt }), ...verdict,
      }
    })
  }

  #verdict(row: WorktreeRetirement): Pick<ReclaimItem, "class" | "reason"> {
    const blocked = row.skip ?? row.checkoutSkip
    if (blocked) return { class: "keep", reason: blocked }
    const single = row.owners.length === 1 && row.owners[0]?.path === row.path
    if (row.finished && single) return { class: "now", reason: "Clean, pushed and quiet; its Thread finished or is archived, and a message makes it again." }
    return { class: "approve", reason: single ? "Clean, pushed and quiet; its Thread isn't archived." : "Clean, pushed and quiet; a checkout of several repositories isn't made again by itself." }
  }

  /**
   * Removes the checkouts asked for, each inspected again with a fetch first, under the same lock as a pass. `now` takes
   * only what still reads `now`; `approve` also what only the person's choice was missing.
   */
  async reclaim(items: readonly ReclaimItem[], consent: "now" | "approve"): Promise<Map<string, true | string>> {
    const outcome = new Map<string, true | string>()
    const lockPath = `${this.#deps.file}.lock`
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
    const lock = await mkdir(lockPath, { mode: 0o700 }).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return false
      throw error
    })
    if (!lock) {
      for (const item of items) outcome.set(item.id, "Another retirement owns the store, or its previous owner needs review.")
      return outcome
    }
    const identity = await lstat(lockPath)
    const fetches: FetchPass = new Map()
    try {
      for (const item of items) {
        try {
          if (this.#closed) throw new Error("The host is stopping; retirement was cancelled.")
          const settings = { ...(await this.settings()), mode: "checkout" as const }
          const rows = this.#deps.worktrees()
          const members = rows.filter((row) => worktreeCheckout(row) === item.path)
          if (!members.length) throw new Error("The checkout is no longer registered.")
          const row = await this.#inspect(item.path, members, rows, settings, fetches, true, await this.#deps.openFiles(), true)
          const verdict = this.#verdict(row)
          if (verdict.class === "keep" || (verdict.class === "approve" && consent === "now")) throw new Error(verdict.reason)
          const single = row.owners.length === 1 && row.owners[0]?.path === row.path
          await this.#deps.remove(item.path, single, verdict.class === "approve")
          outcome.set(item.id, true)
        } catch (error) { outcome.set(item.id, error instanceof Error ? error.message : "Retirement could not finish; the checkout was kept.") }
      }
    } finally {
      const current = await lstat(lockPath)
      if (current.dev === identity.dev && current.ino === identity.ino) await rmdir(lockPath)
    }
    return outcome
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

  async #preview(settings: WorktreeRetentionSettings, fetches: FetchPass, checkout: boolean, refresh: boolean, finishedOnly = false): Promise<WorktreeRetentionReport> {
    const rows = this.#deps.worktrees()
    const groups = new Map<string, ThreadWorktree[]>()
    for (const row of rows) {
      const path = worktreeCheckout(row)
      groups.set(path, [...groups.get(path) ?? [], row])
    }
    // In preview nothing but a finished Fin's checkout is looked at: no folder of any other is walked.
    if (finishedOnly) for (const [path, members] of groups) if (!members.some((member) => this.#finished(settings, member.thread))) groups.delete(path)
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
    // In preview only finished Fins' checkouts go: with none, or with that turned off, the pass reads nothing.
    const fins = this.#deps.worktrees().some((row) => this.#finished(settings, row.thread))
    if ((settings.mode === "preview" && !fins) || this.#closed) return empty
    if (this.#lastStart !== undefined && this.#now() - this.#lastStart < MIN_RETIREMENT_PASS_MS) return this.#last ?? empty
    this.#lastStart = this.#now()
    const fetches: FetchPass = new Map()
    const report = await this.#preview(settings, fetches, settings.mode === "checkout", true, settings.mode === "preview")
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
        if (settings.mode !== report.settings.mode || settings.finishedFins !== report.settings.finishedFins || !row || row.skip || row.finished !== planned.finished || JSON.stringify(row.owners) !== JSON.stringify(planned.owners))
          throw new Error("The checkout's retirement conditions changed; it was kept.")
        return row
      }
      try {
        // Installed packages are reclaimed by themselves only where the person chose removal.
        if (report.settings.mode !== "preview" && !planned.packageSkip) for (const packages of planned.packageIdentities) {
          const row = await current(false)
          if (row.packageSkip || !row.packageIdentities.some(p => p.path === packages.path && p.device === packages.device && p.inode === packages.inode))
            throw new Error("The package folder changed; it was kept.")
          const aside = join(dirname(packages.path), `.retired-packages-${randomUUID()}`)
          await rename(packages.path, aside)
          await this.#deps.packagesRemoved(planned.path)
          await rm(aside, { recursive: true })
        }
        if ((report.settings.mode === "checkout" || planned.finished) && !planned.checkoutSkip) {
          const row = await current(true)
          if (row.checkoutSkip || JSON.stringify(row.heads) !== JSON.stringify(planned.heads)) throw new Error(row.checkoutSkip ?? "The repository changed during inspection.")
          // A finished Fin's one worktree is kept on record whatever the mode, so a message to it makes it again; a
          // checkout of several repositories goes only where the person chose removal, as any Thread's does.
          await this.#deps.remove(planned.path, planned.finished === true && planned.owners.length === 1 && planned.owners[0]?.path === planned.path)
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
    // A Fin closed as finished: its checkout is judged for removal whatever the mode, by the same guards.
    const finished = this.#finished(settings, first.thread)
    if (finished) result.finished = true
    const judged = checkout || finished
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
      // Where the person didn't choose removal, only what Mako can make again goes: one repository's worktree.
      if (finished && settings.mode !== "checkout" && (members.length !== 1 || first.path !== path)) result.checkoutSkip ??= SEVERAL_REPOSITORIES
      if (judged && !result.checkoutSkip) {
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
      if (!judged) result.checkoutSkip ??= "Checkout removal was not requested."
      if ((await this.#deps.using(path)).length || this.#deps.finished(first.thread) === undefined) throw new Error("The Thread resumed while its retirement was checked.")
      if (finished && !this.#finished(settings, first.thread)) throw new Error("The Fin was opened again while its retirement was checked.")
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
