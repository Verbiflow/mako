import { join } from "node:path"
import type { WorkspaceGit } from "../git/index.js"
import { readText, walkWorkspace } from "./files.js"
import type { FileMatches, SearchOptions, SearchResults } from "../contracts/git-workspace-search.js"
import type { SessionSummary } from "../contracts/conversation-session.js"

const SEARCH_MAX_FILES = 200
const SEARCH_MAX_PER_FILE = 20
const SEARCH_WALK_FILES = 5_000

type ListSessions = (
  cwd: string,
  scope: "workspace" | "all"
) => Promise<SessionSummary[]>

function matcher(term: string, options: SearchOptions): (text: string) => boolean {
  if (options.regex || options.wholeWord) {
    const source = options.regex ? term : term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const pattern = new RegExp(
      options.wholeWord ? `\\b(?:${source})\\b` : source,
      options.caseSensitive ? "" : "i"
    )
    return (text) => pattern.test(text)
  }
  if (options.caseSensitive) return (text) => text.includes(term)
  const lower = term.toLowerCase()
  return (text) => text.toLowerCase().includes(lower)
}

export async function searchWorkspace(
  cwd: string,
  workspaceGit: WorkspaceGit,
  listSessions: ListSessions,
  query: string,
  options: SearchOptions = {}
): Promise<SearchResults> {
  void listSessions
  const started = Date.now()
  const term = query.trim()
  const empty: SearchResults = {
    query: term,
    files: [],
    threads: [],
    total: 0,
    truncated: false,
    elapsed: 0,
  }
  if (term.length < 2) return empty
  if (options.regex) {
    try {
      new RegExp(term)
    } catch (error) {
      return { ...empty, error: error instanceof Error ? error.message : "Invalid pattern" }
    }
  }

  const files = await searchFiles(cwd, workspaceGit, term, options)
  if (workspaceGit.cwd !== cwd)
    return searchWorkspace(workspaceGit.cwd, workspaceGit, listSessions, query, options)
  const total = files.reduce((sum, file) => sum + file.lines.length + file.more, 0)
  return {
    query: term,
    files,
    threads: [],
    total,
    truncated: files.length >= SEARCH_MAX_FILES,
    elapsed: Date.now() - started,
  }
}

async function searchFiles(
  cwd: string,
  workspaceGit: WorkspaceGit,
  term: string,
  options: SearchOptions
): Promise<FileMatches[]> {
  const raw = (await workspaceGit.root())
    ? await workspaceGit.grep(term, options)
    : await walkGrep(cwd, term, options)
  const byPath = new Map<string, FileMatches>()
  for (const entry of raw) {
    const first = entry.indexOf(":")
    const second = entry.indexOf(":", first + 1)
    if (first < 0 || second < 0) continue
    const path = entry.slice(0, first)
    const line = Number(entry.slice(first + 1, second))
    if (!Number.isFinite(line)) continue
    let file = byPath.get(path)
    if (!file) {
      if (byPath.size >= SEARCH_MAX_FILES) continue
      file = { path, lines: [], more: 0 }
      byPath.set(path, file)
    }
    if (file.lines.length >= SEARCH_MAX_PER_FILE) {
      file.more += 1
      continue
    }
    file.lines.push({ line, text: entry.slice(second + 1).slice(0, 400) })
  }
  return [...byPath.values()]
}

async function walkGrep(
  cwd: string,
  term: string,
  options: SearchOptions
): Promise<string[]> {
  const test = matcher(term, options)
  const paths = (await walkWorkspace(cwd, cwd, 0)).slice(0, SEARCH_WALK_FILES)
  const out: string[] = []
  for (const path of paths) {
    if (out.length >= SEARCH_MAX_FILES * SEARCH_MAX_PER_FILE) break
    const text = await readText(join(cwd, path))
    if (text === null || text.includes("\0")) continue
    const lines = text.split("\n")
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ""
      if (test(line)) out.push(`${path}:${index + 1}:${line}`)
    }
  }
  return out
}
