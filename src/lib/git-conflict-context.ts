import { z } from "zod"
import type { GitStatus } from "@/lib/types"

/** Menu action, replaced by an ordinary portable attachment when picked. */
export const GIT_CONFLICT_CONTEXT = "mako:git-conflicts"

const GitConflictSnapshotSchema = z.object({
  repository: z.string(),
  branch: z.string().nullish(),
  operation: z.string().nullish(),
  conflictedPaths: z.array(z.string()),
  blocker: z.object({ message: z.string(), detail: z.string().optional() }).nullish(),
})

export type GitConflictSnapshot = z.infer<typeof GitConflictSnapshotSchema>

/** The snapshot `gitConflictContext` wrote, read back for its tile; null for anything else. */
export function readGitConflictContext(text: string): GitConflictSnapshot | null {
  const start = text.indexOf("\n{\n")
  const end = text.indexOf("\n}\n", start)
  if (start < 0 || end < 0) return null
  try {
    return GitConflictSnapshotSchema.safeParse(JSON.parse(text.slice(start + 1, end + 2))).data ?? null
  } catch {
    return null
  }
}

export function gitConflictContext(status: GitStatus | null | undefined, capturedAt = new Date().toISOString(), blocker?: { message: string; detail?: string }) {
  const paths = status?.files.filter(file => file.status === "conflicted").map(file => file.path) ?? []
  if (!status?.root || (!paths.length && !blocker)) return null
  const repository = status.root.split("/").filter(Boolean).at(-1) ?? "repository"
  return {
    name: `${repository}-git-conflicts.md`,
    label: `Git conflicts · ${repository}`,
    text: `# Git conflict context

This is a snapshot attached by the user, not a live Git status or a request to start a mutation.

${JSON.stringify({ repository: status.root, branch: status.branch, head: status.head, upstream: status.upstream, operation: status.operation ?? null, capturedAt, conflictedPaths: paths, blocker }, null, 2)}

Before acting, inspect current Git status in the repository above. These paths may have changed or been resolved since capture. Follow the user's request; inspect base, ours, and theirs when resolving conflicts, preserve unrelated edits, and report any unresolved choices. Do not assume the chat's working directory is this repository. An untracked-file collision happens before a merge starts: preserve a recoverable copy of each blocking local file before moving it aside. Do not stash or clean the entire workspace, and do not overwrite or delete the local copies.
`,
  }
}
