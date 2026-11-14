import {
  modelByIdentity,
  optionAccepts,
  optionDefault,
  resolveModelLaunch,
  type SessionModel,
  type SessionSettings,
} from "@mako/sessions/settings"
import type { NativeRunOptions } from "./native-runner.js"
import type { HarnessProfile } from "../contracts/providers-acp.js"

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
 * The model another harness encoded with its parameters (Cursor's `claude-opus-5-5[context=1m,fast=false]`), never a
 * name of its own in brackets (Claude's `claude-opus-5-5[1m]`).
 */
const ENCODED = /^([^[\]]+)\[[^\]=]+=[^\]]*\]$/

/**
 * A selection made on another harness, held to `models` (this harness's catalog; undefined when it can't be read):
 * a model it lists by its identity, or by the model an encoded ID names, with the options that model has and takes;
 * nothing for a model it doesn't list. Unread, an encoded ID goes as the model it names, options left behind.
 */
export function carriedTuning(models: readonly SessionModel[] | undefined, tuning: SessionSettings): SessionSettings | undefined {
  if (!tuning.model) return tuning
  const base = ENCODED.exec(tuning.model)?.[1]
  if (!models?.length) return base ? { model: base } : tuning
  const model = modelByIdentity(models, tuning.model) ?? (base ? modelByIdentity(models, base) : undefined)
  if (!model) return undefined
  const named = modelByIdentity(models, tuning.model) ? tuning.model : model.id
  const options = Object.fromEntries(Object.entries(tuning.options ?? {}).filter(([id, value]) => {
    const option = model.options.find((candidate) => candidate.id === id)
    return option !== undefined && optionAccepts(option, value)
  }))
  return { model: named, ...(Object.keys(options).length && { options }) }
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
