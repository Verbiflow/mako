import { inspect } from "node:util"
import { z } from "zod"

/** What `scripts/patch-cursor-sdk.mjs` makes the SDK's run logger emit on the process, once per entry. */
export const CURSOR_SDK_LOG_EVENT = "mako:cursor-sdk-log"

const TURN_RUNNER = "@anysphere/agent-client:turn-runner"
const STALL_DETECTOR = "@anysphere/agent-client:stall-detector"
/** Every turn's first request and its success: no retry to account for. */
const ROUTINE = /\] (?:Initial request|Request successful)$/

export const CursorSdkLogEntry = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  logger: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  error: z.unknown().optional(),
})
export type CursorSdkLogEntry = z.infer<typeof CursorSdkLogEntry>

/**
 * The host log line an SDK log entry makes, or `undefined`. Kept: the turn
 * runner's account of its retries and resumes, and the stalls the stream's
 * detector warns of; its lifecycle notes and every other logger are not.
 */
export function cursorRunLogLine(entry: CursorSdkLogEntry): { level: "info" | "warn"; message: string } | undefined {
  const { level, message, logger, metadata, error } = entry
  const warning = level === "warn" || level === "error"
  const kept = logger === TURN_RUNNER ? !ROUTINE.test(message) : logger === STALL_DETECTOR && warning
  if (!kept) return undefined
  const detail = [metadata, error].filter((value) => value !== undefined).map((value) => inspect(value, { depth: 4, breakLength: Infinity }))
  return { level: warning ? "warn" : "info", message: [message, ...detail].join(" ").replace(/\s*\n\s*/g, " | ").slice(0, 4000) }
}
