import { prefetchProcess } from "../start-prefetch.js"
import { NO_NATIVE_PROMPT_IDENTITY } from "../../contracts/native-prompt-identity.js"
import { codexQuestionAnswer } from "./questions.js"
import { CodexQuestionReader } from "./question-reader.js"
import { codexExecutableCandidates, codexStartFiles } from "./executable.js"
import { codexAccessModes, CODEX_DEFAULT_MODE } from "./access.js"
import { CODEX_PLAN_OPTION } from "@mako/sessions/model-catalog"
import type { ProviderLiveDriver } from "../live-driver.js"
import type { ProviderProcessProbe } from "../../threads/index.js"
import type { CodexEngine } from "../codex-app.js"
import type { HarnessContext } from "../host.js"
import { fileResumeEvidence } from "../native-continuation.js"
import { NO_NATIVE_EXCLUSION } from "../../contracts/execution-context.js"

export const CODEX_NATIVE_IDENTITY = { kind: "reported", via: "app-server account/read" } as const

/** The app-server engine loads with the first session; a host that never opens one never loads it. */
export function createCodexLiveDriver(probe: ProviderProcessProbe, context: Pick<HarnessContext, "dataRoot" | "streams">): ProviderLiveDriver {
  const questions = new CodexQuestionReader()
  let loading: Promise<CodexEngine> | undefined
  const engine = () => (loading ??= import("../codex-app.js").then(({ createCodexEngine }) => createCodexEngine(context)))
  return {
    provider: "codex",
    launchEnvironment: { kind: "prepared", via: "app-server spawn consumes AdmittedStartOptions.accountLaunch." },
    makoInstructions: { via: "`turn/start` additionalContext as an application entry, which Codex gives the model as developer context and records as plumbing, never a user message." },
    nativeIdentity: CODEX_NATIVE_IDENTITY,
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    approvalEvidence: { kind: "native-decisions", recovery: "retained-observer", nativeRequests: ["tool-permission"], coverage: "Native codex.tool_decision user events confirm once/session/decline/abort for a unique command or file approval. Repeated tool IDs, amendments and other request families remain unconfirmed. Normalized decisions survive reconnect; request-resolved alone is not confirmation." },
    planning: { via: "setting", option: CODEX_PLAN_OPTION.id, proposal: "The Plan collaboration mode's plan item, built by a message that asks for the implementation",
      feedback: { kind: "next-message", reason: "the plan arrives as the turn ends and nothing waits on an answer." } },
    resume: {
      kind: "native",
      via: "`thread/resume` on the app-server with the thread ID.",
      wake: "The next message starts a new `codex app-server` that resumes the thread.",
      ...fileResumeEvidence(probe),
      elsewhere: {
        via: "`thread/resume` names the new folder as its `cwd`; Codex keeps rollouts by thread, and tells the model the new folder.",
        verified: "scripts/test-codex-resume-elsewhere-live.mjs against codex-cli 0.159.3 with a stand-in model.",
      },
    },
    fork: { kind: "native", point: "run", via: "`thread/fork` at a turn." },
    questions: {
      kind: "session",
      via: "`request_user_input` requests, answered on their own channel; the thread's history retires answered ones.",
      encodeAnswer: codexQuestionAnswer,
      history: (binding) => questions.read(binding),
    },
    nativeAgents: { kind: "observed", via: "`spawn_agent` calls and the agent threads they start." },
    contextBreakdown: { kind: "unavailable", reason: "The app-server reports token totals and the context window, not what fills it." },
    modeSwitching: { kind: "native", via: "Each mode is an approval policy and sandbox, sent with each turn." },
    backgroundStop: { kind: "ends-on-stop", how: "Stop terminates exact native terminal IDs before interruption and checks again after settlement, including child threads. Stopped turn IDs retain a bounded guard for commands reported after interruption; failed native termination disconnects instead of claiming cleanup. Checked on Codex 0.159.3: foreground child exit and same-session follow-up. Closing ends terminals and subagents before the app-server exits." },
    startPrefetch: {
      via: "The app-server, launched as a start launches it, through `initialize` and an ephemeral `thread/start`, with its native build read alongside.",
      files: (env) => codexStartFiles(env),
      run: async (env, cwd, owner, stop) => prefetchProcess(await (await import("../codex-app.js")).codexStartPrefetch(env, cwd), cwd, owner, stop),
    },
    turnRecovery: {
      kind: "continues",
      accepted: "The turn/start response, which names the turn Codex began, before any of the turn runs.",
      exit: "The app-server's exit, or a stdin or spawn error, settles the session failed and disconnected in one update; the rollout path was reported when the thread started.",
      tests: ["scripts/test-turn-recovery-live.mjs"],
    },
    steering: {
      kind: "supported",
      lands: "step",
      via: "`turn/steer` adds the message to the running turn, read at its next step.",
      steer: async (...args) => (await engine()).steer(...args),
    },
    // Re-probed 2026-09-14 (app-server 0.147.0): after thread/compact/start a
    // resumed thread keeps the original turns' items and gains a
    // contextCompaction record — the earlier drop is fixed.
    compaction: {
      kind: "supported",
      start: async (id, actionId) =>
        (await engine()).compact(id, actionId),
    },
    goals: {
      kind: "native",
      via: "`thread/goal/set` and `thread/goal/clear`; `thread/goal/updated` and `cleared` report it, and Codex starts each turn toward an active goal itself.",
      budget: "harness",
      send: (command) => ({ via: "call", run: async (id) => (await engine()).goal(id, command) }),
    },
    sideQuestions: {
      kind: "native",
      via: "Its `/side`, as its TUI runs it: an ephemeral `thread/fork` told the history is reference only, here with a read-only sandbox and no approvals. Each question is a turn on the fork, and closing unsubscribes it.",
      ask: async (id, question) => (await engine()).sideQuestion(id, question),
      close: async (id, side) => (await engine()).closeSide(id, side),
    },
    review: {
      kind: "native",
      via: "`review/start`, inline on the thread, as its `/review` runs it: uncommitted changes, a base branch or a commit. The turn's `exitedReviewMode` item carries the findings.",
      start: { via: "call", run: async (...args) => (await engine()).review(...args) },
    },
    available: () => codexExecutableCandidates().length > 0,
    start: async (...args) =>
      (await engine()).start(...args),
    prompt: async (...args) =>
      (await engine()).prompt(...args),
    permission: async (id, requestId, response, dispatch) => {
      const codex = await engine()
      dispatch.assertCurrent()
      dispatch.report(codex.permission(id, requestId, response))
    },
    cancel: async (id) => (await engine()).cancel(id),
    stopNativeAgent: async (id, nativeId) => (await engine()).stopBackground(id, nativeId),
    close: async (id) => (await engine()).close(id),
    modes: codexAccessModes(),
    defaultMode: CODEX_DEFAULT_MODE,
    setMode: async (...args) => {
      ;(await engine()).setMode(...args)
    },
    stop: () => {
      void loading?.then((codex) => codex.stop())
    },
  }
}
