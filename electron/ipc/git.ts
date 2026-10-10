import { adoptLegacySecrets, hostSecrets } from "../host-secrets.js"
import { COMMIT_STYLE, gitActivity, knownRepository, openRepositories, openRepository } from "@mako/git"
import type { AgentHost } from "../host.js"
import { hostClient } from "../host-client.js"
import { GitDrafting } from "../git-drafting.js"
import { UtilityModelStore, utilityLegacyFiles } from "../utility-model-store.js"
import type { UtilityWork } from "../utility-work.js"
import { HARNESS_ORDER_LIMIT, UTILITY_TASKS } from "../contracts/utility-work.js"
import {
  legacyUtilityModelDirectory,
  migrateUtilityModels,
  utilityModelDirectory,
} from "../utility-model-location.js"
import { savedModelNamer, UtilityModelCatalog } from "../utility-model-catalog.js"
import { hostLog, hostWarn } from "../host-log.js"
import { z } from "zod"
import type {
  CommitGenerationInput,
  GitPushInput,
  GitRemoteInput,
  UtilityCatalogInput,
  UtilityConnectionInput,
  UtilityProvider,
} from "../shared.js"
import { registerIpc } from "./register.js"
import { hostEnvironment } from "../host-environment.js"

export interface GitIpcContext {
  withHost<TResult>(
    operation: (host: AgentHost) => TResult | Promise<TResult>
  ): Promise<TResult>
  models: UtilityModelStore
  work: UtilityWork
}

const UtilityChoiceSchema = z.tuple([z.enum(UTILITY_TASKS), z.string().min(1).max(400)])
const HarnessOrderSchema = z.array(z.string().min(1).max(40)).max(HARNESS_ORDER_LIMIT)

export function installGitIpc(context: GitIpcContext): void {
  const { withHost, models, work } = context
  registerIpc("mako:git-select-repository", (_event, cwd: string, root: string) => withHost((host) => host.selectGitRepository(cwd, root)))
  registerIpc("mako:git-status", () => withHost((host) => host.gitStatus()))
  registerIpc("mako:git-diff", (_event, path: string) =>
    withHost((host) => host.gitDiff(path))
  )
  registerIpc("mako:git-diff-all", () => withHost((host) => host.gitDiffAll()))
  registerIpc("mako:git-stage", (_event, paths: string[]) =>
    withHost((host) => host.gitStage(paths))
  )
  registerIpc("mako:git-unstage", (_event, paths: string[]) =>
    withHost((host) => host.gitUnstage(paths))
  )
  registerIpc("mako:git-discard", (_event, paths: string[]) =>
    withHost((host) => host.gitDiscard(paths))
  )
  registerIpc("mako:git-restore-discarded", (_event, stash: string) =>
    withHost((host) => host.gitRestoreDiscarded(stash))
  )
  registerIpc("mako:git-changed-since", (_event, ref: string) =>
    withHost((host) => host.gitChangedSince(ref))
  )
  registerIpc("mako:git-default-branch", () =>
    withHost((host) => host.gitDefaultBranch())
  )
  registerIpc("mako:git-since-diff", (_event, base: string, path: string) =>
    withHost((host) => host.gitSinceDiff(base, path))
  )
  registerIpc("mako:git-stage-all", () =>
    withHost((host) => host.gitStageAll())
  )
  registerIpc("mako:git-unstage-all", () =>
    withHost((host) => host.gitUnstageAll())
  )
  registerIpc(
    "mako:git-commit",
    (_event, message: string, options?: { amend?: boolean }) =>
      withHost(async (host) => {
        if (options?.amend) await host.gitCommit(message, options)
        else {
          await drafting.commit(hostClient(), host.gitWorkspace, message)
          await host.pushGit()
        }
      })
  )
  registerIpc("mako:git-push", (_event, input: GitPushInput) => withHost((host) => {
    if (host.gitWorkspace !== input.cwd) throw new Error("The project changed before pushing. Select the intended project and try again.")
    return host.gitPush(input.branch)
  }))
  registerIpc("mako:git-remote", (_event, input: GitRemoteInput) => withHost(async (host) => {
    if (host.gitWorkspace !== input.cwd) throw new Error("Select this repository before continuing.")
    return host.gitRemote(input)
  }))
  registerIpc("mako:git-log", (_event, limit?: number) =>
    withHost((host) => host.gitLog(limit))
  )
  registerIpc("mako:git-commit-files", (_event, hash: string) =>
    withHost((host) => host.gitCommitFiles(hash))
  )
  registerIpc(
    "mako:git-commit-file-diff",
    (_event, hash: string, path: string) =>
      withHost((host) => host.gitCommitFileDiff(hash, path))
  )
  registerIpc("mako:git-commit-diff-all", (_event, hash: string) =>
    withHost((host) => host.gitCommitDiffAll(hash))
  )
  // `npm run git:doctor`: what this host holds for a repository against a fresh read.
  registerIpc("mako:git-doctor", async (_event, path: string) => {
    const held = knownRepository(path) !== undefined
    const repository = await openRepository(path)
    if (!repository) throw new Error(`${path} isn't inside a Git repository.`)
    return { held, diagnosis: await repository.diagnose(), activity: gitActivity(), open: openRepositories() }
  })
  const drafting = new GitDrafting(work)
  const catalog = new UtilityModelCatalog(models)
  const nameSavedModels = savedModelNamer(catalog, models)
  registerIpc("mako:utility-model-settings", async () => {
    let [settings, tasks] = await Promise.all([models.settings(), work.settings()])
    if (await nameSavedModels(settings.connections))
      [settings, tasks] = await Promise.all([models.settings(), work.settings()])
    return { ...settings, work: tasks }
  })
  registerIpc("mako:utility-choice", async (_event, task: string, choice: string) => {
    const [parsedTask, parsedChoice] = UtilityChoiceSchema.parse([task, choice])
    await work.choose(parsedTask, parsedChoice)
  })
  registerIpc("mako:harness-order-saved", () => models.harnessOrder())
  registerIpc("mako:harness-order", (_event, order: string[]) =>
    models.saveHarnessOrder(HarnessOrderSchema.parse(order))
  )
  registerIpc(
    "mako:utility-model-catalog",
    (_event, input: UtilityCatalogInput) => catalog.list(input)
  )
  registerIpc(
    "mako:utility-model-connect",
    (_event, input: UtilityConnectionInput) => models.connect(input)
  )
  registerIpc(
    "mako:utility-model-disconnect",
    (_event, provider: UtilityProvider) => models.disconnect(provider)
  )
  registerIpc("mako:git-cancel-generation", (_event, requestId: string) =>
    drafting.cancel(hostClient(), requestId)
  )
  registerIpc(
    "mako:git-generate-message",
    (_event, input: CommitGenerationInput) =>
      withHost((host) => {
        if (host.gitWorkspace !== input.cwd)
          throw new Error(
            "The workspace changed. Refresh Changes before drafting a message."
          )
        return drafting.commitMessage(hostClient(), input)
      })
  )
  registerIpc("mako:default-commit-prompt", () => COMMIT_STYLE)
}

/** This user's model connections, after moving a profile's older copies into them. */
export function openUtilityModels(): UtilityModelStore {
  const dataRoot = hostEnvironment().dataRoot
  const directory = utilityModelDirectory({ dataRoot, appData: hostEnvironment().appData })
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
  adoptLegacySecrets(utilityLegacyFiles(directory))
  return new UtilityModelStore(directory, hostSecrets(), { ready: migration })
}
