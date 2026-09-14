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
 * The tier a thread's reported approval/sandbox pair amounts to. `turn/start`
 * overrides are sticky, so the pair the thread response reports is what the
 * session opened with. Anything read-only asks; workspace-write with the
 * auto reviewer is auto review; workspace-write otherwise accepts edits;
 * danger-full-access waits for nothing.
 */
export function codexObservedTier(reported: {
  approvalPolicy?: AskForApproval | null
  approvalsReviewer?: ApprovalsReviewer | null
  sandbox?: SandboxPolicy | null
}): AccessTier {
  const sandbox = reported.sandbox?.type
  if (sandbox === "dangerFullAccess") return "full"
  if (sandbox === "workspaceWrite")
    return reported.approvalsReviewer === "auto_review" ? "auto" : "edits"
  return "ask"
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
