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
