import type { Capability, LiveCapabilityKey } from "./harness-capabilities.js"
import type { HarnessUsageKey } from "./harness-usage.js"

/** A declaration the window shows: a live capability, a usage reading, or the harness's artifact previews. */
export type DeclarationKey = `capabilities.${LiveCapabilityKey}` | `usage.${HarnessUsageKey}` | "artifacts"

/**
 * What the person gets where each declaration is implemented, in the words
 * Settings › Agents and the new-harness checklist show. A key here is what
 * lets a harness's own feature name the declaration that carries it.
 */
export const DECLARATION_SHOWS = {
  "capabilities.resume": "Conversations reopen where they left off after their process closes.",
  "capabilities.residency": "An idle conversation's process closes, and the next message wakes it.",
  "capabilities.turnRecovery": "A turn whose process dies ends as failed, keeping what it did.",
  "capabilities.fork": "Fork a conversation from any turn.",
  "capabilities.steering": "Messages sent during a turn reach it.",
  "capabilities.compaction": "Compact conversation, in the composer's menu.",
  "capabilities.planning": "Plan mode, with the plan card.",
  "capabilities.approvals": "Approval cards before the agent acts.",
  "capabilities.questions": "Question cards above the composer.",
  "capabilities.modes": "The access menu changes mode mid-conversation.",
  "capabilities.nativeAgents": "The Agents panel.",
  "capabilities.backgroundStop": "Stop ends background commands too.",
  "capabilities.contextBreakdown": "What fills the context, in the meter's popover.",
  "usage.context": "The context meter in the composer.",
  "usage.window": "The meter's window size.",
  "usage.compaction": "The meter after a compaction.",
  "usage.contextBreakdown": "What fills the context, in the meter's popover.",
  "usage.tokens": "Tokens in the meter's popover and Settings › Usage.",
  "usage.cost": "Cost in the meter's popover and Settings › Usage.",
  "usage.missedCalls": "A note when its totals leave calls out.",
  "usage.outsideMako": "Settings › Usage counts its sessions outside Mako.",
  "usage.resetCredits": "Use a reset credit, on the account's row.",
  artifacts: "Interactive previews in the file viewer.",
} as const satisfies Record<DeclarationKey, string>

/** Where Mako shows one of a harness's own features. */
export type UniqueShown =
  | { state: "implemented"; via: string; field: DeclarationKey }
  | { state: "implemented"; via: string; field: "tools"; tools: readonly string[] }
  | Exclude<Capability, { state: "implemented" }>

/**
 * Something only this harness has, as its own types, docs or binary show it
 * (`native`), and where it stands in Mako (`mako`):
 * - `shownBy(key)`: the declaration whose UI carries it, which the harness
 *   must implement or leave to its own behaviour.
 * - `shownInTools(names)`: its tool rows, each name in the harness's vocabulary.
 * - `byDefault(reason)`: it works in Mako's sessions with nothing to show.
 * - `noOp(reason)`: there is nothing in it for Mako to show.
 * - `makoLacks(reason)`: Mako doesn't show it yet, a gap.
 */
export interface UniqueCapability {
  name: string
  native: string
  mako: UniqueShown
}

export const shownBy = (field: DeclarationKey): UniqueShown => ({ state: "implemented", via: DECLARATION_SHOWS[field], field })
export const shownInTools = (tools: readonly string[]): UniqueShown => ({ state: "implemented", via: "Its tool rows in the transcript.", field: "tools", tools })

/** What the person gets from an artifact preview, and the files it covers. */
export type ArtifactCapability = Capability<{ name: string; files: readonly string[] }>
