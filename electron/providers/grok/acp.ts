import { z } from "zod"
import { backgroundCommandLabel, grokHome } from "@mako/sessions"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { GrokAgents } from "./agents.js"
import { grokLaunchPolicy, grokPermissionPolicy } from "./permission-policy.js"
import { grokMcpStartup } from "./mcp-startup.js"
import { grokNotification } from "./notifications.js"
import { grokModelWindow } from "./usage.js"
import { GROK_FOLDER_TRUST_CAPABILITY } from "./folder-trust.js"
import { grokCheckpoint, grokFork } from "./fork.js"
import { grokRequests } from "./plans.js"
import { GROK_TRANSCRIPTS, grokSessionSource, relocateGrokSession } from "./session-source.js"
import { GROK_ACP_HOOKS } from "@mako/sessions/harnesses"
import { resolveExecutable } from "../../executable.js"
import type { AcpLaunch, ProviderAcpSource } from "../acp-source.js"
import type { AccessTier } from "../../contracts/access.js"
import { fileResumeEvidence } from "../../native-continuation.js"
import { grokProcessProbe } from "./process-probe.js"

/**
 * Verified 2026-09-11 against grok 1.0.25 over `agent stdio`: a second
 * session/prompt is queued behind the running turn (eight tool calls ran
 * after it). Probed 2026-10-05 against grok 1.0.46: `_x.ai/interject`
 * `{ sessionId, text }` answers `{ result: { status: "queued" } }`, echoes the message as
 * `_x.ai/session/interjection`, and the running turn reads it before its
 * next step, so that is how Grok steers. In every permission mode except
 * always-approve the ACP server denies tool calls instead of sending
 * session/request_permission, so the host cannot approve on the user's
 * behalf; the tier is fixed by the launch flag.
 *
 * Probed 2026-09-30 against grok 1.0.44 with a scripted model: `default`
 * asks before edits and writing commands and runs read-only ones, `auto`
 * runs edits and read-only commands and asks before writing ones, and
 * `bypassPermissions` asks nothing. `acceptEdits` and `dontAsk` still ask
 * before an edit over ACP, so no tier stands on them. Permission modes are
 * launch-only: `session/set_mode` accepts `bypassPermissions` and changes
 * nothing. Plan is not: `session/set_mode` takes `plan`, which refuses every
 * edit but the plan file, and `default`, which returns to the launch tier.
 * Grok reports both through `current_mode_update`, as it does when the
 * agent enters plan itself or leaves it on an approved or abandoned plan; a
 * rejected plan keeps it in plan. It lists no session modes. A loaded
 * session keeps the mode it was left in, which Grok 1.0.46 reports only as a
 * replayed `current_mode_update`. The `--permission-mode plan` flag is weaker:
 * it asks before an edit instead of refusing it, so Mako does not launch
 * with it. The default tier is pinned explicitly: without it an unchosen
 * session ran Grok's own default while the desk reported nothing.
 */
function grokPermissionMode(tier: AccessTier): string | undefined {
  switch (tier) {
    case "ask":
      return "default"
    case "auto":
      return "auto"
    case "full":
      return "bypassPermissions"
    default:
      return undefined
  }
}

/**
 * Verified 2026-09-26 against grok 1.0.41: an `is_background` command is
 * reported through `_x.ai/session_notification` as a `background_tasks`
 * update carrying every task of the session with its status, again when one
 * finishes. Grok then starts its own turn to read the output.
 */
const InterjectQueued = z.object({ result: z.object({ status: z.literal("queued") }) })

const GrokBackgroundTasksSchema = z.object({
  sessionId: z.string(),
  update: z.object({
    sessionUpdate: z.literal("background_tasks"),
    tasks: z.array(z.object({ status: z.string() })),
  }),
})

/**
 * Verified 2026-09-27 against grok 1.0.41: when a background command settles
 * with no turn running, Grok sends `_x.ai/task_completed` with the task's
 * snapshot, runs a turn on it with no prompt pending, and ends that turn
 * with `turn_completed` on `_x.ai/session_notification`, prompt id
 * `task-completed-<task>`. Its live wire carries no user chunk for it. A
 * cancel ends that turn with stop reason `cancelled`, and a command that
 * settles during a running turn is read in that turn and starts none.
 */
const GrokTaskCompletedSchema = z.object({
  sessionId: z.string(),
  update: z.object({
    sessionUpdate: z.literal("task_completed"),
    task_snapshot: z.object({
      description: z.string().nullish(),
      command: z.string().nullish(),
      exit_code: z.number().nullish(),
      signal: z.string().nullish(),
      explicitly_killed: z.boolean().nullish(),
    }),
  }),
})

const GrokTurnCompletedSchema = z.object({
  sessionId: z.string(),
  update: z.object({
    sessionUpdate: z.literal("turn_completed"),
    stop_reason: z.string().nullish(),
  }),
})

export const grokAcpSource: ProviderAcpSource = {
  nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
  resume: {
    kind: "native",
    via: "ACP `session/load` with the session ID.",
    wake: "The next message starts a new `grok` ACP agent that loads the session, replaying its history.",
    ...fileResumeEvidence(grokProcessProbe),
    locate: ({ nativeId, cwd, env }) => grokSessionSource(nativeId, cwd, join(grokHome(env), "sessions")),
    // Grok loads a session only from its launch directory's sessions folder.
    beforeLoad: async ({ nativeId, cwd, env }) => { await relocateGrokSession({ nativeId, to: cwd, root: join(grokHome(env), "sessions") }) },
    elsewhere: {
      via: "Mako moves the session's folder under the new directory's name in Grok's sessions folder, then `session/load` from there.",
      verified: "scripts/test-grok-relocate-live.ts against grok 1.0.46 with a stand-in model: refused from another directory as saved, then loaded there with its turns once moved, and its next turn carried them.",
    },
  },
  fork: {
    kind: "native",
    point: "checkpoint",
    via: "Grok's `x.ai/session/fork` copies the session through the turn its saved updates counted when the turn ended (`targetPromptIndex`). A turn from before Mako counted it, or a fork into another folder, is imported.",
    checkpoint: grokCheckpoint,
    open: grokFork,
  },
  questions: { kind: "request", via: "`_x.ai/ask_user_question` requests from the `ask_user_question` tool." },
  // grok 1.0.46 writes chat_history.jsonl from the first prompt and updates.jsonl
  // when a turn ends, so a session saved mid-turn names the other file.
  nativeSource: (path, nativeId) => {
    const folder = dirname(path)
    return GROK_TRANSCRIPTS.includes(basename(path)) && basename(folder) === nativeId
      ? { path: folder, record: `grok-session:${nativeId}` } : undefined
  },
  provider: "grok",
  approvalEvidence: { kind: "submission-only", reason: "Grok asks through session/request_permission and its plan approval request; Mako sends the answer but reads no native record of the decision." },
  planning: { via: "mode", mode: "plan", proposal: "exit_plan_mode's plan, replaced by the plan file's text once approved, built by answering its permission request",
    feedback: { kind: "in-refusal", via: "the `feedback` of a cancelled `_x.ai/exit_plan_mode` answer, while a plan file exists; with none, Grok drops the words, so they go as the next message" } },
  agents: {
    kind: "observed",
    via: "`spawn_subagent` calls and the sessions they start.",
    async observe({ env, ...input }) {
      const observer = new GrokAgents({ ...input, home: grokHome(env) })
      await observer.ready
      return observer
    },
  },
  // Grok 1.0.44 answers /compact with `auto_compact_completed` (or
  // `_failed`) before its turn ends, the notices it sends for its own
  // compactions; the host settles the action from those.
  compaction: { kind: "supported", command: "/compact", completion: { kind: "notification", observe: () => () => undefined } },
  // grok 1.0.46 advertises `image: false`, and read the session-flows image inline, with no tool call.
  readsUnadvertised: { image: { verified: "grok 1.0.46, 2026-10-05: an inline image block, counted correctly" } },
  backgroundStop: { kind: "ends-on-stop", how: "While tasks run, Stop closes the session, which ends them, and resumes it in the same process, with or without a running turn. Stop's session/cancel ends a subagent's work with no turn running too, checked on grok 1.0.41. Closing sends session/close too." },
  observeBackground: () => ({
    extension(method, params) {
      if (method !== "_x.ai/session_notification") return undefined
      const parsed = GrokBackgroundTasksSchema.safeParse(params)
      if (!parsed.success) return undefined
      return {
        sessionId: parsed.data.sessionId,
        running: parsed.data.update.tasks.filter((task) => task.status === "running").length,
      }
    },
    /**
     * Checked on grok 1.0.41: `session/close` ends every task and the resumed
     * session keeps its context, with no turn after it. `_x.ai/task/kill` ends
     * one but always queues a turn about the kill, even when it lands before
     * the cancel, and that turn has re-run the command the user stopped.
     */
    async stop(control) {
      if (control.running) await control.reopen()
    },
  }),
  providerTurns: () => ({
    cause(method, params) {
      if (method !== "_x.ai/task_completed") return undefined
      const parsed = GrokTaskCompletedSchema.safeParse(params)
      if (!parsed.success) return undefined
      const task = parsed.data.update.task_snapshot
      return {
        sessionId: parsed.data.sessionId,
        reason: backgroundCommandLabel({
          description: task.description ?? undefined,
          command: task.command ?? undefined,
          exitCode: task.exit_code,
          signal: task.signal,
          stopped: task.explicitly_killed ?? false,
        }),
      }
    },
    ended(method, params) {
      if (method !== "_x.ai/session_notification") return undefined
      const parsed = GrokTurnCompletedSchema.safeParse(params)
      if (!parsed.success) return undefined
      return {
        sessionId: parsed.data.sessionId,
        // `interrupted` is a turn lost with Grok's process, which the host sees for itself.
        interrupted: parsed.data.update.stop_reason === "cancelled",
      }
    },
  }),
  decodeNotification: grokNotification,
  modelWindow: grokModelWindow,
  mcpStartup: grokMcpStartup,
  ...GROK_ACP_HOOKS,
  requests: grokRequests,
  clientCapabilities: { _meta: GROK_FOLDER_TRUST_CAPABILITY },
  steering: { kind: "supported", via: "`_x.ai/interject` adds the message to the running turn, read at its next step.", wire: { extension: "_x.ai/interject", taken: InterjectQueued } },
  launchOptionIds: ["effort"],
  access: {
    unlisted: [{ id: "plan", name: "Plan", description: "Reads and writes only its plan file until you approve the plan." }],
    native: { plan: "plan" },
    launchNativeMode: "default",
    launch: ["ask", "auto", "full"],
    default: "ask",
  },
  available: () => resolveExecutable("grok") !== null,
  async launch(options) {
    const permissionMode = options.access ? grokPermissionMode(options.access) : undefined
    const home = options.env?.HOME || homedir()
    const policy = grokLaunchPolicy(
      grokPermissionPolicy({ cwd: options.cwd, home, grokHome: grokHome(options.env ?? {}, home) }),
      options.access,
      home
    )
    const args = [
      ...(permissionMode ? ["--permission-mode", permissionMode] : []),
      "agent",
      "--no-leader",
    ]
    const effort = z.string().optional().parse(options.tuning?.options?.effort)
    if (effort) args.push("--reasoning-effort", effort)
    args.push("stdio")
    const launch: AcpLaunch = {
      command: "grok",
      versionArgs: ["--version"],
      args,
      configureEnvironment(env) {
        env.GROK_DISABLE_AUTOUPDATER = "1"
      },
    }
    if (policy.notices.length) launch.notices = policy.notices
    if (policy.access) launch.access = policy.access
    return launch
  },
}
import { NO_NATIVE_PROMPT_IDENTITY } from "../../contracts/native-prompt-identity.js"
