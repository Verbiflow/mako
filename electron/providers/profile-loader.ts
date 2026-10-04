import type { HarnessModelCatalog } from "@mako/sessions/model-catalog"
import type { HarnessProfile } from "../shared.js"
import type { ProviderCapability } from "./registry.js"
import { hostWarn } from "../host-log.js"
import { workDefault } from "../contracts/harness-defaults.js"

export interface ProviderProfileLoader extends ProviderCapability {
  label: string
  transport: HarnessProfile["transport"]
  capabilities: string[]
  nativeModelIds?: true
  cacheKey(env: NodeJS.ProcessEnv): string
  load(env: NodeJS.ProcessEnv, cwd?: string): Promise<HarnessProfile>
  loadForSend?(env: NodeJS.ProcessEnv, cwd?: string): Promise<HarnessProfile>
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
    capabilities: loader.capabilities,
  }
  const settings = workDefault(loader.provider, catalog.models) ?? catalog.settings
  if (settings) profile.settings = settings
  if (catalog.configurationError)
    profile.configurationError = catalog.configurationError
  if (catalog.defaultModel) profile.defaultModel = catalog.defaultModel
  if (catalog.configuredModel) profile.configuredModel = catalog.configuredModel
  return profile
}

/**
 * A profile with Mako's model for new conversations (`harness-defaults.ts`)
 * where its catalog offers it. A snapshot saved by an earlier release keeps
 * the defaults it was saved with; this gives it the current ones.
 */
export function withWorkDefault(profile: HarnessProfile): HarnessProfile {
  const settings = profile.available ? workDefault(profile.id, profile.models) : undefined
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
    capabilities: loader.capabilities,
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
    capabilities: loader.capabilities,
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
    capabilities: [],
    error,
  }
}
