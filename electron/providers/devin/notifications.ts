import { createHash } from "node:crypto"
import { z } from "zod"
import { compactionFailedEvent, event, turnFailedEvent, type TranscriptEvent } from "@mako/sessions/events"
import type { JsonObject } from "../../codex-app-json.js"
import type { NativeActivityObservation, NativeNotice } from "../../contracts/native-activity.js"
import type { AcpNotificationDecoding } from "../acp-source.js"

type Retrying = Extract<NativeActivityObservation, { kind: "retrying" }>

/**
 * Devin's vendor notifications, read against devin 3000.10.23 and the zod
 * schemas of the ACP client Devin.app ships (`@exa/windsurf-acp`), whose
 * own view shows compaction only while the status is `started`.
 */
const IGNORED = new Set([
  "_cognition.ai/turn_stats",
  "_cognition.ai/thinking_complete",
  "_cognition.ai/clipboard/write",
  "_cognition.ai/mcp/serversChanged",
  "_cognition.ai/plugins/changed",
  "_cognition.ai/browserPreview/capture",
  "_cognition.ai/browserPreview/opened",
  "_cognition.ai/revert/stepsUpdated",
  "_cognition.ai/revert/historyRewound",
  "_cognition.ai/processMemory",
  "_cognition.ai/loadStarting",
  "_cognition.ai/loadStats",
])

const text = z.string().nullish()
const Session = z.object({ sessionId: z.string() })
const Compaction = z.object({ sessionId: z.string(), status: z.string(), summary: text })
const ConnectionRetry = z.object({
  sessionId: z.string(),
  attempt: z.number().int().positive().nullish(),
  maxAttempts: z.number().int().positive().nullish(),
  isStreamRetry: z.boolean().nullish(),
})
const AgentStopped = z.object({ sessionId: z.string(), cause: z.string(), errorMessage: text })
const Output = z.object({ sessionId: z.string().nullish(), message: z.string(), level: z.string().nullish() })
const Modal = z.object({ sessionId: z.string(), message: z.string(), detail: text, level: z.string().nullish() })
const Billing = z.object({ sessionId: z.string(), title: text, body: text })

/** Causes a turn ends on without failing: the turn's own end, a Stop, a restart of Devin's loop, or Mako closing the process. */
const ENDED = new Set(["complete", "cancelled", "interrupted", "restart", "shutdown"])

/** Causes that fail a turn, in the words Mako shows. */
const FAILED = new Map<string, string | undefined>([
  ["quota_exhausted", "Quota exhausted"],
  ["auth_required", "Sign-in required"],
  ["content_filter", "Content filtered"],
  ["error", undefined],
])

export function devinNotification(method: string, params: JsonObject): AcpNotificationDecoding | undefined {
  if (!method.startsWith("_cognition.ai/")) return undefined
  // Before the session exists Devin names it "".
  const sessionId = Session.safeParse(params).data?.sessionId || undefined
  if (IGNORED.has(method)) return { sessionId, kind: method, notices: [] }
  switch (method) {
    case "_cognition.ai/compaction": {
      const parsed = Compaction.safeParse(params)
      if (!parsed.success) return { sessionId, kind: method, notices: undefined }
      const { status, summary } = parsed.data
      const decoded = { sessionId, kind: `${method}/${status}`, notices: compaction(status, summary ?? undefined) }
      // Devin sends no event ids. A summary is written once per compaction, so
      // it names this one: a load that replays it draws no second marker.
      return status === "completed" && summary ? { ...decoded, id: `compaction:${summaryId(summary)}` } : decoded
    }
    case "_cognition.ai/connection_retry": {
      const parsed = ConnectionRetry.safeParse(params)
      if (!parsed.success) return { sessionId, kind: method, notices: undefined }
      const { attempt, maxAttempts, isStreamRetry } = parsed.data
      const activity: Retrying = { kind: "retrying" }
      if (attempt) activity.attempt = attempt
      if (maxAttempts) activity.maxAttempts = maxAttempts
      activity.reason = isStreamRetry ? "Stream interrupted" : "Connection lost"
      return { sessionId, kind: method, notices: [{ kind: "activity", activity }] }
    }
    case "_cognition.ai/agent_stopped": {
      const parsed = AgentStopped.safeParse(params)
      if (!parsed.success) return { sessionId, kind: method, notices: undefined }
      const { cause, errorMessage } = parsed.data
      return { sessionId, kind: `${method}/${cause}`, notices: agentStopped(cause, errorMessage ?? undefined) }
    }
    case "_cognition.ai/output": {
      const parsed = Output.safeParse(params)
      if (!parsed.success) return { sessionId, kind: method, notices: undefined }
      const { message, level } = parsed.data
      return { sessionId, kind: method, notices: level === "warn" || level === "error" ? [warning(message)] : [] }
    }
    case "_cognition.ai/showModal": {
      const parsed = Modal.safeParse(params)
      if (!parsed.success) return { sessionId, kind: method, notices: undefined }
      const { message, detail, level } = parsed.data
      return {
        sessionId,
        kind: method,
        notices: [level === "info" ? notice(event("Notice", message, detail ?? undefined)) : warning(message, detail ?? undefined)],
      }
    }
    case "_cognition.ai/billingInformation": {
      const parsed = Billing.safeParse(params)
      if (!parsed.success) return { sessionId, kind: method, notices: undefined }
      const { title, body } = parsed.data
      return { sessionId, kind: method, notices: title || body ? [notice(event("Notice", title ?? undefined, body ?? undefined))] : [] }
    }
    default:
      return { sessionId, kind: method, notices: undefined }
  }
}

function compaction(status: string, summary: string | undefined): NativeNotice[] | undefined {
  switch (status) {
    case "started":
      return [{ kind: "activity", activity: { kind: "compacting" } }]
    case "completed":
      return [{ kind: "compacted", compaction: summary ? { summary } : undefined }]
    case "failed":
      return [{ kind: "activity", activity: null }, notice(compactionFailedEvent())]
    case "cancelled":
    case "canceled":
      return [{ kind: "activity", activity: null }]
    default:
      return undefined
  }
}

function agentStopped(cause: string, errorMessage: string | undefined): NativeNotice[] | undefined {
  if (ENDED.has(cause)) return []
  if (FAILED.has(cause)) return [notice(turnFailedEvent(FAILED.get(cause), errorMessage))]
  switch (cause) {
    case "max_turn_requests":
      return [warning("The turn reached Devin's request limit", errorMessage)]
    case "output_truncated":
      return [warning("The response was cut off at the output limit", errorMessage)]
    case "tool_rejected":
      return [notice(event("Notice", "Devin stopped after a tool call was rejected", errorMessage))]
    default:
      return undefined
  }
}

function summaryId(summary: string): string {
  return createHash("sha256").update(summary).digest("hex").slice(0, 16)
}

function notice(marker: TranscriptEvent): NativeNotice {
  return { kind: "event", event: marker }
}

/** A warning's first line reads beside the label; the rest opens on demand. */
function warning(message: string, body?: string): NativeNotice {
  const [line = "", ...rest] = message.trim().split("\n")
  return notice({ ...event("Warning", line, body ?? (rest.length ? message : undefined)), tone: "warning" })
}
