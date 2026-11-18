import { statusCode, type Git, type RepositoryStatus } from "@mako/git"

const STATUS = ["status", "--porcelain", "--untracked-files=normal"]

/** How a caller wants a checkout's status. */
export interface StatusAsk {
  /**
   * As of now: what decides something (a removal, a review, a merge) is read after it's asked, and shares only a
   * read others asked for the same way while it's under way. Without it the caller only shows the status, and takes
   * the one held while nothing has signalled a change since it was read.
   */
  fresh?: boolean
  /** Nobody waits on it as it's read (`Git.idleOutput`). */
  idle?: boolean
}

/**
 * A checkout's `git status --porcelain`, asked once for everyone it can serve. A worktree's summary, its review, the
 * question whether it can be removed, the list of worktrees, an agent's `worktree_status` and the pull request tools
 * each ran their own, and a status walks every file of the checkout.
 *
 * Freshness is said, not timed (`StatusAsk`). A caller that only shows the status takes what's held: the last read of
 * a followed checkout, kept until something signals that its files, index or HEAD may have changed (`touched`: a
 * tool's write, a file event, a turn's end, Git's own markers). A checkout no one follows has nothing held, since
 * nothing would say when it stopped being true. A checkout a tab has open is already kept current from its watcher
 * (`Repository.status`): that answer is taken where it counts the same files, with no process. A caller that needs
 * "as of now" gets a read made after it asked, shared only with others who asked for the same while it's read. A
 * removal itself still reads its own (`removalBlocker`): what it finds decides whether files are deleted.
 */
export class CheckoutStatuses {
  private readonly git: Git
  /** Reads under way: one anyone who only shows it may share, and one made for callers who asked for fresh. */
  private readonly reads = new Map<string, Promise<string>>()
  private readonly fresh = new Map<string, Promise<string>>()
  /** The last status of each followed checkout, while nothing signalled since. */
  private readonly held = new Map<string, string>()
  /** The followed checkouts, each with how many signals it has had: a read is held only if none came while it ran. */
  private readonly followed = new Map<string, number>()

  constructor(git: Git) {
    this.git = git
  }

  read(path: string, ask: StatusAsk = {}): Promise<string> {
    if (ask.fresh) return this.readFresh(path)
    const held = this.held.get(path)
    if (held !== undefined) return Promise.resolve(held)
    const known = this.reads.get(path) ?? this.fresh.get(path)
    if (known) return known
    const status = this.keeping(path, this.watched(path).then((kept) => kept ?? this.run(path, ask.idle === true)))
    this.reads.set(path, status)
    const done = () => {
      if (this.reads.get(path) === status) this.reads.delete(path)
    }
    status.then(done, done)
    return status
  }

  /** Whether a status is held for `path`: read since its last signal, so showing it costs nothing. */
  holds(path: string): boolean {
    return this.held.has(path)
  }

  /** Something says `path`'s files, index or HEAD may have changed: what's held is no longer shown, nor what's being read kept. */
  touched(path: string): void {
    const signals = this.followed.get(path)
    if (signals !== undefined) this.followed.set(path, signals + 1)
    this.held.delete(path)
    // Whoever asks next asks after the signal, so a read that began before it isn't theirs.
    this.reads.delete(path)
  }

  /** The checkouts whose signals reach `touched`: only their statuses are held. Those no longer among them are let go. */
  follow(paths: Iterable<string>): void {
    const wanted = new Set(paths)
    for (const path of this.followed.keys()) if (!wanted.has(path)) {
      this.followed.delete(path)
      this.held.delete(path)
    }
    for (const path of wanted) if (!this.followed.has(path)) this.followed.set(path, 0)
  }

  private readFresh(path: string): Promise<string> {
    const known = this.fresh.get(path)
    if (known) return known
    const status = this.keeping(path, this.run(path, false))
    this.fresh.set(path, status)
    const done = () => {
      if (this.fresh.get(path) === status) this.fresh.delete(path)
    }
    status.then(done, done)
    return status
  }

  /** Holds `reading`'s answer for a followed checkout once it's in, unless a signal came while it was read. */
  private keeping(path: string, reading: Promise<string>): Promise<string> {
    const signals = this.followed.get(path)
    if (signals !== undefined) void reading.then((status) => {
      if (this.followed.get(path) === signals) this.held.set(path, status)
    }, () => undefined)
    return reading
  }

  private run(path: string, idle: boolean): Promise<string> {
    return idle ? this.git.idleOutput(path, STATUS) : this.git.readOutput(path, STATUS)
  }

  /**
   * The status a tab's watcher already keeps of this checkout (`Repository.status`, which reads only the paths that
   * changed), as porcelain lines, when it lists the same files this status would; undefined when no tab has it open,
   * or when the two would count differently and Git is asked: that one lists every untracked file where this names
   * an untracked folder once, and a staged rename as a deletion and an addition where this pairs them.
   */
  private async watched(path: string): Promise<string | undefined> {
    const repository = this.git.knownRepository(path)
    if (!repository?.watched || repository.root !== path) return undefined
    const status = await repository.status().catch(() => undefined)
    return status && sameFiles(status) ? status.entries.map((entry) => `${statusCode(entry).padEnd(2)} ${entry.path}`).join("\n") : undefined
  }
}

/** Whether a watched repository's status lists exactly the files `STATUS` would. */
function sameFiles(status: RepositoryStatus): boolean {
  let added = false
  let deleted = false
  for (const entry of status.entries) {
    // In a folder, it may be one of several this status would name as their folder.
    if (entry.untracked && entry.path.includes("/")) return false
    if (entry.index === "added") added = true
    if (entry.index === "deleted") deleted = true
  }
  return !(added && deleted)
}

// One per `Git`, so per host: every caller holding the host's runner shares its reads, and a test's own runner shares none.
const statuses = new WeakMap<Git, CheckoutStatuses>()

/** The shared status reads of the host that owns `git`. */
export function checkoutStatuses(git: Git): CheckoutStatuses {
  let found = statuses.get(git)
  if (!found) statuses.set(git, found = new CheckoutStatuses(git))
  return found
}
