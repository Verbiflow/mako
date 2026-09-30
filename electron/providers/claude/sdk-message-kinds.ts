import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

type Kind<Message> = Message extends { type: "system"; subtype: infer Subtype extends string }
  ? `system/${Subtype}`
  : Message extends { type: infer Type extends string } ? Type : never

/**
 * Where each message reaches the user: `shown` in the transcript or status
 * row, `state` on the live session, or `ignored` as bookkeeping. Every
 * message the SDK Mako builds against declares is listed; Claude Code can be
 * newer than the SDK, and a message outside this list is logged once so its
 * arrival is on record.
 */
const KNOWN = {
  assistant: "shown",
  user: "shown",
  result: "shown",
  stream_event: "shown",
  rate_limit_event: "shown",
  "system/compact_boundary": "shown",
  "system/status": "shown",
  "system/api_retry": "shown",
  "system/model_refusal_fallback": "shown",
  "system/model_refusal_no_fallback": "shown",
  "system/local_command_output": "shown",
  "system/informational": "shown",
  "system/notification": "shown",
  /** Only a failed hook; Mako asks for no hook events, so these are startup hooks. */
  "system/hook_response": "shown",
  "system/task_notification": "shown",
  "system/task_started": "shown",
  "system/task_updated": "shown",
  "system/task_progress": "shown",
  "system/init": "state",
  "system/background_tasks_changed": "state",
  "system/commands_changed": "state",
  conversation_reset: "state",
  /** Its tool's result carries the denial. */
  "system/permission_denied": "ignored",
  tool_progress: "ignored",
  tool_use_summary: "ignored",
  auth_status: "ignored",
  prompt_suggestion: "ignored",
  "system/hook_started": "ignored",
  "system/hook_progress": "ignored",
  "system/control_request_progress": "ignored",
  "system/plugin_install": "ignored",
  "system/thinking_tokens": "ignored",
  "system/session_state_changed": "ignored",
  "system/worker_shutting_down": "ignored",
  "system/files_persisted": "ignored",
  "system/memory_recall": "ignored",
  "system/elicitation_complete": "ignored",
  "system/mirror_error": "ignored",
} satisfies Record<Kind<SDKMessage>, "shown" | "state" | "ignored">

export function claudeMessageKind(message: SDKMessage): string {
  return message.type === "system" ? `system/${message.subtype}` : message.type
}

/** Whether this SDK declares the kind; one it does not is a newer Claude Code's. */
export function knownClaudeMessageKind(kind: string): boolean {
  return Object.hasOwn(KNOWN, kind)
}
