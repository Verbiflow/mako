/**
 * Provider-neutral access tiers.
 *
 * Every provider describes its permission behaviour in its own vocabulary:
 * Claude has `acceptEdits` and `bypassPermissions`, Codex has an approval
 * policy plus a sandbox, Cursor's local SDK exposes Agent, Devin advertises
 * `bypass`, and Grok takes a launch flag. The desk
 * shows one ladder. A provider mode carries the tier it implements; a tier the
 * provider cannot implement is absent. Native policy details remain provider-owned.
 */
export const ACCESS_TIER_NAMES = ["plan", "chat", "ask", "edits", "auto", "full", "deny"] as const
export type AccessTier = (typeof ACCESS_TIER_NAMES)[number]

/** Who makes the tier true. */
export type AccessEnforcement =
  /** The provider enforces it natively. */
  | "provider"
  /** The provider reads it when its process starts; a running session keeps its launch tier. */
  | "launch"

export interface AccessTierInfo {
  tier: AccessTier
  label: string
  summary: string
}

/** Least to most permissive, which is also the picker order. */
export const ACCESS_TIERS: readonly AccessTierInfo[] = [
  { tier: "plan", label: "Plan", summary: "Reads and proposes a plan. No edits." },
  { tier: "chat", label: "Chat", summary: "Answers questions. No edits or commands." },
  { tier: "ask", label: "Ask before acting", summary: "Edits and commands wait for your approval." },
  { tier: "edits", label: "Accept edits", summary: "File edits run. Commands wait for approval." },
  { tier: "auto", label: "Auto review", summary: "The provider's reviewer approves routine actions and asks about the rest." },
  { tier: "full", label: "Full access", summary: "Nothing waits for approval. Use in a workspace you can throw away." },
  { tier: "deny", label: "Deny unapproved", summary: "Unapproved tools fail instead of asking." },
]

export function accessTierInfo(tier: AccessTier): AccessTierInfo {
  const info = ACCESS_TIERS.find((item) => item.tier === tier)
  if (!info) throw new Error(`Unknown access tier ${tier}`)
  return info
}

/** Host-defined mode ids carry their tier so preferences survive provider changes. */
export function accessModeId(tier: AccessTier): string {
  return `access:${tier}`
}

export function accessTierOfModeId(id: string): AccessTier | null {
  if (!id.startsWith("access:")) return null
  const name = id.slice("access:".length)
  const info = ACCESS_TIERS.find((item) => item.tier === name)
  return info ? info.tier : null
}
