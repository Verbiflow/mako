import {
  modelByIdentity,
  optionAccepts,
  type ModelOption,
  type SessionModel,
  type SessionSettings,
  type SettingValue,
} from "@mako/sessions/settings"

/**
 * Mako's own defaults, in one place and updated as harnesses ship new
 * models. A person's choice in Settings always wins; until they make one,
 * each release's defaults apply, so nobody is left on a model that has
 * since been replaced.
 *
 * - `HARNESS_ORDER` is the order Mako tries harnesses in when it must pick
 *   one itself: setting a project up, naming Threads, drafting commit
 *   messages. Settings › Models lets the person reorder it.
 * - `work` is what a new conversation and a project's setup start on.
 * - `light` names Threads and drafts commit messages: a small model at low
 *   reasoning, never the fast lane's surcharge.
 *
 * Each list is tried in order and the first model the harness's own catalog
 * offers wins, so a harness without the newest model falls back to the one
 * before it. Without a match, `work` keeps the harness's own default and
 * `light` takes the catalog's first model it describes as fast or cheap.
 */
export const HARNESS_ORDER = ["claude", "codex", "cursor", "opencode", "grok", "devin"] as const

type DefaultHarness = (typeof HARNESS_ORDER)[number]

interface ModelPick {
  model: string
  options?: Readonly<Record<string, SettingValue>>
}

interface HarnessDefaults {
  work: readonly ModelPick[]
  light: readonly ModelPick[]
}

const HARNESS_DEFAULTS = {
  claude: {
    work: [{ model: "claude-opus-5-5", options: { effort: "high", fast: false } }],
    light: [{ model: "claude-haiku-4-5", options: { fast: false } }],
  },
  codex: {
    work: [{ model: "gpt-6.1-sol", options: { effort: "medium", serviceTier: "default" } }],
    light: [{ model: "gpt-6-luna", options: { effort: "low", serviceTier: "default" } }],
  },
  cursor: {
    work: [{ model: "auto-smart", options: { optimize_for: "intelligence" } }],
    light: [
      { model: "composer-2.5", options: { fast: "false" } },
      { model: "gpt-5.4-nano", options: { effort: "low" } },
    ],
  },
  opencode: {
    work: [{ model: "openai/gpt-6.1-sol", options: { effort: "medium" } }],
    light: [
      { model: "openai/gpt-6-luna", options: { effort: "low" } },
      { model: "google/gemini-3.8-flash", options: { effort: "low" } },
      { model: "google/gemini-flash-lite-latest", options: { effort: "low" } },
    ],
  },
  grok: {
    work: [{ model: "grok-4.7", options: { effort: "high" } }],
    light: [{ model: "grok-4.7", options: { effort: "low" } }],
  },
  devin: {
    work: [{ model: "swe-2", options: { effort: "high" } }],
    light: [
      { model: "gpt-6-luna", options: { effort: "low", fast: false } },
      { model: "gemini-3.8-flash", options: { effort: "low" } },
    ],
  },
} as const satisfies Record<DefaultHarness, HarnessDefaults>

/** A model's option values by the catalog's option ids. */
export type ModelOptions = Record<string, SettingValue>

/** A model from a harness's catalog and the options to run it with. */
export interface HarnessPick {
  model: SessionModel
  options: ModelOptions
}

/**
 * Every known harness once, in the person's saved order, then Mako's, then
 * any harness neither names. A harness that went away is dropped.
 */
export function harnessOrder(saved: readonly string[] | undefined, known: readonly string[]): string[] {
  const order: string[] = []
  for (const harness of [...(saved ?? []), ...HARNESS_ORDER, ...known])
    if (known.includes(harness) && !order.includes(harness)) order.push(harness)
  return order
}

/** True when `order` is Mako's own order over these harnesses. */
export function isDefaultOrder(order: readonly string[]): boolean {
  const known = [...order]
  return harnessOrder(undefined, known).every((harness, index) => harness === order[index])
}

/** What a new conversation and a project's setup start on, when Mako's defaults name a model this catalog has. */
export function workDefault(harness: string, models: readonly SessionModel[]): SessionSettings | undefined {
  const pick = firstPick(defaultsFor(harness)?.work ?? [], models)
  return pick ? { model: pick.model.id, options: pick.options } : undefined
}

/** The model that names Threads and drafts commit messages through this harness, at low reasoning. */
export function lightDefault(harness: string, models: readonly SessionModel[]): HarnessPick | undefined {
  const pick = firstPick(defaultsFor(harness)?.light ?? [], models)
  if (pick) return { model: pick.model, options: { ...lightOptions(pick.model), ...pick.options } }
  const model = lightModel(models)
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

function defaultsFor(harness: string): HarnessDefaults | undefined {
  const known = HARNESS_ORDER.find((entry) => entry === harness)
  return known ? HARNESS_DEFAULTS[known] : undefined
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
