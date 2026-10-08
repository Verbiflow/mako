import { z } from "zod"
import type { AcpDecoderHooks, AcpUserChunk } from "../acp-decoder.js"
import type { LiveUpdate } from "../live-content.js"
import { backgroundCommandLabel, PROVIDER_TURN_FALLBACK, subagentLabel } from "../provider-turn.js"
import { exclusiveTokens, inclusiveTokens, tokenCount, type HarnessTokens } from "./tokens.js"
import { defineVocabulary } from "./vocabulary.js"

/**
 * Names are `_meta["x.ai/tool"].name` on each ACP tool call. Server-side
 * search tools carry no name, only their title; `titles` names them.
 */
export const GROK_VOCABULARY = defineVocabulary({
  harness: "grok",
  checked: {
    version: "1.0.46",
    on: "2026-10-06",
    against: "the model request of grok agent stdio 1.0.46 in every Mako mode (scripts/fixtures/native-tools), and ~/.grok/sessions updates.jsonl through audit:tools",
  },
  mcp: ["s__t"],
  tools: {
    run_terminal_command: { kind: "shell" },
    monitor: { kind: "shell" },
    get_command_or_subagent_output: { kind: "shell-output", label: "Command output" },
    kill_command_or_subagent: { kind: "shell-stop" },
    read_file: { kind: "read" },
    list_dir: { kind: "list" },
    grep: { kind: "search" },
    search_replace: { kind: "edit" },
    write: { kind: "write" },
    web_search: { kind: "web-search" },
    x_search: { kind: "web-search", label: "X search", unlisted: "A server-side xAI search, reported by title; the request Grok sends defines no such tool." },
    web_fetch: { kind: "web-fetch", unlisted: "An older Grok's (last recorded 2026-09-24); 1.0.46 defines none." },
    search_tool: { kind: "tool-search" },
    todo_write: { kind: "todo" },
    spawn_subagent: { kind: "agent" },
    enter_plan_mode: { kind: "mode", label: "Plan mode" },
    exit_plan_mode: { kind: "plan-exit" },
    ask_user_question: { kind: "question" },
    use_tool: { kind: "mcp", wraps: { form: "arguments", tool: "tool_name", args: "tool_input" } },
    workflow: { kind: "agent", label: "Workflow" },
    scheduler_create: { kind: "other", label: "Schedule" },
    scheduler_delete: { kind: "other", label: "Remove schedule" },
    scheduler_list: { kind: "other", label: "Schedules" },
    send_feedback: { kind: "other", label: "Send feedback" },
    image_gen: { kind: "image" },
    image_edit: { kind: "image", label: "Edit image" },
    image_to_video: { kind: "image", label: "Generate video" },
    reference_to_video: { kind: "image", label: "Generate video" },
  },
  concepts: {
    checked: {
      version: "1.0.46",
      on: "2026-10-06",
      against: "the user guide grok 1.0.46 ships in ~/.grok/docs, grok --help, an initialize-only ACP call, and the binary through harness:self-report",
    },
    instructions: {
      files: ["Agents.md", "Claude.md", "CLAUDE.md", "CLAUDE.local.md", "AGENT.md", "AGENTS.md", ".claude/CLAUDE.md", ".claude/CLAUDE.local.md"],
      rules: [".grok/rules", ".claude/rules", ".cursor/rules"],
      user: ["~/.grok/rules", "~/.claude/rules", "~/.cursor/rules"],
      order: "Home first (Grok, Claude, Cursor), then the repo root down to the working directory, every match loaded and deeper ones winning; project files need folder trust.",
    },
    hooks: {
      config: ["~/.grok/hooks", ".grok/hooks", "~/.grok/config.toml", "~/.claude/settings.json", ".claude/settings.json", ".claude/settings.local.json", "~/.cursor/hooks.json", ".cursor/hooks.json"],
      events: [
        "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied", "Stop", "StopFailure",
        "StopCancelled", "Notification", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "SessionEnd",
      ],
      control: "UserPromptSubmit, PreToolUse and Stop block: decision allow|deny|ask|defer, exit 2 denies, other failures pass. Claude tool names map to Grok's in matchers. An ACP client registers its own through _x.ai/hooks.",
    },
    // Project folders load only once the project is trusted (`$GROK_HOME/trusted_folders.toml`).
    skills: [".grok/skills", ".claude/skills", ".cursor/skills", ".agents/skills", "~/.grok/skills", "~/.agents/skills", "~/.claude/skills", "~/.cursor/skills"],
    commands: { folders: [".grok/commands", ".agents/commands", ".claude/commands", ".cursor/commands", "~/.grok/commands", "~/.agents/commands", "~/.claude/commands", "~/.cursor/commands"] },
    agents: [".grok/agents", ".claude/agents", "~/.grok/agents", "~/.claude/agents"],
    mcpConfig: ["~/.grok/config.toml", ".grok/config.toml", "~/.claude.json", "~/.cursor/mcp.json", ".cursor/mcp.json", ".mcp.json"],
    output: {
      live: "ACP over stdio, with _x.ai extensions",
      headless: ["plain", "json", "streaming-json", "streaming-messages-json"],
      store: "~/.grok/sessions/<encoded working directory>/<id>/updates.jsonl, one ACP update per line, with summary.json and plan.md",
    },
    models: "grok models; the ACP initialize model list",
    distinct: [
      { name: "X search", via: "x_keyword_search and x_semantic_search tools" },
      { name: "Image and video generation", via: "image_gen, /imagine, /imagine-video" },
      { name: "Announcements", via: "_x.ai/announcements/update" },
      { name: "Folder trust", via: "_x.ai/folder_trust/request to a client that sets x.ai/folderTrust.interactive, saved in ~/.grok/trusted_folders.toml" },
    ],
  },
})

/** Titles that name a server-side tool, which reports no name of its own. */
const GROK_TOOL_TITLES: readonly (readonly [RegExp, string])[] = [
  [/^web search\b/i, "web_search"],
  [/^x search\b/i, "x_search"],
]

/** The part of a Grok tool call's `_meta` that names the tool. */
export const GrokToolMeta = z.object({ "x.ai/tool": z.object({ name: z.string().trim().min(1).optional() }).optional() })
export type GrokToolMeta = z.infer<typeof GrokToolMeta>

const GrokCommandOutput = z.object({ type: z.literal("Bash"), exit_code: z.number().nullish() })

/**
 * A shell command that exited non-zero, live or saved. Grok reports it
 * `completed`, keeping `failed` for a timeout or a signal; Mako shows it
 * failed, as it shows Claude's and Codex's.
 */
export function grokCommandFailed(rawOutput: z.core.util.JSONType | undefined): boolean {
  const output = GrokCommandOutput.safeParse(rawOutput)
  return output.success && output.data.exit_code != null && output.data.exit_code !== 0
}

/** Grok's name for a tool call, live or saved: `_meta["x.ai/tool"].name`, or the server-side tool its title names. */
export function grokToolName(meta: GrokToolMeta | undefined, title: string | undefined): string | undefined {
  return meta?.["x.ai/tool"]?.name ?? (title ? GROK_TOOL_TITLES.find(([pattern]) => pattern.test(title))?.[1] : undefined)
}

const RawOutput = z.json().optional().catch(undefined)
const Stamped = z.object({ eventId: z.string() }).loose()

/**
 * Grok's plan mode, recorded 2026-09-30 from grok 1.0.44 against a scripted
 * model. The agent writes `plan.md` in the session's folder, then calls
 * `exit_plan_mode`: a tool call carrying the model's own copy as
 * `planContent`. An approved call completes with the plan file's text as
 * `rawOutput.PlanReady.plan_content`, which replaces it and which a
 * reloaded session replays. The request that asks to build it is the live
 * client's (`electron/providers/grok/plans.ts`).
 */
const ExitPlanCallSchema = z.object({
  toolCallId: z.string(),
  rawInput: z.object({ planContent: z.string() }),
  _meta: z.object({ "x.ai/tool": z.object({ name: z.literal("exit_plan_mode") }) }),
})
const PlanReadySchema = z.object({
  toolCallId: z.string(),
  rawOutput: z.object({ type: z.literal("ExitPlanMode"), PlanReady: z.object({ plan_content: z.string() }) }),
})

export const grokPlanId = (sessionId: string, toolCallId: string): string => `grok:${sessionId}:${toolCallId}`

export function grokProposedPlan(id: string, text: string): LiveUpdate[] {
  return text.trim() ? [{ kind: "proposed-plan", id, text, status: "proposed", replace: true }] : []
}

/** What Grok's updates mean beyond ACP's own fields, read the same live and from `updates.jsonl`. */
/**
 * Grok records the start of the turn it runs after a background command as a
 * user chunk it wrote itself, then closes it with `turn_completed` whose
 * prompt id is `task-completed-<task>` (grok 1.0.41):
 *
 *   <system-reminder>
 *   Background task "<id>" completed (exit code: 0).
 *   Description: <description> | Duration: 8.2s
 *   …
 *
 * A background subagent that finishes while Grok is idle wakes it the same
 * way (grok 1.0.44):
 *
 *   <system-reminder>
 *   While you were idle, 1 background subagent completed:
 *   - [general-purpose] "<description>" — completed successfully (32.9s, 2 tool calls)
 *   …
 */
export function backgroundReminderLabel(text: string): string | undefined {
  const body = /^\s*<system-reminder>\s*([\s\S]*?)<\/system-reminder>\s*$/.exec(text)?.[1]
  if (!body) return undefined
  const subagents = /^While you were idle, (\d+) background subagents? \w+:/.exec(body)
  if (subagents) return subagentReminderLabel(body, Number(subagents[1]))
  const status = /^Background task "[^"]*" ([^\n(.]+)/.exec(body)?.[1]?.trim()
  if (!status) return undefined
  const exitCode = /exit code:\s*(-?\d+)/.exec(body)?.[1]
  return backgroundCommandLabel({
    description: /^Description:\s*(.*?)(?:\s*\|\s*Duration:.*)?$/m.exec(body)?.[1],
    exitCode: exitCode === undefined ? undefined : Number(exitCode),
    stopped: /kill|stop|cancel/i.test(status),
  })
}

function subagentReminderLabel(body: string, count: number): string {
  if (count !== 1) return `${count} subagents finished`
  const line = /^- \[[^\]]*\] "(.*)" — (\S+)/m.exec(body)
  const status = line?.[2] ?? ""
  return subagentLabel({
    description: line?.[1],
    state: /^complete/i.test(status) ? "completed" : /cancel|stop|kill/i.test(status) ? "cancelled" : /fail|error/i.test(status) ? "failed" : undefined,
  })
}


/**
 * A user message Grok replays on `session/load`, drawn as its store's line
 * is (`readGrokSession`): a turn Grok started itself opens as Grok's, its
 * /compact is the compaction already drawn, a background reminder opens
 * Grok's turn, and a steer is what the person typed. Grok marks the chunk
 * itself (xai-grok-shell `session/storage`).
 */
export function grokReplayedUser(update: AcpUserChunk): LiveUpdate | null | undefined {
  const meta = GrokUserMeta.parse(update._meta)
  const text = update.content.type === "text" ? update.content.text : ""
  if (meta?.hostTurn) return text.trim() === "/compact" ? null : { kind: "provider-turn", reason: backgroundReminderLabel(text) ?? PROVIDER_TURN_FALLBACK }
  const reminder = update.content.type === "text" ? backgroundReminderLabel(text) : undefined
  if (reminder) return { kind: "provider-turn", reason: reminder }
  const typed = meta?.interjection ? GrokDisplayText.safeParse(update.content._meta).data?.displayText : undefined
  return typed === undefined ? undefined : { kind: "user", text: typed, steeringFor: "running" }
}

const GrokUserMeta = z.looseObject({ hostTurn: z.boolean().optional(), interjection: z.boolean().optional() }).nullish().catch(undefined)
const GrokDisplayText = z.looseObject({ displayText: z.string() })

/**
 * How Mako reads each of Grok's session updates beyond ACP's own (the kinds
 * of its `SessionUpdate`, xai-org/grok-build 1.0.45
 * `extensions/notification.rs`), live and saved alike. A kind missing here
 * is unknown, and kept as such.
 *
 * - `marker`: a transcript fact, drawn by `grokUpdateMarker`.
 * - `activity`: what Grok is doing or the session's title, shown live only.
 * - `observed`: read by other observers: background tasks, the turns Grok
 *   starts itself, and subagents, which Mako follows through their
 *   `meta.json`. A `turn_completed` also says why Grok ended the turn
 *   itself, which is drawn.
 * - `ignored`: Grok's own bookkeeping and streaming detail, already shown
 *   through ACP's updates or not about the conversation.
 */
export const GROK_UPDATES: Record<string, "marker" | "activity" | "observed" | "ignored"> = {
  auto_compact_completed: "marker",
  auto_compact_failed: "marker",
  model_auto_switched: "marker",
  retry_state: "marker",
  image_dropped: "marker",
  hook_annotation: "marker",
  scheduled_task_created: "marker",
  scheduled_task_fired: "marker",
  scheduled_task_deleted: "marker",
  auto_recovery_started: "marker",
  auto_recovery_exhausted: "marker",
  auto_compact_started: "activity",
  auto_compact_cancelled: "activity",
  session_summary_generated: "activity",
  background_tasks: "observed",
  task_completed: "observed",
  turn_completed: "observed",
  subagent_spawned: "observed",
  subagent_finished: "observed",
  task_backgrounded: "ignored",
  compaction_checkpoint: "ignored",
  session_recap: "ignored",
  session_recap_unavailable: "ignored",
  subagent_progress: "ignored",
  turn_usage: "ignored",
  reasoning_completed: "ignored",
  tool_call_delta_chunk: "ignored",
  diff_review: "ignored",
  pending_interaction: "ignored",
  interaction_resolved: "ignored",
  plan_kept: "ignored",
  plan_cleared: "ignored",
  plan_executing: "ignored",
  goal_updated: "ignored",
  workflow_updated: "ignored",
  rewind_marker: "ignored",
  hook_run_started: "ignored",
  hook_execution: "ignored",
  hooks_changed: "ignored",
  plugins_changed: "ignored",
  plugin_updates_installed: "ignored",
  session_status: "ignored",
  relay_sync_status: "ignored",
  last_turn_summary: "ignored",
  served_model: "ignored",
  image_compressed: "ignored",
  // The end of the turn Grok continues after compacting; its `turn_completed` follows.
  auto_continue_completed: "ignored",
  // Grok asking for a rating of the session, which it shows only in its own pager.
  feedback_request: "ignored",
  // A monitor's output lines, which reach the model in its reminders.
  monitor_event: "ignored",
  // `session/set_config_option` answers with the model, and `config_option_update` shows it.
  model_changed: "ignored",
}

/** Grok's memory and response streaming detail, every kind of which is `ignored`. */
const GROK_IGNORED_PREFIXES = ["memory_", "response_"]

/** How Mako reads a Grok session update kind; undefined for one it doesn't know. */
export function grokUpdateReading(kind: string): (typeof GROK_UPDATES)[string] | undefined {
  return Object.hasOwn(GROK_UPDATES, kind) ? GROK_UPDATES[kind] : GROK_IGNORED_PREFIXES.some((prefix) => kind.startsWith(prefix)) ? "ignored" : undefined
}

export const GROK_ACP_HOOKS = {
  replayedUser: grokReplayedUser,
  toolName: (tool) => grokToolName(GrokToolMeta.safeParse(tool._meta).data, tool.title),
  toolFailed: (update) => grokCommandFailed(RawOutput.parse(update.rawOutput)),
  /**
   * Grok's turn-end plan, which shows its in-progress todos as completed to
   * stop their spinners. Grok sends it without the `eventId` every update it
   * keeps in `updates.jsonl` carries: "must not be persisted or replayed on
   * session reload", its todo state staying the truth (grok-build
   * `acp_session_impl/turn_end.rs`, `emit_turn_end_plan_cleanup`).
   */
  transient: (notification) => notification.update.sessionUpdate === "plan" && !Stamped.safeParse(notification._meta).success,
  plans: () => ({
    update(update, sessionId) {
      if (update.sessionUpdate === "tool_call") {
        const call = ExitPlanCallSchema.safeParse(update)
        return call.success ? grokProposedPlan(grokPlanId(sessionId, call.data.toolCallId), call.data.rawInput.planContent) : []
      }
      if (update.sessionUpdate !== "tool_call_update") return []
      const ready = PlanReadySchema.safeParse(update)
      return ready.success ? grokProposedPlan(grokPlanId(sessionId, ready.data.toolCallId), ready.data.rawOutput.PlanReady.plan_content) : []
    },
  }),
} satisfies AcpDecoderHooks

/** Grok's cost unit: its own documentation says 1 USD is 10^10 ticks. */
export const GROK_TICKS_PER_USD = 10_000_000_000

/**
 * What a turn spent, OpenAI-style (`inputTokens` includes cached input): a
 * `turn_completed` update's `usage`, and each model's entry in its
 * `modelUsage`. Live and in `updates.jsonl` alike.
 */
export const GrokSpend = z.object({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cachedReadTokens: tokenCount,
  cacheCreationTokens: tokenCount,
  reasoningTokens: tokenCount,
  costUsdTicks: tokenCount,
})
export type GrokSpend = z.infer<typeof GrokSpend>

/**
 * A turn's `usage`, with the spend of each model it used when Grok itemizes
 * it, and what Grok says its own count of the turn left out (Grok 1.0.46's
 * headless guide): `usageIsIncomplete` when a subagent's usage could not be
 * applied or the turn's usage drain timed out, so the tokens may be low and
 * the cost is omitted; `costIsPartial` when some calls reported no cost, so
 * all of it is omitted rather than summed into a bill that looks complete.
 */
export const GrokTurnUsage = GrokSpend.extend({
  modelUsage: z.record(z.string(), GrokSpend.nullable().catch(null)).nullish().catch(undefined),
  usageIsIncomplete: z.boolean().nullish().catch(undefined),
  costIsPartial: z.boolean().nullish().catch(undefined),
})
export type GrokTurnUsage = z.infer<typeof GrokTurnUsage>

/** What a turn's own count left out, by `GrokTurnUsage`'s flags: its tokens (and so its cost), or its cost alone. */
export function grokUnrecorded(usage: GrokTurnUsage): "tokens" | "cost" | undefined {
  if (usage.usageIsIncomplete === true) return "tokens"
  if (usage.costIsPartial === true) return "cost"
  return undefined
}

export function grokTokens(spend: GrokSpend): HarnessTokens {
  return inclusiveTokens({
    input: spend.inputTokens,
    cacheRead: spend.cachedReadTokens,
    cacheWrite: spend.cacheCreationTokens,
    output: spend.outputTokens,
    reasoning: spend.reasoningTokens,
  })
}

/** The spend's cost in dollars, when Grok reports one. */
export function grokCost(spend: GrokSpend): number | undefined {
  return spend.costUsdTicks === null || spend.costUsdTicks === undefined ? undefined : spend.costUsdTicks / GROK_TICKS_PER_USD
}

/** One model call, from `response_completed`'s `usage`, Anthropic-style: `input_tokens` leaves out what the cache supplied. */
export const GrokCallUsage = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  cache_read_input_tokens: tokenCount,
  cache_creation_input_tokens: tokenCount,
  reasoning_tokens: tokenCount,
})
export type GrokCallUsage = z.infer<typeof GrokCallUsage>

export function grokCallTokens(usage: GrokCallUsage): HarnessTokens {
  return exclusiveTokens({
    input: usage.input_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
    output: usage.output_tokens,
    reasoning: usage.reasoning_tokens,
  })
}
