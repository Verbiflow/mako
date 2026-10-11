import { join } from "node:path"
import type { MethodTable } from "../base/methods.js"
import type { HostEnvironment } from "../base/host-environment.js"
import type { DomainSecrets } from "../base/host-secrets.js"
import { installGitIpc, openUtilityModels, type GitTab } from "./methods.js"
import { UtilityWork } from "./utility-work.js"
import { githubStatus, listPulls, listRemoteBranches, pullForBranch, repoAvatar, userAvatar, type CreatePullOptions } from "./github.js"
import { mergePullRequest, openPullRequest, rerunFailedChecks } from "./pull-requests.js"
import type { MergeMethod } from "../contracts/git-actions.js"
import type { Git } from "@mako/git"

export type { GitTab } from "./methods.js"
export { WorkspaceGit, previewDiffs, treeDiff, treeFiles } from "./workspace-git.js"
export { hostGit } from "./host-git.js"
export { discoverRepositories, projectRepositories } from "./repository-discovery.js"
export { githubStatus, listBranchPulls, listPullHeads } from "./github.js"
export { pullRequestTools, registerPullRequestTools, type PullRequestTools } from "./pull-request-tools.js"

export interface GitMethodsDeps {
  /** Thread worktrees remember each branch's pull request; a new or merged one makes them read it again. */
  worktrees: { forgetPulls(): void } | null
  withHost<T>(run: (host: GitTab) => T | Promise<T>): Promise<T>
  git: Git
  environment: Pick<HostEnvironment, "dataRoot" | "appData">
  secrets: DomainSecrets
}

/** Status, staging, commits and their drafts, and the pull requests of the tab in front. */
export function declareGitMethods(methods: MethodTable, { worktrees, withHost, git, environment, secrets }: GitMethodsDeps): void {
  const models = openUtilityModels(environment, secrets)
  const avatars = join(environment.dataRoot, "avatars")
  installGitIpc(methods, { withHost, git, models, work: new UtilityWork({ models }) })
  methods.handle("mako:github-status", () => withHost((h) => githubStatus(h.gitWorkspace)))
  methods.handle("mako:pull-request", () => withHost((h) => pullForBranch(h.gitWorkspace)))
  methods.handle("mako:pull-requests", (limit?: number) => withHost((h) => listPulls(h.gitWorkspace, limit)))
  methods.handle("mako:pull-branches", () => withHost((h) => listRemoteBranches(git, h.gitWorkspace)))
  methods.handle("mako:create-pull", (options: CreatePullOptions) =>
    withHost(async (h) => {
      const opened = await openPullRequest(git, h.gitWorkspace, options)
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
  methods.handle("mako:rerun-checks", () => withHost((h) => rerunFailedChecks(git, h.gitWorkspace)))
  methods.handle("mako:repo-avatar", (repo: string) => withHost((h) => repoAvatar(h.gitWorkspace, repo, avatars)))
  methods.handle("mako:user-avatar", () => withHost((h) => userAvatar(h.gitWorkspace, avatars)))
}
