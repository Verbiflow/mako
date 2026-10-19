import { z } from "zod"
import type { AcpDecoderHooks, AcpUserChunk } from "../acp-decoder.js"
import type { AcpToolReading, AcpToolUpdate } from "../acp-tool-details.js"
import type { LiveUpdate } from "../live-content.js"
import { backgroundCommandTurn, causeBody, outputBody, outputTail, subagentTurn, UNNAMED_TURN, type ProviderTurnCause } from "../provider-turn.js"
import { exclusiveTokens, inclusiveTokens, tokenCount, type HarnessTokens } from "./tokens.js"
import { defineVocabulary } from "./vocabulary.js"
import { cutOffTurn, SETUP_NOTICES, STOP_MARKER } from "../stream-merge.js"

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
    run_terminal_command: { kind: "shell", effects: { cwd: "result.current_dir", exitCode: "result.exit_code", background: "is_background" } },
    monitor: { kind: "shell", effects: { background: true } },
    get_command_or_subagent_output: { kind: "shell-output", label: "Command output" },
    kill_command_or_subagent: { kind: "shell-stop" },
    read_file: { kind: "read" },
    list_dir: { kind: "list" },
    grep: { kind: "search" },
    search_replace: { kind: "edit", effects: { edits: { old: "old_string", new: "new_string", all: "replace_all" } } },
    // Its `diff` content holds the file before and after the write.
    write: { kind: "write", effects: { content: "content", wholeDiffs: true } },
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
      config: ["~/.grok/hooks", ".grok/hooks", "~/.grok/config.toml", "~/.grok/disabled-hooks", "~/.claude/settings.json", "~/.claude/settings.local.json", ".claude/settings.json", ".claude/settings.local.json", "~/.cursor/hooks.json", ".cursor/hooks.json"],
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
    },
    models: "grok models; the ACP initialize model list",
  },
  storage: {
    checked: {
      version: "1.0.46",
      on: "2026-10-13",
      against: "the sessions grok 1.0.46 wrote under ~/.grok/sessions, forks and rewinds included",
    },
    where: "~/.grok/sessions/<encoded working directory>/<id>/updates.jsonl, one ACP update per line, with summary.json and plan.md",
    encodings: ["plain"],
    history: {
      rewinds: "rewind_marker: back to before its target-th counted turn",
      copies: "summary.json parent_session_id and forked_at",
    },
    stream: [
      SETUP_NOTICES,
      STOP_MARKER,
      ...cutOffTurn(["tool", "text", "thinking"], "Grok 1.0.46 writes a turn's words and calls to updates.jsonl as they complete, so a turn its process was killed under keeps neither its call nor the words before it; the flows of 2026-10-16 stream them in a killed turn (01a1481a-a592) whose updates.jsonl lacks them."),
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

/** Undefined for any other call's output, rather than a failed `safeParse`, which builds an `Error`. */
const GrokCommandOutput = z.object({ type: z.literal("Bash"), exit_code: z.number().nullish() }).optional().catch(undefined)

/**
 * A shell command that exited non-zero, live or saved. Grok reports it
 * `completed`, keeping `failed` for a timeout or a signal; Mako shows it
 * failed, as it shows Claude's and Codex's.
 */
export function grokCommandFailed(rawOutput: z.core.util.JSONType | undefined): boolean {
  const exitCode = GrokCommandOutput.parse(rawOutput)?.exit_code
  return exitCode != null && exitCode !== 0
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
 * client's (`packages/host/src/harnesses/grok/plans.ts`).
 */
const ExitPlanCallSchema = z.object({
  toolCallId: z.string(),
  rawInput: z.object({ planContent: z.string() }),
  _meta: z.object({ "x.ai/tool": z.object({ name: z.literal("exit_plan_mode") }) }),
}).optional().catch(undefined)
/* This and `ExitPlanCallSchema` read every call but a plan's as undefined, rather than failing a `safeParse`, which builds an `Error` each time. */
const PlanReadySchema = z.object({
  toolCallId: z.string(),
  rawOutput: z.object({ type: z.literal("ExitPlanMode"), PlanReady: z.object({ plan_content: z.string() }) }),
}).optional().catch(undefined)

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
  return backgroundReminderTurn(text)?.reason
}

const GrokInstant = z.object({ secs_since_epoch: z.number(), nanos_since_epoch: z.number().optional() })

/**
 * The snapshot Grok sends live (`_x.ai/task_completed`) and keeps in
 * `updates.jsonl` when a background task settles (grok 1.0.41 to 1.0.46):
 * what ran, how it ended, when it started and ended, and what it printed.
 */
export const GrokTaskSnapshot = z.object({
  task_id: z.string().nullish(),
  description: z.string().nullish(),
  command: z.string().nullish(),
  /** `bash`, or `monitor` for a watch the agent left running. */
  kind: z.string().nullish(),
  exit_code: z.number().nullish(),
  signal: z.string().nullish(),
  explicitly_killed: z.boolean().nullish(),
  output: z.string().nullish(),
  start_time: GrokInstant.nullish(),
  end_time: GrokInstant.nullish(),
})
export type GrokTaskSnapshot = z.infer<typeof GrokTaskSnapshot>

function instant(at: z.infer<typeof GrokInstant> | null | undefined): number | undefined {
  return at ? at.secs_since_epoch * 1000 + Math.floor((at.nanos_since_epoch ?? 0) / 1e6) : undefined
}

/** How long a snapshot's task ran, from its two ends. */
function snapshotDuration(task: GrokTaskSnapshot): number | undefined {
  const start = instant(task.start_time)
  const end = instant(task.end_time)
  return start !== undefined && end !== undefined && end >= start ? end - start : undefined
}

/** A settled task as the cause of the turn Grok runs on it: what ran, how it ended, how long it took, and the end of its output. */
export function grokTaskTurn(task: GrokTaskSnapshot): ProviderTurnCause {
  const outcome = {
    description: task.description ?? undefined,
    command: task.command ?? undefined,
    exitCode: task.exit_code,
    signal: task.signal,
    stopped: task.explicitly_killed ?? false,
    durationMs: snapshotDuration(task),
    output: task.output ?? undefined,
  }
  const turn = backgroundCommandTurn(outcome)
  if (task.kind !== "monitor") return turn
  // A monitor's task ends when its watch does; what it printed last is the news.
  const name = turn.cause?.kind === "command" ? turn.cause.name : undefined
  return { ...turn, cause: { kind: "monitor", outcome: "ended", ...name && { name } } }
}

/** Seconds as Grok prints them in its reminders, `8.2s` or `65.95s`. */
function reminderSeconds(text: string | undefined): number | undefined {
  const seconds = text === undefined ? undefined : Number(text)
  return seconds === undefined || !Number.isFinite(seconds) ? undefined : Math.round(seconds * 1000)
}

/**
 * `backgroundReminderLabel` with what settled. `snapshots` are the task
 * snapshots read earlier in the same store, by task id: the reminder names
 * its task, and its snapshot holds the output the reminder leaves out.
 */
export function backgroundReminderTurn(text: string, snapshots?: ReadonlyMap<string, GrokTaskSnapshot>): ProviderTurnCause | undefined {
  const body = /^\s*<system-reminder>\s*([\s\S]*?)<\/system-reminder>\s*$/.exec(text)?.[1]
  if (!body) return undefined
  const subagents = /^While you were idle, (\d+) background subagents? \w+:/.exec(body)
  if (subagents) return subagentReminderTurn(body, Number(subagents[1]))
  const task = /^Background task "([^"]*)" ([^\n(.]+)/.exec(body)
  const status = task?.[2]?.trim()
  if (!status) return undefined
  const exitCode = /exit code:\s*(-?\d+)/.exec(body)?.[1]
  const snapshot = task?.[1] ? snapshots?.get(task[1]) : undefined
  return backgroundCommandTurn({
    description: /^Description:\s*(.*?)(?:\s*\|\s*Duration:.*)?$/m.exec(body)?.[1],
    exitCode: exitCode === undefined ? undefined : Number(exitCode),
    stopped: /kill|stop|cancel/i.test(status),
    durationMs: reminderSeconds(/\|\s*Duration:\s*([\d.]+)s/.exec(body)?.[1]) ?? (snapshot && snapshotDuration(snapshot)),
    output: snapshot?.output ?? undefined,
  })
}

/** One subagent in a wake reminder: `- [type] "description" — completed successfully (32.9s, 2 tool calls)`. */
const SUBAGENT_LINE = /^- \[[^\]]*\] "(.*)" — (\S+)[^\n]*?(?:\(([\d.]+)s\b[^)]*\))?$/gm

/** What each subagent in a wake reminder reported, in order: the text after its `=== Output ===`, up to Grok's own metadata. */
function reminderOutputs(body: string): string[] {
  return Array.from(body.matchAll(/=== Output ===\n([\s\S]*?)(?=\n<subagent_meta>|\n<subagent_result>|\n=== Task |$)/g), (match) => match[1]!.trim())
}

function subagentState(status: string): "completed" | "cancelled" | "failed" | undefined {
  return /^complete/i.test(status) ? "completed" : /cancel|stop|kill/i.test(status) ? "cancelled" : /fail|error/i.test(status) ? "failed" : undefined
}

function subagentReminderTurn(body: string, count: number): ProviderTurnCause {
  const lines = Array.from(body.matchAll(SUBAGENT_LINE))
  const outputs = reminderOutputs(body)
  if (count !== 1) {
    // Grok's own count is the line; each subagent's report opens under it.
    const turn: ProviderTurnCause = { reason: `${count} subagents finished` }
    const reports = lines.map((line, index) => [`**${line[1]}** · ${line[2]}`, outputs[index]].filter(Boolean).join("\n\n"))
    const report = causeBody(reports.join("\n\n"))
    if (report) turn.body = report
    return turn
  }
  const line = lines[0]
  return subagentTurn({
    description: line?.[1],
    id: /^=== Task (\S+) ===$/m.exec(body)?.[1],
    state: subagentState(line?.[2] ?? ""),
    durationMs: reminderSeconds(line?.[3]),
    result: outputs[0],
  })
}

/**
 * Grok's live word on a background subagent: `subagent_spawned` names it,
 * `subagent_finished` says how it ended, how long it ran and what it
 * reported. Only a finish that will wake Grok (`will_wake`) starts a turn.
 */
export const GrokSubagentSpawned = z.object({ sessionUpdate: z.literal("subagent_spawned"), subagent_id: z.string(), description: z.string().nullish() })
export const GrokSubagentFinished = z.object({
  sessionUpdate: z.literal("subagent_finished"),
  subagent_id: z.string(),
  status: z.string().nullish(),
  duration_ms: z.number().nullish(),
  output: z.string().nullish(),
  error: z.string().nullish(),
  will_wake: z.boolean().nullish(),
})

/** A finished subagent as the cause of the turn Grok wakes for, named by what spawned it. */
export function grokSubagentTurn(finished: z.infer<typeof GrokSubagentFinished>, description: string | undefined): ProviderTurnCause {
  return subagentTurn({
    description,
    id: finished.subagent_id,
    state: subagentState(finished.status ?? ""),
    durationMs: finished.duration_ms ?? undefined,
    result: finished.output ?? (finished.error ? outputBody(outputTail(finished.error)) : undefined),
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
  if (meta?.hostTurn)
    return text.trim() === "/compact" ? null
      : grokHostCommand(text) ? { kind: "user", text: text.trim() }
        : { kind: "provider-turn", ...backgroundReminderTurn(text) ?? UNNAMED_TURN }
  const reminder = update.content.type === "text" ? backgroundReminderTurn(text) : undefined
  if (reminder) return { kind: "provider-turn", ...reminder }
  const typed = meta?.interjection ? GrokDisplayText.safeParse(update.content._meta).data?.displayText : undefined
  return typed === undefined ? undefined : { kind: "user", text: typed, steeringFor: "running" }
}

/**
 * A slash command Grok answers itself without the model (`/goal clear`),
 * which it saves as a turn of its own (`_meta.hostTurn`) with the command's
 * words: grok 1.0.46 on 2026-10-16 (session 01a144da-e155) wrote `/goal
 * clear` so, as it writes `/compact`.
 */
export function grokHostCommand(text: string): boolean {
  return /^\/[a-z][\w-]*(?:\s|$)/i.test(text.trim())
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
 * - `observed`: read by other observers: background tasks, the goal, the
 *   turns Grok starts itself, and subagents, which Mako follows through their
 *   `meta.json`. A `turn_completed` also says why Grok ended the turn
 *   itself, which is drawn.
 * - `ignored`: Grok's own bookkeeping and streaming detail, already shown
 *   through ACP's updates or not about the conversation.
 */
export type GrokUpdateReading = "marker" | "activity" | "observed" | "ignored"

export const GROK_UPDATES = {
  auto_compact_completed: "marker",
  auto_compact_failed: "marker",
  model_auto_switched: "marker",
  retry_state: "marker",
  image_dropped: "marker",
  hook_annotation: "marker",
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
  // The goal bar's, not the transcript's: the live decoder reports it as the conversation's goal.
  goal_updated: "observed",
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
  // Grok's tasks pane, not its transcript (xai-grok-pager `handle_scheduled_task_*`, 1.0.46): the
  // `scheduler_create` call shows the scheduling, and each firing runs as a loop subagent. `created`
  // is re-sent on every restore and after a skipped fire, and `fired` is never saved.
  scheduled_task_created: "ignored",
  scheduled_task_fired: "ignored",
  scheduled_task_deleted: "ignored",
  // `session/set_config_option` answers with the model, and `config_option_update` shows it.
  model_changed: "ignored",
} as const satisfies Record<string, GrokUpdateReading>

const UPDATE_READINGS: ReadonlyMap<string, GrokUpdateReading> = new Map(Object.entries(GROK_UPDATES))

/** Grok's memory and response streaming detail, every kind of which is `ignored`. */
const GROK_IGNORED_PREFIXES = ["memory_", "response_"]

/** How Mako reads a Grok session update kind; undefined for one it doesn't know. */
export function grokUpdateReading(kind: string): GrokUpdateReading | undefined {
  return UPDATE_READINGS.get(kind) ?? (GROK_IGNORED_PREFIXES.some((prefix) => kind.startsWith(prefix)) ? "ignored" : undefined)
}

/**
 * Where Grok (1.0.46) keeps what a tool gave the model: in `rawOutput`, under
 * a field its `type` names, while ACP's `content` holds a line for Grok's own
 * client or nothing. Read as `content` alone, a search showed "found 5
 * matches" and none of them, a listing, an MCP result (a `thread_history`
 * answer among them) and a todo update showed nothing, and an edit showed its
 * diff without Grok's words for it. A command's own output is already its
 * `content`, so the `Bash` result reads as before.
 */
export const GROK_TOOL_READING: AcpToolReading = { output: grokToolOutput }

const RawOutputKind = z.object({ type: z.string() })
const GrepOutput = z.object({ stdout: z.array(z.number().int().min(0).max(255)) })
const ListOutput = z.object({ Content: z.object({ content: z.string() }) })
const McpOutput = z.object({ output: z.union([z.object({ OkayOutput: z.string() }), z.object({ Error: z.string() })]) })
const EditOutput = z.object({ EditsApplied: z.object({ tool_output_for_prompt: z.string() }) })
const TodoOutput = z.object({ TodosUpdated: z.object({ summary_for_prompt: z.string() }) })

function grokToolOutput(update: AcpToolUpdate): string | undefined {
  // Most updates carry no `rawOutput`; nothing is parsed for them.
  if (update.rawOutput === undefined || update.rawOutput === null) return undefined
  const kind = RawOutputKind.safeParse(update.rawOutput)
  if (!kind.success) return undefined
  const raw = update.rawOutput
  switch (kind.data.type) {
    case "GrepSearch": {
      const grep = GrepOutput.safeParse(raw)
      return grep.success && grep.data.stdout.length ? Buffer.from(grep.data.stdout).toString("utf8") : undefined
    }
    case "ListDir": return ListOutput.safeParse(raw).data?.Content.content
    case "MCP": {
      const output = McpOutput.safeParse(raw).data?.output
      return output && ("OkayOutput" in output ? output.OkayOutput : output.Error)
    }
    case "SearchReplace": return EditOutput.safeParse(raw).data?.EditsApplied.tool_output_for_prompt
    case "Todo": return TodoOutput.safeParse(raw).data?.TodosUpdated.summary_for_prompt
    default: return undefined
  }
}

export const GROK_ACP_HOOKS = {
  replayedUser: grokReplayedUser,
  toolReading: GROK_TOOL_READING,
  // A command's folder and exit are its `rawOutput`'s (`run_terminal_command` in the vocabulary).
  effects: { harness: "grok" },
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
        const call = ExitPlanCallSchema.parse(update)
        return call ? grokProposedPlan(grokPlanId(sessionId, call.toolCallId), call.rawInput.planContent) : []
      }
      if (update.sessionUpdate !== "tool_call_update") return []
      const ready = PlanReadySchema.parse(update)
      return ready ? grokProposedPlan(grokPlanId(sessionId, ready.toolCallId), ready.rawOutput.PlanReady.plan_content) : []
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
