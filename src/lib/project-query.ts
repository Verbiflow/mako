import { githubRepository, type GitHubRepository } from "@mako/host/contracts/projects"

/**
 * What a person typed into Open project: a path to browse, a GitHub repository to clone, or words to find a project
 * by. A path starts as one does in a shell (`~/`, `/`, `./`, `../`); anything else that names a repository
 * (`owner/name`, an address) is one; the rest is a search.
 */
export type ProjectQuery =
  | { kind: "empty" }
  | { kind: "path"; text: string }
  | { kind: "repository"; repository: GitHubRepository }
  | { kind: "search"; term: string }

export function isPathQuery(text: string): boolean {
  return /^(~|\.{1,2})(\/|$)|^\//.test(text)
}

export function projectQuery(text: string): ProjectQuery {
  const trimmed = text.trim()
  if (!trimmed) return { kind: "empty" }
  if (isPathQuery(trimmed)) return { kind: "path", text: text.trimStart() }
  const repository = !/\s/.test(trimmed) ? githubRepository(trimmed) : undefined
  if (repository) return { kind: "repository", repository }
  return { kind: "search", term: trimmed }
}

/** Whether ⌘K's query is better answered by Open project: a path, or a GitHub address. */
export function asksForProject(text: string): boolean {
  const trimmed = text.trim()
  return isPathQuery(trimmed) || /github\.com\/|^git@github\.com:/i.test(trimmed)
}

/** `path` from home as `~/…`, as a person reads it. */
export function tildePath(path: string, home: string | undefined): string {
  if (!home) return path
  if (path === home) return "~"
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** The typed path with its last part replaced by `name` and a slash, so Tab goes into that folder. */
export function completePath(typed: string, name: string): string {
  const cut = typed.lastIndexOf("/")
  if (cut < 0) return `${typed === "~" ? "~/" : typed}${name}/`
  return `${typed.slice(0, cut + 1)}${name}/`
}

/**
 * Where a clone goes when the person hasn't said: the folder most of their recent projects sit in (the newest
 * among equals), or their home folder.
 */
export function cloneParent(recent: readonly string[], home: string | undefined): string | undefined {
  const counts = new Map<string, { count: number; first: number }>()
  recent.forEach((path, at) => {
    const parent = path.replace(/\/+$/, "").split("/").slice(0, -1).join("/")
    if (!parent || parent === home || (home && !parent.startsWith(`${home}/`) && parent.split("/").length < 3)) return
    const held = counts.get(parent)
    counts.set(parent, held ? { count: held.count + 1, first: held.first } : { count: 1, first: at })
  })
  const best = [...counts].sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)[0]
  return best?.[0] ?? home
}

/** A new project's name: one folder, not hidden, nothing a shell or Git would trip on. */
export function projectNameProblem(name: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return undefined
  if (trimmed.includes("/")) return "A name is one folder; type a path starting with ~/ to put it elsewhere."
  if (trimmed.startsWith(".")) return "A project's name can't start with a dot."
  if (trimmed.length > 100) return "Keep the name under 100 characters."
  return undefined
}
