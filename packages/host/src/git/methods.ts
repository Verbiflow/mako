import type { DomainSecrets } from "../base/host-secrets.js"
import type { HostEnvironment } from "../base/host-environment.js"
import { COMMIT_STYLE, type Git } from "@mako/git"
import { hostClient } from "../base/host-client.js"
import { GitDrafting } from "./drafting.js"
import { UtilityModelStore, utilityLegacyFiles } from "./utility-model-store.js"
import type { UtilityWork } from "./utility-work.js"
import { HARNESS_ORDER_LIMIT, UTILITY_TASKS } from "../contracts/utility-work.js"
import {
  legacyUtilityModelDirectory,
  migrateUtilityModels,
  utilityModelDirectory,
} from "./utility-model-location.js"
import { savedModelNamer, UtilityModelCatalog } from "./utility-model-catalog.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { z } from "zod"
import type { CommitGenerationInput, UtilityCatalogInput, UtilityConnectionInput, UtilityProvider } from "../contracts/utility-models.js"
import type { GitCommitEntry, GitCommitFile, GitDiff, GitFile, GitPushInput, GitRemoteInput, GitRemoteResult, GitStatus } from "../contracts/git-workspace-search.js"
import type { MethodTable } from "../base/methods.js"

/**
 * The repository of a client's tab in front, as Workspaces holds it: each
 * change to it also tells that client's window what Changes now shows.
 */
export interface GitTab {
  /** The folder Git commands run in: the selected repository, else the workspace. */
  readonly gitWorkspace: string
  selectGitRepository(cwd: string, root: string): Promise<GitStatus>
  gitStatus(): Promise<GitStatus>
  gitDiff(path: string): Promise<GitDiff>
  gitDiffAll(): Promise<{ diffs: GitDiff[]; truncated: number }>
  gitCommitFiles(hash: string): Promise<GitCommitFile[]>
  gitCommitDiffAll(hash: string): Promise<{ diffs: GitDiff[]; truncated: number }>
  gitCommitFileDiff(hash: string, path: string): Promise<GitDiff>
  gitStage(paths: string[]): Promise<void>
  gitUnstage(paths: string[]): Promise<void>
  gitDiscard(paths: string[]): Promise<{ stash: string }>
  gitRestoreDiscarded(stash: string): Promise<void>
  gitChangedSince(ref: string): Promise<{ base: string; files: GitFile[] } | null>
  gitDefaultBranch(): Promise<string | null>
  gitSinceDiff(base: string, path: string): Promise<GitDiff>
  gitStageAll(): Promise<void>
  gitUnstageAll(): Promise<void>
  gitCommit(message: string, options?: { amend?: boolean }): Promise<void>
  gitRemote(input: GitRemoteInput): Promise<GitRemoteResult>
  gitPush(expectedBranch?: string): Promise<void>
  gitLog(limit?: number): Promise<GitCommitEntry[]>
  /** Tells the window what Changes shows now. */
  pushGit(): Promise<void>
}

export interface GitIpcContext {
  withHost<TResult>(
    operation: (host: GitTab) => TResult | Promise<TResult>
  ): Promise<TResult>
  git: Git
  models: UtilityModelStore
  work: UtilityWork
}

const UtilityChoiceSchema = z.tuple([z.enum(UTILITY_TASKS), z.string().min(1).max(400)])
const HarnessOrderSchema = z.array(z.string().min(1).max(40)).max(HARNESS_ORDER_LIMIT)

export function installGitIpc(methods: MethodTable, context: GitIpcContext): void {
  const { withHost, git, models, work } = context
  methods.handle("mako:git-select-repository", (cwd: string, root: string) => withHost((host) => host.selectGitRepository(cwd, root)))
  methods.handle("mako:git-status", () => withHost((host) => host.gitStatus()))
  methods.handle("mako:git-diff", (path: string) =>
    withHost((host) => host.gitDiff(path))
  )
  methods.handle("mako:git-diff-all", () => withHost((host) => host.gitDiffAll()))
  methods.handle("mako:git-stage", (paths: string[]) =>
    withHost((host) => host.gitStage(paths))
  )
  methods.handle("mako:git-unstage", (paths: string[]) =>
    withHost((host) => host.gitUnstage(paths))
  )
  methods.handle("mako:git-discard", (paths: string[]) =>
    withHost((host) => host.gitDiscard(paths))
  )
  methods.handle("mako:git-restore-discarded", (stash: string) =>
    withHost((host) => host.gitRestoreDiscarded(stash))
  )
  methods.handle("mako:git-changed-since", (ref: string) =>
    withHost((host) => host.gitChangedSince(ref))
  )
  methods.handle("mako:git-default-branch", () =>
    withHost((host) => host.gitDefaultBranch())
  )
  methods.handle("mako:git-since-diff", (base: string, path: string) =>
    withHost((host) => host.gitSinceDiff(base, path))
  )
  methods.handle("mako:git-stage-all", () =>
    withHost((host) => host.gitStageAll())
  )
  methods.handle("mako:git-unstage-all", () =>
    withHost((host) => host.gitUnstageAll())
  )
  methods.handle(
    "mako:git-commit",
    (message: string, options?: { amend?: boolean }) =>
      withHost(async (host) => {
        if (options?.amend) await host.gitCommit(message, options)
        else {
          await drafting.commit(hostClient(), host.gitWorkspace, message)
          await host.pushGit()
        }
      })
  )
  methods.handle("mako:git-push", (input: GitPushInput) => withHost((host) => {
    if (host.gitWorkspace !== input.cwd) throw new Error("The project changed before pushing. Select the intended project and try again.")
    return host.gitPush(input.branch)
  }))
  methods.handle("mako:git-remote", (input: GitRemoteInput) => withHost(async (host) => {
    if (host.gitWorkspace !== input.cwd) throw new Error("Select this repository before continuing.")
    return host.gitRemote(input)
  }))
  methods.handle("mako:git-log", (limit?: number) =>
    withHost((host) => host.gitLog(limit))
  )
  methods.handle("mako:git-commit-files", (hash: string) =>
    withHost((host) => host.gitCommitFiles(hash))
  )
  methods.handle(
    "mako:git-commit-file-diff",
    (hash: string, path: string) =>
      withHost((host) => host.gitCommitFileDiff(hash, path))
  )
  methods.handle("mako:git-commit-diff-all", (hash: string) =>
    withHost((host) => host.gitCommitDiffAll(hash))
  )
  // `npm run git:doctor`: what this host holds for a repository against a fresh read.
  methods.handle("mako:git-doctor", async (path: string) => {
    const held = git.knownRepository(path) !== undefined
    const repository = await git.openRepository(path)
    if (!repository) throw new Error(`${path} isn't inside a Git repository.`)
    return { held, diagnosis: await repository.diagnose(), activity: git.activity(), open: git.repositories().open }
  })
  const drafting = new GitDrafting(git, work)
  const catalog = new UtilityModelCatalog(models)
  const nameSavedModels = savedModelNamer(catalog, models)
  methods.handle("mako:utility-model-settings", async () => {
    let [settings, tasks] = await Promise.all([models.settings(), work.settings()])
    if (await nameSavedModels(settings.connections))
      [settings, tasks] = await Promise.all([models.settings(), work.settings()])
    return { ...settings, work: tasks }
  })
  methods.handle("mako:utility-choice", async (task: string, choice: string) => {
    const [parsedTask, parsedChoice] = UtilityChoiceSchema.parse([task, choice])
    await work.choose(parsedTask, parsedChoice)
  })
  methods.handle("mako:harness-order-saved", () => models.harnessOrder())
  methods.handle("mako:harness-order", (order: string[]) =>
    models.saveHarnessOrder(HarnessOrderSchema.parse(order))
  )
  methods.handle(
    "mako:utility-model-catalog",
    (input: UtilityCatalogInput) => catalog.list(input)
  )
  methods.handle(
    "mako:utility-model-connect",
    (input: UtilityConnectionInput) => models.connect(input)
  )
  methods.handle(
    "mako:utility-model-disconnect",
    (provider: UtilityProvider) => models.disconnect(provider)
  )
  methods.handle("mako:git-cancel-generation", (requestId: string) =>
    drafting.cancel(hostClient(), requestId)
  )
  methods.handle(
    "mako:git-generate-message",
    (input: CommitGenerationInput) =>
      withHost((host) => {
        if (host.gitWorkspace !== input.cwd)
          throw new Error(
            "The workspace changed. Refresh Changes before drafting a message."
          )
        return drafting.commitMessage(hostClient(), input)
      })
  )
  methods.handle("mako:default-commit-prompt", () => COMMIT_STYLE)
}

/** This user's model connections, after moving a profile's older copies into them. */
export function openUtilityModels({ dataRoot, appData }: Pick<HostEnvironment, "dataRoot" | "appData">, secrets: DomainSecrets): UtilityModelStore {
  const directory = utilityModelDirectory({ dataRoot, appData })
  const migration = migrateUtilityModels(
    legacyUtilityModelDirectory(dataRoot),
    directory
  ).then(
    (moved) => {
      if (moved.moved.length || moved.replaced.length || moved.dropped.length)
        hostLog("utility-models", "moved profile connections to the user store", {
          to: directory,
          moved: moved.moved.join(","),
          replaced: moved.replaced.join(","),
          dropped: moved.dropped.join(","),
        })
    },
    // A copy that would not move stays where it was, in host.log, and out of
    // the way: the user can still connect here, and nothing was deleted.
    (error: NodeJS.ErrnoException) => {
      hostWarn("utility-models", "profile connections were not moved", {
        from: legacyUtilityModelDirectory(dataRoot),
        to: directory,
        error: error.message,
      })
    }
  )
  secrets.adoptLegacy(utilityLegacyFiles(directory))
  return new UtilityModelStore(directory, secrets.secrets, { ready: migration })
}
