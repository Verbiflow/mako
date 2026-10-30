import { ACCESS_CHOICES_PATH, AccessChoicesAnswerSchema, type AccessChoices } from "@mako/protocol/access-choices"
import { ACCESS_TIERS, ACCESS_TIER_NAMES, accessTierInfo, type AccessTier } from "@mako/host/contracts/access"
import type { HarnessDescriptor, LiveSessionMode } from "@mako/host/contracts/providers-acp"
import { GatewayError, type Gateway } from "./gateway"
import { macCall } from "./start"

export type { AccessChoices }

/**
 * The person's access choice for each harness, as their account keeps them: the same choices every Mac's window starts
 * with, so a start from here runs in the mode it would from the desk. Undefined from a cloud that doesn't keep them yet.
 */
export async function readAccessChoices(gateway: Gateway): Promise<AccessChoices | undefined> {
  try {
    return AccessChoicesAnswerSchema.parse(await gateway.rest("GET", ACCESS_CHOICES_PATH)).choices
  } catch (error) {
    if (error instanceof GatewayError && error.status === 404) return undefined
    throw error
  }
}

/** Makes `mode` the person's choice for `harness`, for every device; all the choices as they stand after. */
export async function chooseAccess(gateway: Gateway, harness: string, mode: LiveSessionMode): Promise<AccessChoices> {
  const choice = mode.access ? { mode: mode.id, access: mode.access } : { mode: mode.id }
  return AccessChoicesAnswerSchema.parse(await gateway.rest("PATCH", ACCESS_CHOICES_PATH, { choices: { [harness]: choice } })).choices
}

/** A harness's access ladder, as a Mac declares it: its modes, and the one it starts in by its own configuration. */
export interface Ladder {
  modes: readonly LiveSessionMode[]
  defaultMode?: string
}

/** Each harness's ladder, as one of the account's Macs declares them (`mako:harness-descriptors`). */
export async function macLadders(gateway: Gateway, webDeviceId: string, deviceId: string): Promise<Record<string, Ladder>> {
  const descriptors = await macCall<HarnessDescriptor[]>(gateway, webDeviceId, deviceId, "mako:harness-descriptors", [])
  const ladders: Record<string, Ladder> = {}
  for (const descriptor of descriptors) {
    if (!descriptor.modes?.length) continue
    const ladder: Ladder = { modes: descriptor.modes }
    if (descriptor.defaultMode) ladder.defaultMode = descriptor.defaultMode
    ladders[descriptor.provider] = ladder
  }
  return ladders
}

/** The access a new session of a harness starts in, as the New sheet's chip says it. */
export interface AccessInEffect {
  /** The mode the start names: the person's choice, unless the harness no longer offers it. */
  mode?: string
  tier?: AccessTier
  /** Compact, as the desk's composer chip says it. */
  label: string
  /** The harness's own name for the mode, when the tier's differs. */
  detail?: string
}

const tierOf = (access: string | undefined): AccessTier | undefined => ACCESS_TIER_NAMES.find((tier) => tier === access)

/**
 * What a start of `harness` runs in: the person's choice, or with none, the harness's own configuration. Without the
 * harness's ladder (no Mac to ask), the choice stands as the account keeps it, its tier as it was chosen.
 */
export function accessInEffect(harness: string, choices: AccessChoices | undefined, ladder: Ladder | undefined): AccessInEffect {
  const chosen = choices?.[harness]
  const mode = chosen && ladder ? ladder.modes.find((each) => each.id === chosen.mode) : undefined
  if (chosen && (mode || !ladder)) {
    const tier = mode?.access ?? tierOf(chosen.access)
    const effect: AccessInEffect = { mode: chosen.mode, label: tier ? tierLabel(tier) : (mode?.name ?? chosen.mode) }
    if (tier) effect.tier = tier
    if (mode && tier && mode.name !== accessTierInfo(tier).label) effect.detail = mode.name
    return effect
  }
  // A one-mode harness has nothing to choose: its one level is what runs.
  const only = ladder?.modes.length === 1 ? ladder.modes[0] : undefined
  if (only?.access) return { tier: only.access, label: tierLabel(only.access) }
  return { label: "Native default" }
}

/** The plan toggle names plan mode on the desk; the chip says what it allows. */
function tierLabel(tier: AccessTier): string {
  return tier === "plan" ? "Read-only" : accessTierInfo(tier).label
}

/** A ladder in picker order: least to most permissive, a mode without a tier last. */
export function orderedModes(modes: readonly LiveSessionMode[]): LiveSessionMode[] {
  const order = (mode: LiveSessionMode) => (mode.access ? ACCESS_TIERS.findIndex((info) => info.tier === mode.access) : ACCESS_TIERS.length)
  return [...modes].sort((left, right) => order(left) - order(right))
}
