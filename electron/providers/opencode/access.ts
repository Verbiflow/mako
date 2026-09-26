import { accessModeId, accessTierInfo, accessTierOfModeId, type AccessTier } from "../../contracts/access.js"
import type { LiveSessionMode } from "../../shared.js"

/** The native agent the launch presets configure. It is shown as the preset, never by name. */
export const OPENCODE_BASE_AGENT = "build"
const LAUNCH_TIERS = ["ask", "edits", "full"] as const satisfies readonly AccessTier[]

function launchMode(tier: AccessTier): LiveSessionMode {
  const info = accessTierInfo(tier)
  return { id: accessModeId(tier), name: info.label, description: info.summary, access: tier, enforcement: "launch" }
}

/** The ladder before a session reports its own agents. */
export const openCodeModes: readonly LiveSessionMode[] = [
  { id: "plan", name: "Plan", access: "plan", enforcement: "provider" },
  ...LAUNCH_TIERS.map(launchMode),
]
export const OPENCODE_DEFAULT_MODE = accessModeId("ask")

/** Primary agents the user can select: Plan on the ladder, custom agents by name, presets for Build. */
export function openCodeSessionModes(agents: ReadonlyArray<{ id: string; name: string; description?: string }>): LiveSessionMode[] {
  const modes: LiveSessionMode[] = []
  for (const agent of agents) {
    if (agent.id === OPENCODE_BASE_AGENT) continue
    const mode: LiveSessionMode = agent.id === "plan"
      ? { id: "plan", name: "Plan", access: "plan", enforcement: "provider" }
      : { id: agent.id, name: agent.name || agent.id }
    if (agent.description) mode.description = agent.description
    modes.push(mode)
  }
  return [...modes, ...LAUNCH_TIERS.map(launchMode)]
}

export function openCodeLaunchAccess(mode: string | undefined): AccessTier {
  const tier = mode ? accessTierOfModeId(mode) : undefined
  return tier === "full" || tier === "edits" ? tier : "ask"
}

/** The native agent for a selected mode. A preset other than the launch preset needs a new session. */
export function openCodeAgentForMode(mode: string, launchAccess: AccessTier): string {
  const tier = accessTierOfModeId(mode)
  if (!tier || !mode.startsWith("access:")) return mode
  if (tier === launchAccess) return OPENCODE_BASE_AGENT
  const label = accessTierInfo(tier).label
  throw new Error(`OpenCode reads ${label} when its session starts. It will apply to the next conversation you start with OpenCode; this session keeps ${accessTierInfo(launchAccess).label}.`)
}

/** The mode shown for a native agent: Build is whichever preset the session launched with. */
export function openCodeModeForAgent(agent: string, launchAccess: AccessTier): string {
  return agent === OPENCODE_BASE_AGENT ? accessModeId(launchAccess) : agent
}
