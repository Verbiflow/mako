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

/** The most rules a person keeps, and the longest one: what every Apex reads must stay short. */
export const FIN_RULES_LIMIT = 12
export const FIN_RULE_CHARS = 280

/** Where a rule sends a Fin: a harness, and the model and options to run it on there, or what the person uses there. */
export const FinTargetSchema = z.object({ harness: z.string().min(1).max(64), settings: SessionSettingsSchema.optional() })
export type FinTarget = z.infer<typeof FinTargetSchema>

/** One of the person's rules, in their own words: work like `when` goes to `target`. */
export const FinRuleSchema = z.object({
  id: z.string().min(1).max(64),
  when: z.string().trim().min(1).max(FIN_RULE_CHARS),
  target: FinTargetSchema,
})
export type FinRule = z.infer<typeof FinRuleSchema>

/** The longest standing rules a person writes for one role: every agent of that role reads them whole. */
export const ROLE_RULES_CHARS = 2000

/**
 * How the person wants an Apex to pick its Fins' harness and model (Settings › Fins): rules in their own words, first
 * fit wins, read by every Apex as it starts a Fin and named on the Fin it chose, and where the rest go (`otherwise`;
 * absent, the Apex's own harness). `forFins` and `forApexes` are their standing rules for every agent of each role, in
 * their own words; absent or empty, there are none.
 */
export const FinPolicySchema = z.object({
  rules: z.array(FinRuleSchema).max(FIN_RULES_LIMIT),
  otherwise: FinTargetSchema.optional(),
  forFins: z.string().trim().max(ROLE_RULES_CHARS).optional(),
  forApexes: z.string().trim().max(ROLE_RULES_CHARS).optional(),
})
export type FinPolicy = z.infer<typeof FinPolicySchema>

/** The person's standing rules for one role, as `FinPolicy` keeps them. */
export type RoleRules = "forFins" | "forApexes"

/**
 * The names of the person's standing rules among the standing lines of Mako's note (`standingLines`): each said whole
 * to a new process, then again only when it changes, and forgotten when the harness compacts or rewinds its history.
 */
export const ROLE_RULE_LINES = { forFins: "fin-rules", forApexes: "apex-rules" } as const satisfies Record<RoleRules, string>

const HEADS = { forFins: "The person's rules for every Fin:", forApexes: "The person's rules for you as an Apex:" } as const satisfies Record<RoleRules, string>
const NONE = {
  forFins: "The person has no rules for every Fin now: any they gave you before no longer apply.",
  forApexes: "The person has no rules for you as an Apex now: any they gave you before no longer apply.",
} as const satisfies Record<RoleRules, string>

/** Each role's standing line, by its name (`ROLE_RULE_LINES`); undefined where there's nothing to say. */
export type RoleRuleLines = { [Role in RoleRules as (typeof ROLE_RULE_LINES)[Role]]?: string }

/** Who reads a role's standing rules: a Fin the Fin rules, and the Apex rules any Thread that is or may become an Apex. */
export interface RuleReader {
  fin: boolean
  apex: boolean
  /** The rule lines (`ROLE_RULE_LINES`) the conversation's history ever carried: a line it read stays, to say the rules went. */
  read: ReadonlySet<string>
}

/**
 * The person's standing rules as standing lines of Mako's note, by name: each under its head, or once the conversation
 * read some and the person cleared them, the line that says they no longer apply. A line a reader doesn't take, or has
 * nothing to say, is undefined, so a person who never wrote any rules changes no note.
 */
export function roleRuleLines(policy: Pick<FinPolicy, RoleRules> | undefined, reader: RuleReader): RoleRuleLines {
  const line = (role: RoleRules, takes: boolean): string | undefined => {
    if (!takes) return undefined
    const text = policy?.[role]?.trim()
    if (text) return `${HEADS[role]}\n${text}`
    return reader.read.has(ROLE_RULE_LINES[role]) ? NONE[role] : undefined
  }
  return { [ROLE_RULE_LINES.forFins]: line("forFins", reader.fin), [ROLE_RULE_LINES.forApexes]: line("forApexes", reader.apex) }
}

/**
 * What the person's rules add to Mako's note for a new agent of `role`, as Settings previews it on every device: its
 * standing line (`roleRuleLines`), and for an Apex the rules for which work goes where (`finPolicyNote`). Empty when
 * they add nothing.
 */
export function roleRulesPreview(role: RoleRules, policy: FinPolicy, target: (target: FinTarget) => string): string[] {
  const fin = role === "forFins"
  const lines = Object.values(roleRuleLines(policy, { fin, apex: !fin, read: new Set() })).filter((line) => line !== undefined)
  return fin ? lines : [...lines, ...finPolicyNote(policy, target)]
}

/**
 * How many of the person's Fins run at once on one device, every tree's: its capacity, from its hardware and what a
 * Fin costs there (`fin-capacity.ts`), unless they fix a number for it (Settings › Fins), at most `FIN_LIMIT_MAX`.
 * The count protects that machine, so each device keeps its own. `FIN_LIMIT` is a host's without a capacity reading.
 * A start past it is refused unless its Apex asks it to wait (`agents_start` `queue`).
 */
export const FIN_LIMIT = 16
export const FIN_LIMIT_MAX = 64
export const FinLimitSchema = z.number().int().min(1).max(FIN_LIMIT_MAX)
/** The person's Fins at work across every place at once: a safety net over the places' own bounds, generous by default. */
export const FIN_CEILING = 64
export const FIN_CEILING_MAX = 500
export const FinCeilingSchema = z.number().int().min(1).max(FIN_CEILING_MAX)

/** A device's capacity as Settings › Fins shows it: the number in force, the one it computed, and what it's based on. */
export interface FinCapacityReading {
  /** In force now: the person's own number, else the computed one as pressure allows. */
  atOnce: number
  /** What the hardware and the cost of a Fin here give. */
  auto: number
  /** "14 cores, 36 GB · a Fin ≈ 0.35 core, 0.8 GB · room for 1 build". */
  why: string
  /** Why it's lower than `auto` now: "14 now, not 17: memory pressure for 6 min". */
  pressure?: string
  /** False while it's still on the measured defaults, before this machine read enough of its own Fins. */
  measured: boolean
  /** What this device runs now for another place's Threads, each in a Fin's place: "an iOS simulator for a cloud Thread". */
  lent?: string[]
}

/**
 * What bounds the cloud's Fins: each runs on a machine of its own, so no device's count does, only the person's plan
 * (how many at once) and the daily spend ceiling they set. Absent, either one holds nothing.
 */
export interface CloudFinLimits {
  atOnce?: number
  dailySpendCents?: number
  spentTodayCents?: number
}

/** What a place's Fins at once are held to: a device's own count, or the cloud's plan and spend. */
export type FinPlaceLimit = { place: "device"; atOnce: number } | ({ place: "cloud" } & CloudFinLimits)

/** The cloud's bounds as Settings › Fins says them: "8 at once · $20.00 a day", or "By your plan". */
export function cloudWords(limits: CloudFinLimits): string {
  const parts = [...limits.atOnce !== undefined ? [`${limits.atOnce} at once`] : [], ...limits.dailySpendCents !== undefined ? [`$${(limits.dailySpendCents / 100).toFixed(2)} a day`] : []]
  return parts.length ? parts.join(" · ") : "By your plan"
}

/** Why a place takes no more Fins now, in the words a refused start or a queued one says; undefined while it has room. */
export function placeFull(limit: FinPlaceLimit, working: number): string | undefined {
  if (limit.place === "device") return working >= limit.atOnce ? `${working} of the ${limit.atOnce} Fins this device runs at once are at work` : undefined
  if (limit.atOnce !== undefined && working >= limit.atOnce) return `${working} of the ${limit.atOnce} cloud Fins the person's plan runs at once are at work`
  if (limit.dailySpendCents !== undefined && (limit.spentTodayCents ?? 0) >= limit.dailySpendCents)
    return `today's cloud spend reached the person's ceiling of $${(limit.dailySpendCents / 100).toFixed(2)}`
  return undefined
}

/** What the host keeps of the person's model choices for Fins (`mako:fin-defaults`). */
export interface FinChoicesReading {
  /** Settings › Fins, by harness. */
  chosen: FinDefaults
  /** The model and options the person last started or sent with on each harness, as "what I use" there. */
  used: Readonly<Record<string, SessionSettings>>
  /** The person's rules for which work goes where. */
  policy: FinPolicy
  /** The person's own number of Fins at once for this device; absent: its capacity (Auto). */
  limit?: number
  /** This device's capacity; absent from a host before it. */
  capacity?: FinCapacityReading
  /** The person's Fins at once across every place (`FIN_CEILING` unless they set another); absent from a host before it. */
  ceiling?: number
  /** The cloud's, once Fins start there: by the person's plan and spend ceiling, never this device's count. */
  cloud?: CloudFinLimits
  /**
   * "When an account runs out, continue on the next one" (`contracts/fin-fallback.ts`): on unless the person turned
   * it off, which keeps a Fin where it is when its account runs out, as before.
   */
  moveOnLimit: boolean
}

/**
 * The rules as an Apex reads them, ahead of the person's message when they're new to it: one short line each,
 * numbered as `agents_start`'s `rule` names them. Empty without rules or an `otherwise`.
 */
export function finPolicyNote(policy: FinPolicy, target: (target: FinTarget) => string): string[] {
  if (!policy.rules.length && !policy.otherwise) return []
  return [
    "The person's rules for picking a Fin's harness and model, first fit wins. Pass its number as agents_start's rule, and leave harness, model, reasoning and fast out unless the person named them:",
    ...policy.rules.map((rule, index) => `${index + 1}. ${oneLine(rule.when)} → ${target(rule.target)}`),
    policy.otherwise ? `None fits: ${target(policy.otherwise)} (leave rule out).` : "None fits: your own harness (leave rule out).",
  ]
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

/** Where a Fin's model came from, most specific first; `connection` is a connection's model its harness's account ran out for. */
export const FinTuningSourceSchema = z.enum(["asked", "rule", "fins", "apex", "used", "mako", "harness", "connection"])
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
  /** The person's rule the Apex followed, or their `otherwise`, on this harness: who it is in a note, and its model. */
  rule?: { who: string; settings: SessionSettings }
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
      ["rule", input.rule?.settings, input.rule?.who ?? "Your rule"],
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
