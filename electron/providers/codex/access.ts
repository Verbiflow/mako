import { z } from "zod"
import {
  accessModeId,
  accessTierInfo,
  accessTierOfModeId,
  type AccessTier,
} from "../../contracts/access.js"
import type { LiveSessionMode } from "../../shared.js"
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js"
import type { AskForApproval } from "./generated/v2/AskForApproval.js"
import type { ApprovalsReviewer } from "./generated/v2/ApprovalsReviewer.js"
import type { SandboxPolicy } from "./generated/v2/SandboxPolicy.js"

/**
 * Codex has no session mode; its approval policy, sandbox, and reviewer are
 * overridden per turn/start and stay in force for later turns. The four tiers
 * below are the pairings Codex itself documents for its own presets.
 */
export const CODEX_ACCESS_TIERS: readonly AccessTier[] = ["ask", "edits", "auto", "full"]

/**
 * What a fresh Codex session runs under when nothing was chosen. Codex's own
 * default is on-request with a read-only sandbox — everything the workspace
 * cannot grant waits for approval — which is the ask rung. A session that
 * opens under a configured policy reports its own pair instead
 * (`codexObservedTier`), so this only names the out-of-box floor.
 */
export const CODEX_DEFAULT_MODE = accessModeId("ask")

/**
 * Validate native policy before projecting it into Mako's access picker.
 * Unknown wire variants stay unclassified; they are not the default preset.
 */
export const CodexReportedAccessSchema = z.object({
  approvalPolicy: z.union([
    z.enum(["untrusted", "on-request", "never"]),
    z.object({
      granular: z.object({
        sandbox_approval: z.boolean(),
        rules: z.boolean(),
        skill_approval: z.boolean(),
        request_permissions: z.boolean(),
        mcp_elicitations: z.boolean(),
      }),
    }),
  ]).optional(),
  approvalsReviewer: z.enum(["user", "auto_review", "guardian_subagent"]).optional(),
  sandbox: z.discriminatedUnion("type", [
    z.object({ type: z.literal("dangerFullAccess") }),
    z.object({ type: z.literal("readOnly"), networkAccess: z.boolean() }),
    z.object({
      type: z.literal("externalSandbox"),
      networkAccess: z.enum(["restricted", "enabled"]),
    }),
    z.object({
      type: z.literal("workspaceWrite"),
      writableRoots: z.array(z.string()),
      networkAccess: z.boolean(),
      excludeTmpdirEnvVar: z.boolean(),
      excludeSlashTmp: z.boolean(),
    }),
  ]).optional(),
}) satisfies z.ZodType<{
  approvalPolicy?: AskForApproval
  approvalsReviewer?: ApprovalsReviewer
  sandbox?: SandboxPolicy
}>

/** Recognize native presets without treating absent/custom policy as Ask. */
export function codexObservedTier(reported: {
  approvalPolicy?: AskForApproval | null
  approvalsReviewer?: ApprovalsReviewer | null
  sandbox?: SandboxPolicy | null
}): AccessTier | null {
  const sandbox = reported.sandbox?.type
  if (sandbox === "dangerFullAccess") return "full"
  if (reported.approvalPolicy !== "on-request" && reported.approvalPolicy !== "untrusted") return null
  if (sandbox === "workspaceWrite") {
    if (reported.approvalsReviewer === "auto_review") return "auto"
    if (reported.approvalsReviewer === undefined || reported.approvalsReviewer === "user") return "edits"
  }
  if (sandbox === "readOnly" && (reported.approvalsReviewer === undefined || reported.approvalsReviewer === "user")) return "ask"
  return null
}

export function codexAccessModes(): LiveSessionMode[] {
  return CODEX_ACCESS_TIERS.map((tier) => {
    const info = accessTierInfo(tier)
    return {
      id: accessModeId(tier),
      name: info.label,
      description: info.summary,
      access: tier,
      enforcement: "provider" as const,
    }
  })
}

export function codexAccessTier(modeId: string): AccessTier {
  const tier = accessTierOfModeId(modeId)
  if (!tier || !CODEX_ACCESS_TIERS.includes(tier))
    throw new Error("Codex does not offer that access level")
  return tier
}

export type CodexTurnAccess = Pick<
  TurnStartParams,
  "approvalPolicy" | "sandboxPolicy" | "approvalsReviewer"
>

/** Applied to every turn/start once a tier is chosen; Codex keeps it for later turns. */
export function codexTurnAccess(tier: AccessTier | null): CodexTurnAccess {
  const workspaceWrite = {
    type: "workspaceWrite" as const,
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
  switch (tier) {
    case "ask":
      return {
        approvalPolicy: "untrusted",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        approvalsReviewer: "user",
      }
    case "edits":
      return { approvalPolicy: "on-request", sandboxPolicy: workspaceWrite, approvalsReviewer: "user" }
    case "auto":
      return { approvalPolicy: "on-request", sandboxPolicy: workspaceWrite, approvalsReviewer: "auto_review" }
    case "full":
      return { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "user" }
    default:
      return {}
  }
}
