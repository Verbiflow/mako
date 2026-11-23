import { worktreeCheckout } from "./thread-worktrees.js"

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

/** A list's folders by path, each with its first place in the list: `worktreeAt` returns the first that holds a path. */
interface WorktreeFolders {
  paths: Map<string, number>
  checkouts: Map<string, number>
}

const foldersOf = new WeakMap<readonly { path: string }[], WorktreeFolders>()

/** The first place in the list of a folder holding `plain`, by `pathInside`'s rule: the path itself, or any stretch of it that ends before a `/`. */
function firstHolding(folders: Map<string, number>, plain: string): number | undefined {
  let first = folders.get(plain)
  for (let cut = plain.lastIndexOf("/"); cut >= 0; cut = cut === 0 ? -1 : plain.lastIndexOf("/", cut - 1)) {
    const at = folders.get(plain.slice(0, cut))
    if (at !== undefined && (first === undefined || at < first)) first = at
  }
  return first
}

/**
 * `worktreeAt`, for a list that's asked about many paths while it stands (a window's worktrees, asked by every row of
 * its rail): the list's folders are indexed once, and a path is found by its own parent folders, not by a pass over
 * every worktree. The answers are `worktreeAt`'s.
 */
export function worktreeIn<Worktree extends { path: string; repoRoot?: string; project?: string }>(
  worktrees: readonly Worktree[] | undefined,
  path: string | undefined
): { worktree: Worktree; inside: string } | undefined {
  if (!path || !worktrees) return undefined
  let folders = foldersOf.get(worktrees)
  if (!folders) {
    folders = { paths: new Map(), checkouts: new Map() }
    for (const [at, worktree] of worktrees.entries()) {
      const own = plainPath(worktree.path)
      if (!folders.paths.has(own)) folders.paths.set(own, at)
      const checkout = checkoutOf(worktree)
      if (checkout !== worktree.path && !folders.checkouts.has(plainPath(checkout))) folders.checkouts.set(plainPath(checkout), at)
    }
    foldersOf.set(worktrees, folders)
  }
  const plain = plainPath(path)
  const within = firstHolding(folders.paths, plain)
  if (within !== undefined) return { worktree: worktrees[within]!, inside: plain.slice(plainPath(worktrees[within]!.path).length) }
  const mirrored = firstHolding(folders.checkouts, plain)
  if (mirrored !== undefined) return { worktree: worktrees[mirrored]!, inside: plain.slice(plainPath(checkoutOf(worktrees[mirrored]!)).length) }
  return undefined
}

/** How many worktrees back a project is looked for: a Fin's worktree is made from its Apex's, and a Fin's Fin's from that. */
const PROJECT_HOPS = 8

/**
 * The project `folder` is in, where `folder` is already what `path` stands for and `step` says what a folder stands
 * for in turn (undefined for one in no worktree). A worktree made from another worktree names that one, so one step
 * finds a worktree, not the project. It stops at `PROJECT_HOPS`, and before a folder it has been through, so records
 * that name each other end at the last new one.
 */
export function projectEnd(path: string | undefined, folder: string, step: (folder: string) => string | undefined): string {
  let seen: string[] | undefined
  for (let hops = 1; hops < PROJECT_HOPS; hops += 1) {
    const next = step(folder)
    if (next === undefined || next === folder || next === path || seen?.includes(next)) break
    ;(seen ??= []).push(folder)
    folder = next
  }
  return folder
}

type Found = { worktree: { path: string; repoRoot: string; project?: string }; inside: string }

/** The same folder in what a worktree was made from: its main checkout, or the project folder its checkout mirrors. */
const madeFrom = ({ worktree, inside }: Found, path: string | undefined) =>
  pathInside(worktree.path, path ?? "") ? `${worktree.repoRoot}${inside}` : `${worktree.project}${inside}`

/** The same folder in the project, when `path` is in one of `worktrees`: in the main checkout, however many worktrees back that is. */
export function projectFolder(worktrees: readonly { path: string; repoRoot: string; project?: string }[] | undefined, path: string | undefined): string | undefined {
  const found = worktreeAt(worktrees, path)
  return found && projectEnd(path, madeFrom(found, path), (folder) => {
    const up = worktreeAt(worktrees, folder)
    return up && madeFrom(up, folder)
  })
}

/**
 * `projectFolder` of a worktree already found for `path` (`worktreeAt`, `worktreeIn`): no second look for it. Given
 * the indexed list it was found in, a worktree made from another of them is followed to the project; without, the
 * answer is what this worktree was made from.
 */
export function projectFolderOf(found: Found, path: string | undefined, worktrees?: readonly { path: string; repoRoot: string; project?: string }[]): string {
  const folder = madeFrom(found, path)
  if (!worktrees) return folder
  return projectEnd(path, folder, (at) => {
    const up = worktreeIn(worktrees, at)
    return up && madeFrom(up, at)
  })
}
