/**
 * What went wrong, as callers branch on it. Git's own words stay in
 * `stderr`; `kind` is read from them once, here, so no caller matches
 * Git's messages itself.
 */
export type GitErrorKind =
  | "not_repository"
  | "local_changes"
  | "untracked_files"
  | "conflicts"
  | "rejected"
  | "auth"
  | "timeout"
  | "missing"
  | "moved"
  | "failed"

export class GitError extends Error {
  readonly kind: GitErrorKind
  /** Git's own error output, trimmed; empty when Git said nothing. */
  readonly stderr: string
  /** The subcommand, such as `status`. */
  readonly command: string
  readonly code: number | null

  constructor(input: { kind?: GitErrorKind; message?: string; stderr?: string; command?: string; code?: number | null; cause?: unknown }) {
    const stderr = (input.stderr ?? "").trim()
    const fallback = `${input.command ? `git ${input.command}` : "git"} failed${input.code == null ? "" : ` (exit ${input.code})`}`
    super(input.message ?? (stderr || fallback), { cause: input.cause })
    this.name = "GitError"
    this.kind = input.kind ?? classify(stderr)
    this.stderr = stderr
    this.command = input.command ?? ""
    this.code = input.code ?? null
  }
}

const KINDS: ReadonlyArray<[GitErrorKind, RegExp]> = [
  ["not_repository", /not a git repository|must be run in a work tree/i],
  ["untracked_files", /untracked working tree files? would be (overwritten|removed)/i],
  ["local_changes", /local changes to the following files would be overwritten|commit your changes or stash them/i],
  ["conflicts", /^CONFLICT \(|Automatic merge failed|fix conflicts and then commit|resolve your current index first|Merge conflict in|unmerged files/im],
  ["rejected", /\[rejected\]|non-fast-forward|\(fetch first\)|Updates were rejected/i],
  ["auth", /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|Repository not found|returned error: 403/i],
]

export function classify(stderr: string): GitErrorKind {
  for (const [kind, pattern] of KINDS) if (pattern.test(stderr)) return kind
  return "failed"
}
