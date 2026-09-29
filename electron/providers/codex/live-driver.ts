import { codexQuestionAnswer } from "./questions.js"
import { readCodexQuestionHistory } from "./question-reader.js"
import { codexExecutableCandidates } from "./executable.js"
import { codexAccessModes, CODEX_DEFAULT_MODE } from "./access.js"
import type { ProviderLiveDriver } from "../live-driver.js"

export const codexLiveDriver: ProviderLiveDriver = {
  provider: "codex",
  sessionQuestions: { encodeAnswer: codexQuestionAnswer, history: readCodexQuestionHistory },
  approvalEvidence: { kind: "native-decisions", recovery: "retained-observer", nativeRequests: ["tool-permission"], coverage: "Native codex.tool_decision user events confirm once/session/decline/abort for a unique command or file approval. Repeated tool IDs, amendments and other request families remain unconfirmed. Normalized decisions survive reconnect; request-resolved alone is not confirmation." },
  observesNativeAgents: true,
  canResume: true,
  forkPoint: "run",
  backgroundStop: { kind: "ends-on-stop", how: "Stop cleans the thread's background terminals once the interrupted turn settles, and at once with no turn running; it interrupts each subagent thread's turn and cleans its terminals too. Closing does both before the app-server exits. Codex 0.154 keeps terminals and subagents through an interrupt, which adds the running command, and past the app-server's exit." },
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
