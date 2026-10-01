import { z } from "zod"
import { backgroundCommandLabel } from "@mako/sessions"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { GrokAgents } from "./agents.js"
import { grokAskOverride } from "./claude-permissions.js"
import { grokNotification } from "./notifications.js"
import { grokPlans, grokRequests } from "./plans.js"
import { grokToolName } from "./tool-name.js"
import { resolveExecutable } from "../../executable.js"
import type { AcpLaunch, ProviderAcpSource } from "../acp-source.js"
import type { AccessTier } from "../../contracts/access.js"

/**
 * Verified 2026-09-11 against grok 1.0.25 over `agent stdio`: a second
 * session/prompt is queued behind the running turn (eight tool calls ran
 * after it), so Grok advertises no steering. In every permission mode except
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
 * rejected plan keeps it in plan. It lists no session modes, and a loaded
 * session starts outside plan. The `--permission-mode plan` flag is weaker:
 * it asks before an edit instead of refusing it, so Mako does not launch
 * with it. The default tier is pinned explicitly: without it an unchosen
 * session ran Grok's own default while the desk reported nothing.
 */
/**
 * Grok writes `<workspace>/<id>/updates.jsonl` (`chat_history.jsonl` before
 * 1.0) under ~/.grok/sessions, one folder per URL-encoded launch directory;
 * the other folders are searched when the directory was spelled differently,
 * as a macOS temporary path is under /private.
 */
export function grokSessionSource(
  nativeId: string,
  cwd: string,
  root = join(homedir(), ".grok", "sessions")
): string | undefined {
  if (!/^[\w-]+$/.test(nativeId)) return undefined
  let workspaces: string[]
  try {
    workspaces = readdirSync(root)
  } catch {
    return undefined
  }
  const launched = encodeURIComponent(cwd)
  for (const workspace of [launched, ...workspaces.filter((name) => name !== launched)])
    for (const transcript of ["updates.jsonl", "chat_history.jsonl"]) {
      const path = join(root, workspace, nativeId, transcript)
      if (existsSync(path)) return path
    }
  return undefined
}

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
  provider: "grok",
  approvalEvidence: { kind: "submission-only", reason: "Grok asks through session/request_permission and its plan approval request; Mako sends the answer but reads no native record of the decision." },
  planning: { via: "mode", mode: "plan", proposal: "exit_plan_mode's plan, replaced by the plan file's text once approved, built by answering its permission request" },
  async observeAgents({ env, ...input }) {
    const observer = new GrokAgents({ ...input, home: env.GROK_HOME ?? join(homedir(), ".grok") })
    await observer.ready
    return observer
  },
  compaction: { kind: "unavailable", reason: "Grok's ACP connection does not provide verified compaction. Start a new thread and carry over what matters." },
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
        interrupted: /cancel|interrupt|abort/i.test(parsed.data.update.stop_reason ?? ""),
      }
    },
  }),
  decodeNotification: grokNotification,
  plans: grokPlans,
  requests: grokRequests,
  toolName: grokToolName,
  canResume: true,
  locateSession: ({ nativeId, cwd }) => grokSessionSource(nativeId, cwd),
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
    const override = options.access === "ask" ? grokAskOverride(options.cwd, options.env?.HOME || homedir()) : undefined
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
      args,
      configureEnvironment(env) {
        env.GROK_DISABLE_AUTOUPDATER = "1"
      },
    }
    if (override) {
      launch.notices = [override.notice]
      if (override.access) launch.access = override.access
    }
    return launch
  },
}
