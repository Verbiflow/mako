import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { z } from "zod"
import { laterEdit, PreferencesSchema, type PreferenceEntry, type Preferences } from "@mako/protocol/preferences"
import { publishFileSync } from "../base/published-files.js"
import { isPreferenceName, PREFERENCE_NAMES, readPreference, type PreferenceName, type PreferenceValue, type PreferenceValues } from "../contracts/preferences.js"
import type { JsonValue } from "../contracts/json.js"
import type { MethodTable } from "../base/methods.js"

/** One account's preferences at a revision, which each change raises: an older one is never taken over a newer. */
export interface AccountPreferences {
  /** The account's ID: another account's revisions are its own. */
  account: string
  preferences: Preferences
  revision: number
}

/** The account's end of them (`GET`/`PATCH /v1/preferences`); undefined from a cloud that doesn't keep them yet. */
export interface PreferencesAccount {
  read(): Promise<AccountPreferences | undefined>
  /** Sends edits; answers every preference the account keeps after them. */
  write(preferences: Preferences): Promise<AccountPreferences | undefined>
}

export interface PreferenceDeps {
  /** `<user root>/preferences.json`: every host of this user (the app, its profiles) reads the same. */
  file: string
  /** The signed-in account's end, or undefined while signed out, or on a host that acts for no person. */
  account(): Promise<PreferencesAccount | undefined>
  /** What's in effect changed: every window, and every part of this host that mirrors one, hears it. */
  announce(values: PreferenceValues): void
  /** The clock edits are stamped by; a test's own. */
  now?(): number
  log?(message: string, fields?: Record<string, string | number | boolean>): void
}

const StoredSchema = z.object({
  version: z.literal(1),
  /** As the account last said them, at its revision. */
  held: PreferencesSchema.catch({}).default({}),
  revision: z.number().int().nonnegative().optional(),
  account: z.string().optional(),
  /** Edits made here (or offered from what this device kept before) that the account hasn't taken yet. */
  unsent: PreferencesSchema.catch({}).default({}),
  /** Preferences this device has offered from what it kept before the account kept them: each offered once. */
  offered: z.array(z.string()).catch([]).default([]),
})
type Stored = { held: Preferences; revision?: number; account?: string; unsent: Preferences; offered: string[] }

const sameEntry = (left: PreferenceEntry | undefined, right: PreferenceEntry | undefined) => left?.op === right?.op && left?.at === right?.at

/**
 * The preferences that follow the person's account, as this host knows them (`contracts/preferences.ts`). The account
 * owns them: an edit made here is in effect here at once, kept as unsent, and sent; the account's answers and its
 * `preferences-changed` events replace what's held. For each preference the later edit is in effect, by when it was
 * made and then its ID (`laterEdit`), which is how the account settles them too, so this host and the account always
 * agree once they've heard each other. A host that isn't signed in keeps its edits alone, and sends them when it is.
 *
 * What a device kept before the account kept them (a Mac's Fin settings, its harness order, a window's theme) is
 * offered once, stamped with when it was last edited there (the file's modification time where that's all there is):
 * the account keeps it where it holds nothing newer, so a first sync never replaces a later choice made elsewhere.
 */
export class PreferenceStore {
  readonly #deps: PreferenceDeps
  #stored: Stored = { held: {}, unsent: {}, offered: [] }
  #readAt = -1
  #syncing: Promise<void> = Promise.resolve()
  #last: string | undefined

  constructor(deps: PreferenceDeps) {
    this.#deps = deps
  }

  /** Every preference in effect: for each, the later of the account's and an edit made here it hasn't taken yet. */
  values(): PreferenceValues {
    const values: PreferenceValues = {}
    for (const name of PREFERENCE_NAMES) {
      const value = this.value(name)
      if (value !== undefined) Object.assign(values, { [name]: value })
    }
    return values
  }

  /**
   * The file they're kept in, written first when nothing has been kept yet, so there's always one to open. It holds
   * what's in effect (`held`, the account's) and what this Mac changed that the account hasn't taken yet (`unsent`).
   */
  file(): string {
    if (!existsSync(this.#deps.file)) this.#write(this.#read())
    return this.#deps.file
  }

  /** `name` as it's in effect, or undefined for Mako's default. */
  value<Name extends PreferenceName>(name: Name): PreferenceValue<Name> | undefined {
    return readPreference(name, this.#entry(name)?.value)
  }

  /** Whether `name` has an edit at all, here or in the account: one cleared back to the default counts. */
  has(name: PreferenceName): boolean {
    return this.#entry(name) !== undefined
  }

  /** The person changed `name` here (null: back to the default): in effect at once, and the account's once it takes it. */
  async set<Name extends PreferenceName>(name: Name, value: PreferenceValue<Name> | null): Promise<PreferenceValues> {
    this.change(name, value)
    await this.sync()
    return this.values()
  }

  /**
   * The person's own edit of `name`, made now: stamped at the later of this clock and just after the edit in effect, so
   * an edit made after seeing a value always wins over it, whatever this device's clock says. Sent in the background.
   */
  change<Name extends PreferenceName>(name: Name, value: PreferenceValue<Name> | null): void {
    this.edit(name, value, Math.max(this.#now(), (this.#entry(name)?.at ?? 0) + 1))
  }

  /**
   * An edit to `name` made at `at` (another program of this user's, an older Mako, wrote it to its own file then): kept
   * as the person's if it's later than what's in effect, and sent. Answers whether it was.
   */
  edit<Name extends PreferenceName>(name: Name, value: PreferenceValue<Name> | null, at: number): boolean {
    // SAFETY: `PreferenceValue<Name>` is JSON by `PREFERENCE_SCHEMAS`; null clears it.
    const entry: PreferenceEntry = { value: value as JsonValue | null, at: Math.max(0, Math.round(at)), op: randomUUID() }
    if (!laterEdit(entry, this.#entry(name))) return false
    const stored = this.#read()
    this.#write({ ...stored, unsent: { ...stored.unsent, [name]: entry } })
    this.#announce()
    void this.sync()
    return true
  }

  /**
   * What this device kept of `name` before the account kept it, edited at `at`: offered once, and kept where neither
   * the account nor this host holds a later edit. Asked again after it was offered, nothing.
   */
  offer<Name extends PreferenceName>(name: Name, value: PreferenceValue<Name> | undefined, at: number): void {
    const stored = this.#read()
    if (stored.offered.includes(name)) return
    this.#write({ ...stored, offered: [...stored.offered, name] })
    if (value !== undefined) this.edit(name, value, at)
  }

  /**
   * The account said its preferences: all of them (an answer), or those a change touched (a `preferences-changed`
   * event). A whole answer replaces what's held unless this host heard a newer revision; an event is laid over what's
   * held when it's the next revision, and one that skips a revision has the whole set read again.
   */
  heard({ account, preferences, revision }: AccountPreferences, whole: boolean): void {
    const stored = this.#read()
    const same = stored.account === account
    if (same && stored.revision !== undefined && revision <= stored.revision && !(whole && revision === stored.revision)) return
    if (!whole && (!same || stored.revision === undefined || revision !== stored.revision + 1)) {
      void this.sync()
      return
    }
    const held = whole ? { ...preferences } : { ...stored.held, ...preferences }
    // An edit here the account now holds, or one it holds a later edit than, is sent.
    const unsent = Object.fromEntries(Object.entries(stored.unsent).filter(([key, entry]) => !sameEntry(held[key], entry) && laterEdit(entry, held[key])))
    this.#write({ ...stored, held, account, revision, unsent })
    this.#announce()
  }

  /**
   * Sends the account what it hasn't taken and reads its preferences back: at start, on signing in, and when its stream
   * may have missed an event. One at a time; a failure leaves what's unsent for the next.
   */
  sync(): Promise<void> {
    const run = this.#syncing.then(() => this.#sync()).catch((error: Error) => {
      this.#deps.log?.("the account's preferences couldn't be read or written; kept here until the next sync", { error: error.message })
    })
    this.#syncing = run
    return run
  }

  async #sync(): Promise<void> {
    const account = await this.#deps.account()
    if (!account) return
    const sending = this.#read().unsent
    if (Object.keys(sending).length) {
      const answer = await account.write(sending)
      if (answer === undefined) return
      // The answer is the account's whole set after the write: an edit it took, or holds a later one than, is no
      // longer sent (`heard`), and one made here meanwhile still is.
      this.heard(answer, true)
      return
    }
    const answer = await account.read()
    if (answer !== undefined) this.heard(answer, true)
  }

  #entry(name: PreferenceName): PreferenceEntry | undefined {
    const { held, unsent } = this.#read()
    const mine = unsent[name]
    return mine && laterEdit(mine, held[name]) ? mine : held[name]
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }

  #announce(): void {
    const values = this.values()
    const said = JSON.stringify(values)
    if (said === this.#last) return
    this.#last = said
    this.#deps.announce(values)
  }

  #read(): Stored {
    let modified: number
    try {
      modified = statSync(this.#deps.file).mtimeMs
    } catch {
      return this.#stored
    }
    if (modified === this.#readAt) return this.#stored
    try {
      const parsed = StoredSchema.parse(JSON.parse(readFileSync(this.#deps.file, "utf8")))
      this.#stored = { held: parsed.held, unsent: parsed.unsent, offered: parsed.offered }
      if (parsed.revision !== undefined && parsed.account !== undefined) Object.assign(this.#stored, { account: parsed.account, revision: parsed.revision })
    } catch (error) {
      this.#deps.log?.("the preferences kept here couldn't be read; the account's are read again", { error: error instanceof Error ? error.message : String(error) })
    }
    this.#readAt = modified
    // Another host of this user changed them: this one's windows hear what's in effect now.
    this.#announce()
    return this.#stored
  }

  #write(next: Stored): void {
    this.#stored = next
    publishFileSync(this.#deps.file, `${JSON.stringify({ version: 1, ...next })}\n`)
    this.#readAt = statSync(this.#deps.file).mtimeMs
  }
}

/** The preferences for every window: read, and changed (null: back to the default). */
export function declarePreferenceMethods(methods: MethodTable, store: PreferenceStore): void {
  methods.handle("mako:preferences", () => store.values())
  methods.handle("mako:preference-set", (name: string, value: JsonValue | null) => {
    if (!isPreferenceName(name)) throw new Error(`No preference ${name}`)
    const parsed = value === null ? null : readPreference(name, value)
    if (parsed === undefined) throw new Error(`That isn't a value ${name} takes`)
    return store.set(name, parsed)
  })
  // Settings' Open settings file: where these are kept, made when nothing is yet.
  methods.handle("mako:preferences-file", (): string => store.file())
  // What a window kept before the account kept it, offered once with when it was edited there (0: unknown).
  methods.handle("mako:preference-offer", (name: string, value: JsonValue, at: number) => {
    if (!isPreferenceName(name)) throw new Error(`No preference ${name}`)
    store.offer(name, readPreference(name, value), at)
    return store.values()
  })
}
