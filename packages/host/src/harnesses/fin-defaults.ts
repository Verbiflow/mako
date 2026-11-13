import { readFileSync, statSync } from "node:fs"
import { publishFileSync } from "../base/published-files.js"
import { z } from "zod"
import { SessionSettingsSchema, type SessionSettings } from "@mako/sessions/settings"
import { FIN_CEILING, FinCeilingSchema, FinLimitSchema, FinPolicySchema, FinRuleSchema, FinTargetSchema, ROLE_RULES_CHARS, type FinCapacityReading, type FinChoicesReading, type FinDefaults, type FinPolicy, type RoleRules } from "../contracts/fin-tuning.js"
import type { MethodTable } from "../base/methods.js"
import type { JsonObject } from "../contracts/json.js"

const HarnessSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
/** One entry a newer Mako wrote in a shape this build doesn't read is left out, never a reason the others aren't. */
const SettingsByHarness = z.record(z.string(), SessionSettingsSchema.optional().catch(undefined))
const RoleRulesText = z.string().trim().max(ROLE_RULES_CHARS)
/** What a newer Mako wrote that this build doesn't read (each device's Fin limit, say), kept as JSON and written back as it was. */
const Unread = z.json()
const StoredSchema = z
  .object({
    version: z.literal(1),
    chosen: SettingsByHarness.default({}),
    used: SettingsByHarness.default({}),
    /** Each rule read alone: one in a shape a newer Mako wrote is left out, never the others. */
    policy: z
      .object({
        rules: z.array(FinRuleSchema.optional().catch(undefined)).catch([]),
        otherwise: FinTargetSchema.optional().catch(undefined),
        forFins: RoleRulesText.optional().catch(undefined),
        forApexes: RoleRulesText.optional().catch(undefined),
      })
      .catchall(Unread)
      .default({ rules: [] }),
    limit: FinLimitSchema.optional().catch(undefined),
    ceiling: FinCeilingSchema.optional().catch(undefined),
    /** Moving across accounts/harnesses requires the person's explicit choice. */
    moveOnLimit: z.boolean().optional().catch(undefined),
  })
  .catchall(Unread)
const ROLES = z.enum(["forFins", "forApexes"]) satisfies z.ZodType<RoleRules>

/** What the file holds: `other` and `policyOther` are the fields beside and in the policy this build doesn't read, so a save here never drops them. */
type Stored = { chosen: FinDefaults; used: Record<string, SessionSettings>; policy: FinPolicy; limit?: number; ceiling?: number; moveOnLimit?: boolean; other: JsonObject; policyOther: JsonObject }

function kept(entries: Readonly<Record<string, SessionSettings | undefined>>): Record<string, SessionSettings> {
  return Object.fromEntries(Object.entries(entries).filter((entry): entry is [string, SessionSettings] => entry[1] !== undefined))
}

/** A policy as kept: an `otherwise` or rules for a role only when there is one, so an empty field reads as none. */
function withoutEmpty({ rules, otherwise, forFins, forApexes }: FinPolicy): FinPolicy {
  return { rules, ...(otherwise && { otherwise }), ...(forFins && { forFins }), ...(forApexes && { forApexes }) }
}

const same = <Value>(left: Value, right: Value) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

/**
 * The person's model choices for Fins, by harness (`contracts/fin-tuning.ts`): what they chose for them in Settings ›
 * Fins, the model they last started or sent with on each harness themselves, which "what I use" means there, and how
 * many Fins run at once on this device (each device keeps its own: the count protects its machine). One
 * file in the user root, so every host of this person (the app, its profiles) reads the same, and the web app reads it
 * through this Mac. Each save changes only what it names and keeps the rest of the file as it was.
 */
export class FinDefaultsStore {
  readonly #file: string
  #stored: Stored = { chosen: {}, used: {}, policy: { rules: [] }, other: {}, policyOther: {} }
  #readAt = -1

  constructor(file: string) {
    this.#file = file
  }

  reading(): FinChoicesReading {
    const { chosen, used, policy, limit, ceiling, moveOnLimit } = this.#read()
    return { chosen: { ...chosen }, used: { ...used }, policy, ...(limit !== undefined && { limit }), ceiling: ceiling ?? FIN_CEILING, moveOnLimit: moveOnLimit ?? false }
  }

  /** The person's own number of Fins at once on this device, or with null, its capacity (Auto). */
  setLimit(limit: number | null): FinChoicesReading {
    const next = limit === null ? undefined : FinLimitSchema.parse(limit)
    const stored = this.#read()
    if (stored.limit !== next) this.#write(withOwn(stored, "limit", next))
    return this.reading()
  }

  /** Whether a Fin whose account runs out goes on to the next step of its order (`contracts/fin-fallback.ts`). */
  chooseMoveOnLimit(on: boolean): FinChoicesReading {
    z.boolean().parse(on)
    const { moveOnLimit, ...stored } = this.#read()
    if (moveOnLimit !== on) this.#write({ ...stored, moveOnLimit: on })
    return this.reading()
  }

  /** Fins at once across every place (`FIN_CEILING`, the default, is kept as none chosen). */
  setCeiling(ceiling: number): FinChoicesReading {
    const parsed = FinCeilingSchema.parse(ceiling)
    const next = parsed === FIN_CEILING ? undefined : parsed
    const stored = this.#read()
    if (stored.ceiling !== next) this.#write(withOwn(stored, "ceiling", next))
    return this.reading()
  }

  /** Fins on `harness` run on `settings`, or with none, on what the person uses there. */
  choose(harness: string, settings: SessionSettings | null): FinChoicesReading {
    HarnessSchema.parse(harness)
    const parsed = settings === null ? undefined : SessionSettingsSchema.parse(settings)
    if (parsed && !parsed.model) throw new Error("A Fins default names a model.")
    const stored = this.#read()
    if (!same(stored.chosen[harness], parsed)) {
      const chosen = { ...stored.chosen }
      if (parsed) chosen[harness] = parsed
      else delete chosen[harness]
      this.#write({ ...stored, chosen })
    }
    return this.reading()
  }

  /**
   * The person's rules for which work goes where, whole, as Settings › Fins saved them: in their order, each id once,
   * and where the rest go. Their standing rules for each role are saved on their own (`saveRoleRules`) and kept here.
   */
  savePolicy(policy: FinPolicy): FinChoicesReading {
    const { rules, otherwise } = FinPolicySchema.parse(policy)
    const ids = new Set(rules.map((rule) => rule.id))
    if (ids.size !== rules.length) throw new Error("Each rule has an id of its own.")
    for (const target of [...rules.map((rule) => rule.target), ...(otherwise ? [otherwise] : [])]) {
      HarnessSchema.parse(target.harness)
      if (target.settings && !target.settings.model) throw new Error("A rule's model is named, or left to what the person uses.")
    }
    const stored = this.#read()
    const next = withoutEmpty({ ...stored.policy, rules, otherwise })
    if (!same(stored.policy, next)) this.#write({ ...stored, policy: next })
    return this.reading()
  }

  /** The person's standing rules for every agent of `role`, in their own words; empty is none. Nothing else changes. */
  saveRoleRules(role: RoleRules, text: string): FinChoicesReading {
    const field = ROLES.parse(role)
    const words = RoleRulesText.parse(text)
    const stored = this.#read()
    const next = withoutEmpty({ ...stored.policy, [field]: words })
    if (!same(stored.policy, next)) this.#write({ ...stored, policy: next })
    return this.reading()
  }

  /** The person started or sent on `harness` with `settings`: what they use there now. */
  use(harness: string, settings: SessionSettings | undefined): void {
    if (!settings?.model || !HarnessSchema.safeParse(harness).success) return
    const stored = this.#read()
    if (same(stored.used[harness], settings)) return
    this.#write({ ...stored, used: { ...stored.used, [harness]: settings } })
  }

  #read(): Stored {
    let modified: number
    try {
      modified = statSync(this.#file).mtimeMs
    } catch {
      return this.#stored
    }
    if (modified === this.#readAt) return this.#stored
    try {
      const { chosen, used, policy, limit, ceiling, moveOnLimit, ...other } = StoredSchema.parse(JSON.parse(readFileSync(this.#file, "utf8")))
      const { rules, otherwise, forFins, forApexes, ...policyOther } = policy
      this.#stored = {
        chosen: kept(chosen),
        used: kept(used),
        policy: withoutEmpty({ rules: rules.filter((rule) => rule !== undefined), otherwise, forFins, forApexes }),
        ...(limit !== undefined && { limit }),
        ...(ceiling !== undefined && { ceiling }),
        ...(moveOnLimit !== undefined && { moveOnLimit }),
        other,
        policyOther,
      }
    } catch {
      // A file this build can't read is replaced at the next choice; until then Fins run on what the person uses.
    }
    this.#readAt = modified
    return this.#stored
  }

  #write(next: Stored): void {
    this.#stored = next
    const { chosen, used, policy, limit, ceiling, moveOnLimit, other, policyOther } = next
    publishFileSync(this.#file, `${JSON.stringify({ ...other, version: 1, chosen, used, policy: { ...policyOther, ...policy }, ...(limit !== undefined && { limit }), ...(ceiling !== undefined && { ceiling }), ...(moveOnLimit !== undefined && { moveOnLimit }) })}\n`)
    this.#readAt = statSync(this.#file).mtimeMs
  }
}

/** `stored` with one of the person's numbers set, or left out for the default. */
function withOwn(stored: Stored, key: "limit" | "ceiling", value: number | undefined): Stored {
  const next: Stored = { ...stored }
  delete next[key]
  if (value !== undefined) next[key] = value
  return next
}

/** Settings › Fins on every window and the web app's Macs: read, with this device's capacity, and chosen. */
export function declareFinDefaultMethods(methods: MethodTable, store: FinDefaultsStore, capacity?: () => FinCapacityReading | undefined, changed?: () => void): void {
  const read = (reading: FinChoicesReading): FinChoicesReading => {
    const held = capacity?.()
    return held ? { ...reading, capacity: held } : reading
  }
  methods.handle("mako:fin-defaults", () => read(store.reading()))
  methods.handle("mako:fin-default-choose", (harness: string, settings: SessionSettings | null) => read(store.choose(harness, settings)))
  methods.handle("mako:fin-policy-save", (policy: FinPolicy) => read(store.savePolicy(policy)))
  methods.handle("mako:fin-role-rules-save", (role: RoleRules, text: string) => read(store.saveRoleRules(role, text)))
  // A number the person raised takes what waits at once.
  methods.handle("mako:fin-limit-set", (limit: number | null) => {
    const reading = read(store.setLimit(limit))
    changed?.()
    return reading
  })
  methods.handle("mako:fin-ceiling-set", (ceiling: number) => {
    const reading = read(store.setCeiling(ceiling))
    changed?.()
    return reading
  })
  methods.handle("mako:fin-move-on-limit", (on: boolean) => read(store.chooseMoveOnLimit(on)))
}
