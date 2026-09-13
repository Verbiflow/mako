/**
 * Provider-neutral access tiers.
 *
 * Every provider describes its permission behaviour in its own vocabulary:
 * Claude has `acceptEdits` and `bypassPermissions`, Codex has an approval
 * policy plus a sandbox, Cursor advertises `agent`/`plan`/`ask` over ACP and
 * nothing else, Devin advertises `bypass`, Grok takes a launch flag. The desk
 * shows one ladder. A provider mode carries the tier it implements; a tier the
 * provider cannot implement is either synthesized by the host (it answers the
 * agent's permission requests) or absent.
 */
export const ACCESS_TIER_NAMES = ["plan", "chat", "ask", "edits", "auto", "full", "deny"] as const
export type AccessTier = (typeof ACCESS_TIER_NAMES)[number]

/** Who makes the tier true. */
export type AccessEnforcement =
  /** The provider enforces it natively. */
  | "provider"
  /** The host answers the provider's permission requests on the user's behalf. */
  | "host"
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

/** Tool-call kinds an "Accept edits" tier runs without asking, per the ACP tool-kind vocabulary. */
const EDIT_TIER_KINDS = new Set(["read", "edit", "search", "think"])

export interface AccessPermissionOption {
  optionId: string
  kind?: string
}

/**
 * The option the host selects on the user's behalf, or null when the request
 * must reach the user. A request whose options are not all allow/reject
 * choices is a question, never auto-answered. Once-scoped grants are preferred
 * so the agent keeps asking and a later, stricter tier is honoured.
 */
export function hostAccessDecision(
  tier: AccessTier | null,
  request: { toolKind?: string; options: readonly AccessPermissionOption[]; questions?: boolean }
): string | null {
  if (!tier || request.questions) return null
  if (request.options.length === 0) return null
  const answerable = request.options.every(
    (option) =>
      option.kind === "allow_once" ||
      option.kind === "allow_always" ||
      option.kind === "reject_once" ||
      option.kind === "reject_always"
  )
  if (!answerable) return null
  const permitted =
    tier === "full" ||
    (tier === "edits" && request.toolKind !== undefined && EDIT_TIER_KINDS.has(request.toolKind))
  if (!permitted) return null
  const once = request.options.find((option) => option.kind === "allow_once")
  const always = request.options.find((option) => option.kind === "allow_always")
  return once?.optionId ?? always?.optionId ?? null
}

/** Tiers the host can enforce by answering permission requests. */
export function hostEnforceable(tier: AccessTier): boolean {
  return tier === "full" || tier === "edits"
}
