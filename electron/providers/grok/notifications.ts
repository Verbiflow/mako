import { z } from "zod"
import { plainWords } from "@mako/sessions/events"
import { grokUpdateMarker } from "@mako/sessions"
import { objectValue, type JsonObject } from "../../codex-app-json.js"
import type { NativeActivityObservation, NativeNotice } from "../../contracts/native-activity.js"
import type { AcpNotificationDecoding } from "../acp-source.js"

type Retrying = Extract<NativeActivityObservation, { kind: "retrying" }>

/**
 * Grok's session updates beyond ACP's own, read against grok 1.0.44. They
 * arrive on `_x.ai/session_notification` and are saved as
 * `_x.ai/session/update`, both as `{ sessionId, update: { sessionUpdate, … } }`;
 * one sent on ACP's own `session/update` reaches here after the SDK refuses its kind.
 * Field names come from the recorded auto-compaction payloads and, for the
 * rest, from the binary's serde variants: `retry_state` is flattened with a
 * `state` tag of `retrying` (4 fields), `failed` or `exhausted`.
 */
const SESSION_METHODS = new Set(["_x.ai/session_notification", "_x.ai/session/update", "session/update"])

/** Workspace indexing and search progress, which Grok documents as its other notifications. */
const WORKSPACE_METHODS = new Set([
  "_x.ai/fs_notify",
  "_x.ai/fs/index",
  "_x.ai/fs/index/delta",
  "_x.ai/search/fuzzy/status",
  "_x.ai/git/worktree/status",
])

/**
 * Read by other observers: background tasks, the turns Grok starts itself,
 * and subagents, which Mako follows through their `meta.json`.
 */
const OBSERVED = new Set(["background_tasks", "task_completed", "turn_completed", "subagent_spawned", "subagent_finished"])

/** Grok's own bookkeeping and streaming detail, already shown through ACP's updates or not about the conversation. */
const IGNORED = new Set([
  "task_backgrounded",
  "compaction_checkpoint",
  "session_recap",
  "session_recap_unavailable",
  "subagent_progress",
  "turn_usage",
  "reasoning_completed",
  "tool_call_delta_chunk",
  "diff_review",
  "pending_interaction",
  "interaction_resolved",
  "plan_kept",
  "plan_cleared",
  "plan_executing",
  "goal_updated",
  "workflow_updated",
  "rewind_marker",
  "hooks_changed",
  "plugins_changed",
  "plugin_updates_installed",
  "project_trusted",
  "load_errors",
  "session_status",
  "relay_sync_status",
  "last_turn_summary",
  "served_model",
  "image_compressed",
  // `session/set_config_option` answers with the model, and `config_option_update` shows it.
  "model_changed",
])
const IGNORED_PREFIXES = ["memory_", "hook_", "response_"]

const GrokUpdate = z.looseObject({ sessionUpdate: z.string() })
/** `_meta.eventId` is Grok's own id for the update, the same live and saved. */
const Envelope = z.object({ sessionId: z.string(), update: GrokUpdate, _meta: z.looseObject({ eventId: z.string().optional() }).optional() })
const Session = z.object({ sessionId: z.string() })
const count = z.number().int().nonnegative().nullish()
const text = z.string().nullish()
const RetryState = z.object({
  state: z.string(),
  attempt: count,
  max_retries: count,
  error_type: text,
  is_rate_limited: z.boolean().nullish(),
})
const SummaryGenerated = z.object({ session_summary: text })

export function grokNotification(method: string, params: JsonObject): AcpNotificationDecoding | undefined {
  if (WORKSPACE_METHODS.has(method)) return { kind: method, notices: [] }
  // The snapshot that announces a turn Grok starts itself; the provider-turn observer reads it.
  if (method === "_x.ai/task_completed") return { sessionId: Session.safeParse(params).data?.sessionId, kind: method, notices: [] }
  if (!SESSION_METHODS.has(method)) return undefined
  const envelope = Envelope.safeParse(params)
  const update = objectValue(params["update"])
  if (!envelope.success || !update) return { kind: method, notices: undefined }
  const { sessionId } = envelope.data
  const { sessionUpdate } = envelope.data.update
  const kind = `${method}/${sessionUpdate}`
  const decoded = grokSessionUpdate(sessionUpdate, update)
  const id = envelope.data._meta?.eventId
  return { sessionId, kind: decoded.kind ? `${kind}/${decoded.kind}` : kind, notices: decoded.notices, state: decoded.state, ...id && { id } }
}

interface DecodedUpdate {
  notices: NativeNotice[] | undefined
  state?: AcpNotificationDecoding["state"]
  /** A finer key for the log, when the variant's own tag is unknown. */
  kind?: string
}

/** Activity and title here; every transcript marker comes from `grokUpdateMarker`, which saved history reads too. */
function grokSessionUpdate(sessionUpdate: string, update: JsonObject): DecodedUpdate {
  if (OBSERVED.has(sessionUpdate) || IGNORED.has(sessionUpdate) || IGNORED_PREFIXES.some((prefix) => sessionUpdate.startsWith(prefix)))
    return { notices: [] }
  const marker = grokUpdateMarker(sessionUpdate, update)
  const markers: NativeNotice[] = marker ? [{ kind: "event", event: marker }] : []
  switch (sessionUpdate) {
    case "auto_compact_started":
      return { notices: [{ kind: "activity", activity: { kind: "compacting" } }] }
    case "auto_compact_completed":
    case "auto_compact_failed":
    case "auto_compact_cancelled":
      return { notices: [{ kind: "activity", activity: null }, ...markers] }
    case "retry_state":
      return retryState(update, markers)
    case "session_summary_generated": {
      const title = SummaryGenerated.safeParse(update).data?.session_summary?.trim()
      return title ? { notices: [], state: { title } } : { notices: [] }
    }
    default:
      return { notices: marker ? markers : undefined }
  }
}

function retryState(update: JsonObject, markers: NativeNotice[]): DecodedUpdate {
  const parsed = RetryState.safeParse(update)
  if (!parsed.success) return { notices: undefined }
  const { state, attempt, max_retries: maxRetries, error_type: errorType, is_rate_limited: rateLimited } = parsed.data
  switch (state.toLowerCase()) {
    case "retrying": {
      const activity: Retrying = { kind: "retrying" }
      const reason = rateLimited ? "Rate limited" : errorType ? plainWords(errorType) : undefined
      if (attempt) activity.attempt = attempt
      if (maxRetries) activity.maxAttempts = maxRetries
      if (reason) activity.reason = reason
      return { notices: [{ kind: "activity", activity }] }
    }
    case "failed":
      return { notices: [{ kind: "activity", activity: null }] }
    case "exhausted":
      return { notices: [{ kind: "activity", activity: null }, ...markers] }
    default:
      return { notices: undefined, kind: state }
  }
}
