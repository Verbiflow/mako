import { z } from "zod"
import { ACCESS_TIER_NAMES } from "./access.js"

/**
 * The person's access choice for each harness: the mode a new session of it starts in, from any window, the web app or
 * a phone, on a Mac or in the cloud. Their Mako account keeps them (`@mako/protocol/access-choices`), so every surface
 * reads the same; the host keeps the last it heard, which a Mac that isn't signed in keeps alone.
 *
 * `mode` is the harness's own mode ID from its ladder (`HarnessDescriptor.modes`); `access`, that mode's tier, so a
 * surface without the ladder can still say what's in effect.
 */
export const AccessChoiceSchema = z.object({ mode: z.string().min(1).max(64), access: z.enum(ACCESS_TIER_NAMES).optional() })
export type AccessChoice = z.infer<typeof AccessChoiceSchema>

export const AccessChoicesSchema = z.record(z.string(), AccessChoiceSchema)
export type AccessChoices = z.infer<typeof AccessChoicesSchema>

/** The mode IDs alone, by harness: what a start reads. */
export function chosenModes(choices: AccessChoices): Record<string, string> {
  return Object.fromEntries(Object.entries(choices).map(([harness, choice]) => [harness, choice.mode]))
}
