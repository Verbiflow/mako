import {
  modelByIdentity,
  optionAccepts,
  type ModelOption,
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
  /** What a new conversation and a project's setup start on. Without a match, the harness's own default. */
  work: readonly ModelPick[]
  /**
   * What drafts commit messages: a small model at low reasoning, never the
   * fast lane's surcharge. Without a match, the catalog's first model it
   * describes as fast or cheap. `"own"` runs the harness's own default model
   * at low reasoning, for a harness such as OpenCode whose default is a free
   * model it changes itself.
   */
  light: readonly ModelPick[] | "own"
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
 * The model that drafts commit messages through this harness, at low
 * reasoning. `ownDefault` is the model the harness itself
 * starts on, from its catalog.
 */
export function lightDefault(defaults: HarnessDefaults | undefined, models: readonly SessionModel[], ownDefault?: string): HarnessPick | undefined {
  const light = defaults?.light ?? []
  const pick = light === "own" ? undefined : firstPick(light, models)
  if (pick) return { model: pick.model, options: { ...lightOptions(pick.model), ...pick.options } }
  const model = (light === "own" && ownDefault ? catalogModel(models, ownDefault) : undefined) ?? lightModel(models)
  return model ? { model, options: lightOptions(model) } : undefined
}

/**
 * The options that keep a model quick and cheap for small work: its lowest
 * sensible reasoning level and its fast lane off. A model chosen by hand for
 * titles or commits runs with these too.
 */
export function lightOptions(model: SessionModel): ModelOptions {
  return Object.fromEntries(
    model.options.flatMap((option) => {
      const value = option.role === "reasoning" ? lowReasoning(option) : option.role === "speed" ? speedOff(option) : undefined
      return value === undefined ? [] : [[option.id, value]]
    })
  )
}

/** Words a catalog uses for its fast, inexpensive models, and for the ones it has replaced. */
const LIGHT = /\b(fast(est)?|affordable|cheap(est)?|lightweight|quick(est)?|small(est)?|mini|nano|lite|flash)\b/i
const RETIRED = /\b(older|legacy|previous|deprecated|retired)\b/i

/**
 * The first model a catalog describes as fast or inexpensive, read from its
 * own ids, names and descriptions, for a harness Mako's defaults don't name
 * or whose named models are gone. Catalogs list their newest models first;
 * one the catalog calls older or legacy is passed over while a current one
 * qualifies.
 */
export function lightModel(models: readonly SessionModel[]): SessionModel | undefined {
  const text = (model: SessionModel) => [model.id, model.label, model.description ?? "", ...(model.aliases ?? [])].join(" ")
  const light = models.filter((model) => LIGHT.test(text(model)))
  return light.find((model) => !RETIRED.test(text(model))) ?? light[0]
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

const LOW_REASONING = ["low", "minimal"]

function lowReasoning(option: ModelOption): SettingValue | undefined {
  if (option.kind !== "select") return undefined
  return LOW_REASONING.find((value) => option.values.some((choice) => choice.value === value))
}

function speedOff(option: ModelOption): SettingValue | undefined {
  if (option.kind === "boolean") return false
  if (option.booleanValues) return option.booleanValues.off
  return ["false", "default", "off"].find((value) => option.values.some((choice) => choice.value === value))
}
