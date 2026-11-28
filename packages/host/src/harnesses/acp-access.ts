import type { SessionConfigOption, SessionMode, SessionModeState } from "@agentclientprotocol/sdk"
import {
  ACCESS_TIERS,
  accessModeId,
  accessTierInfo,
  accessTierOfModeId,
  type AccessTier,
} from "../contracts/access.js"
import type { LiveSessionMode } from "../contracts/providers-acp.js"

/**
 * How one ACP provider's modes sit on the shared access ladder.
 *
 * `native` names the provider mode that implements a tier.
 * `launch` lists tiers the provider reads from its launch flags or
 * environment; a running session keeps the tier it started with.
 */
export interface AcpAccessPolicy {
  native?: Partial<Record<AccessTier, string>>
  launch?: readonly AccessTier[]
  /** Native modes the agent takes through `session/set_mode` and reports without listing them. */
  unlisted?: readonly SessionMode[]
  /**
   * The native mode id that means "the launch tier": the agent reports it on
   * leaving one of its native modes, and Mako sends it to leave one.
   */
  launchNativeMode?: string
  /**
   * Tiers no native mode makes true, which Mako makes true by answering the
   * agent's tool requests itself: each runs in the native mode named, and every
   * request for a tool's call is approved without a card. A question the agent
   * asks the person still reaches them.
   */
  answered?: Partial<Record<AccessTier, string>>
  /**
   * The tier a session runs under when the user has not chosen one. A
   * launch-listed default is passed to the process so the level the desk
   * reports is the level enforced; a native default is what the provider
   * itself opens in.
   */
  default?: AccessTier
}

/** The mode id a fresh session starts in, for the pre-launch ladder. */
export function acpDefaultMode(policy: AcpAccessPolicy | undefined): string | undefined {
  const tier = policy?.default
  return tier ? (policy?.native?.[tier] ?? accessModeId(tier)) : undefined
}

/**
 * ACP lets an agent report its modes as a config option in the `mode`
 * category instead of `session.modes`. It is the same fact in another field,
 * so the ladder and the current mode are read from whichever the agent sends.
 */
export function acpNativeModes(
  options: readonly SessionConfigOption[]
): SessionModeState | null {
  const option = options.find(
    (candidate) =>
      candidate.type === "select" &&
      (candidate.category === "mode" || candidate.id === "mode")
  )
  if (!option || option.type !== "select") return null
  const entries = Array.isArray(option.options) ? option.options : []
  const availableModes = entries
    .flatMap((entry) => ("options" in entry ? entry.options : [entry]))
    .map((entry) => {
      const mode: SessionMode = { id: entry.value, name: entry.name }
      if (entry.description) mode.description = entry.description
      return mode
    })
  if (!availableModes.length || !option.currentValue) return null
  return { availableModes, currentModeId: option.currentValue }
}

export interface AcpAccessSelection {
  /** The mode id shown as current. */
  currentMode: string | null
}

export function acpSessionModes(
  policy: AcpAccessPolicy | undefined,
  native: Pick<SessionModeState, "availableModes"> | null
): LiveSessionMode[] {
  const tierOf = new Map<string, AccessTier>()
  for (const info of ACCESS_TIERS) {
    const id = policy?.native?.[info.tier]
    if (id) tierOf.set(id, info.tier)
  }
  const modes: LiveSessionMode[] = []
  for (const mode of native?.availableModes ?? policy?.unlisted ?? []) {
    const access = tierOf.get(mode.id)
    const entry: LiveSessionMode = { id: mode.id, name: mode.name }
    if (mode.description) entry.description = mode.description
    if (access) {
      entry.access = access
      entry.enforcement = "provider"
    }
    modes.push(entry)
  }
  const covered = new Set(modes.map((mode) => mode.access))
  for (const info of ACCESS_TIERS) {
    if (!policy?.answered?.[info.tier] || covered.has(info.tier)) continue
    covered.add(info.tier)
    modes.push({ id: accessModeId(info.tier), name: info.label, description: info.summary, access: info.tier, enforcement: "mako" })
  }
  for (const tier of policy?.launch ?? []) {
    if (covered.has(tier)) continue
    covered.add(tier)
    const info = accessTierInfo(tier)
    modes.push({
      id: accessModeId(tier),
      name: info.label,
      description: info.summary,
      access: tier,
      enforcement: "launch",
    })
  }
  return modes
}

/** The mode a fresh session shows, given what was requested before launch. */
export function acpInitialSelection(
  policy: AcpAccessPolicy | undefined,
  modes: readonly LiveSessionMode[],
  native: SessionModeState | null,
  requestedModeId: string | undefined
): AcpAccessSelection {
  const requested = requestedModeId ? modes.find((mode) => mode.id === requestedModeId) : undefined
  if (requested && !native && policy?.unlisted?.some((mode) => mode.id === requested.id))
    return { currentMode: requested.id }
  const tier = requested?.access ?? null
  if (requested?.enforcement === "mako") return { currentMode: requested.id }
  if (!requested || !tier || requested.enforcement === "provider")
    return { currentMode: native?.currentModeId ?? null }
  if (policy?.launch?.includes(tier)) return { currentMode: requested.id }
  return { currentMode: native?.currentModeId ?? null }
}

export type AcpModeChange =
  | { kind: "native"; modeId: string; nativeModeId: string }
  | { kind: "unchanged"; modeId: string }

/**
 * What selecting `modeId` means for this session, now in `current`. A
 * launch-only tier that is not the running session's own launch tier cannot
 * be made true now, so it is refused with the reason rather than shown as
 * applied. Returning to the launch tier from a native mode sends the
 * policy's `launchNativeMode`.
 */
export function acpModeChange(
  policy: AcpAccessPolicy | undefined,
  modes: readonly LiveSessionMode[],
  modeId: string,
  launchedTier: AccessTier | null,
  harness: string,
  current: string | null = null
): AcpModeChange {
  const tier = accessTierOfModeId(modeId)
  if (!tier) {
    if (!modes.some((mode) => mode.id === modeId)) throw new Error(`${harness} does not offer that mode`)
    return { kind: "native", modeId, nativeModeId: modeId }
  }
  const mode = modes.find((item) => item.id === modeId)
  if (!mode) throw new Error(`${harness} does not offer that access level`)
  const answeredIn = mode.enforcement === "mako" ? policy?.answered?.[tier] : undefined
  if (answeredIn) return { kind: "native", modeId, nativeModeId: answeredIn }
  if (policy?.launch?.includes(tier) && tier === launchedTier)
    return policy.launchNativeMode && current !== null && current !== modeId
      ? { kind: "native", modeId, nativeModeId: policy.launchNativeMode }
      : { kind: "unchanged", modeId }
  throw new Error(
    `${harness} reads ${accessTierInfo(tier).label} when its session starts. It will apply to the next conversation you start with ${harness}; this session keeps ${launchedTier ? accessTierInfo(launchedTier).label : "its current level"}.`
  )
}

/** The mode id Mako shows for a mode the agent reports. */
export function acpReportedMode(
  policy: AcpAccessPolicy | undefined,
  nativeModeId: string,
  launchedTier: AccessTier | null,
  current: string | null = null
): string {
  // A tier Mako answers for runs in a native mode of the agent's: the agent reporting that mode is the tier holding.
  const answered = current ? accessTierOfModeId(current) : null
  if (answered && policy?.answered?.[answered] === nativeModeId) return current!
  return launchedTier && nativeModeId === policy?.launchNativeMode ? accessModeId(launchedTier) : nativeModeId
}

/**
 * Whether Mako answers this tool request itself: the session's mode is a tier
 * Mako answers for (`AcpAccessPolicy.answered`), and the request asks to run a
 * call, with a choice to allow it, rather than putting a question to the person.
 * The option chosen is the one that allows it once.
 */
export function acpAnsweredRequest(
  policy: AcpAccessPolicy | undefined,
  currentMode: string | null | undefined,
  request: { options: readonly { optionId: string; kind?: string }[]; questions?: readonly unknown[]; implementsPlan?: unknown },
  toolCallId: string | undefined
): string | undefined {
  const tier = currentMode ? accessTierOfModeId(currentMode) : null
  if (!tier || !policy?.answered?.[tier]) return undefined
  if (request.questions?.length || request.implementsPlan || toolCallId?.startsWith("interaction_")) return undefined
  if (!request.options.every((option) => option.kind && /^(allow|reject)_(once|always)$/.test(option.kind))) return undefined
  return (request.options.find((option) => option.kind === "allow_once") ?? request.options.find((option) => option.kind === "allow_always"))?.optionId
}
