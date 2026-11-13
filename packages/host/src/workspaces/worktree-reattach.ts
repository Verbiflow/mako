import { randomBytes } from "node:crypto"
import { constants, existsSync } from "node:fs"
import { access, mkdir, rename, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { PARALLEL_CHECKOUT, type Git } from "@mako/git"
import { endChildInput } from "@mako/sessions/child-input"
import { hostCommand } from "../base/host-command.js"
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
 * hook as `worktree add` would have: projects install their own hooks or generate code there (husky), and a Mako
 * worktree must get what any other checkout does. Outside the repository's write turn, both: they take as long as the
 * files, filters and hook do.
 */
export async function fillWorktree(git: Git, path: string): Promise<void> {
  await git.output(path, [...PARALLEL_CHECKOUT, "reset", "--hard", "-q"])
  await runPostCheckout(git, path)
}

/**
 * The post-checkout hook, run as `worktree add` runs it (`builtin/worktree.c`): in the new worktree, with `<null>
 * <HEAD> 1`, and `GIT_DIR` and `GIT_WORK_TREE` unset so it finds the repository from there. Found by `rev-parse
 * --git-path`, which honours `core.hooksPath`, and run only when it's there and executable, as Git does. Not through
 * `git hook run`, which Git before 2.36 lacks (Xcode 13's tools ship 2.32, Ubuntu 22.04 2.34). A hook that fails fails
 * the start, as it failed `worktree add`.
 */
/** How long the post-checkout hook may run, as any Git command may (`Git.run`'s default), before it's stopped. */
const HOOK_TIMEOUT_MS = 120_000

async function runPostCheckout(git: Git, path: string): Promise<void> {
  const hook = resolve(path, await git.output(path, ["rev-parse", "--git-path", "hooks/post-checkout"]))
  if (!(await access(hook, constants.X_OK).then(() => true, () => false))) return
  const head = await git.output(path, ["rev-parse", "HEAD"])
  const env = { ...git.environment() }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  // Git gives a hook no input (`/dev/null`): its stdin ends at once, so a hook that reads it never waits on it. And it
  // has the time any Git command has. `hostCommand` rejects with the command's output on the error.
  const running = hostCommand(hook, ["0".repeat(head.length), head, "1"], { cwd: path, env, maxBuffer: 16 * 1024 * 1024, timeout: HOOK_TIMEOUT_MS })
  endChildInput(running.child)
  await running.catch((error: Error & { stderr?: string }) => {
    const said = error.stderr?.trim().split("\n")[0]
    throw new Error(`The repository's post-checkout hook failed in ${path}${said ? `: ${said}` : ""}`, { cause: error })
  })
}
