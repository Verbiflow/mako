import { worktreeCheckout } from "../../electron/contracts/thread-worktrees.ts"

/** macOS reaches /tmp, /var and /etc through /private, and harnesses record either spelling of one folder. */
export const plainPath = (path: string) => (path.startsWith("/private/") ? path.slice("/private".length) : path)

export const pathInside = (folder: string, path: string) =>
  plainPath(path) === plainPath(folder) || plainPath(path).startsWith(`${plainPath(folder)}/`)

/** A Thread's checkout, for one of Mako's worktrees: the worktree, or the folder mirroring a project of several repositories. */
export const checkoutOf = (worktree: { path: string; repoRoot?: string; project?: string }) =>
  worktree.repoRoot !== undefined && worktree.project !== undefined
    ? worktreeCheckout({ path: worktree.path, repoRoot: worktree.repoRoot, project: worktree.project })
    : worktree.path

/**
 * The worktree holding `path`, and the rest of the path inside it ("" or
 * "/web"). In a checkout of several repositories, a path outside all of
 * them, such as the checkout itself, finds its first worktree, with the
 * rest of the path inside the checkout.
 */
export function worktreeAt<Worktree extends { path: string; repoRoot?: string; project?: string }>(
  worktrees: readonly Worktree[] | undefined,
  path: string | undefined
): { worktree: Worktree; inside: string } | undefined {
  if (!path || !worktrees) return undefined
  for (const worktree of worktrees)
    if (pathInside(worktree.path, path)) return { worktree, inside: plainPath(path).slice(plainPath(worktree.path).length) }
  for (const worktree of worktrees) {
    const checkout = checkoutOf(worktree)
    if (checkout !== worktree.path && pathInside(checkout, path)) return { worktree, inside: plainPath(path).slice(plainPath(checkout).length) }
  }
  return undefined
}

/** The same folder in the main checkout, when `path` is in one of `worktrees`. */
export function projectFolder(worktrees: readonly { path: string; repoRoot: string; project?: string }[] | undefined, path: string | undefined): string | undefined {
  const found = worktreeAt(worktrees, path)
  if (!found) return undefined
  const { worktree, inside } = found
  return pathInside(worktree.path, path ?? "") ? `${worktree.repoRoot}${inside}` : `${worktree.project}${inside}`
}
