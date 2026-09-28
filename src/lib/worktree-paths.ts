/** macOS reaches /tmp, /var and /etc through /private, and harnesses record either spelling of one folder. */
export const plainPath = (path: string) => (path.startsWith("/private/") ? path.slice("/private".length) : path)

export const pathInside = (folder: string, path: string) =>
  plainPath(path) === plainPath(folder) || plainPath(path).startsWith(`${plainPath(folder)}/`)

/** The worktree holding `path`, and the rest of the path inside it ("" or "/web"). */
export function worktreeAt<Worktree extends { path: string }>(
  worktrees: readonly Worktree[] | undefined,
  path: string | undefined
): { worktree: Worktree; inside: string } | undefined {
  if (!path || !worktrees) return undefined
  for (const worktree of worktrees)
    if (pathInside(worktree.path, path)) return { worktree, inside: plainPath(path).slice(plainPath(worktree.path).length) }
  return undefined
}

/** The same folder in the main checkout, when `path` is in one of `worktrees`. */
export function projectFolder(worktrees: readonly { path: string; repoRoot: string }[] | undefined, path: string | undefined): string | undefined {
  const found = worktreeAt(worktrees, path)
  return found ? `${found.worktree.repoRoot}${found.inside}` : undefined
}
