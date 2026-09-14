import type {
  SkillDelivery,
  SkillOrigin,
  SkillProviderStatus,
  SkillRecord,
} from "./mcp-skills-integrations.js"

/**
 * Which copy of a skill a provider gets when a message references it.
 *
 * A skill discovered under a provider's own roots is that provider's to load;
 * Mako points at it and stays out of the way. A skill found only under
 * another provider's roots, or under `.agents/skills` for a provider not
 * verified to read that root, is handed over: its instructions ride in the
 * prompt and its directory is named for the supporting files. The composer's
 * chip, the menu's badge and the send all read this one rule, so what the
 * user sees before sending is what the provider receives.
 */
export const UNIVERSAL_SKILL_PROVIDER = "agents"

/** The largest SKILL.md body carried inside a prompt; above it the prompt points at the file. */
export const SKILL_HANDOVER_LIMIT = 24 * 1024

function readsUniversal(
  providers: readonly SkillProviderStatus[],
  harness: string
): boolean {
  return providers.some(
    (provider) => provider.id === harness && provider.readsUniversalRoot
  )
}

function isNative(
  origin: SkillOrigin,
  harness: string,
  universal: boolean
): boolean {
  return (
    origin.provider === harness ||
    (universal && origin.provider === UNIVERSAL_SKILL_PROVIDER)
  )
}

/**
 * The copy a delivery names. A project copy is the most specific and is the
 * one a CLI loads over its user copy, so it wins; for a handover the
 * universal root is neutral, so it beats another provider's; the registry's
 * order settles the rest.
 */
function preferred(origins: readonly SkillOrigin[]): SkillOrigin | undefined {
  return (
    origins.find((origin) => origin.scope === "workspace") ??
    origins.find((origin) => origin.provider === UNIVERSAL_SKILL_PROVIDER) ??
    origins[0]
  )
}

/** The origin a delivery reads from: the provider's own copy when it has one, else the handover's. */
export function skillDeliveryOrigin(
  skill: SkillRecord,
  harness: string,
  providers: readonly SkillProviderStatus[]
): { origin: SkillOrigin; native: boolean } | undefined {
  const universal = readsUniversal(providers, harness)
  const own = skill.origins.filter((origin) =>
    isNative(origin, harness, universal)
  )
  const native = preferred(own)
  if (native) return { origin: native, native: true }
  const origin = preferred(skill.origins)
  return origin ? { origin, native: false } : undefined
}

export function skillDelivery(
  skill: SkillRecord,
  harness: string,
  providers: readonly SkillProviderStatus[]
): SkillDelivery {
  const chosen = skillDeliveryOrigin(skill, harness, providers)
  if (!chosen) return { kind: "missing" }
  if (chosen.native) return { kind: "native", path: chosen.origin.provenance }
  return {
    kind: "handover",
    path: chosen.origin.provenance,
    from: chosen.origin.provider,
  }
}

/** Resolve a typed name against the registry; an unknown name is `missing`. */
export function skillDeliveryFor(
  skills: readonly SkillRecord[],
  providers: readonly SkillProviderStatus[],
  name: string,
  harness: string
): SkillDelivery {
  const skill = skills.find((entry) => entry.name === name)
  return skill ? skillDelivery(skill, harness, providers) : { kind: "missing" }
}
