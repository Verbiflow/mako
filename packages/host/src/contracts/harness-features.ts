import type { ToolKind } from "@mako/sessions/tool-identity"
import type { Capability, LiveCapabilityKey } from "./harness-capabilities.js"
import type { HarnessUsageKey } from "./harness-usage.js"

/** A declaration the window shows: a live capability, a usage reading, or the harness's artifact previews. */
export type DeclarationKey = `capabilities.${LiveCapabilityKey}` | `usage.${HarnessUsageKey}` | "artifacts"

/**
 * What the person gets where each declaration is implemented, in the words
 * Settings › Agents and the new-harness checklist show.
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
  "usage.balance": "Credit or money left beyond the plan, on the account's row.",
  "usage.limitSwitch": "A line above the composer offering an account with room, when the one in use nears its limit or is refused.",
  "usage.toolSpend": "Nothing yet: no harness reports it, and Mako never splits a call's spend among its tools by guess.",
  artifacts: "Interactive previews in the file viewer.",
} as const satisfies Record<DeclarationKey, string>

interface FeatureInfo {
  /** Mako's name for it, the one every surface shows whatever the harness calls it. */
  name: string
  /** What it is, in words true of every harness that has it. */
  is: string
  /** Mako's own implementation, which serves any harness: a harness can't lack it, only use it or its own. */
  mako?: string
  /** It happens through tool calls of this kind, so a harness's vocabulary names its form. */
  tools?: ToolKind
}

/**
 * Features more than one harness has, each under Mako's one name. A harness
 * says what it calls each and where Mako stands on it, so Codex's `/goal`,
 * Claude Code's `/goal` and Grok's `/goal` are one Goals row and one
 * place in the window, each driving the harness's own implementation, and a
 * harness without one gets Mako's where Mako has one.
 *
 * Something only one harness has belongs in its `unique` list instead; a
 * declared field only one harness implements stays a field, and the window
 * marks it as that harness's alone.
 */
export const HARNESS_FEATURES = {
  goals: {
    name: "Goals",
    is: "The agent keeps working, turn after turn, until a condition you set is met.",
    mako: "Mako asks the agent to continue after each turn until it reports the goal met or says what it needs, or until the goal's tokens reach its budget.",
  },
  review: {
    name: "Code review",
    is: "The agent reviews a set of changes and reports what's wrong.",
    mako: "Mako asks the agent to review the changes without editing them and to end its reply with the findings as data, which the transcript shows as the review's card.",
  },
  sideQuestions: {
    name: "Side questions",
    is: "A question answered beside the turn, without interrupting it or joining the conversation.",
    mako: "Mako asks a copy of the session, and discards the copy when the side conversation closes.",
  },
  scheduledPrompts: { name: "Scheduled prompts", is: "A prompt that runs again on an interval." },
  cloudRuns: { name: "Cloud runs", is: "A conversation handed to the harness's cloud, or started there." },
  backgroundSessions: {
    name: "Background sessions",
    is: "A conversation goes on with no terminal open.",
    mako: "Mako runs every conversation in its host, with no terminal open.",
  },
  fileRewind: {
    name: "File rewind",
    is: "Files put back as they were before a turn.",
    mako: "Rewind restores Mako's workspace checkpoint from before the turn.",
  },
  worktrees: {
    name: "Worktrees",
    is: "Work in a Git worktree of its own.",
    mako: "A Thread moves into a worktree of its own, and its conversations run there.",
  },
  computerUse: {
    name: "Computer use",
    is: "The agent drives a browser or the Mac.",
    mako: "Mako's browser and computer control, through its `mako-computer` MCP server.",
  },
  notifications: {
    name: "Notifications",
    is: "You hear when a turn ends or needs you.",
    mako: "Mako's desktop notifications.",
  },
  folderTrust: { name: "Folder trust", is: "The harness asks before it trusts a project folder." },
  editApprovals: { name: "Edit before approving", is: "A command or tool input changed in its approval, then run." },
  plugins: { name: "Plugins", is: "Packages of commands, skills, agents and hooks the harness loads." },
  responseStyle: { name: "Response style", is: "A saved style for how the agent writes its replies." },
  webSearch: { name: "Web search", is: "The agent searches the web.", tools: "web-search" },
  imageGeneration: { name: "Image generation", is: "The agent makes or edits images.", tools: "image" },
  codeMode: { name: "Code mode", is: "The agent calls its tools from a script it writes.", tools: "code" },
} as const satisfies Record<string, FeatureInfo>

export type HarnessFeatureKey = keyof typeof HARNESS_FEATURES
export const HARNESS_FEATURE_KEYS: readonly HarnessFeatureKey[] = [
  "goals",
  "review",
  "sideQuestions",
  "scheduledPrompts",
  "cloudRuns",
  "backgroundSessions",
  "fileRewind",
  "worktrees",
  "computerUse",
  "notifications",
  "folderTrust",
  "editApprovals",
  "plugins",
  "responseStyle",
  "webSearch",
  "imageGeneration",
  "codeMode",
]

/** What a harness calls a feature, as the person types or sees it (`name`), and where it has it (`where`). */
export interface NativeFeature {
  name: string
  where: string
}

type NotImplemented = Exclude<Capability, { state: "implemented" }>

/** Where Mako stands on one feature for one harness, as its definition says it. */
export type FeatureStanding =
  /** The harness's own implementation, shown in Mako. */
  | { state: "implemented"; through: "harness"; via: string }
  /** The harness's own, shown as its tool rows; the vocabulary names them. */
  | { state: "implemented"; through: "tools" }
  /** Mako's own implementation, with anything particular to this harness. */
  | { state: "implemented"; through: "mako"; note?: string }
  | NotImplemented

/** One harness's declaration of one shared feature: its own form, if it has one, and where Mako stands. */
export interface FeatureDeclaration {
  native?: NativeFeature
  mako: FeatureStanding
}

export type FeatureDeclarations = Record<HarnessFeatureKey, FeatureDeclaration>

/** A feature as the window reads it: the harness's own form, and whose implementation runs, or why none does. */
export interface HarnessFeature {
  native?: NativeFeature
  mako: Capability<{ through: "harness" | "mako" }>
}

export type HarnessFeatures = Record<HarnessFeatureKey, HarnessFeature>

export const native = (name: string, where: string): NativeFeature => ({ name, where })
export const shownAs = (via: string): FeatureStanding => ({ state: "implemented", through: "harness", via })
export const TOOL_ROWS: FeatureStanding = { state: "implemented", through: "tools" }
export const makosOwn = (note?: string): FeatureStanding =>
  note === undefined ? { state: "implemented", through: "mako" } : { state: "implemented", through: "mako", note }

export const TOOL_ROWS_VIA = "Its tool rows in the transcript."

/** Where Mako shows one of a harness's own features: its tool rows, or why nothing does. */
export type UniqueShown = { state: "implemented"; via: string; tools: readonly string[] } | NotImplemented

/**
 * Something only this harness has, as its own types, docs or binary show it
 * (`native`), and where it stands in Mako (`mako`): `shownInTools(names)`,
 * each name in the harness's vocabulary, `byDefault`, `noOp`, or `makoLacks`
 * for a gap. A feature in `HARNESS_FEATURES`, or one a declared field
 * carries, is shared, so it isn't listed here.
 */
export interface UniqueCapability {
  name: string
  native: string
  mako: UniqueShown
}

export const shownInTools = (tools: readonly string[]): UniqueShown => ({ state: "implemented", via: TOOL_ROWS_VIA, tools })

/** What the person gets from an artifact preview, and the files it covers. */
export type ArtifactCapability = Capability<{ name: string; files: readonly string[] }>
