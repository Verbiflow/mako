import { NO_NATIVE_PROMPT_IDENTITY } from "../../contracts/native-prompt-identity.js"
import { codexQuestionAnswer } from "./questions.js"
import { readCodexQuestionHistory } from "./question-reader.js"
import { codexExecutableCandidates } from "./executable.js"
import { codexAccessModes, CODEX_DEFAULT_MODE } from "./access.js"
import { CODEX_PLAN_OPTION } from "@mako/sessions/model-catalog"
import type { ProviderLiveDriver } from "../live-driver.js"
import { fileResumeEvidence } from "../../native-continuation.js"
import { codexProcessProbe } from "./process-probe.js"
import { NO_NATIVE_EXCLUSION } from "../../contracts/execution-context.js"

export const CODEX_NATIVE_IDENTITY = { kind: "reported", via: "app-server account/read" } as const

export const codexLiveDriver: ProviderLiveDriver = {
  ...fileResumeEvidence(codexProcessProbe),
  provider: "codex",
  launchEnvironment: { kind: "prepared", via: "app-server spawn consumes ProviderStartOptions.accountLaunch." },
  nativeIdentity: CODEX_NATIVE_IDENTITY,
  nativeExclusion: NO_NATIVE_EXCLUSION,
  nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
  sessionQuestions: { encodeAnswer: codexQuestionAnswer, history: readCodexQuestionHistory },
  approvalEvidence: { kind: "native-decisions", recovery: "retained-observer", nativeRequests: ["tool-permission"], coverage: "Native codex.tool_decision user events confirm once/session/decline/abort for a unique command or file approval. Repeated tool IDs, amendments and other request families remain unconfirmed. Normalized decisions survive reconnect; request-resolved alone is not confirmation." },
  planning: { via: "setting", option: CODEX_PLAN_OPTION.id, proposal: "The Plan collaboration mode's plan item, built by a message that asks for the implementation" },
  observesNativeAgents: true,
  canResume: true,
  forkPoint: "run",
  backgroundStop: { kind: "ends-on-stop", how: "Stop terminates exact native terminal IDs before interruption and checks again after settlement, including child threads. Stopped turn IDs retain a bounded guard for commands reported after interruption; failed native termination disconnects instead of claiming cleanup. Checked on Codex 0.159.3: foreground child exit and same-session follow-up. Closing ends terminals and subagents before the app-server exits." },
  turnRecovery: {
    kind: "continues",
    accepted: "The turn/start response, which names the turn Codex began, before any of the turn runs.",
    exit: "The app-server's exit, or a stdin or spawn error, settles the session failed and disconnected in one update; the rollout path was reported when the thread started.",
    tests: ["scripts/test-turn-recovery-live.mjs"],
  },
  steer: async (...args) =>
    (await import("../../codex-app.js")).codexAppSteer(...args),
  // Re-probed 2026-09-14 (app-server 0.147.0): after thread/compact/start a
  // resumed thread keeps the original turns' items and gains a
  // contextCompaction record — the earlier drop is fixed.
  compaction: {
    kind: "supported",
    start: async (id, actionId) =>
      (await import("../../codex-app.js")).codexAppCompact(id, actionId),
  },
  available: () => codexExecutableCandidates().length > 0,
  start: async (...args) =>
    (await import("../../codex-app.js")).codexAppStart(...args),
  prompt: async (...args) =>
    (await import("../../codex-app.js")).codexAppPrompt(...args),
  permission: async (id, requestId, response, dispatch) => {
    const { codexAppPermission } = await import("../../codex-app.js")
    dispatch.assertCurrent()
    dispatch.report(codexAppPermission(id, requestId, response))
  },
  cancel: async (id) => (await import("../../codex-app.js")).codexAppCancel(id),
  close: async (id) => (await import("../../codex-app.js")).codexAppClose(id),
  steering: "step",
  modes: codexAccessModes(),
  defaultMode: CODEX_DEFAULT_MODE,
  setMode: async (...args) => {
    ;(await import("../../codex-app.js")).codexAppSetMode(...args)
  },
}
