import { accessTierOfModeId, type AccessTier } from "../../contracts/access.js"
import type { LiveSessionMode } from "../../shared.js"

export const openCodeModes: readonly LiveSessionMode[] = [
  { id: "plan", name: "Plan", access: "plan", enforcement: "provider" },
  { id: "access:ask", name: "Ask", access: "ask", enforcement: "launch" },
  { id: "access:edits", name: "Edit", access: "edits", enforcement: "launch" },
  { id: "access:full", name: "Full access", access: "full", enforcement: "launch" },
]
export function openCodeLaunchAccess(mode: string | undefined): AccessTier {
  const tier = mode ? accessTierOfModeId(mode) : undefined
  return tier === "full" || tier === "edits" ? tier : "ask"
}
export function openCodeAgentForMode(mode: string, launchAccess: AccessTier): string {
  if (!mode.startsWith("access:")) return mode
  if (mode !== `access:${launchAccess}`) throw new Error("OpenCode applies this access preset when its session starts")
  return "build"
}
