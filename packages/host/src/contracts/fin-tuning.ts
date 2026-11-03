import { z } from "zod"
import {
  modelByIdentity,
  optionAccepts,
  optionDefault,
  SessionSettingsSchema,
  settingsWithVariant,
  type ModelOption,
  type SessionModel,
  type SessionSettings,
  type SettingValue,
} from "@mako/sessions/settings"

/**
 * What a Fin runs on, decided once as it starts and the same on every harness.
 *
 * Without a model named, a Fin runs on what the person uses: their own choice
 * for Fins on that harness (Settings › Fins), else its Apex's model and
 * options when it shares the Apex's harness, else the model they last chose
 * there themselves, else Mako's pick for the harness (`HarnessDefaults.work`),
 * and only then the harness's own default. A layer whose model the harness no
 * longer lists, or can't start, is passed over with a note the Apex and the
 * Fin's row both show.
 *
 * Named by the Apex or an outside caller (`agents_start`, `mako agents start`),
 * the model, reasoning and fast lane are each held to the harness's catalog,
 * leniently read ("opus 5.5", "extra high"), and a choice it doesn't offer is
 * refused with the ones it does. Reasoning and fast named without a model
 * apply to whichever model the layers chose.
 */

/** The person's choice of model and options for Fins on each harness; a harness without one runs Fins on what they use. */
export const FinDefaultsSchema = z.record(z.string().min(1).max(64), SessionSettingsSchema)
export type FinDefaults = z.infer<typeof FinDefaultsSchema>

/** What the host keeps of the person's model choices for Fins (`mako:fin-defaults`). */
export interface FinChoicesReading {
  /** Settings › Fins, by harness. */
  chosen: FinDefaults
  /** The model and options the person last started or sent with on each harness, as "what I use" there. */
  used: Readonly<Record<string, SessionSettings>>
}

/** Where a Fin's model came from, most specific first. */
export const FinTuningSourceSchema = z.enum(["asked", "fins", "apex", "used", "mako", "harness"])
export type FinTuningSource = z.infer<typeof FinTuningSourceSchema>

/** What a spawn named, as the person said it through its Apex. */
export interface FinAsked {
  model?: string
  reasoning?: string
  /** True for the model's fast lane or its fast sibling, false for its standard one. */
  fast?: boolean
}

export interface FinTuningInput {
  /** The harness's name as the person reads it. */
  label: string
  /** Its catalog; empty while it hasn't been read, when nothing can be held to it. */
  models: readonly SessionModel[]
  asked: FinAsked
  /** Settings › Fins for this harness. */
  chosen?: SessionSettings
  /** The Apex's model now, when the Fin runs on the Apex's harness. */
  apex?: SessionSettings
  /** The person's last model on this harness. */
  used?: SessionSettings
  /** Mako's pick for the harness. */
  recommended?: SessionSettings
}

export type FinTuning =
  | { settings?: SessionSettings; source: FinTuningSource; notes: string[] }
  | { refused: string }

/** What a Fin runs on in words: its model's label, its reasoning level's and whether it's on the fast lane. */
export interface FinTuningWords {
  model: string
  reasoning?: string
  fast?: true
}

const LIST_LIMIT = 30

export function resolveFinTuning(input: FinTuningInput): FinTuning {
  const { models, asked, label } = input
  const notes: string[] = []
  let base: { model: SessionModel | undefined; settings: SessionSettings; source: FinTuningSource } | undefined
  if (asked.model) {
    const found = findModel(models, asked.model)
    if ("refused" in found) return { refused: `${label} ${found.refused}` }
    if (found.model?.unavailable) return { refused: `${label} lists ${found.model.label} but can't start it: ${found.model.unavailable}` }
    base = { model: found.model, settings: found.model ? { model: found.model.id } : { model: asked.model }, source: "asked" }
  } else {
    const layers: [FinTuningSource, SessionSettings | undefined, string][] = [
      ["fins", input.chosen, `Your Fins default for ${label}`],
      ["apex", input.apex, "Your Apex's model"],
      ["used", input.used, `Your last model on ${label}`],
      ["mako", input.recommended, `Mako's pick for ${label}`],
    ]
    for (const [source, settings, who] of layers) {
      if (!settings?.model) continue
      const expanded = settingsWithVariant(models, settings)
      const model = modelByIdentity(models, expanded.model)
      if (models.length && (!model || model.unavailable)) {
        notes.push(`${who}, ${model?.label ?? settings.model}, ${model ? `can't start (${model.unavailable})` : `isn't listed by ${label} anymore`}`)
        continue
      }
      base = { model, settings: { model: model?.id ?? settings.model, ...carried(model, expanded.options) }, source }
      break
    }
  }
  if (!base) {
    if (asked.reasoning || asked.fast !== undefined)
      return { refused: `${label} names no model to set ${asked.reasoning ? "reasoning" : "speed"} on: name one.${choices(models)}` }
    return { source: "harness", notes: notes.length ? [`${notes.join("; ")}: it runs on ${label}'s own default.`] : [] }
  }
  let { model, settings } = base
  if (asked.fast !== undefined && model) {
    const sped = withSpeed(models, model, settings, asked.fast, label)
    if ("refused" in sped) return sped
    ;({ model, settings } = sped)
  } else if (asked.fast !== undefined && !models.length) {
    return { refused: `${label}'s models haven't been read here yet, so its fast lane can't be told apart: leave fast out, or try again in a moment.` }
  }
  if (asked.reasoning) {
    if (!model) settings = { ...settings, options: { ...settings.options, effort: asked.reasoning } }
    else {
      const option = model.options.find((each) => each.role === "reasoning" && !each.disabledReason)
      if (!option) return { refused: `${model.label} on ${label} has no reasoning levels: leave reasoning out, or name a model that has them.${reasoningChoices(models)}` }
      const value = findValue(option, asked.reasoning)
      if (value === undefined) return { refused: `${model.label} on ${label} takes reasoning ${valueList(option)}, not ${asked.reasoning}.` }
      settings = { ...settings, options: { ...settings.options, [option.id]: value } }
    }
  }
  const words = model ? finTuningWords(models, settings) : undefined
  return {
    settings,
    source: base.source,
    notes: notes.length ? [`${notes.join("; ")}: it runs on ${words?.model ?? settings.model} instead.`] : [],
  }
}

/** A Fin's model and options as the person reads them, from its harness's catalog; undefined for a model it doesn't list. */
export function finTuningWords(models: readonly SessionModel[], settings: SessionSettings | undefined): FinTuningWords | undefined {
  if (!settings?.model) return undefined
  const expanded = settingsWithVariant(models, settings)
  const model = modelByIdentity(models, expanded.model)
  if (!model) return undefined
  const words: FinTuningWords = { model: model.label }
  const value = (option: ModelOption) => expanded.options?.[option.id] ?? optionDefault(option)
  const reasoning = model.options.find((option) => option.role === "reasoning")
  const level = reasoning && value(reasoning)
  if (reasoning && level !== undefined) words.reasoning = choiceLabel(reasoning, level)
  const speed = model.options.find((option) => option.role === "speed")
  if (speed && isOn(speed, value(speed))) words.fast = true
  return words
}

/** "Opus 5.5 · High · Fast": a Fin's words in one line. */
export function finTuningLine(words: FinTuningWords): string {
  return [words.model, words.reasoning, words.fast && "Fast"].filter(Boolean).join(" · ")
}

/** The options a layer carries onto `model`: those it offers and accepts, never a plan mode, which is its Apex's own. */
function carried(model: SessionModel | undefined, options: SessionSettings["options"]): Pick<SessionSettings, "options"> {
  if (!options) return {}
  if (!model) return { options }
  const kept: Record<string, SettingValue> = {}
  for (const [id, value] of Object.entries(options)) {
    const option = model.options.find((each) => each.id === id)
    if (option && option.role !== "plan" && !option.disabledReason && optionAccepts(option, value)) kept[id] = value
  }
  return Object.keys(kept).length ? { options: kept } : {}
}

const squash = (text: string) => text.toLowerCase().replace(/[\s._\-/:()[\]]+/g, "")

/** A model by id, alias or variant, then by its id or label in any case or spacing, then by the one label it ends or holds. */
function findModel(models: readonly SessionModel[], asked: string): { model: SessionModel | undefined } | { refused: string } {
  if (!models.length) return { model: undefined }
  const exact = modelByIdentity(models, asked)
  if (exact) return { model: exact }
  const want = squash(asked)
  const same = models.filter((model) => squash(model.id) === want || squash(model.label) === want)
  if (same.length === 1) return { model: same[0] }
  for (const fits of [(text: string) => text.endsWith(want), (text: string) => text.includes(want)]) {
    const found = models.filter((model) => fits(squash(model.label)) || fits(squash(model.id)))
    if (found.length === 1) return { model: found[0] }
    if (found.length > 1) return { refused: `has several models for "${asked}": ${found.slice(0, LIST_LIMIT).map(modelWords).join(", ")}. Name one.` }
  }
  return { refused: `has no model "${asked}".${choices(models)}` }
}

function modelWords(model: SessionModel): string {
  return model.label === model.id ? model.id : `${model.label} (${model.id})`
}

function choices(models: readonly SessionModel[]): string {
  const offered = models.filter((model) => !model.unavailable)
  if (!offered.length) return ""
  const more = offered.length - LIST_LIMIT
  return ` Its models: ${offered.slice(0, LIST_LIMIT).map(modelWords).join(", ")}${more > 0 ? `, and ${more} more` : ""}.`
}

function reasoningChoices(models: readonly SessionModel[]): string {
  const levelled = models.flatMap((model) => {
    const option = !model.unavailable && model.options.find((each) => each.role === "reasoning" && !each.disabledReason)
    return option ? [`${model.label} (${valueList(option)})`] : []
  })
  return levelled.length ? ` Those that do: ${levelled.slice(0, LIST_LIMIT).join("; ")}.` : ""
}

/** Spellings people use for the same level, each to the catalog's own. */
const LEVEL_WORDS = new Map([
  ["extrahigh", "xhigh"], ["xhigh", "extrahigh"], ["veryhigh", "xhigh"], ["maximum", "max"], ["max", "maximum"], ["med", "medium"], ["mid", "medium"], ["min", "minimal"], ["off", "none"], ["lowest", "low"], ["highest", "max"],
])

function findValue(option: ModelOption, asked: string): SettingValue | undefined {
  if (option.kind === "boolean") return /^(on|true|yes)$/i.test(asked) ? true : /^(off|false|no)$/i.test(asked) ? false : undefined
  const wants = [squash(asked), LEVEL_WORDS.get(squash(asked))].filter(Boolean)
  return option.values.find((choice) => [choice.value, choice.label, ...(choice.aliases ?? [])].some((spelled) => wants.includes(squash(spelled))))?.value
}

function valueList(option: ModelOption): string {
  if (option.kind === "boolean") return "on or off"
  const values = option.values.map((choice) => choice.value)
  return values.length > 1 ? `${values.slice(0, -1).join(", ")} or ${values.at(-1)}` : (values[0] ?? "nothing")
}

function choiceLabel(option: ModelOption, value: SettingValue): string {
  if (option.kind === "boolean") return value === true ? "On" : "Off"
  return option.values.find((choice) => choice.value === value)?.label ?? String(value)
}

function isOn(option: ModelOption, value: SettingValue | undefined): boolean {
  if (value === undefined) return false
  if (option.kind === "boolean") return value === true
  if (option.booleanValues) return option.booleanValues.on === value
  return /fast|priority/i.test(String(value))
}

/** The value of a speed option that puts its model on the fast lane, or takes it off. */
function speedValue(option: ModelOption, fast: boolean): SettingValue | undefined {
  if (option.kind === "boolean") return fast
  if (option.booleanValues) return fast ? option.booleanValues.on : option.booleanValues.off
  const on = option.values.find((choice) => /fast|priority/i.test(choice.value))
  if (fast) return on?.value
  return option.values.find((choice) => choice !== on && (choice.default || /default|standard|off|normal/i.test(choice.value)))?.value
    ?? option.values.find((choice) => choice !== on)?.value
}

/** A model the harness lists as another's fast sibling: Grok's `grok-4.7-build-fast`, Devin's `swe-1.6-fast`. */
function fastSibling(models: readonly SessionModel[], model: SessionModel): SessionModel | undefined {
  return models.find((each) => each !== model && !each.unavailable && each.id.startsWith(`${model.id}-`) && /fast/i.test(each.id.slice(model.id.length)))
}

/** The model a fast sibling is the fast one of. */
function standardSibling(models: readonly SessionModel[], model: SessionModel): SessionModel | undefined {
  return models
    .filter((each) => each !== model && !each.unavailable && model.id.startsWith(`${each.id}-`) && /fast/i.test(model.id.slice(each.id.length)))
    .sort((left, right) => right.id.length - left.id.length)[0]
}

function withSpeed(
  models: readonly SessionModel[],
  model: SessionModel,
  settings: SessionSettings,
  fast: boolean,
  label: string
): { model: SessionModel; settings: SessionSettings } | { refused: string } {
  const to = (sibling: SessionModel) => ({ model: sibling, settings: { model: sibling.id, ...carried(sibling, settings.options) } })
  // A fast model of its own is left for its standard one, even where it lists a fast option too (Devin's SWE-1.6 Fast).
  const standard = standardSibling(models, model)
  if (!fast && standard) return to(standard)
  const option = model.options.find((each) => each.role === "speed")
  if (option && !option.disabledReason) {
    const value = speedValue(option, fast)
    if (value !== undefined) return { model, settings: { ...settings, options: { ...settings.options, [option.id]: value } } }
  }
  const sibling = fast ? fastSibling(models, model) : undefined
  if (sibling) return to(sibling)
  if (!fast || standard) return { model, settings }
  const lanes = models.filter((each) => !each.unavailable && (each.options.some((entry) => entry.role === "speed" && !entry.disabledReason) || standardSibling(models, each)))
  return {
    refused: `${model.label} on ${label} has no fast lane: leave fast out, or name a model that has one.${lanes.length ? ` Those that do: ${lanes.slice(0, LIST_LIMIT).map(modelWords).join(", ")}.` : ` No ${label} model has one.`}`,
  }
}
