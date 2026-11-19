import type { HarnessModelCatalog } from "@mako/sessions/model-catalog"
import type { SessionModel } from "@mako/sessions/settings"
import type { HarnessProfile } from "../contracts/providers-acp.js"
import type { ProviderCapability } from "./registry.js"
import { hostWarn } from "../base/host-log.js"
import { workDefault, workDefaultProblems, type HarnessDefaults } from "../contracts/harness-defaults.js"
import type { FolderDefaults } from "./provider-profile-cache.js"

/** This query's owner, independent of a session's native execution authority.
 * Stop only this query's process on cancellation and await cleanup. A waiter
 * borrowing another query's catalog must not dispose that other owner's process. */
export interface ProfileLoadContext {
  signal: AbortSignal
  /**
   * The models this account listed the last time, read from the runtime `runtimeStamp` still names. What the harness
   * said of each then (whether it runs it, each option's value) need not be asked again.
   */
  kept?: readonly SessionModel[]
}

export interface FolderConfiguration {
  /**
   * The project-level configuration files the harness reads, relative to each folder from the checkout's root down
   * to the folder asked. Two checkouts of one repository whose files are the same bytes configure it the same.
   */
  files: readonly string[]
  /** The profile names the model the folder is configured with, whatever Mako's defaults are. */
  configuredModel?: true
  /**
   * The folder's fields read without starting a process, where the harness's configuration can be parsed as the
   * harness itself resolves it. Undefined when it can't say.
   */
  read?(env: NodeJS.ProcessEnv, cwd: string, models: readonly SessionModel[]): Promise<FolderDefaults | undefined>
}

export interface ProviderProfileLoader extends ProviderCapability {
  /** The harness's name wherever Mako shows it. */
  label: string
  /** Mako's model choices for this harness until the person makes their own. */
  defaults: HarnessDefaults
  transport: HarnessProfile["transport"]
  nativeModelIds?: true
  cacheKey(env: NodeJS.ProcessEnv): string
  /**
   * What names the runtime a discovery reads, for a harness whose answers about each model are costly and change
   * only with it: the same stamp and account hand the next discovery what the last one read (`ProfileLoadContext.kept`).
   */
  runtimeStamp?(env: NodeJS.ProcessEnv): Promise<string | undefined>
  /**
   * Declared by a harness whose profile says something of the folder's own configuration (`settings` where Mako's
   * default isn't offered, `configuredModel`). A send in a folder never discovered must launch on what that folder
   * configures, so it takes those from here rather than from the account's list alone (`HarnessProfiles`).
   */
  folder?: FolderConfiguration
  load(env: NodeJS.ProcessEnv, cwd?: string, context?: ProfileLoadContext): Promise<HarnessProfile>
  loadForSend?(env: NodeJS.ProcessEnv, cwd?: string, context?: ProfileLoadContext): Promise<HarnessProfile>
}

export function availableProviderProfile(
  loader: ProviderProfileLoader,
  catalog: HarnessModelCatalog
): HarnessProfile {
  const profile: HarnessProfile = {
    id: loader.provider,
    label: loader.label,
    available: true,
    transport: loader.transport,
    models: catalog.models,
  }
  const settings = workDefault(loader.defaults, catalog.models) ?? catalog.settings
  if (settings) profile.settings = settings
  const problems = catalog.models.length ? workDefaultProblems(loader.defaults, catalog.models) : []
  if (problems.length) hostWarn("discovery", "Mako's default model isn't offered", { harness: loader.provider, problems: problems.join("; ") })
  if (catalog.configurationError)
    profile.configurationError = catalog.configurationError
  if (catalog.defaultModel) profile.defaultModel = catalog.defaultModel
  if (catalog.configuredModel) profile.configuredModel = catalog.configuredModel
  return profile
}

/**
 * A profile with Mako's model for new conversations where its catalog offers
 * it. A snapshot saved by an earlier release keeps the defaults it was saved
 * with; this gives it the current ones.
 */
export function withWorkDefault(profile: HarnessProfile, defaults: HarnessDefaults): HarnessProfile {
  const settings = profile.available ? workDefault(defaults, profile.models) : undefined
  return settings ? { ...profile, settings } : profile
}

export function unavailableProviderProfile(
  loader: ProviderProfileLoader,
  error: string
): HarnessProfile {
  // The composer will only say "Model unavailable"; the reason lives here.
  hostWarn("discovery", "provider profile unavailable", { harness: loader.provider, error })
  return {
    id: loader.provider,
    label: loader.label,
    available: false,
    transport: loader.transport,
    models: [],
    error,
  }
}

/** Discovery has not answered yet. Never persisted; replaced by the first real load. */
export function pendingProviderProfile(
  loader: ProviderProfileLoader
): HarnessProfile {
  return {
    id: loader.provider,
    label: loader.label,
    available: false,
    pending: true,
    transport: loader.transport,
    models: [],
  }
}

export function unknownProviderProfile(
  provider: string,
  error: string
): HarnessProfile {
  return {
    id: provider,
    label: provider,
    available: false,
    transport: "remote",
    models: [],
    error,
  }
}
