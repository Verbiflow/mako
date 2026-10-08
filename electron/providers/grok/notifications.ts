import { z } from "zod"
import { grokErrorLabel, grokTurnCause, grokUpdateMarker } from "@mako/sessions"
import { grokUpdateReading } from "@mako/sessions/harnesses"
import { objectValue, type JsonObject } from "../../codex-app-json.js"
import type { NativeActivityObservation, NativeNotice } from "../../contracts/native-activity.js"
import type { AcpNotificationDecoding } from "../acp-source.js"
import { grokModelWindow, grokUsage } from "./usage.js"

type Retrying = Extract<NativeActivityObservation, { kind: "retrying" }>

/**
 * Grok's session updates beyond ACP's own, read against grok 1.0.44. They
 * arrive on `_x.ai/session_notification` and are saved as
 * `_x.ai/session/update`, both as `{ sessionId, update: { sessionUpdate, … } }`;
 * one sent on ACP's own `session/update` reaches here after the SDK refuses its kind.
 * Shapes are checked against Grok's source (xai-org/grok-build 1.0.45,
 * `xai-grok-shell/src/extensions/notification.rs`) and the recorded pairs:
 * `retry_state` is flattened with a `type` tag: `retrying` with the
 * attempt and the error kind, then `failed` with the error that ends the turn.
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
 * What Grok tells its own pager about the process, each known to Mako another
 * way or not about the conversation (xai-org/grok-build 1.0.45,
 * `xai-grok-pager/src/app/acp_handler`; recorded from grok 1.0.46).
 */
const PAGER_METHODS = new Set([
  // The steps of opening a session ("loading your plugins"), sent while
  // `session/new` or `session/load` runs; MCP servers are read from their own notices.
  "_x.ai/session/setup",
  // The roster of every session the process runs, for Grok's fleet dashboard.
  "_x.ai/sessions/changed",
  // Grok's shared prompt queue, which holds only what Mako itself sent.
  "_x.ai/queue/changed",
  // The end of a turn, which the `session/prompt` response and `turn_completed`
  // both carry; Grok keeps it for older pagers and plans to drop it.
  "_x.ai/session/prompt_complete",
  // Feature flags and tips for Grok's pager, refreshed with its remote settings.
  "_x.ai/settings/update",
  // xAI's product announcements, which Grok shows as a banner in its pager.
  "_x.ai/announcements/update",
])

const GrokUpdate = z.looseObject({ sessionUpdate: z.string() })
/** `_meta.eventId` is Grok's own id for the update, the same live and saved. */
const Envelope = z.object({ sessionId: z.string(), update: GrokUpdate, _meta: z.looseObject({ eventId: z.string().optional() }).optional() })
const Session = z.object({ sessionId: z.string() })
const count = z.number().int().nonnegative().nullish()
const text = z.string().nullish()
const RetryState = z.object({
  type: z.string(),
  attempt: count,
  max_retries: count,
  reason: text,
  error_type: text,
})
const SummaryGenerated = z.object({ session_summary: text })

export function grokNotification(method: string, params: JsonObject): AcpNotificationDecoding | undefined {
  if (WORKSPACE_METHODS.has(method) || PAGER_METHODS.has(method)) return { kind: method, notices: [] }
  // The snapshot that announces a turn Grok starts itself; the provider-turn observer reads it.
  if (method === "_x.ai/task_completed") return { sessionId: Session.safeParse(params).data?.sessionId, kind: method, notices: [] }
  // The echo of a message Mako steered in; the host already shows it.
  if (method === "_x.ai/session/interjection") return { sessionId: Session.safeParse(params).data?.sessionId, kind: method, notices: [] }
  // The model list, sent when the session opens and when its model changes, names the window.
  if (method === "_x.ai/models/update") {
    const size = grokModelWindow(params)
    return { kind: method, connectionWide: true, notices: [], ...size && { usage: [{ kind: "window", size }] } }
  }
  if (!SESSION_METHODS.has(method)) return undefined
  const envelope = Envelope.safeParse(params)
  const update = objectValue(params["update"])
  if (!envelope.success || !update) return { kind: method, notices: undefined }
  const { sessionId } = envelope.data
  const { sessionUpdate } = envelope.data.update
  const kind = `${method}/${sessionUpdate}`
  const meta = objectValue(params["_meta"])
  const decoded = grokSessionUpdate(sessionUpdate, update, meta)
  const usage = grokUsage(sessionUpdate, update)
  const id = envelope.data._meta?.eventId
  return {
    sessionId,
    kind: decoded.kind ? `${kind}/${decoded.kind}` : kind,
    notices: decoded.notices ?? (usage ? [] : undefined),
    state: decoded.state,
    ...usage && { usage },
    ...id && { id },
  }
}

interface DecodedUpdate {
  notices: NativeNotice[] | undefined
  state?: AcpNotificationDecoding["state"]
  /** A finer key for the log, when the variant's own tag is unknown. */
  kind?: string
}

/**
 * Activity and title here; every transcript marker comes from `grokUpdateMarker`
 * or `grokTurnCause`, which saved history reads too.
 */
function grokSessionUpdate(sessionUpdate: string, update: JsonObject, meta: JsonObject | undefined): DecodedUpdate {
  if (sessionUpdate === "turn_completed") {
    const cause = grokTurnCause(meta)
    return { notices: cause ? [{ kind: "event", event: cause }] : [] }
  }
  const reading = grokUpdateReading(sessionUpdate)
  if (reading === "observed" || reading === "ignored") return { notices: [] }
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
    case "scheduled_task_deleted":
      return { notices: markers }
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
  const { type: state, attempt, max_retries: maxRetries, reason: words, error_type: errorType } = parsed.data
  switch (state) {
    case "retrying": {
      const activity: Retrying = { kind: "retrying" }
      const reason = grokErrorLabel(errorType ?? undefined) ?? words ?? undefined
      if (attempt) activity.attempt = attempt
      if (maxRetries) activity.maxAttempts = maxRetries
      if (reason) activity.reason = reason
      return { notices: [{ kind: "activity", activity }] }
    }
    case "failed":
    case "exhausted":
      return { notices: [{ kind: "activity", activity: null }, ...markers] }
    default:
      return { notices: undefined, kind: state }
  }
}
