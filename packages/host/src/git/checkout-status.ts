import type { Git } from "@mako/git"

const STATUS = ["status", "--porcelain", "--untracked-files=normal"]

/**
 * A checkout's `git status --porcelain`, read once for everyone who asks while it's being read. A worktree's summary,
 * its review, the question whether it can be removed, the list of worktrees, an agent's `worktree_status` and the pull
 * request tools each ran their own, and a status walks every file of the checkout: asked together, they were that many
 * walks of one tree. Only a read under way is shared, so every answer was still being read when it was asked for: a
 * review asked right after a commit never takes what was read before it. A removal itself reads its own
 * (`removalBlocker`): what it finds decides whether files are deleted.
 */
export class CheckoutStatuses {
  private readonly git: Git
  private readonly reads = new Map<string, Promise<string>>()

  constructor(git: Git) {
    this.git = git
  }

  /** `idle`: nobody waits on it as it's read (`Git.idleOutput`); one who does and finds an idle read under way shares that. */
  read(path: string, idle = false): Promise<string> {
    const known = this.reads.get(path)
    if (known) return known
    const status = idle ? this.git.idleOutput(path, STATUS) : this.git.readOutput(path, STATUS)
    this.reads.set(path, status)
    const done = () => {
      if (this.reads.get(path) === status) this.reads.delete(path)
    }
    status.then(done, done)
    return status
  }
}

// One per `Git`, so per host: every caller holding the host's runner shares its reads, and a test's own runner shares none.
const statuses = new WeakMap<Git, CheckoutStatuses>()

/** The shared status reads of the host that owns `git`. */
export function checkoutStatuses(git: Git): CheckoutStatuses {
  let found = statuses.get(git)
  if (!found) statuses.set(git, found = new CheckoutStatuses(git))
  return found
}
