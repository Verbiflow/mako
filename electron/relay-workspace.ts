import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, isAbsolute, resolve } from "node:path"

/**
 * Where a remote job runs.
 *
 * A packaged app launched from Finder has `process.cwd() === "/"`, and the
 * host's own workspace pool starts there. The first real Slack request ever
 * sent to the installed app failed with `mkdir '/.mako-relay-…'` because the
 * relay took that pool's workspace as its default. Remote work therefore
 * resolves its directory here, from what the user actually did, and never
 * from the process.
 */

export interface RelayProject {
  name: string
  path: string
  lastUsedAt?: string
}

export interface RelayWorkspaceCandidate {
  cwd?: string
  at?: string
}

export type RelayWorkspaceSource = "selected" | "thread" | "recent" | "home"

export interface RelayWorkspaceResolution {
  cwd: string
  source: RelayWorkspaceSource
}

export class RelayWorkspaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RelayWorkspaceError"
  }
}

function normalizedPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "")
  return normalized || (path.startsWith("/") ? "/" : "")
}

/** Paths that are never a project: the root, temp roots, and scratch runs. */
export function isScratchPath(path: string): boolean {
  const normalized = normalizedPath(path)
  if (!normalized || normalized === "/") return true
  if (/^\/(?:private\/)?tmp(?:\/|$)/.test(normalized)) return true
  if (/^\/(?:private\/)?var\/folders(?:\/|$)/.test(normalized)) return true
  if (/^[A-Za-z]:\/Users\/[^/]+\/AppData\/Local\/Temp(?:\/|$)/i.test(normalized))
    return true
  return false
}

export function relayProjectName(path: string): string {
  return basename(normalizedPath(path)) || path
}

/**
 * Distinct project directories, most recently used first. The home directory
 * is the fallback for work with no project and is not offered as one.
 */
export function rankRelayProjects(
  candidates: Iterable<RelayWorkspaceCandidate>,
  { home = homedir(), limit = 15 }: { home?: string; limit?: number } = {}
): RelayProject[] {
  const latest = new Map<string, string | undefined>()
  const homePath = normalizedPath(home)
  for (const candidate of candidates) {
    if (!candidate.cwd || !isAbsolute(candidate.cwd)) continue
    const path = normalizedPath(candidate.cwd)
    if (isScratchPath(path) || path === homePath) continue
    const current = latest.get(path)
    if (!latest.has(path) || (candidate.at ?? "") > (current ?? ""))
      latest.set(path, candidate.at)
  }
  return [...latest.entries()]
    .sort(([, left], [, right]) => (right ?? "").localeCompare(left ?? ""))
    .slice(0, limit)
    .map(([path, lastUsedAt]) => ({
      name: relayProjectName(path),
      path,
      lastUsedAt,
    }))
}

/** A project by exact path, then by name, then by a unique name fragment. */
export function findRelayProject(
  query: string,
  projects: readonly RelayProject[]
): RelayProject | undefined {
  const trimmed = query.trim()
  if (!trimmed) return undefined
  const path = normalizedPath(trimmed)
  const exact = projects.find((project) => project.path === path)
  if (exact) return exact
  const lower = trimmed.toLowerCase()
  const named = projects.filter(
    (project) => project.name.toLowerCase() === lower
  )
  if (named.length === 1) return named[0]
  const partial = projects.filter((project) =>
    project.name.toLowerCase().includes(lower)
  )
  return partial.length === 1 ? partial[0] : named[0]
}

export async function isUsableWorkspace(path: string): Promise<boolean> {
  if (!isAbsolute(path) || normalizedPath(path) === "/") return false
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve the directory for one remote job.
 *
 * An explicit selection must exist; a missing selection is the user's mistake
 * and is reported, never silently replaced. A source thread's own directory is
 * next, then the most recently used project, then the home directory.
 */
export async function resolveRelayWorkspace(input: {
  selected?: string
  threadCwd?: string
  recent: () => Iterable<RelayWorkspaceCandidate>
  home?: string
}): Promise<RelayWorkspaceResolution> {
  const home = input.home ?? homedir()
  if (input.selected) {
    const selected = resolve(input.selected)
    if (!(await isUsableWorkspace(selected)))
      throw new RelayWorkspaceError(
        `The project \`${input.selected}\` is not a directory on this Mac. Send \`projects\` to list recent ones.`
      )
    return { cwd: selected, source: "selected" }
  }
  if (input.threadCwd && (await isUsableWorkspace(input.threadCwd)))
    return { cwd: input.threadCwd, source: "thread" }
  for (const project of rankRelayProjects(input.recent(), { home })) {
    if (await isUsableWorkspace(project.path))
      return { cwd: project.path, source: "recent" }
  }
  if (!(await isUsableWorkspace(home)))
    throw new RelayWorkspaceError(
      "Mako has no usable directory for remote work on this Mac."
    )
  return { cwd: home, source: "home" }
}

/** Plain text: it becomes a task title in the gateway, not markdown. */
export function describeRelayWorkspace(
  resolution: RelayWorkspaceResolution
): string {
  const name = relayProjectName(resolution.cwd)
  switch (resolution.source) {
    case "selected":
      return `in ${name}`
    case "thread":
      return `in ${name}, the thread's project`
    case "recent":
      return `in ${name}, your most recent project`
    case "home":
      return "in your home directory; send projects to choose one"
  }
}
