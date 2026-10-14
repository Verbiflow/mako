/**
 * The renames in a repository's history, for files renamed before Mako
 * tracked the folder. Read from
 * `git log -M --name-status --diff-filter=R --format=%x00%ct`, newest
 * commit first; a later read of only the newer commits adds to it.
 */
export class RenameHistory {
  /** Each path's renames away from it, oldest first. */
  private readonly away = new Map<string, { to: string; at: number }[]>()
  private count = 0

  get size(): number {
    return this.count
  }

  /** Add the renames in `log`, as `RENAME_LOG` prints them. Paths Git quoted (a tab or newline in the name) are left out. */
  add(log: string): this {
    let at = 0
    for (const line of log.split("\n")) {
      if (line.startsWith("\0")) {
        at = Number(line.slice(1)) * 1_000
        continue
      }
      if (!line.startsWith("R")) continue
      const [, from, to] = line.split("\t")
      if (!from || !to || from.startsWith('"') || to.startsWith('"')) continue
      const list = this.away.get(from)
      const rename = { to, at }
      if (!list) this.away.set(from, [rename])
      else if (!list.some((known) => known.to === to && known.at === at)) {
        list.push(rename)
        list.sort((a, b) => a.at - b.at)
      } else continue
      this.count++
    }
    return this
  }

  /**
   * Where the file at `path` (inside the repository) went, following the
   * first rename at or after `since` (milliseconds), then each in a later
   * commit; undefined when none came after, or it came back to `path`.
   * Renames in one commit happen at once, so `a→b, b→c` there is no chain.
   */
  follow(path: string, since: number): string | undefined {
    let at = path
    let next = this.away.get(at)?.find((rename) => rename.at >= since)
    for (let hops = 0; next && hops < 64; hops++) {
      at = next.to
      const after = next.at
      next = this.away.get(at)?.find((rename) => rename.at > after)
    }
    return at === path ? undefined : at
  }
}

/** The `git log` arguments `RenameHistory.add` reads; append a range such as `HEAD` or `old..HEAD`. */
export const RENAME_LOG = ["-c", "core.quotePath=false", "log", "-M", "--name-status", "--diff-filter=R", "--format=%x00%ct"] as const
