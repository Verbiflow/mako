import type { CloudFinLimits } from "../contracts/fin-tuning.js"
import { readFileSync, statSync } from "node:fs"
import { publishFileSync } from "../base/published-files.js"
import { z } from "zod"
import { SessionSettingsSchema, type SessionSettings } from "@mako/sessions/settings"
import { FIN_CEILING, FinCeilingSchema, FinDefaultsSchema, FinLimitSchema, FinPolicySchema, FinRuleSchema, FinTargetSchema, ROLE_RULES_CHARS, type FinCapacityReading, type FinChoicesReading, type FinDefaults, type FinPolicy, type RoleRules } from "../contracts/fin-tuning.js"
import type { MethodTable } from "../base/methods.js"
import type { JsonObject } from "../contracts/json.js"
import type { PreferenceName, PreferenceValue } from "../contracts/preferences.js"

/** The preferences that follow the person's account (`PreferenceStore`), as the Fin settings read and change them. */
export interface FinPreferences {
  value<Name extends PreferenceName>(name: Name): PreferenceValue<Name> | undefined
  has(name: PreferenceName): boolean
  /** The person's own edit, made now. */
  change<Name extends PreferenceName>(name: Name, value: PreferenceValue<Name> | null): void
  /** Another program's edit, made at `at`; kept if it's later than the one in effect. */
  edit<Name extends PreferenceName>(name: Name, value: PreferenceValue<Name> | null, at: number): boolean
  offer<Name extends PreferenceName>(name: Name, value: PreferenceValue<Name> | undefined, at: number): void
}

/** The Fin settings that follow the account, as this file keeps them, in the shape `mirror` compares. */
type Synced = { chosen: FinDefaults; rules: Pick<FinPolicy, "rules" | "otherwise">; forFins?: string; forApexes?: string; ceiling?: number; moveOnLimit?: false }

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
    /** Kept only once the person turned "When an account runs out, continue on the next one" off. */
    moveOnLimit: z.literal(false).optional().catch(undefined),
    /**
     * The synced settings as the last mirror wrote them (`FinDefaultsStore.mirror`), by whichever host of this user wrote
     * it. A file whose synced settings still match it is a mirror; one that differs was edited by another program (an
     * older Mako, which keeps this field as it found it).
     */
    preferencesMirror: z.string().optional().catch(undefined),
  })
  .catchall(Unread)
const ROLES = z.enum(["forFins", "forApexes"]) satisfies z.ZodType<RoleRules>

/** What the file holds: `other` and `policyOther` are the fields beside and in the policy this build doesn't read, so a save here never drops them. */
type Stored = { chosen: FinDefaults; used: Record<string, SessionSettings>; policy: FinPolicy; limit?: number; ceiling?: number; moveOnLimit?: false; mirrored?: string; other: JsonObject; policyOther: JsonObject }

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
  readonly #preferences: FinPreferences | undefined
  #stored: Stored = { chosen: {}, used: {}, policy: { rules: [] }, other: {}, policyOther: {} }
  #readAt = -1

  /**
   * With `preferences`, the person's Fin settings follow their account: they're read from it and every change goes to
   * it, and this file only mirrors them (for older builds sharing it) and keeps what's this device's own: its number of
   * Fins at once and the model it last used on each harness.
   */
  constructor(file: string, preferences?: FinPreferences) {
    this.#file = file
    this.#preferences = preferences
  }

  reading(): FinChoicesReading {
    const { used, limit } = this.#read()
    const { chosen, rules, forFins, forApexes, ceiling, moveOnLimit } = this.#synced()
    const policy = withoutEmpty({ ...rules, ...(forFins && { forFins }), ...(forApexes && { forApexes }) })
    return { chosen: { ...chosen }, used: { ...used }, policy, ...(limit !== undefined && { limit }), ceiling: ceiling ?? FIN_CEILING, moveOnLimit: moveOnLimit ?? true }
  }

  /**
   * What this file kept of the synced settings before the account kept them, offered once. When each was chosen isn't
   * known (the file is written whenever the person starts a session, so its time says nothing of them), so each is
   * offered at 0 and only fills what the account holds nothing for (`PreferenceStore.offer`): a choice made since on
   * another Mac is never replaced by an older one kept here.
   */
  offerFromFile(): void {
    const preferences = this.#preferences
    if (!preferences) return
    const at = 0
    const file = this.#fileSynced()
    preferences.offer("fins.chosen", Object.keys(file.chosen).length ? file.chosen : undefined, at)
    preferences.offer("fins.rules", file.rules.rules.length || file.rules.otherwise ? file.rules : undefined, at)
    preferences.offer("fins.forFins", file.forFins, at)
    preferences.offer("fins.forApexes", file.forApexes, at)
    preferences.offer("fins.ceiling", file.ceiling, at)
    preferences.offer("fins.moveOnLimit", file.moveOnLimit === false ? false : undefined, at)
  }

  /**
   * Writes the synced settings in effect into the file, for an older Mako that reads them there, with the settings as
   * written (`preferencesMirror`). Synced settings in the file that no longer match what the last mirror wrote, by any
   * host of this user, were changed by another program (an older Mako, which keeps that field as it found it): that's
   * its edit, made when the file changed, and it goes to the account rather than being written over. A file no mirror
   * wrote yet was offered once (`offerFromFile`), not edited.
   */
  mirror(): void {
    const preferences = this.#preferences
    if (!preferences) return
    const stored = this.#read()
    const file = this.#fileSynced()
    const said = JSON.stringify(file)
    if (stored.mirrored !== undefined && said !== stored.mirrored) {
      const at = this.#modified() ?? Date.now()
      const before = parseSynced(stored.mirrored)
      if (before) {
        let edited = false
        if (JSON.stringify(file.chosen) !== JSON.stringify(before.chosen)) edited = preferences.edit("fins.chosen", file.chosen, at) || edited
        if (JSON.stringify(file.rules) !== JSON.stringify(before.rules)) edited = preferences.edit("fins.rules", file.rules, at) || edited
        if (file.forFins !== before.forFins) edited = preferences.edit("fins.forFins", file.forFins ?? null, at) || edited
        if (file.forApexes !== before.forApexes) edited = preferences.edit("fins.forApexes", file.forApexes ?? null, at) || edited
        if (file.ceiling !== before.ceiling) edited = preferences.edit("fins.ceiling", file.ceiling ?? null, at) || edited
        if (file.moveOnLimit !== before.moveOnLimit) edited = preferences.edit("fins.moveOnLimit", file.moveOnLimit ?? null, at) || edited
        // The edits are in effect now, and announced: the next mirror writes what's in effect, theirs included.
        if (edited) return
      }
    }
    const want = this.#synced()
    const wanted = JSON.stringify(want)
    if (wanted === said && stored.mirrored === wanted) return
    const next: Stored = { ...stored }
    delete next.ceiling
    delete next.moveOnLimit
    const { forFins, forApexes } = want
    this.#write({ ...next, chosen: want.chosen, policy: withoutEmpty({ ...want.rules, ...(forFins && { forFins }), ...(forApexes && { forApexes }) }), ...withOwnSynced(want), mirrored: wanted })
  }

  /** The synced settings in effect: the account's where it holds them, else what this file keeps. */
  #synced(): Synced {
    const file = this.#fileSynced()
    const preferences = this.#preferences
    if (!preferences) return file
    const pick = <Name extends PreferenceName>(name: Name, kept: PreferenceValue<Name> | undefined): PreferenceValue<Name> | undefined => (preferences.has(name) ? preferences.value(name) : kept)
    const forFins = pick("fins.forFins", file.forFins)
    const forApexes = pick("fins.forApexes", file.forApexes)
    const ceiling = pick("fins.ceiling", file.ceiling)
    return {
      chosen: pick("fins.chosen", file.chosen) ?? {},
      rules: pick("fins.rules", file.rules) ?? { rules: [] },
      ...(forFins && { forFins }),
      ...(forApexes && { forApexes }),
      ...(ceiling !== undefined && ceiling !== FIN_CEILING && { ceiling }),
      ...(pick("fins.moveOnLimit", file.moveOnLimit) === false && { moveOnLimit: false as const }),
    }
  }

  /** The synced settings as this file keeps them. */
  #fileSynced(): Synced {
    const { chosen, policy, ceiling, moveOnLimit } = this.#read()
    const { rules, otherwise, forFins, forApexes } = policy
    return { chosen, rules: { rules, ...(otherwise && { otherwise }) }, ...(forFins && { forFins }), ...(forApexes && { forApexes }), ...(ceiling !== undefined && { ceiling }), ...(moveOnLimit === false && { moveOnLimit }) }
  }

  #modified(): number | undefined {
    try {
      return statSync(this.#file).mtimeMs
    } catch {
      return undefined
    }
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
    if (this.#preferences) {
      if (this.reading().moveOnLimit !== on) this.#preferences.change("fins.moveOnLimit", on ? null : false)
      return this.reading()
    }
    const { moveOnLimit, ...stored } = this.#read()
    if ((moveOnLimit ?? true) !== on) this.#write(on ? stored : { ...stored, moveOnLimit: false })
    return this.reading()
  }

  /** Fins at once across every place (`FIN_CEILING`, the default, is kept as none chosen). */
  setCeiling(ceiling: number): FinChoicesReading {
    const parsed = FinCeilingSchema.parse(ceiling)
    const next = parsed === FIN_CEILING ? undefined : parsed
    if (this.#preferences) {
      if (this.#synced().ceiling !== next) this.#preferences.change("fins.ceiling", next ?? null)
      return this.reading()
    }
    const stored = this.#read()
    if (stored.ceiling !== next) this.#write(withOwn(stored, "ceiling", next))
    return this.reading()
  }

  /** Fins on `harness` run on `settings`, or with none, on what the person uses there. */
  choose(harness: string, settings: SessionSettings | null): FinChoicesReading {
    HarnessSchema.parse(harness)
    const parsed = settings === null ? undefined : SessionSettingsSchema.parse(settings)
    if (parsed && !parsed.model) throw new Error("A Fins default names a model.")
    if (this.#preferences) {
      const before = this.#synced().chosen
      if (!same(before[harness], parsed)) {
        const chosen = { ...before }
        if (parsed) chosen[harness] = parsed
        else delete chosen[harness]
        this.#preferences.change("fins.chosen", Object.keys(chosen).length ? chosen : null)
      }
      return this.reading()
    }
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
    if (this.#preferences) {
      const next = { rules, ...(otherwise && { otherwise }) }
      if (!same(this.#synced().rules, next)) this.#preferences.change("fins.rules", next.rules.length || next.otherwise ? next : null)
      return this.reading()
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
    if (this.#preferences) {
      const name = field === "forFins" ? "fins.forFins" : "fins.forApexes"
      if ((this.#synced()[field] ?? "") !== words) this.#preferences.change(name, words || null)
      return this.reading()
    }
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
      const { chosen, used, policy, limit, ceiling, moveOnLimit, preferencesMirror, ...other } = StoredSchema.parse(JSON.parse(readFileSync(this.#file, "utf8")))
      const { rules, otherwise, forFins, forApexes, ...policyOther } = policy
      this.#stored = {
        chosen: kept(chosen),
        used: kept(used),
        policy: withoutEmpty({ rules: rules.filter((rule) => rule !== undefined), otherwise, forFins, forApexes }),
        ...(limit !== undefined && { limit }),
        ...(ceiling !== undefined && { ceiling }),
        ...(moveOnLimit === false && { moveOnLimit }),
        ...(preferencesMirror !== undefined && { mirrored: preferencesMirror }),
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
    const { chosen, used, policy, limit, ceiling, moveOnLimit, mirrored, other, policyOther } = next
    publishFileSync(this.#file, `${JSON.stringify({ ...other, version: 1, chosen, used, policy: { ...policyOther, ...policy }, ...(limit !== undefined && { limit }), ...(ceiling !== undefined && { ceiling }), ...(moveOnLimit === false && { moveOnLimit }), ...(mirrored !== undefined && { preferencesMirror: mirrored }) })}\n`)
    this.#readAt = statSync(this.#file).mtimeMs
  }
}

const SyncedSchema = z.object({
  chosen: FinDefaultsSchema.catch({}),
  rules: z.object({ rules: z.array(FinRuleSchema).catch([]), otherwise: FinTargetSchema.optional().catch(undefined) }).catch({ rules: [] }),
  forFins: z.string().optional().catch(undefined),
  forApexes: z.string().optional().catch(undefined),
  ceiling: z.number().optional().catch(undefined),
  moveOnLimit: z.literal(false).optional().catch(undefined),
})

/** The synced settings a mirror wrote (`preferencesMirror`), or undefined for a mark this build can't read. */
function parseSynced(text: string): Synced | undefined {
  try {
    const parsed = SyncedSchema.parse(JSON.parse(text))
    const { rules } = parsed
    return {
      chosen: parsed.chosen,
      rules: { rules: rules.rules, ...(rules.otherwise && { otherwise: rules.otherwise }) },
      ...(parsed.forFins !== undefined && { forFins: parsed.forFins }),
      ...(parsed.forApexes !== undefined && { forApexes: parsed.forApexes }),
      ...(parsed.ceiling !== undefined && { ceiling: parsed.ceiling }),
      ...(parsed.moveOnLimit === false && { moveOnLimit: false as const }),
    }
  } catch {
    return undefined
  }
}

/** The synced numbers of `want` as the file keeps them: each only when it isn't the default. */
function withOwnSynced(want: Synced): Pick<Stored, "ceiling" | "moveOnLimit"> {
  return { ...(want.ceiling !== undefined && { ceiling: want.ceiling }), ...(want.moveOnLimit === false && { moveOnLimit: false }) }
}

/** `stored` with one of the person's numbers set, or left out for the default. */
function withOwn(stored: Stored, key: "limit" | "ceiling", value: number | undefined): Stored {
  const next: Stored = { ...stored }
  delete next[key]
  if (value !== undefined) next[key] = value
  return next
}

/** Settings › Fins on every window and the web app's Macs: read, with this device's capacity, and chosen. */
export function declareFinDefaultMethods(methods: MethodTable, store: FinDefaultsStore, capacity?: () => FinCapacityReading | undefined, changed?: () => void, cloud?: { reading(): CloudFinLimits }): void {
  const read = (reading: FinChoicesReading): FinChoicesReading => {
    const held = capacity?.()
    return { ...reading, ...(held && { capacity: held }), ...(cloud && { cloud: cloud.reading() }) }
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
