import type { Git, RunOptions } from "@mako/git"
import type { MoveCheckpoint } from "@mako/protocol/moves"

/**
 * A Thread's worktree coming back from the cloud after the person changed it here meanwhile. `base` is the checkout
 * this Mac last sent or laid there; `mine`, the worktree as the return found it (kept before anything was laid); and
 * `theirs`, the machine's, already applied (`applyMoveCheckpoint`, so its objects are here and HEAD, the branch and the
 * index are the machine's). The files become a three-way merge of the three: what only one side changed keeps that
 * side, what both changed alike stays, and a file both changed differently holds Git's conflict markers, `this Mac`
 * against `the cloud`, for whoever resolves it. The index stays the machine's, so its staged work is still staged.
 * Commits the person made here on the Thread's branch meanwhile are kept on `<branch>-mac`, never lost.
 *
 * Writes into the repository only the refs it reads by (`refs/mako/merge/*`, removed after) and that branch; nothing
 * else of the person's.
 */
export type ReturnMerge = {
  /** Files the person changed here that the merge kept, conflicts included. */
  merged: string[]
  /** Files both sides changed differently, now holding conflict markers. */
  conflicts: string[]
  /** The branch the person's own commits here were kept on, when there were any. */
  mine?: string
}

const TIMEOUT_MS = 5 * 60_000
const REFS = "refs/mako/merge"

async function run(git: Git, options: RunOptions): Promise<string> {
  const result = await git.run({ timeoutMs: TIMEOUT_MS, maxBytes: 16 * 1024 * 1024, ...options, args: ["-c", "core.fsmonitor=false", ...options.args] })
  if (result.truncated) throw new Error(`git ${options.args[0] ?? ""} wrote more than 16 MB`)
  return result.stdout.toString("utf8")
}

/** Whether the worktree reads as the checkout this Mac last sent: the same HEAD, index and files, which capture makes the same commits. */
export function unchangedSince(base: MoveCheckpoint, mine: MoveCheckpoint): boolean {
  return base.head === mine.head && base.index === mine.index && base.work === mine.work
}

/**
 * Merges `mine` into the worktree at `checkout`, which holds `theirs` now. `bundles` are the files of `base` and `mine`
 * (their objects are fetched from them); `theirs`' are the repository's already.
 */
export async function mergeReturned(git: Git, checkout: string, input: { base: MoveCheckpoint; mine: MoveCheckpoint; theirs: MoveCheckpoint; bundles: { base: string; mine: string } }): Promise<ReturnMerge> {
  const { base, mine, theirs } = input
  // Each side's commits by a name that reads well in a conflict's markers: `mako/merge/this-mac`, `mako/merge/cloud`.
  await run(git, { cwd: checkout, args: ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", input.bundles.base, `refs/mako/*:${REFS}/base/*`] })
  await run(git, { cwd: checkout, args: ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", input.bundles.mine, `refs/mako/*:${REFS}/mine/*`] })
  try {
    await run(git, { cwd: checkout, args: ["update-ref", `${REFS}/this-mac`, mine.work] })
    await run(git, { cwd: checkout, args: ["update-ref", `${REFS}/cloud`, theirs.work] })
    let kept: string | undefined
    if (mine.head !== base.head) {
      // The person committed (or checked out) here meanwhile: those commits stay theirs, on a branch of their own.
      kept = `${theirs.branch ?? base.branch ?? "mako"}-mac`
      await run(git, { cwd: checkout, args: ["update-ref", `refs/heads/${kept}`, mine.head] })
    }
    const merged = await git.run({
      cwd: checkout,
      args: ["-c", "core.fsmonitor=false", "merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", `--merge-base=${base.work}`, "mako/merge/this-mac", "mako/merge/cloud"],
      codes: [0, 1],
      timeoutMs: TIMEOUT_MS,
    })
    const [tree = "", ...rest] = merged.stdout.toString("utf8").split("\0")
    const conflicts = merged.code === 1 ? [...new Set(rest.filter(Boolean))] : []
    const changed = (await run(git, { cwd: checkout, args: ["diff", "--name-only", "-z", "--no-renames", base.work, mine.work] })).split("\0").filter(Boolean)
    // The files become the merge exactly: the index first made to read as the machine's files, so laying the merge's
    // tree from there writes and removes precisely what differs; then the machine's own index again.
    await run(git, { cwd: checkout, args: ["read-tree", theirs.work] })
    await run(git, { cwd: checkout, args: ["read-tree", "-u", "--reset", tree.trim()] })
    await run(git, { cwd: checkout, args: ["read-tree", theirs.index] })
    return { merged: changed, conflicts, ...kept && { mine: kept } }
  } finally {
    const refs = (await run(git, { cwd: checkout, args: ["for-each-ref", "--format=%(refname)", REFS] })).split("\n").filter(Boolean)
    for (const ref of refs) await run(git, { cwd: checkout, args: ["update-ref", "-d", ref] }).catch(() => undefined)
  }
}
