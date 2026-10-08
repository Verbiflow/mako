import type { HarnessModelCatalog } from "@mako/sessions/model-catalog"
import type { HarnessProfile } from "../shared.js"
import type { ProviderCapability } from "./registry.js"
import { hostWarn } from "../host-log.js"
import { workDefault, workDefaultProblems, type HarnessDefaults } from "../contracts/harness-defaults.js"

/** This query's owner, independent of a session's native execution authority.
 * Stop only this query's process on cancellation and await cleanup. A waiter
 * borrowing another query's catalog must not dispose that other owner's process. */
export interface ProfileLoadContext {
  signal: AbortSignal
}

export interface ProviderProfileLoader extends ProviderCapability {
  /** The harness's name wherever Mako shows it. */
  label: string
  /** Mako's model choices for this harness until the person makes their own. */
  defaults: HarnessDefaults
  transport: HarnessProfile["transport"]
  nativeModelIds?: true
  cacheKey(env: NodeJS.ProcessEnv): string
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
