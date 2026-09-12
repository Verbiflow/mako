import {
  modelByIdentity,
  optionDefault,
  resolveModelLaunch,
  type SessionSettings,
} from "@mako/sessions/settings"
import type { NativeRunOptions } from "./providers/native-runner.js"
import type { HarnessProfile } from "./shared.js"

export function canonicalHarnessModelId(
  profile: HarnessProfile,
  identity: string | undefined
): string | undefined {
  return modelByIdentity(profile.models, identity)?.id
}

export function resolveHarnessTuning(
  profile: HarnessProfile,
  tuning: SessionSettings | undefined
): SessionSettings | undefined {
  return tuning ? resolveModelLaunch(profile.models, tuning) : undefined
}

/**
 * A headless run's settings, with the catalog's defaults beside them. A live
 * session already holds its provider's defaults, so a selection that names
 * only a model is complete there; a command line starts from nothing, and a
 * runner that must state a level (Cursor folds it into the model id) needs
 * to know which level the provider would have used.
 */
export function withCatalogDefaults(
  profile: HarnessProfile,
  settings: SessionSettings
): NativeRunOptions {
  const model = modelByIdentity(profile.models, settings.model)
  if (!model) return settings
  const defaults: NonNullable<SessionSettings["options"]> = {}
  for (const option of model.options) {
    const value = optionDefault(option)
    if (value !== undefined) defaults[option.id] = value
  }
  return { ...settings, defaults }
}
