import { prepareDevinMcp } from "./session-mcp.js"
import { devinResumePolicy } from "./resume.js"
import type { ProviderAcpSource } from "../acp-source.js"
import { devinExecutable } from "./executable.js"
import { devinPermissionTitle } from "./permissions.js"
import { configureDevinEnvironment } from "./environment.js"
import { devinCompaction } from "./compaction.js"
import { devinToolName } from "./tool-name.js"
import { DevinAgents } from "./agents.js"
import { DevinApprovalObserver, readDevinApprovalDecisions } from "./approval-observer.js"
import { hostWarn } from "../../host-log.js"

export const devinAcpSource: ProviderAcpSource = {
  ...devinResumePolicy(),
  provider: "devin",
  approvalEvidence: { kind: "native-decisions", recovery: "retained-observer", nativeRequests: ["structured-question"], coverage: "Structured question selections from exact native tool events and the saved main branch. Tool permission choices remain submission-only." },
  toolName: devinToolName,
  clientCapabilities: { _meta: { "cognition.ai/subagentSupport": true } },
  observeAgents: input => new DevinAgents(input),
  compaction: devinCompaction,
  canResume: true,
  steering: "concurrent-prompt",
  access: {
    native: { edits: "accept-edits", auto: "smart", chat: "ask", plan: "plan", full: "bypass" },
    default: "edits",
  },
  nativeModes: [
    { id: "accept-edits", name: "Code" },
    { id: "smart", name: "Smart" },
    { id: "ask", name: "Ask" },
    { id: "plan", name: "Plan" },
    { id: "bypass", name: "Bypass Permissions" },
  ],
  available: () => devinExecutable() !== null,
  async launch(options) {
    return {
      command: devinExecutable() ?? "devin",
      args: ["acp"],
      configureEnvironment: configureDevinEnvironment,
      permissionTitle: devinPermissionTitle,
      prepareMcp: prepareDevinMcp,
      async prepareApprovals({ previous, publish }) {
        if (options.nativePath && options.resume) {
          try {
            for (const decision of readDevinApprovalDecisions(options.nativePath, previous.filter(p => p.sessionId === options.resume))) publish(decision)
          } catch { hostWarn("devin", "Native answer history could not be reconciled") }
        }
        return new DevinApprovalObserver(publish)
      },
    }
  },
}
