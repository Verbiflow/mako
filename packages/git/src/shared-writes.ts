import { readFileSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

/**
 * How long a write waits for a ref lock another program holds (an agent's own commit or branch, the person's
 * terminal) before it fails. Git's own defaults are 100 ms for a ref and 1 s for `packed-refs`, so a commit an agent
 * makes in its worktree at the moment Mako deletes a branch in the same repository failed the delete.
 */
export const REF_LOCK_WAIT_MS = 3_000
export const REF_LOCK_WAIT = ["-c", `core.filesRefLockTimeout=${REF_LOCK_WAIT_MS}`, "-c", `core.packedRefsTimeout=${REF_LOCK_WAIT_MS}`]

/** Options Git reads before the subcommand that take a value as the next word. */
const VALUED = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"])

/** The subcommand and the words after it, past Git's own options (`-c name=value`, `-C path`). */
export function subcommandOf(args: readonly string[]) {
  let at = 0
  for (; at < args.length; at += 1) {
    const word = args[at]!
    if (VALUED.has(word)) at += 1
    else if (!word.startsWith("-")) break
  }
  return { command: args[at] ?? "", rest: args.slice(at + 1) }
}

const has = (rest: readonly string[], ...flags: string[]) => rest.some((word) => flags.includes(word) || flags.some((flag) => flag.startsWith("--") && word.startsWith(`${flag}=`)))
const words = (rest: readonly string[]) => rest.filter((word) => !word.startsWith("-"))

/** `worktree` verbs that change the repository's record of its worktrees (`add` only `--no-checkout`, below). */
const WORKTREE_WRITES = new Set(["remove", "move", "prune", "repair", "lock", "unlock"])
/** `branch` and `tag` options that list rather than make. */
const LISTING = ["--list", "-l", "--show-current", "-a", "--all", "-r", "--remotes", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--format", "-v", "-vv", "--verbose", "--sort", "-n"]
/** `remote` verbs that change the repository's configuration or refs, without reaching the network. */
const REMOTE_WRITES = new Set(["add", "remove", "rm", "rename", "set-url", "set-head", "set-branches"])
/** Commands that write HEAD, a branch or another ref every checkout of the repository shares. */
const REF_WRITES = new Set(["update-ref", "pack-refs"])
/** `checkout` and `switch` options that make or reset a branch; without one they move only their own checkout's HEAD. */
const BRANCHING = ["-b", "-B", "-c", "-C", "--orphan", "--create", "--force-create"]

/**
 * Whether a command writes what every checkout of a repository shares: its refs, its record of worktrees or its
 * configuration. Mako runs those one at a time per repository (`Git.run`), so its own writes never race each other
 * for a lock.
 *
 * Left out on purpose:
 * - `fetch`, `pull` and `push`: they wait on the network, and a slow remote would hold every start in the
 *   repository behind them; they wait out a held lock instead (`REF_LOCK_WAIT`).
 * - `reset`, `read-tree`, `update-index`, `add` and the like: they write one checkout's index and files, and HEAD's
 *   branch only when that checkout is on one, which only its own Thread writes; a `reset --hard` can rewrite every
 *   file for seconds.
 * - `commit`, `merge`, `rebase`, `cherry-pick`, `revert` and `am`: they too move only the checkout's own branch, and
 *   run the repository's hooks for as long as those take: a pre-commit hook running tests would hold every Thread's
 *   start in the repository behind the person's commit. They wait out a held lock instead.
 * - `checkout` and `switch` of a branch that exists, a worktree added with its files, and `stash push`/`pop`/`apply`:
 *   they rewrite the checkout's files, through smudge and LFS filters that can reach the network, and run the
 *   post-checkout hook, for as long as all that takes. A stash's one shared ref (`refs/stash`) waits out a held lock.
 *   Making or resetting a branch (`checkout -b`) does take the turn.
 */
export function writesShared(args: readonly string[]): boolean {
  const { command, rest } = subcommandOf(args)
  switch (command) {
    case "worktree":
      // A worktree added with its files checks them out, hooks and all, for as long as that takes: Mako adds it
      // `--no-checkout` in the turn and writes its files after, as its own checkout's (`reset --hard`).
      if (rest[0] === "add") return rest.includes("--no-checkout")
      return WORKTREE_WRITES.has(rest[0] ?? "")
    case "branch":
    case "tag":
      if (has(rest, "-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "-u", "--set-upstream-to", "--unset-upstream", "-f", "--force", "--edit-description")) return true
      return words(rest).length > 0 && !has(rest, ...LISTING)
    case "symbolic-ref":
      return has(rest, "-d", "--delete") || words(rest).length >= 2
    case "checkout":
    case "switch":
      return has(rest, ...BRANCHING)
    case "reflog":
      return ["expire", "delete"].includes(rest[0] ?? "")
    case "remote":
      return REMOTE_WRITES.has(rest[0] ?? "")
    case "config": {
      const verb = rest[0] ?? ""
      if (["set", "unset", "rename-section", "remove-section"].includes(verb)) return true
      if (["get", "list", "edit"].includes(verb) || has(rest, "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--show-origin")) return false
      return has(rest, "--unset", "--unset-all", "--add", "--replace-all", "--rename-section", "--remove-section") || words(rest).length >= 2
    }
    default:
      return REF_WRITES.has(command)
  }
}

/**
 * The folder every checkout of `cwd`'s repository shares (`git rev-parse --git-common-dir`), read from the files Git
 * leaves rather than by starting Git: a main checkout's `.git` folder, or, for a linked worktree, the `commondir` its
 * `.git` file points through. Outside a repository, `cwd` itself. Its real path, so a repository reached through a
 * link (macOS's `/var` is `/private/var`) is one repository.
 */
export function commonDirOf(cwd: string): string {
  const found = findCommonDir(cwd)
  try {
    return realpathSync(found)
  } catch {
    return found
  }
}

function findCommonDir(cwd: string): string {
  for (let folder = resolve(cwd); ; folder = dirname(folder)) {
    const dotGit = join(folder, ".git")
    const kind = (() => {
      try {
        const stat = statSync(dotGit)
        return stat.isDirectory() ? "folder" : stat.isFile() ? "file" : undefined
      } catch {
        return undefined
      }
    })()
    if (kind === "folder") return dotGit
    if (kind === "file") {
      const named = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim()
      if (!named) return dotGit
      const gitDir = isAbsolute(named) ? named : resolve(folder, named)
      try {
        const common = readFileSync(join(gitDir, "commondir"), "utf8").trim()
        return isAbsolute(common) ? common : resolve(gitDir, common)
      } catch {
        // A worktree Git is still adding (its `.git` file written, its `commondir` not yet) or taking away: by Git's own
        // layout its folder `<repository>/.git/worktrees/<name>` is that repository's, so its writes take its turn.
        return basename(dirname(gitDir)) === "worktrees" ? dirname(dirname(gitDir)) : gitDir
      }
    }
    if (dirname(folder) === folder) return resolve(cwd)
  }
}
