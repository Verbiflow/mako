import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

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

/**
 * Kinds Claude Code sends that the SDK's types don't declare yet, with the
 * CLI they were first seen from. Parse these before reading them. A kind the
 * SDK starts typing fails to compile here: move it to `KNOWN` and read it
 * through the SDK's type.
 */
const NEWER = untyped({
  /**
   * Claude Code 2.1.283: each prompt Mako sends, by its uuid, is `queued`,
   * `started`, `completed` or `cancelled`. `queued` arrives before the turn's
   * `init`, so the driver takes it as the earliest receipt. Still untyped in
   * SDK 0.3.293.
   */
  command_lifecycle: "state",
})

function untyped<const Kinds extends Record<string, "shown" | "state" | "ignored">>(
  kinds: Kinds & { readonly [Typed in Kind<SDKMessage>]?: never }
): Kinds {
  return kinds
}

const CommandLifecycleSchema = z.object({
  type: z.literal("command_lifecycle"),
  command_uuid: z.string(),
  state: z.string(),
})

/** A prompt's progress through Claude Code's queue, from a CLI newer than the SDK's types. */
export function claudeCommandLifecycle(message: SDKMessage): z.infer<typeof CommandLifecycleSchema> | undefined {
  return CommandLifecycleSchema.safeParse(message).data
}

/** The ids of the messages Mako sent that `message` shows Claude Code took: a queued command, a user message, or the ones a reply answers. */
export function claudeAcknowledged(message: SDKMessage): Set<string> {
  const ids = new Set<string>()
  const lifecycle = claudeCommandLifecycle(message)
  if (lifecycle && lifecycle.state !== "cancelled") ids.add(lifecycle.command_uuid)
  if (message.type === "user" && message.uuid) ids.add(message.uuid)
  if ("user_message_uuid" in message && message.user_message_uuid)
    ids.add(message.user_message_uuid)
  if ("user_message_uuids" in message)
    for (const id of message.user_message_uuids ?? []) ids.add(id)
  return ids
}

const kinds = (where: "shown" | "state" | "ignored") =>
  [...Object.entries(KNOWN), ...Object.entries(NEWER)].flatMap(([kind, place]) => place === where ? [kind] : [])

/** Kinds the decoder or driver turns into something the user sees or the session reads. */
export const CLAUDE_DECODED_KINDS: ReadonlySet<string> = new Set([...kinds("shown"), ...kinds("state")])
/** Kinds known as bookkeeping; they decode to nothing. */
export const CLAUDE_SILENT_KINDS: ReadonlySet<string> = new Set(kinds("ignored"))

export function claudeMessageKind(message: SDKMessage): string {
  return message.type === "system" ? `system/${message.subtype}` : message.type
}

/** Whether this SDK declares the kind; one it does not is a newer Claude Code's. */
export function knownClaudeMessageKind(kind: string): boolean {
  return Object.hasOwn(KNOWN, kind) || Object.hasOwn(NEWER, kind)
}
