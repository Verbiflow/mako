import type { SessionModeState } from "@agentclientprotocol/sdk"
import {
  ACCESS_TIERS,
  accessModeId,
  accessTierInfo,
  accessTierOfModeId,
  hostEnforceable,
  type AccessTier,
} from "./contracts/access.js"
import type { LiveSessionMode } from "./shared.js"

/**
 * How one ACP provider's modes sit on the shared access ladder.
 *
 * `native` names the provider mode that implements a tier. `host` lists tiers
 * the host makes true by answering the provider's permission requests, on top
 * of `base`. `launch` lists tiers the provider reads from its launch flags or
 * environment; a running session keeps the tier it started with.
 */
export interface AcpAccessPolicy {
  native?: Partial<Record<AccessTier, string>>
  host?: readonly AccessTier[]
  launch?: readonly AccessTier[]
  base?: string
}

export interface AcpAccessSelection {
  /** The mode id shown as current. */
  currentMode: string | null
  /** The tier the host enforces by answering permission requests, if any. */
  hostTier: AccessTier | null
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
  for (const mode of native?.availableModes ?? []) {
    const access = tierOf.get(mode.id)
    if (!access && policy?.base === mode.id) continue
    const entry: LiveSessionMode = { id: mode.id, name: mode.name }
    if (mode.description) entry.description = mode.description
    if (access) {
      entry.access = access
      entry.enforcement = "provider"
    }
    modes.push(entry)
  }
  const covered = new Set(modes.map((mode) => mode.access))
  for (const tier of [...(policy?.host ?? []), ...(policy?.launch ?? [])]) {
    if (covered.has(tier)) continue
    covered.add(tier)
    const info = accessTierInfo(tier)
    modes.push({
      id: accessModeId(tier),
      name: info.label,
      description: info.summary,
      access: tier,
      enforcement: policy?.host?.includes(tier) ? "host" : "launch",
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
  const tier = requested?.access ?? null
  if (!requested || !tier || requested.enforcement === "provider")
    return { currentMode: native?.currentModeId ?? null, hostTier: null }
  const hostTier = policy?.host?.includes(tier) && hostEnforceable(tier) ? tier : null
  if (hostTier || policy?.launch?.includes(tier)) return { currentMode: requested.id, hostTier }
  return { currentMode: native?.currentModeId ?? null, hostTier: null }
}

export type AcpModeChange =
  | { kind: "native"; modeId: string; hostTier: null }
  | { kind: "host"; modeId: string; hostTier: AccessTier; baseMode: string | null }
  | { kind: "unchanged"; modeId: string }

/**
 * What selecting `modeId` means for this session. A launch-only tier that is
 * not the running session's own launch tier cannot be made true now, so it is
 * refused with the reason rather than shown as applied.
 */
export function acpModeChange(
  policy: AcpAccessPolicy | undefined,
  modes: readonly LiveSessionMode[],
  modeId: string,
  launchedTier: AccessTier | null,
  nativeCurrent: string | null,
  harness: string
): AcpModeChange {
  const tier = accessTierOfModeId(modeId)
  if (!tier) return { kind: "native", modeId, hostTier: null }
  const mode = modes.find((item) => item.id === modeId)
  if (!mode) throw new Error(`${harness} does not offer that access level`)
  if (mode.enforcement === "host" || (policy?.host?.includes(tier) && hostEnforceable(tier))) {
    const baseMode = policy?.base && nativeCurrent !== policy.base ? policy.base : null
    return { kind: "host", modeId, hostTier: tier, baseMode }
  }
  if (tier === launchedTier) return { kind: "unchanged", modeId }
  throw new Error(
    `${harness} reads ${accessTierInfo(tier).label} when its session starts. It will apply to the next conversation you start with ${harness}; this session keeps ${launchedTier ? accessTierInfo(launchedTier).label : "its current level"}.`
  )
}
