import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { PARALLEL_CHECKOUT, type Git } from "@mako/git"
import type { ReturnProjectMissing } from "../contracts/cloud-threads.js"

/**
 * A Thread's worktree that can't take the Thread back, because the project it was made from isn't on this Mac (moved or
 * deleted), or the folder chosen in its place isn't a clone of the same repository. Thrown before anything changes.
 */
export class ProjectMissingError extends Error {
  readonly missing: ReturnProjectMissing
  constructor(message: string, missing: ReturnProjectMissing) {
    super(message)
    this.name = "ProjectMissingError"
    this.missing = missing
  }
}

/** Whether Git reads `folder` as a checkout of its own: its `.git` there, and the repository it names there too. */
export async function workingCheckout(git: Git, folder: string): Promise<boolean> {
  // `.git` rather than asking Git alone, which would answer for a repository around a folder that lost its own.
  return existsSync(join(folder, ".git")) && git.succeeds(folder, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
}

/**
 * Makes `folder` a worktree of `repoRoot` again, keeping whatever files it holds: told where its repository is now when
 * the repository moved (`git worktree repair`), or added to it afresh when the repository doesn't know it (a fresh
 * clone, or a worktree Git pruned) or the folder is gone. On `branch` when the repository has it and no other
 * checkout holds it; detached at the repository's HEAD otherwise. What it holds is laid over it after, so the files it
 * starts with don't matter: an existing folder's are kept as changes, and its index reads as its HEAD.
 */
export async function reattachWorktree(git: Git, repoRoot: string, folder: string, branch: string | undefined): Promise<void> {
  if (existsSync(join(folder, ".git"))) {
    await git.output(repoRoot, ["worktree", "repair", folder]).catch(() => "")
    if (await workingCheckout(git, folder)) return
  }
  // An entry for a worktree whose folder is gone, or that names another folder, holds its branch: it goes first.
  await git.output(repoRoot, ["worktree", "prune"]).catch(() => "")
  const onBranch = branch !== undefined
    && (await git.succeeds(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]))
    && !(await git.output(repoRoot, ["worktree", "list", "--porcelain"])).split("\n").includes(`branch refs/heads/${branch}`)
  // Added without its files, which would hold the repository's turn while they're written (`Git.run`); filled after.
  const add = (path: string) =>
    git.output(repoRoot, ["worktree", "add", "--quiet", "--no-checkout", ...onBranch && branch ? [path, branch] : ["--detach", path, "HEAD"]])
  if (!existsSync(folder)) {
    await mkdir(dirname(folder), { recursive: true, mode: 0o700 })
    await add(folder)
    await fillWorktree(git, folder)
    return
  }
  // The folder stays where the Thread's sessions know it: a worktree is added beside it unchecked out, its `.git` moved
  // in, and the repository told where it is now.
  const beside = `${folder}.mako-reattach-${randomBytes(4).toString("hex")}`
  try {
    await add(beside)
    await rename(join(beside, ".git"), join(folder, ".git"))
    await git.output(repoRoot, ["worktree", "repair", folder])
    await git.output(folder, ["reset", "--quiet"])
  } finally {
    await rm(beside, { recursive: true, force: true })
  }
  if (!(await workingCheckout(git, folder))) throw new Error(`Git couldn't make ${folder} a worktree of ${repoRoot} again.`)
}

/**
 * Writes a worktree added `--no-checkout` (its HEAD set, its index empty), then runs the repository's post-checkout
 * hook as `worktree add` would have (`<null> <HEAD> 1`, through `core.hooksPath`): projects install their own hooks or
 * generate code there (husky), and a Mako worktree must get what any other checkout does. Outside the repository's
 * write turn, both: they take as long as the files, filters and hook do.
 */
export async function fillWorktree(git: Git, path: string): Promise<void> {
  await git.output(path, [...PARALLEL_CHECKOUT, "reset", "--hard", "-q"])
  const head = await git.output(path, ["rev-parse", "HEAD"])
  await git.output(path, ["hook", "run", "--ignore-missing", "post-checkout", "--", "0".repeat(head.length), head, "1"])
}

