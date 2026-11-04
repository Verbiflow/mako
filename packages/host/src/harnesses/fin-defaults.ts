import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import { SessionSettingsSchema, type SessionSettings } from "@mako/sessions/settings"
import { FinPolicySchema, FinRuleSchema, FinTargetSchema, type FinChoicesReading, type FinDefaults, type FinPolicy } from "../contracts/fin-tuning.js"
import type { MethodTable } from "../base/methods.js"

const HarnessSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
/** One entry a newer Mako wrote in a shape this build doesn't read is left out, never a reason the others aren't. */
const SettingsByHarness = z.record(z.string(), SessionSettingsSchema.optional().catch(undefined))
const StoredSchema = z.object({
  version: z.literal(1),
  chosen: SettingsByHarness.default({}),
  used: SettingsByHarness.default({}),
  /** Each rule read alone: one in a shape a newer Mako wrote is left out, never the others. */
  policy: z
    .object({ rules: z.array(FinRuleSchema.optional().catch(undefined)).catch([]), otherwise: FinTargetSchema.optional().catch(undefined) })
    .default({ rules: [] }),
})
type Stored = { chosen: FinDefaults; used: Record<string, SessionSettings>; policy: FinPolicy }

function kept(entries: Readonly<Record<string, SessionSettings | undefined>>): Record<string, SessionSettings> {
  return Object.fromEntries(Object.entries(entries).filter((entry): entry is [string, SessionSettings] => entry[1] !== undefined))
}

const same = (left: SessionSettings | undefined, right: SessionSettings | undefined) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

/**
 * The person's model choices for Fins, by harness (`contracts/fin-tuning.ts`): what they chose for them in Settings ›
 * Fins, and the model they last started or sent with on each harness themselves, which "what I use" means there. One
 * file in the user root, so every host of this person (the app, its profiles) reads the same, and the web app reads it
 * through this Mac.
 */
export class FinDefaultsStore {
  readonly #file: string
  #stored: Stored = { chosen: {}, used: {}, policy: { rules: [] } }
  #readAt = -1

  constructor(file: string) {
    this.#file = file
  }

  reading(): FinChoicesReading {
    const { chosen, used, policy } = this.#read()
    return { chosen: { ...chosen }, used: { ...used }, policy }
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

  /** The person's rules, whole, as Settings › Fins saved them: in their order, each id once. */
  savePolicy(policy: FinPolicy): FinChoicesReading {
    const parsed = FinPolicySchema.parse(policy)
    const ids = new Set(parsed.rules.map((rule) => rule.id))
    if (ids.size !== parsed.rules.length) throw new Error("Each rule has an id of its own.")
    for (const target of [...parsed.rules.map((rule) => rule.target), ...(parsed.otherwise ? [parsed.otherwise] : [])]) {
      HarnessSchema.parse(target.harness)
      if (target.settings && !target.settings.model) throw new Error("A rule's model is named, or left to what the person uses.")
    }
    const stored = this.#read()
    if (JSON.stringify(stored.policy) !== JSON.stringify(parsed)) this.#write({ ...stored, policy: parsed })
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
      const parsed = StoredSchema.parse(JSON.parse(readFileSync(this.#file, "utf8")))
      const rules = parsed.policy.rules.filter((rule) => rule !== undefined)
      this.#stored = { chosen: kept(parsed.chosen), used: kept(parsed.used), policy: { rules, ...(parsed.policy.otherwise && { otherwise: parsed.policy.otherwise }) } }
    } catch {
      // A file this build can't read is replaced at the next choice; until then Fins run on what the person uses.
    }
    this.#readAt = modified
    return this.#stored
  }

  #write(next: Stored): void {
    this.#stored = next
    mkdirSync(dirname(this.#file), { recursive: true })
    const temporary = `${this.#file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, ...next })}\n`)
    renameSync(temporary, this.#file)
    this.#readAt = statSync(this.#file).mtimeMs
  }
}

/** Settings › Fins on every window and the web app's Macs: read, and chosen. */
export function declareFinDefaultMethods(methods: MethodTable, store: FinDefaultsStore): void {
  methods.handle("mako:fin-defaults", () => store.reading())
  methods.handle("mako:fin-default-choose", (harness: string, settings: SessionSettings | null) => store.choose(harness, settings))
  methods.handle("mako:fin-policy-save", (policy: FinPolicy) => store.savePolicy(policy))
}
