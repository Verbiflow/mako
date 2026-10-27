import type { NativeStores } from "@mako/sessions/read-only-sqlite"
import { DEVIN_ACP_HOOKS, devinUsageReading } from "@mako/sessions/harnesses"
import { prepareDevinMcp } from "./session-mcp.js"
import { devinResumePolicy } from "./resume.js"
import type { ProviderAcpSource } from "../acp-source.js"
import { devinExecutable } from "./executable.js"
import { devinPermissionTitle } from "./permissions.js"
import { configureDevinEnvironment } from "./environment.js"
import { devinCompaction } from "./compaction.js"
import { DevinAgents, devinChildUpdate } from "./agents.js"
import { devinBackground } from "./background.js"
import { devinProviderTurns } from "./provider-turns.js"
import { devinNotification } from "./notifications.js"
import { devinMcpStartup } from "./mcp-startup.js"
import { DevinPlans } from "./plans.js"
import { hostWarn } from "../../base/host-log.js"
import { devinCheckpoint, devinFork } from "./fork.js"
import { devinSideQuestions } from "./side-questions.js"
import { NO_NATIVE_PROMPT_IDENTITY } from "../../contracts/native-prompt-identity.js"
import { adapters } from "../heavy.js"

/** Devin's ACP source, reading Devin's store as `stores` opens it. */
export function createDevinAcpSource(stores: NativeStores): ProviderAcpSource {
  const { nativeSource, ...resume } = devinResumePolicy(stores)
  return {
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    nativeSource,
    resume: {
      kind: "native",
      via: "ACP `session/load` with the session ID.",
      wake: "The next message starts a new `devin` ACP agent that loads the session, replaying its history.",
      ...resume,
      elsewhere: {
        via: "The same `session/load` with the new folder as its `cwd`; Devin's store is global and keeps the first folder on record.",
        verified: "scripts/test-devin-relocate-live.ts against devin 3000.10.23 (Devin.app's CLI), signed in: loaded with its turns, and its next turn remembered them and named the new folder.",
      },
    },
    fork: {
      kind: "native",
      point: "checkpoint",
      via: "Devin's revert extension: `forkFromStep` copies the session through the node its history ended at when the turn did. A turn from before Mako recorded that node goes as a transcript.",
      checkpoint: (session) => devinCheckpoint(stores, session),
      open: devinFork,
    },
    questions: { kind: "request", via: "The `ask_user_question` tool's request." },
    provider: "devin",
    approvalEvidence: { kind: "native-decisions", recovery: "retained-observer", nativeRequests: ["structured-question"], coverage: "Structured question selections from exact native tool events and the saved main branch. Tool permission choices remain submission-only." },
    planning: { via: "mode", mode: "plan", proposal: "write_plan's rendered plan file, built by answering exit_plan_mode's permission request",
      feedback: { kind: "next-message", reason: "its plan approval is ACP's session/request_permission, whose answer is an option id, and devin 3000.10.23 reads no words with a rejection." } },
    ...DEVIN_ACP_HOOKS,
    clientCapabilities: { _meta: { "cognition.ai/subagentSupport": true } },
    agents: { kind: "observed", via: "`run_subagent` calls, whose usage arrives tagged with the subagent's ID.", child: devinChildUpdate, observe: input => new DevinAgents(input) },
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
    goals: { kind: "mako", reason: "Devin has no goal; its `/loop` repeats one prompt until a review of the diff passes." },
    sideQuestions: devinSideQuestions,
    review: {
      kind: "mako",
      reason: "Devin has no command that only reviews: its `/loop` reviews the diff and fixes it. It has a read-only review subagent, which Mako's prompt hands the review to.",
      reviewer: "Hand the review to your review subagent: call `run_subagent` with the `subagent_review` profile, and report what it finds.",
    },
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
        // Its handshake's `agentInfo.version` is `0.0.0-dev` from every release (3000.10.23 and 3000.11.205 alike), which
        // names no build; `devin --version` names it (`devin 3000.11.205 (6dea39440ae3)`), in about 10 ms. The version a
        // launch runs is what Mako stamps the session's records with, which a restore weighs (`restoreGate`).
        versionArgs: ["--version"],
        configureEnvironment: configureDevinEnvironment,
        prepareMcp: prepareDevinMcp,
        async prepareApprovals({ previous, publish }) {
          const { DevinApprovalObserver, readDevinApprovalDecisions } = await adapters.devinApprovals.load("devin approvals")
          if (options.nativePath && options.resume) {
            try {
              for (const decision of readDevinApprovalDecisions(stores, options.nativePath, previous.filter(p => p.sessionId === options.resume))) publish(decision)
            } catch { hostWarn("devin", "Native answer history could not be reconciled") }
          }
          return new DevinApprovalObserver(publish, previous)
        },
      }
    },
  }
}
