import {
  modelByIdentity,
  optionAccepts,
  type SessionModel,
  type SessionSettings,
  type SettingValue,
} from "@mako/sessions/settings"

/** A model by catalog id or alias, and the options to start it with. */
export interface ModelPick {
  model: string
  options?: Readonly<Record<string, SettingValue>>
}

/**
 * Mako's own model choices for one harness, declared with its profile and
 * updated as the harness ships new models. A person's choice in Settings
 * always wins; until they make one, each release's defaults apply, so nobody
 * is left on a model that has since been replaced.
 *
 * Each list is tried in order and the first model the harness's catalog
 * offers wins, so a harness without the newest model falls back to the one
 * before it.
 */
export interface HarnessDefaults {
  /**
   * What a new conversation and a project's setup start on. Without a match,
   * the harness's own default. The first pick is held to the harness's
   * recorded catalog (`scripts/fixtures/model-catalogs`), so a renamed model
   * fails a test before it reaches a session.
   */
  work: readonly ModelPick[]
  /** Why Mako names no model for this harness, when `work` is empty. */
  none?: string
}

/** A model's option values by the catalog's option ids. */
export type ModelOptions = Record<string, SettingValue>

/** A model from a harness's catalog and the options to run it with. */
export interface HarnessPick {
  model: SessionModel
  options: ModelOptions
}

/**
 * Every known harness once, in the person's saved order and then Mako's.
 * `known` is in Mako's order: the order harnesses are installed in
 * (`providers/index.ts`). A harness that went away is dropped.
 */
export function harnessOrder(saved: readonly string[] | undefined, known: readonly string[]): string[] {
  const order: string[] = []
  for (const harness of [...(saved ?? []), ...known])
    if (known.includes(harness) && !order.includes(harness)) order.push(harness)
  return order
}

/** True when `order` is Mako's own order over `known`. */
export function isDefaultOrder(order: readonly string[], known: readonly string[]): boolean {
  const own = harnessOrder(undefined, known)
  return own.length === order.length && own.every((harness, index) => harness === order[index])
}

/** What a new conversation and a project's setup start on, when Mako's defaults name a model this catalog has. */
export function workDefault(defaults: HarnessDefaults | undefined, models: readonly SessionModel[]): SessionSettings | undefined {
  const pick = firstPick(defaults?.work ?? [], models)
  return pick ? { model: pick.model.id, options: pick.options } : undefined
}

/**
 * Why `models` can't start Mako's first pick as declared: a model it doesn't
 * offer, or an option value the model doesn't accept. Later picks are for
 * older catalogs and aren't held to this one.
 */
export function workDefaultProblems(defaults: HarnessDefaults, models: readonly SessionModel[]): string[] {
  const [pick] = defaults.work
  if (!pick) return []
  const model = catalogModel(models, pick.model)
  if (!model) return [`${pick.model} isn't in the catalog`]
  return Object.entries(pick.options ?? {}).flatMap(([id, value]) => {
    const option = model.options.find((entry) => entry.id === id)
    if (!option) return [`${model.id} has no ${id} option`]
    return optionAccepts(option, value) ? [] : [`${model.id} doesn't accept ${id} ${String(value)}`]
  })
}

function firstPick(picks: readonly ModelPick[], models: readonly SessionModel[]): HarnessPick | undefined {
  for (const pick of picks) {
    const model = catalogModel(models, pick.model)
    if (!model) continue
    const options: ModelOptions = {}
    for (const [id, value] of Object.entries(pick.options ?? {})) {
      const option = model.options.find((entry) => entry.id === id)
      if (option && optionAccepts(option, value)) options[id] = value
    }
    return { model, options }
  }
  return undefined
}

/** A catalog's model by id or alias, or by a dated id such as `claude-haiku-4-5-20251001`. */
function catalogModel(models: readonly SessionModel[], id: string): SessionModel | undefined {
  return modelByIdentity(models, id) ?? models.find((model) => model.id.startsWith(`${id}-`) && /^\d{8}$/.test(model.id.slice(id.length + 1)))
}