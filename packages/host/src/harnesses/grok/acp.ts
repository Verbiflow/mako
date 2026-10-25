import { grokBackground } from "./background.js"
import { z } from "zod"
import { grokHome } from "@mako/sessions"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { GrokAgents } from "./agents.js"
import { GROK_OWN_PERMISSIONS, grokLaunchNotices, grokPermissionPolicy } from "./permission-policy.js"
import { grokMcpStartup } from "./mcp-startup.js"
import { grokNotification } from "./notifications.js"
import { grokChildSpend, grokModelWindow } from "./usage.js"
import { GROK_FOLDER_TRUST_CAPABILITY } from "./folder-trust.js"
import { grokFork, GrokTurnCounts } from "./fork.js"
import { grokRequests } from "./plans.js"
import { GROK_TRANSCRIPTS, grokSessionSource, relocateGrokSession } from "./session-source.js"
import { GROK_ACP_HOOKS, GrokSubagentFinished, GrokSubagentSpawned, grokSubagentTurn, GrokTaskSnapshot, grokTaskTurn } from "@mako/sessions/harnesses"
import { resolveExecutable } from "../../base/executable.js"
import type { AcpLaunch, ProviderAcpSource } from "../acp-source.js"
import { untilStopped, withEarlierExchanges } from "../../contracts/live-side-questions.js"
import type { AccessTier } from "../../contracts/access.js"
import { fileResumeEvidence } from "../native-continuation.js"
import { grokSessionCheckpoint } from "./session-checkpoint.js"
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

const InterjectQueued = z.object({ result: z.object({ status: z.literal("queued") }) })

/** `_x.ai/btw`'s reply, checked against grok 1.0.46. */
const BtwAnswer = z.object({ result: z.object({ answer: z.string() }) })

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
    task_snapshot: GrokTaskSnapshot,
  }),
})

/**
 * A background subagent finishing wakes Grok the same way (grok 1.0.44): it
 * reports `subagent_finished` with `will_wake`, runs a turn, and ends it
 * with `turn_completed`. Checked against grok 1.0.46 with its own model
 * (scripts/probe-provider-turn.mjs, 2026-10-12): the wake turn's report,
 * name and duration are the ones its store keeps, and a finish reported
 * while the parent's turn still ran woke Grok once that turn completed. Its store keeps these under `_x.ai/session/update`,
 * as it keeps `turn_completed`, which the live wire sends as a session
 * notification.
 */
const GrokSubagentSchema = z.object({
  sessionId: z.string(),
  update: z.union([GrokSubagentSpawned, GrokSubagentFinished]),
})

const GrokTurnCompletedSchema = z.object({
  sessionId: z.string(),
  update: z.object({
    sessionUpdate: z.literal("turn_completed"),
    stop_reason: z.string().nullish(),
  }),
})

export function createGrokAcpSource(): ProviderAcpSource {
  const counts = new GrokTurnCounts()
  return {
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    resume: {
      kind: "native",
      via: "ACP `session/load` with the session ID.",
      wake: "The next message starts a new `grok` ACP agent that loads the session, replaying its history.",
      ...fileResumeEvidence(grokProcessProbe, grokSessionCheckpoint),
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
      via: "Grok's `x.ai/session/fork` copies the session through the turn its saved updates counted when the turn ended (`targetPromptIndex`). A turn from before Mako counted it, or a fork into another folder, goes as a transcript.",
      checkpoint: (session) => counts.checkpoint(session),
      open: grokFork,
    },
    questions: { kind: "request", via: "`_x.ai/ask_user_question` requests from the `ask_user_question` tool." },
    // grok 1.0.46 writes chat_history.jsonl from the first prompt and updates.jsonl
    // when a turn ends, so a session saved mid-turn names the other file. The
    // store is Grok's sessions folder: the launch directory's folder under it
    // only files the session, and moving into another one (`elsewhere`) keeps it.
    nativeSource: (path, nativeId) => {
      const folder = dirname(path)
      return GROK_TRANSCRIPTS.includes(basename(path)) && basename(folder) === nativeId
        ? { path: dirname(dirname(folder)), record: `grok-session:${nativeId}` } : undefined
    },
    provider: "grok",
    approvalEvidence: {
      kind: "native-decisions",
      recovery: "retained-observer",
      nativeRequests: ["tool-permission"],
      coverage: "Shell command approvals: the command running or failing, and whether Grok saved it to its project's permission.toml, say which of Yes, Yes and don't ask again, No, and No and don't ask again it applied. Edit, MCP and plan approvals keep their grants in memory and stay submission-only.",
    },
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
    // Goal mode is on unless the person's config turns `goal.enabled` off (grok 1.0.46).
    // Grok refuses a new objective while a goal is unfinished, and resumes only a paused one.
    sideQuestions: {
      kind: "native",
      // grok 1.0.46 answers each one alone, from the conversation, and keeps it out of the conversation's history.
      via: "Its `/btw`, through `_x.ai/btw`, with the side conversation's earlier exchanges ahead of each follow-up.",
      ask: async (peer, { question, earlier, signal }) => {
        const reply = await untilStopped(peer.extMethod("_x.ai/btw", { sessionId: peer.sessionId, question: withEarlierExchanges(question, earlier) }), signal)
        const parsed = BtwAnswer.safeParse(reply)
        if (!parsed.success) throw new Error(`Grok answered the side question in a form Mako doesn't read: ${JSON.stringify(reply)?.slice(0, 200)}`)
        return parsed.data.result.answer
      },
    },
    goals: {
      kind: "native",
      via: "The `/goal` command as a message, with `--budget`, `pause`, `resume` and `clear`; `goal_updated` reports it.",
      budget: "harness",
      send: (command) => {
        switch (command.kind) {
          case "set":
            return { via: "message", texts: command.replacing ? ["/goal clear", grokGoal(command.objective, command.tokenBudget)] : [grokGoal(command.objective, command.tokenBudget)] }
          case "resume":
            return { via: "message", texts: command.from === "paused" ? ["/goal resume"] : ["/goal clear", grokGoal(command.objective, command.tokenBudget)] }
          case "pause":
            return { via: "message", texts: ["/goal pause"] }
          case "clear":
            return { via: "message", texts: ["/goal clear"] }
        }
      },
    },
    review: { kind: "mako", reason: "Grok has no review command; a skill can add one." },
    // grok 1.0.46 advertises `image: false`, and read the session-flows image inline, with no tool call.
    readsUnadvertised: { image: { verified: "grok 1.0.46, 2026-10-05: an inline image block, counted correctly" } },
    backgroundStop: { kind: "ends-on-stop", how: "While tasks run, Stop closes the session, which ends them, and resumes it in the same process, with or without a running turn. Stop's session/cancel ends a subagent's work with no turn running too, checked on grok 1.0.41. Closing sends session/close too." },
    observeBackground: grokBackground,
    providerTurns: () => {
      /** What each subagent was spawned to do, by id, so the turn its finish wakes can name it. */
      const subagents = new Map<string, string>()
      return {
        cause(method, params) {
          if (method === "_x.ai/session_notification" || method === "_x.ai/session/update") {
            const parsed = GrokSubagentSchema.safeParse(params)
            if (!parsed.success) return undefined
            const update = parsed.data.update
            if (update.sessionUpdate === "subagent_spawned") {
              if (update.description) subagents.set(update.subagent_id, update.description)
              if (subagents.size > 256) subagents.delete(subagents.keys().next().value!)
              return undefined
            }
            if (!update.will_wake) return undefined
            return { sessionId: parsed.data.sessionId, wakes: true, ...grokSubagentTurn(update, subagents.get(update.subagent_id)) }
          }
          if (method !== "_x.ai/task_completed") return undefined
          const parsed = GrokTaskCompletedSchema.safeParse(params)
          if (!parsed.success) return undefined
          return { sessionId: parsed.data.sessionId, ...grokTaskTurn(parsed.data.update.task_snapshot) }
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
      }
    },
    decodeNotification: grokNotification,
    childSpend: grokChildSpend,
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
      const notices = grokLaunchNotices(grokPermissionPolicy({ cwd: options.cwd, home, grokHome: grokHome(options.env ?? {}, home) }), home)
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
          Object.assign(env, GROK_OWN_PERMISSIONS)
        },
        async prepareApprovals({ root, previous, publish }) {
          const folder = join(root, "grok")
          for (const decision of await readGrokApprovalDecisions(folder, previous)) publish(decision)
          const file = await grokPermissionFile(grokHome(options.env ?? {}, home), await gitRoot(options.cwd) ?? options.cwd)
          return new GrokApprovalObserver({ root: folder, file, previous, publish })
        },
      }
      if (notices.length) launch.notices = notices
      return launch
    },
  }
}
import { NO_NATIVE_PROMPT_IDENTITY } from "../../contracts/native-prompt-identity.js"
import { GrokApprovalObserver, grokPermissionFile, readGrokApprovalDecisions } from "./approval-observer.js"
import { gitRoot } from "../../tools/index.js"

/** Grok's `/goal <objective> [--budget <tokens>]`. */
function grokGoal(objective: string, tokenBudget: number | undefined): string {
  return tokenBudget === undefined ? `/goal ${objective}` : `/goal ${objective} --budget ${tokenBudget}`
}
