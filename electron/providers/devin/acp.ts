import { DEVIN_ACP_HOOKS, devinUsageReading } from "@mako/sessions/harnesses"
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
import { devinCheckpoint, devinFork } from "./fork.js"
import { NO_NATIVE_PROMPT_IDENTITY } from "../../contracts/native-prompt-identity.js"

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
  fork: {
    kind: "native",
    point: "checkpoint",
    via: "Devin's revert extension: `forkFromStep` copies the session through the node its history ended at when the turn did. A turn from before Mako recorded that node is imported.",
    checkpoint: devinCheckpoint,
    open: devinFork,
  },
  questions: { kind: "request", via: "The `ask_user_question` tool's request." },
  provider: "devin",
  approvalEvidence: { kind: "native-decisions", recovery: "retained-observer", nativeRequests: ["structured-question"], coverage: "Structured question selections from exact native tool events and the saved main branch. Tool permission choices remain submission-only." },
  planning: { via: "mode", mode: "plan", proposal: "write_plan's rendered plan file, built by answering exit_plan_mode's permission request",
    feedback: { kind: "next-message", reason: "its plan approval is ACP's session/request_permission, whose answer is an option id, and devin 3000.10.23 reads no words with a rejection." } },
  ...DEVIN_ACP_HOOKS,
  clientCapabilities: { _meta: { "cognition.ai/subagentSupport": true } },
  agents: { kind: "observed", via: "`run_subagent` calls, whose usage arrives tagged with the subagent's ID.", observe: input => new DevinAgents(input) },
  observeBackground: devinBackground,
  providerTurns: devinProviderTurns,
  decodeNotification: devinNotification,
  usageUpdate: (meta) => {
    const reading = devinUsageReading(meta)
    return reading.of === "repeat" ? reading : { of: reading.of, observations: reading.tokens ? [{ kind: "spent", tokens: reading.tokens }] : [] }
  },
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
