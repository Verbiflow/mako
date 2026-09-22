import { app, safeStorage } from "electron"
import { join } from "node:path"
import { COMMIT_PROMPT, type AgentHost } from "../host.js"
import { hostClient } from "../host-client.js"
import { CommitGeneration } from "../commit-generation.js"
import { UtilityModelStore } from "../utility-model-store.js"
import {
  legacyUtilityModelDirectory,
  migrateUtilityModels,
  utilityModelDirectory,
} from "../utility-model-location.js"
import { UtilityModelCatalog } from "../utility-model-catalog.js"
import { hostLog, hostWarn } from "../host-log.js"
import type {
  CommitGenerationInput,
  GitPushInput,
  UtilityCatalogInput,
  UtilityConnectionInput,
  UtilityProvider,
} from "../shared.js"
import { registerIpc } from "./register.js"
import { configureKiriCache } from "../kiri-engine.js"

export interface GitIpcContext {
  withHost<TResult>(
    operation: (host: AgentHost) => TResult | Promise<TResult>
  ): Promise<TResult>
}

export function installGitIpc(context: GitIpcContext): void {
  const { withHost } = context
  configureKiriCache(join(app.getPath("userData"), "kiri-analysis-cache"))
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
          await generation.commit(hostClient(), host.gitWorkspace, message)
          await host.pushGit()
        }
      })
  )
  registerIpc("mako:git-push", (_event, input: GitPushInput) => withHost((host) => {
    if (host.gitWorkspace !== input.cwd) throw new Error("The project changed before pushing. Select the intended project and try again.")
    return host.gitPush(input.branch)
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
  const dataRoot = app.getPath("userData")
  const directory = utilityModelDirectory({ dataRoot, appData: app.getPath("appData") })
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
  const models = new UtilityModelStore(
    directory,
    {
      available: () =>
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== "linux" ||
          safeStorage.getSelectedStorageBackend() !== "basic_text"),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    },
    { ready: migration }
  )
  const generation = new CommitGeneration(models)
  const catalog = new UtilityModelCatalog(models)
  registerIpc("mako:utility-model-settings", () => models.settings())
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
    generation.cancel(hostClient(), requestId)
  )
  registerIpc(
    "mako:git-generate-message",
    (_event, input: CommitGenerationInput) =>
      withHost((host) => {
        if (host.gitWorkspace !== input.cwd)
          throw new Error(
            "The workspace changed. Refresh Changes before drafting a message."
          )
        return generation.generate(hostClient(), input)
      })
  )
  registerIpc("mako:default-commit-prompt", () => COMMIT_PROMPT)
}
