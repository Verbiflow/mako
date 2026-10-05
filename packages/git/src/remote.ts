import { GitError } from "./errors.js"
import type { Repository } from "./repository.js"
import { run } from "./run.js"

export type RemoteAction = "fetch" | "pull" | "merge" | "merge_autostash" | "continue" | "abort"

/** The branch and commit a person chose an action for; anything else moving first stops it. */
export interface ExpectedHead {
  branch: string
  head: string | null
}

/** Network commands wait this long for a remote. */
const NETWORK_TIMEOUT_MS = 120_000
const NO_EDITOR = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" }

/**
 * Brings in what the remote has, or finishes what such a command started.
 * Pull only fast-forwards; merge takes the upstream into local commits, and
 * `merge_autostash` sets local edits aside around it.
 */
export async function remote(repository: Repository, action: RemoteAction, expected: ExpectedHead | null, signal?: AbortSignal): Promise<void> {
  await repository.write(async () => {
    try {
      if (action === "fetch") {
        await run({ cwd: repository.root, args: ["fetch", "--all", "--no-recurse-submodules"], timeoutMs: NETWORK_TIMEOUT_MS, signal })
        return
      }
      const status = await repository.status()
      if (!expected || expected.branch !== (status.head.branch ?? "(detached)") || expected.head !== status.head.oid)
        throw new GitError({ kind: "moved", message: action === "continue" || action === "abort" ? "HEAD or branch changed. Refresh before continuing." : "HEAD or branch changed since you chose this action. Refresh and review the branch again." })
      switch (action) {
        case "pull": {
          idle(repository)
          if (!status.head.upstream) throw new GitError({ message: "This branch has no upstream. Set one with Git before pulling." })
          if (status.head.ahead > 0 && status.head.behind > 0) throw new GitError({ message: "Both branches have new commits. Choose an explicit merge or rebase before pushing." })
          await run({ cwd: repository.root, args: ["pull", "--ff-only", "--no-rebase", "--no-autostash", "--no-recurse-submodules"], timeoutMs: NETWORK_TIMEOUT_MS, signal })
          return
        }
        case "merge":
        case "merge_autostash": {
          idle(repository)
          if (!status.head.upstream) throw new GitError({ message: "This branch has no upstream to merge." })
          await run({ cwd: repository.root, args: ["fetch", "--all", "--no-recurse-submodules"], timeoutMs: NETWORK_TIMEOUT_MS, signal })
          await run({ cwd: repository.root, args: ["merge", "--ff", "--no-edit", action === "merge_autostash" ? "--autostash" : "--no-autostash", "--", status.head.upstream], env: NO_EDITOR, timeoutMs: NETWORK_TIMEOUT_MS, signal })
          return
        }
        case "continue": {
          if (status.entries.some((entry) => entry.conflicted)) throw new GitError({ kind: "conflicts", message: "Resolve and stage the conflicted files before continuing." })
          const operation = repository.operation()
          if (!operation) throw new GitError({ message: "There is no operation to continue." })
          await run({ cwd: repository.root, args: [operation, "--continue"], env: NO_EDITOR, signal })
          return
        }
        case "abort": {
          const operation = repository.operation()
          if (!operation) throw new GitError({ message: "There is no operation to abort." })
          await run({ cwd: repository.root, args: [operation, "--abort"], env: NO_EDITOR, signal })
          return
        }
      }
    } finally {
      repository.changedAll(`ran ${action}`)
    }
  })
}

function idle(repository: Repository): void {
  if (repository.operation()) throw new GitError({ message: "Finish the current merge, rebase, or cherry-pick before changing branches or pulling." })
}

/**
 * Pushes `branch` to its upstream, or publishes it to `origin` and makes that
 * its upstream when it has none. Tags stay local.
 */
export async function push(repository: Repository, branch: string, signal?: AbortSignal): Promise<void> {
  await repository.write(async () => {
    try {
      const head = await repository.head(signal)
      if (head.branch !== branch || !head.oid) throw new GitError({ kind: "moved", message: "The branch changed before pushing." })
      const ref = `refs/heads/${branch}`
      const upstream = await run({ cwd: repository.root, args: ["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", ref], read: true, signal })
      const [remoteName = "", destination = ""] = upstream.stdout.toString("utf8").trim().split("\0")
      const target = remoteName
        ? (() => {
            if (!destination.startsWith("refs/heads/")) throw new GitError({ message: "Invalid upstream branch." })
            return ["--", remoteName, `${ref}:${destination}`]
          })()
        : ["--set-upstream", "--", "origin", `${ref}:${ref}`]
      await run({ cwd: repository.root, args: ["push", "--porcelain", "--no-follow-tags", ...target], timeoutMs: NETWORK_TIMEOUT_MS, signal })
    } finally {
      repository.changedAll("pushed")
    }
  })
}
