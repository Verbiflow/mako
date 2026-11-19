import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileStamp, gitFileText, parseGitConfig, personalGitConfigFiles, storedRef } from "@mako/git"
import type { ContinueRepository } from "@mako/protocol/continues"
import { locateCheckout } from "../base/checkout-location.js"
import type { HostJobs, JobDemand } from "../base/host-jobs.js"
import { hostLog } from "../base/host-log.js"
import { CloudRepositorySchema, githubRepositoryUrl } from "../contracts/cloud-threads.js"

/** Folders whose reading is kept; the one read longest ago goes first. */
const MAX_FOLDERS = 1_024

/** A folder's reading with the files it came from, stamped as they were read; no files for a folder in no repository. */
interface Reading {
  files: readonly string[]
  stamp: string
  found: ContinueRepository | null
}

export type CheckoutRepositoriesOptions = {
  /** What Git itself says of the folder (`folderRepository`), null where it names no repository on GitHub: asked only where the files alone can't say. */
  ask(folder: string): Promise<ContinueRepository | null>
}

/**
 * Each folder's origin on GitHub and the branch it pushes to, as `folderRepository` says them, read from the files Git
 * keeps instead of by two processes a folder: HEAD for the branch, the repository's `config` for the origin's URL and
 * the branch's upstream, and the upstream's ref for whether it is there. A reading stands while those files' stamps
 * do, so asking again costs a few `stat`s; a folder that is in no repository costs the look for a `.git` above it,
 * which is also how one made since is found. Asked through Git, forty folders were eighty processes at once each
 * minute, the ones that are no repository failing the same way every time.
 *
 * The files are trusted only where they say all Git would: a repository Git itself would name is never lost. Git is
 * asked instead (`ask`), once for each change of the same stamps, when the origin read from `config` is no GitHub
 * repository as written (it may be an alias), when a configuration file read here includes another (`include`,
 * `includeIf`), or when a `url.*.insteadOf` rule, the repository's or the person's, rewrites the origin.
 */
export class CheckoutRepositories {
  readonly #options: CheckoutRepositoriesOptions
  readonly #known = new Map<string, Reading>()

  constructor(options: CheckoutRepositoriesOptions) {
    this.#options = options
  }

  async read(folder: string): Promise<ContinueRepository | null> {
    const known = this.#known.get(folder)
    if (known?.files.length && (await stamped(known.files)) === known.stamp) return known.found
    const read = await readCheckout(folder, this.#options.ask)
    this.#known.delete(folder)
    this.#known.set(folder, read)
    if (this.#known.size > MAX_FOLDERS) this.#known.delete(this.#known.keys().next().value!)
    return read.found
  }
}

async function stamped(files: readonly string[]): Promise<string> {
  return (await Promise.all(files.map(fileStamp))).join("\0")
}

async function configFile(path: string): Promise<Map<string, string[]>> {
  return parseGitConfig(await readFile(path, "utf8").catch(() => ""))
}

/** Whether a configuration file brings in another, whose values aren't read here. */
function includesAnother(config: ReadonlyMap<string, string[]>): boolean {
  for (const key of config.keys()) if (key.startsWith("include.") || key.startsWith("includeif.")) return true
  return false
}

/** Whether a `url.<base>.insteadOf` or `pushInsteadOf` rule of this file names the start of `url`, so Git reads another URL for it. */
function rewrites(config: ReadonlyMap<string, string[]>, url: string): boolean {
  for (const [key, values] of config)
    if (/^url\..*\.(insteadof|pushinsteadof)$/.test(key) && values.some((value) => value !== "" && url.startsWith(value))) return true
  return false
}

async function readCheckout(folder: string, ask: CheckoutRepositoriesOptions["ask"]): Promise<Reading> {
  const gitDir = (await locateCheckout(folder))?.gitDir
  if (!gitDir) return { files: [], stamp: "", found: null }
  // A linked worktree's own folder holds its HEAD; the origin and every branch's upstream are the repository's.
  const common = await gitFileText(join(gitDir, "commondir"))
  const commonDir = common ? resolve(gitDir, common) : gitDir
  const personal = personalGitConfigFiles()
  const own = [join(commonDir, "config"), join(gitDir, "config.worktree")]
  const files = [join(gitDir, "HEAD"), ...own, ...personal]
  // Each file is stamped before it is read, so a change made meanwhile is read again next time.
  const stamp = await stamped(files)
  const [config, worktree, ...persons] = await Promise.all([...own, ...personal].map(configFile))
  if (!config || !worktree) return { files, stamp, found: null }
  const origin = config.get("remote.origin.url")?.[0] ?? ""
  const url = githubRepositoryUrl(origin)
  const branch = /^ref: refs\/heads\/(\S+)$/.exec((await gitFileText(join(gitDir, "HEAD"))) ?? "")?.[1]
  const tracks = branch !== undefined && config.get(`branch.${branch}.remote`)?.at(-1) === "origin"
  const upstream = tracks ? /^refs\/heads\/(.+)$/.exec(config.get(`branch.${branch}.merge`)?.at(-1) ?? "")?.[1] : undefined
  // An upstream is one only while its branch is here as origin's: Git says none once that ref is pruned.
  const tracking = upstream === undefined ? undefined : `refs/remotes/origin/${upstream}`
  const refs = [...(tracking ? [join(commonDir, tracking)] : []), join(commonDir, "packed-refs")]
  const refStamp = await stamped(refs)
  const reading = (found: ContinueRepository | null): Reading => ({ files: [...files, ...refs], stamp: `${stamp}\0${refStamp}`, found })
  // Where the files don't say all Git would, Git says it: an origin that is no repository as written, a file that
  // includes another, a rule that rewrites the origin. The person's files count for both: Git reads them for every repository.
  const unsure = (origin !== "" && !url) || [config, worktree, ...persons].some((file) => includesAnother(file) || rewrites(file, origin))
  if (unsure) return reading(await ask(folder).catch(() => null))
  if (!url) return reading(null)
  const there = tracking !== undefined && (await storedRef(commonDir, tracking)) !== null
  return reading(CloudRepositorySchema.safeParse(there && upstream !== undefined ? { url, branch: upstream } : { url }).data ?? null)
}

export type ListedRepositoriesOptions = {
  /** The folder's origin on GitHub and the branch it pushes to (`CheckoutRepositories.read`), or null where it has none. */
  read(folder: string): Promise<ContinueRepository | null>
  /** The rows are made again: a reading moved. */
  changed(): void
  againMs: number
  /** The host's recurring work, which the reading again is one job of. */
  jobs: Pick<HostJobs, "every">
  /**
   * On while a branch can move under Mako's eye (a window, agents at work): read again every `againMs` only then, and
   * all at once as it comes back on, so an idle host reads nothing on a timer. Absent, always.
   */
  needed?: JobDemand
}

/**
 * Each Thread worktree's origin on GitHub and the branch it pushes to, as last read: what a cloud Thread continuing
 * one of its Sessions while this Mac is off clones. The rows ask as they're made (`of`, inside `listing`); every folder
 * their last making asked for is read again each `againMs`, so a branch pushed or tracked since is said even when
 * nothing else about its row changes, and they're made again only when a reading moved.
 */
export class ListedRepositories {
  readonly #options: ListedRepositoriesOptions
  readonly #known = new Map<string, ContinueRepository | null>()
  readonly #reading = new Map<string, Promise<void>>()
  #asked = new Set<string>()
  #asking: Set<string> | undefined
  readonly #stopJob: () => void
  readonly #stopNeeded: (() => void) | undefined

  constructor(options: ListedRepositoriesOptions) {
    this.#options = options
    const needed = options.needed
    this.#stopJob = options.jobs.every("read listed worktrees' repositories again", options.againMs, () => this.#readAll(), needed ? { needs: [needed] } : {})
    this.#stopNeeded = needed?.onChange((on) => {
      if (on) void this.#readAll()
    })
  }

  async #readAll(): Promise<void> {
    await Promise.all([...this.#asked].map((folder) => this.#read(folder)))
  }

  /** The rows' making, `undefined` while they can't be made: the folders `of` is asked for in it are the ones read again. */
  listing<T>(make: () => T | undefined): T | undefined {
    const asking = new Set<string>()
    this.#asking = asking
    try {
      const rows = make()
      if (rows !== undefined) this.#asked = asking
      return rows
    } finally {
      this.#asking = undefined
    }
  }

  /** The folder's repository as last read; the first ask reads it, and the rows are made again once it's in. */
  of(folder: string): ContinueRepository | undefined {
    this.#asking?.add(folder)
    if (!this.#known.has(folder)) void this.#read(folder)
    return this.#known.get(folder) ?? undefined
  }

  stop(): void {
    this.#stopNeeded?.()
    this.#stopJob()
  }

  /** One reading of a folder at a time: whoever asks during it shares it. */
  #read(folder: string): Promise<void> {
    let reading = this.#reading.get(folder)
    if (!reading) {
      reading = this.#readNow(folder).finally(() => this.#reading.delete(folder))
      this.#reading.set(folder, reading)
    }
    return reading
  }

  async #readNow(folder: string): Promise<void> {
    const found = await this.#options.read(folder).catch(() => null)
    const had = this.#known.has(folder)
    const before = this.#known.get(folder)
    this.#known.set(folder, found)
    if (before?.url === found?.url && before?.branch === found?.branch) return
    if (had) hostLog("cloud-conversations", "a Thread worktree's branch on GitHub changed; its row says so now", { folder, from: before?.branch ?? null, to: found?.branch ?? null })
    this.#options.changed()
  }
}
