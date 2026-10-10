import type { MethodTable } from "@mako/host/base/methods"
import { installGitIpc, openUtilityModels, type GitTab } from "../ipc/git.js"
import { UtilityWork } from "../utility-work.js"
import { githubStatus, listPulls, listRemoteBranches, pullForBranch, repoAvatar, userAvatar, type CreatePullOptions } from "../github.js"
import { mergePullRequest, openPullRequest, rerunFailedChecks } from "../pull-requests.js"
import type { MergeMethod } from "@mako/host/contracts/git-actions"

export interface GitMethodsDeps {
  /** Thread worktrees remember each branch's pull request; a new or merged one makes them read it again. */
  worktrees: { forgetPulls(): void } | null
  withHost<T>(run: (host: GitTab) => T | Promise<T>): Promise<T>
}

/** Status, staging, commits and their drafts, and the pull requests of the tab in front. */
export function declareGitMethods(methods: MethodTable, { worktrees, withHost }: GitMethodsDeps): void {
  const models = openUtilityModels()
  installGitIpc(methods, { withHost, models, work: new UtilityWork({ models }) })
  methods.handle("mako:github-status", () => withHost((h) => githubStatus(h.gitWorkspace)))
  methods.handle("mako:pull-request", () => withHost((h) => pullForBranch(h.gitWorkspace)))
  methods.handle("mako:pull-requests", (limit?: number) => withHost((h) => listPulls(h.gitWorkspace, limit)))
  methods.handle("mako:pull-branches", () => withHost((h) => listRemoteBranches(h.gitWorkspace)))
  methods.handle("mako:create-pull", (options: CreatePullOptions) =>
    withHost(async (h) => {
      const opened = await openPullRequest(h.gitWorkspace, options)
      worktrees?.forgetPulls()
      return opened.pull
    })
  )
  methods.handle("mako:merge-pull", (strategy: MergeMethod) =>
    withHost(async (h) => {
      const { pull } = await mergePullRequest(h.gitWorkspace, strategy)
      worktrees?.forgetPulls()
      return pull
    })
  )
  methods.handle("mako:rerun-checks", () => withHost((h) => rerunFailedChecks(h.gitWorkspace)))
  methods.handle("mako:repo-avatar", (repo: string) => withHost((h) => repoAvatar(h.gitWorkspace, repo)))
  methods.handle("mako:user-avatar", () => withHost((h) => userAvatar(h.gitWorkspace)))
}
