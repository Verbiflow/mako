import { laterEdit, PREFERENCES_PATH, PreferencesAnswerSchema, PreferencesSchema, type PreferenceEntry, type PreferencesAnswer } from "@mako/protocol/preferences"
import { PREFERENCE_NAMES, readPreference, type PreferenceName, type PreferenceValue, type PreferenceValues } from "@mako/host/contracts/preferences"
import type { JsonValue } from "@mako/host/contracts/json"
import { z } from "zod"
import { createHook, createStore } from "@/state/store"
import type { Gateway } from "./gateway"

/**
 * The preferences that follow the person's account (`@mako/protocol/preferences`), read from it directly: the phone
 * shows the person's theme, Fin settings and harness order with every Mac asleep. An edit made here is in effect here
 * at once and sent; one the account can't take yet (offline) is kept in this browser and sent at the next read. For
 * each preference the later edit is in effect, as the account settles them (`laterEdit`).
 */
export interface WebPreferencesState {
  values: PreferenceValues
  /** Whether each preference has an edit at all, here or in the account: one cleared back to the default counts. */
  held: ReadonlySet<PreferenceName>
  /** Whether the account's preferences were read this visit: until then, a preference not held may only be unread. */
  read: boolean
}

export const webPreferencesStore = createStore<WebPreferencesState>({ values: {}, held: new Set(), read: false })
export const useWebPreferences = createHook(webPreferencesStore)

const KeptSchema = z.object({ held: PreferencesSchema.catch({}), revision: z.number().int().nonnegative().optional(), unsent: PreferencesSchema.catch({}) })
type Kept = z.infer<typeof KeptSchema>
/** The browser's own theme from before the account kept it (`theme.ts`), offered once. */
const LEGACY_THEME = "mako:web:theme"

export class WebPreferences {
  readonly #gateway: Gateway
  readonly #key: string
  #kept: Kept
  #syncing: Promise<void> = Promise.resolve()

  constructor(gateway: Gateway, accountId: string) {
    this.#gateway = gateway
    this.#key = `mako:web:preferences:${accountId}`
    this.#kept = this.#load()
    this.#offerLegacyTheme()
    this.#publish()
  }

  /** The person changed `name` here (null: back to the default): in effect at once, and sent. */
  set<Name extends PreferenceName>(name: Name, value: PreferenceValue<Name> | null): Promise<void> {
    // The later of this clock and just after the edit in effect: an edit made after seeing a value always wins over it.
    const at = Math.max(Date.now(), (effective(this.#kept.held[name], this.#kept.unsent[name])?.at ?? 0) + 1)
    // SAFETY: `PreferenceValue<Name>` is JSON by `PREFERENCE_SCHEMAS`; null clears it.
    const entry: PreferenceEntry = { value: value as JsonValue | null, at, op: crypto.randomUUID() }
    this.#keep({ ...this.#kept, unsent: { ...this.#kept.unsent, [name]: entry } })
    return this.sync()
  }

  /** The account's stream said which changed, at its revision: the next revision is laid over, a skipped one read whole. */
  heard(answer: PreferencesAnswer): void {
    const { revision } = this.#kept
    if (revision !== undefined && answer.revision <= revision) return
    if (revision === undefined || answer.revision !== revision + 1) {
      void this.sync()
      return
    }
    this.#take({ preferences: { ...this.#kept.held, ...answer.preferences }, revision: answer.revision })
  }

  /** Sends what's kept here unsent and reads the account's preferences back: as the list is read, and after an edit. */
  sync(): Promise<void> {
    const run = this.#syncing.then(() => this.#sync()).catch((error) => console.warn("[mako] the account's preferences weren't read; kept here until the next read", error))
    this.#syncing = run
    return run
  }

  async #sync(): Promise<void> {
    const sending = this.#kept.unsent
    const answer = Object.keys(sending).length
      ? await this.#gateway.rest("PATCH", PREFERENCES_PATH, { preferences: sending })
      : await this.#gateway.rest("GET", PREFERENCES_PATH)
    this.#take(PreferencesAnswerSchema.parse(answer))
  }

  /** The account's whole set: what's held, and an edit here it took, or holds a later one than, no longer sent. */
  #take({ preferences, revision }: PreferencesAnswer): void {
    const unsent = Object.fromEntries(Object.entries(this.#kept.unsent).filter(([key, entry]) => preferences[key]?.op !== entry.op && laterEdit(entry, preferences[key])))
    this.#keep({ held: preferences, revision, unsent })
    if (!webPreferencesStore.get().read) webPreferencesStore.set({ read: true })
  }

  #offerLegacyTheme(): void {
    const theme = localStorage.getItem(LEGACY_THEME)
    if (theme === null) return
    localStorage.removeItem(LEGACY_THEME)
    if (theme !== "light" && theme !== "dark") return
    // Its time isn't known: it fills the account's theme only where the account holds none.
    this.#keep({ ...this.#kept, unsent: { ...this.#kept.unsent, theme: { value: theme, at: 0, op: crypto.randomUUID() } } })
  }

  #keep(next: Kept): void {
    this.#kept = next
    localStorage.setItem(this.#key, JSON.stringify(next))
    this.#publish()
  }

  #load(): Kept {
    try {
      const raw = localStorage.getItem(this.#key)
      if (raw) return KeptSchema.parse(JSON.parse(raw))
    } catch {
      // Kept by a build this one can't read: read again from the account.
    }
    return { held: {}, unsent: {} }
  }

  #publish(): void {
    const values: PreferenceValues = {}
    const held = new Set<PreferenceName>()
    for (const name of PREFERENCE_NAMES) {
      const entry = effective(this.#kept.held[name], this.#kept.unsent[name])
      if (!entry) continue
      held.add(name)
      const value = readPreference(name, entry.value)
      if (value !== undefined) Object.assign(values, { [name]: value })
    }
    webPreferencesStore.set({ values, held })
  }
}

/** The later of the account's edit and one made here it hasn't taken. */
function effective(held: PreferenceEntry | undefined, mine: PreferenceEntry | undefined): PreferenceEntry | undefined {
  return mine && laterEdit(mine, held) ? mine : held
}

/** A preference as it's in effect on this browser now, or undefined for the default. */
export function webPreference<Name extends PreferenceName>(name: Name): PreferenceValue<Name> | undefined {
  // SAFETY: `values` holds each name's value as `readPreference` parsed it for that name.
  return webPreferencesStore.get().values[name] as PreferenceValue<Name> | undefined
}
