import { z } from "zod"
import { FinCeilingSchema, FinDefaultsSchema, FinRuleSchema, FinTargetSchema, ROLE_RULES_CHARS, FIN_RULES_LIMIT } from "./fin-tuning.js"
import type { JsonValue } from "./json.js"

/**
 * The preferences that follow the person's account (`@mako/protocol/preferences`), and the value each holds. The
 * account keeps them as JSON and never reads them; these schemas are what every surface reads them by. A value this
 * build can't read (a newer Mako's, say) is read as none, never as an error, and never written over unread.
 *
 * Each device keeps the rest for itself: its own number of Fins at once, the model it last used on each harness, its
 * keyboard, editor, layout and the like.
 */
export const PREFERENCE_SCHEMAS = {
  /** The look on every surface: the system's, or one of Mako's two. */
  theme: z.enum(["system", "light", "dark"]),
  /** Settings › Fins, by harness: what Fins on each run on. */
  "fins.chosen": FinDefaultsSchema,
  /** The person's rules for which work goes where, in their order, and where the rest go. */
  "fins.rules": z.object({ rules: z.array(FinRuleSchema).max(FIN_RULES_LIMIT), otherwise: FinTargetSchema.optional() }),
  /** Standing rules for every Fin, and for every Apex, in the person's own words. */
  "fins.forFins": z.string().trim().max(ROLE_RULES_CHARS),
  "fins.forApexes": z.string().trim().max(ROLE_RULES_CHARS),
  /** Fins at once across every place. */
  "fins.ceiling": FinCeilingSchema,
  /** "When an account runs out, continue on the next one". */
  "fins.moveOnLimit": z.boolean(),
  /** The person's harness order, most preferred first. */
  harnessOrder: z.array(z.string().min(1).max(64)).max(32),
} as const

export type PreferenceName = keyof typeof PREFERENCE_SCHEMAS
export type PreferenceValue<Name extends PreferenceName> = z.infer<(typeof PREFERENCE_SCHEMAS)[Name]>
export const PREFERENCE_NAMES: readonly PreferenceName[] = Object.keys(PREFERENCE_SCHEMAS).filter(isPreferenceName)

/** Whether `key` names a preference this build reads. */
export function isPreferenceName(key: string): key is PreferenceName {
  return Object.hasOwn(PREFERENCE_SCHEMAS, key)
}

/** `value` as `name` holds it, or undefined for none and for a value this build can't read. */
export function readPreference<Name extends PreferenceName>(name: Name, value: JsonValue | null | undefined): PreferenceValue<Name> | undefined {
  if (value === null || value === undefined) return undefined
  const parsed = PREFERENCE_SCHEMAS[name].safeParse(value)
  // SAFETY: `PREFERENCE_SCHEMAS[name]` parses exactly `PreferenceValue<Name>`; TypeScript can't narrow the indexed schema.
  return parsed.success ? (parsed.data as PreferenceValue<Name>) : undefined
}

/** The preferences in effect, by name: each the person's value, or absent for Mako's default. */
export type PreferenceValues = { [Name in PreferenceName]?: PreferenceValue<Name> }
