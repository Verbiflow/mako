import { DEVIN_ACP_HOOKS } from "@mako/sessions/harnesses"
import { prepareDevinMcp } from "./session-mcp.js"
import { devinResumePolicy } from "./resume.js"
import type { ProviderAcpSource } from "../acp-source.js"
import { devinExecutable } from "./executable.js"
import { devinPermissionTitle } from "./permissions.js"
import { configureDevinEnvironment } from "./environment.js"
import { devinCompaction } from "./compaction.js"
import { DevinAgents } from "./agents.js"
import { devinBackground } from "./background.js"
import { devinProviderTurns } from "./provider-turns.js"
import { devinNotification } from "./notifications.js"
import { devinMcpStartup } from "./mcp-startup.js"
import { DevinPlans } from "./plans.js"
import { DevinApprovalObserver, readDevinApprovalDecisions } from "./approval-observer.js"
import { hostWarn } from "../../host-log.js"
import { devinUsageUpdate } from "./usage.js"

const { nativeSource, ...resume } = devinResumePolicy()

export const devinAcpSource: ProviderAcpSource = {
  nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
  nativeSource,
  resume: {
    kind: "native",
    via: "ACP `session/load` with the session ID.",
    wake: "The next message starts a new `devin` ACP agent that loads the session, replaying its history.",
    ...resume,
  },
  fork: { kind: "import", via: "Mako writes the conversation up to the fork point into a new Devin session and resumes it, as its ACP agent has no fork." },
  questions: { kind: "request", via: "The `ask_user_question` tool's request." },
  provider: "devin",
  approvalEvidence: { kind: "native-decisions", recovery: "retained-observer", nativeRequests: ["structured-question"], coverage: "Structured question selections from exact native tool events and the saved main branch. Tool permission choices remain submission-only." },
  planning: { via: "mode", mode: "plan", proposal: "write_plan's rendered plan file, built by answering exit_plan_mode's permission request" },
  ...DEVIN_ACP_HOOKS,
  clientCapabilities: { _meta: { "cognition.ai/subagentSupport": true } },
  agents: { kind: "observed", via: "`run_subagent` calls, whose usage arrives tagged with the subagent's ID.", observe: input => new DevinAgents(input) },
  observeBackground: devinBackground,
  providerTurns: devinProviderTurns,
  decodeNotification: devinNotification,
  usageUpdate: devinUsageUpdate,
  mcpStartup: devinMcpStartup,
  plans: () => new DevinPlans(),
  permissionTitle: devinPermissionTitle,
  backgroundStop: { kind: "ends-on-stop", how: "Stop kills each running background shell with killBackgroundShell, and its session/cancel ends each background subagent, with or without a running turn; no turn follows. Closing closes stdin, which ends them; a signal would leave them running." },
  compaction: devinCompaction,
  steering: { kind: "supported", via: "A prompt sent while a turn runs is read at its next step.", wire: "concurrent-prompt" },
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
      prepareMcp: prepareDevinMcp,
      async prepareApprovals({ previous, publish }) {
        if (options.nativePath && options.resume) {
          try {
            for (const decision of readDevinApprovalDecisions(options.nativePath, previous.filter(p => p.sessionId === options.resume))) publish(decision)
          } catch { hostWarn("devin", "Native answer history could not be reconciled") }
        }
        return new DevinApprovalObserver(publish, previous)
      },
    }
  },
}
import { NO_NATIVE_PROMPT_IDENTITY } from "../../contracts/native-prompt-identity.js"
