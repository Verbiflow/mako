import { HANDLE_LENGTH, handleWord, threadCode } from "@mako/host/contracts/thread-handles"
import { projectFolder } from "@mako/host/contracts/worktree-paths"
import type { ThreadRef } from "@/lib/types"

/**
 * A Thread's handle as the window says it (`threadHandle`): the same one the host and an agent's list say, worked out
 * here from the Thread's ID with no call. A code is a hash, and a word a pass over a folder's name, so each is made
 * once and kept: a rail of rows asks for theirs at every draw, and the `@` menu for every Thread's at every key.
 */
const codes = new Map<string, string>()
const words = new Map<string, string>()

/** A Thread's whole code (`threadCode`), hashed once. */
export function codeOfThread(thread: string): string {
  let code = codes.get(thread)
  if (code === undefined) {
    code = threadCode(thread)
    codes.set(thread, code)
  }
  return code
}

function wordOf(project: string | undefined): string {
  const folder = project ?? ""
  let word = words.get(folder)
  if (word === undefined) {
    word = handleWord(project)
    words.set(folder, word)
  }
  return word
}

/** The handle of a Thread in `project`, its project's folder (never its worktree's); undefined for a row with no Thread yet. */
export function handleOfThread(thread: string | undefined, project: string | undefined): string | undefined {
  return thread === undefined ? undefined : `${wordOf(project)}-${codeOfThread(thread).slice(0, HANDLE_LENGTH)}`
}

/**
 * The project folder a row's handle takes its word from, as the rail files the row: where its worktree was made from,
 * else what the window's folders map its own to (`WorktreesState.folderMap`), else its folder as it stands.
 */
export function handleProject(row: Pick<ThreadRef, "cwd" | "worktrees">, folderMap: (path: string) => string | undefined): string | undefined {
  return projectFolder(row.worktrees, row.cwd) ?? (row.cwd ? folderMap(row.cwd) : undefined) ?? row.cwd
}

/** What the `@` menu matches a typed handle against: the Thread's word and its whole code, so more characters than a handle shows still find it. */
export function handleSearchKey(thread: string, project: string | undefined): string {
  return `${wordOf(project)}-${codeOfThread(thread)}`
}
