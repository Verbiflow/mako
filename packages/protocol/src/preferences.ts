import { z } from "zod"

/**
 * The person's preferences that follow their account (`/v1/preferences`), as against those each device keeps for
 * itself. The account is the one owner: every device reads them from it, a Mac keeps the last it heard so it works
 * offline, and a change made where the account can't be reached is sent once it can.
 *
 * Each key is one preference, and holds its value with when the person made that edit (`at`, the editing device's
 * clock, in milliseconds) and the edit's own ID (`op`). Two devices that edit the same key, one of them offline, are
 * settled by the edit made last: the account keeps a write only if its `(at, op)` is after the one it holds, so the
 * same edit sent twice changes nothing and an older one that arrives late never replaces a newer one. A value of
 * `null` is the preference cleared, back to Mako's default. Values are whatever the key's owner says they are
 * (`PreferenceValues` in the host's contracts); the account keeps them as JSON and never reads them.
 */

/** A preference's name: dotted words (`theme`, `fins.rules`). */
export const PreferenceKeySchema = z.string().regex(/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*){0,3}$/).max(64)
export type PreferenceKey = z.infer<typeof PreferenceKeySchema>

/** The most preferences an account keeps, and the most bytes one value's JSON may take. */
export const PREFERENCES_MAX = 64
export const PREFERENCE_VALUE_BYTES = 16 * 1024

const BoundedJsonSchema = z.json().refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= PREFERENCE_VALUE_BYTES, `A preference's value is at most ${PREFERENCE_VALUE_BYTES} bytes of JSON`)

/** One preference as the account keeps it: its value, when it was edited, and the edit. */
export const PreferenceEntrySchema = z.lazy(() => z.object({
  value: BoundedJsonSchema.nullable(),
  at: z.number().int().nonnegative(),
  op: z.string().min(1).max(64),
}))
export type PreferenceEntry = z.infer<typeof PreferenceEntrySchema>

export const PreferencesSchema = z.lazy(() => z
  .record(PreferenceKeySchema, PreferenceEntrySchema)
  .refine((preferences) => Object.keys(preferences).length <= PREFERENCES_MAX, `At most ${PREFERENCES_MAX} preferences`))
export type Preferences = z.infer<typeof PreferencesSchema>

/** Where they're read and changed: `GET` answers them all, `PATCH` writes those it names and answers them all. */
export const PREFERENCES_PATH = "/v1/preferences"

/**
 * `GET /v1/preferences`, and what a `PATCH` answers: every preference the account keeps, and their revision, which each
 * change raises by one. A device keeps the highest revision it heard: an answer or an event older than that changes
 * nothing.
 */
export const PreferencesAnswerSchema = z.lazy(() => z.object({ preferences: PreferencesSchema, revision: z.number().int().nonnegative() }))
export type PreferencesAnswer = z.infer<typeof PreferencesAnswerSchema>

/** `PATCH /v1/preferences`: each edit named is kept where it's newer than the account's, the rest left as they are. */
export const PreferenceWritesSchema = z.lazy(() => z.object({ preferences: PreferencesSchema }).strict())
export type PreferenceWrites = z.infer<typeof PreferenceWritesSchema>

/**
 * Whether edit `next` was made after `held`: later by the clock, or at the same moment, by its ID. An edit at 0 is one
 * whose time isn't known (what a device kept before the account kept them, with no record of when it was chosen): it
 * fills a preference the account holds nothing for, and never replaces one it holds, however that was made.
 */
export function laterEdit(next: Pick<PreferenceEntry, "at" | "op">, held: Pick<PreferenceEntry, "at" | "op"> | undefined): boolean {
  if (!held) return true
  if (next.at === 0) return false
  return next.at > held.at || (next.at === held.at && next.op > held.op)
}

/** What `applyPreferenceWrites` makes of the held preferences: all of them after, and those the writes changed. */
export interface AppliedPreferenceWrites {
  preferences: Preferences
  changed: Preferences
}

/**
 * `held` with `writes` applied as the account applies them: each kept only where it's a later edit than the one held.
 * An edit stamped after `now` (a device whose clock runs ahead) is kept at `now`, or just after the edit held when
 * that's later still, so it can't outlast edits the person makes after it elsewhere, while an edit a device stamped just
 * after the one it saw (`at` = the held edit's + 1, its clock behind) still follows it. Answers what changed, which is
 * empty when nothing did.
 */
export function applyPreferenceWrites(held: Preferences, writes: Preferences, now: number): AppliedPreferenceWrites {
  const preferences: Preferences = { ...held }
  const changed: Preferences = {}
  for (const [key, write] of Object.entries(writes)) {
    const entry: PreferenceEntry = { ...write, at: Math.min(write.at, Math.max(now, (preferences[key]?.at ?? 0) + 1)) }
    if (!laterEdit(entry, preferences[key])) continue
    preferences[key] = entry
    changed[key] = entry
  }
  return { preferences, changed }
}
