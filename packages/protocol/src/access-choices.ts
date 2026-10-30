import { z } from "zod"

/**
 * The person's access choice for each harness, kept by their account: the mode a new session of that harness starts
 * in, wherever it's started (a Mac's window, the web app, a phone) and wherever it runs (a Mac or a cloud machine).
 * The account is the one owner; a Mac keeps the last it heard so a start without the network still has it, and a Mac
 * that isn't signed in keeps its own.
 *
 * `mode` is the harness's own mode ID as its ladder lists it (`bypassPermissions`, `access:full`, …); `access` is the
 * tier that mode is on (`full`, `ask`, …), so a surface without the ladder can still say what's in effect.
 */
export const AccessChoiceSchema = z.object({ mode: z.string().min(1).max(64), access: z.string().min(1).max(16).optional() }).strict()
export type AccessChoice = z.infer<typeof AccessChoiceSchema>

/** A harness's ID, as the choices are keyed. */
export const AccessHarnessSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)
/** The most harnesses the choices keep. */
export const ACCESS_CHOICES_MAX = 32

export const AccessChoicesSchema = z
  .record(AccessHarnessSchema, AccessChoiceSchema)
  .refine((choices) => Object.keys(choices).length <= ACCESS_CHOICES_MAX, `At most ${ACCESS_CHOICES_MAX} harnesses`)
export type AccessChoices = z.infer<typeof AccessChoicesSchema>

/** Where they're read and changed: `GET` answers them all, `PATCH` changes those it names and answers them all. */
export const ACCESS_CHOICES_PATH = "/v1/access"

/**
 * `GET /v1/access`, and what a `PATCH` answers: every choice the account keeps, and their revision, which each change
 * raises by one. A device keeps the highest it heard: an answer or an event older than that changes nothing.
 */
export const AccessChoicesAnswerSchema = z.object({ choices: AccessChoicesSchema, revision: z.number().int().nonnegative() })
export type AccessChoicesAnswer = z.infer<typeof AccessChoicesAnswerSchema>

/**
 * `PATCH /v1/access`: the choices named are made, the rest left as they are. `fill`: only for harnesses the account
 * has no choice for yet, as a Mac offers what it kept before the account kept them; asked twice, the same end.
 */
export const AccessChoosingSchema = z.object({ choices: AccessChoicesSchema, fill: z.boolean().optional() }).strict()
export type AccessChoosing = z.infer<typeof AccessChoosingSchema>

/** `choices` with `next` applied as a `PATCH` applies it. */
export function applyAccessChoosing(choices: AccessChoices, next: AccessChoosing): AccessChoices {
  const applied: AccessChoices = { ...choices }
  for (const [harness, choice] of Object.entries(next.choices)) if (!next.fill || !applied[harness]) applied[harness] = choice
  return applied
}

/** Whether two sets of choices say the same. */
export function sameAccessChoices(left: AccessChoices, right: AccessChoices): boolean {
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((harness) => left[harness]?.mode === right[harness]?.mode && left[harness]?.access === right[harness]?.access)
}
