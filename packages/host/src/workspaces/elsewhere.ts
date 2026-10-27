import type { EncodedValue } from "../contracts/runtime-value.js"

/**
 * A conversation's folder that lives on another host, a cloud machine's clone: a window looking at that conversation
 * reads its files and its Git there, through the conversation's own route, never a copy on this Mac. Every cloud Thread
 * of one repository has the same path on its machine, so the folder is known by its conversation, not by its path.
 */
export type ElsewhereFolder = {
  /** The conversation whose folder it is. */
  conversation: string
  /** Where it is, in words: `a cloud machine`. */
  where: string
  /**
   * A host call answered in that folder by the host that has it when the call is made, with its answer as that host
   * encoded it; `here` once the folder is this Mac's again (its Thread came back), for this host to answer.
   */
  call(channel: string, args: readonly unknown[]): Promise<{ value: EncodedValue } | "here">
}

/** What a window reads and changes in its folder, answered by the host that has it. */
export const ELSEWHERE_CALLS: ReadonlySet<string> = new Set([
  "mako:list-files",
  "mako:read-file",
  "mako:search",
  "mako:git-status",
  "mako:git-diff",
  "mako:git-diff-all",
  "mako:git-log",
  "mako:git-commit-files",
  "mako:git-commit-file-diff",
  "mako:git-commit-diff-all",
  "mako:git-changed-since",
  "mako:git-since-diff",
  "mako:git-default-branch",
  "mako:git-remote",
  "mako:git-select-repository",
  "mako:git-doctor",
  "mako:git-stage",
  "mako:git-unstage",
  "mako:git-stage-all",
  "mako:git-unstage-all",
  "mako:git-discard",
  "mako:git-restore-discarded",
  "mako:git-commit",
  "mako:git-push",
])

/** A folder's app, run where the folder is: each names the folder as its first argument. */
export const ELSEWHERE_APP_CALLS: ReadonlySet<string> = new Set([
  "mako:thread-app",
  "mako:thread-app-start",
  "mako:thread-app-stop",
  "mako:thread-app-restart",
  "mako:thread-app-check",
  "mako:thread-app-output",
  "mako:thread-app-probe",
  "mako:thread-app-make-room",
  "mako:thread-app-take-turn",
])

/** Whether a window whose folder is `folder`, elsewhere, has this call answered there. */
export function answeredElsewhere(channel: string, args: readonly unknown[], folder: string): boolean {
  return ELSEWHERE_CALLS.has(channel) || (ELSEWHERE_APP_CALLS.has(channel) && args[0] === folder)
}

/** What only this Mac can do, and why it can't for a folder elsewhere. */
export function elsewhereRefusal(channel: string, where: string): string | undefined {
  switch (channel) {
    case "mako:open-in-editor":
    case "mako:reveal":
      return `This conversation's folder is on ${where}, not this Mac, so it can't be opened here. Its files are in the Files panel.`
    case "mako:git-generate-message":
      return `Commit messages are drafted from folders on this Mac. This conversation's folder is on ${where}: ask its agent to commit, or write the message.`
    default:
      return undefined
  }
}
