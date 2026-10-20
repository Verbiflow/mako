import { problemType, type Problem, type ProblemType } from "@mako/protocol"
import { z } from "zod"

/** The largest picture a viewer draws, in device pixels. */
export const ControlVideoBoxSchema = z.object({
  width: z.number().int().min(16).max(8192),
  height: z.number().int().min(16).max(8192),
}).strict()

/**
 * What a client asks a cloud machine's host for when it watches a conversation's preview through the conversation's
 * Thread: live video of the tab its agent drives, no larger than `box` when it gives one. Each message of the stream
 * is one encoded `ControlVideoPacket`. Asked again on the same stream, the host takes the new box and sends a fresh
 * picture, a poster then a key frame, for a viewer that lost what it had.
 */
export const ControlVideoWatchSchema = z.object({
  kind: z.literal("control-video"),
  conversationId: z.string().min(1).max(1024),
  box: ControlVideoBoxSchema.optional(),
}).strict()
export type ControlVideoWatch = z.infer<typeof ControlVideoWatchSchema>

/**
 * How the machine ends a preview's video, each as its own problem: no turn drives the tab (it streams again when the
 * agent next acts), the preview ended, or the video failed.
 */
export const CONTROL_VIDEO_ENDINGS = {
  paused: { type: "unavailable", title: "Paused between turns" },
  gone: { type: "not-found", title: "The preview ended" },
  failed: { type: "failed", title: "The preview's video stopped" },
} as const satisfies Record<string, { type: ProblemType; title: string }>
export type ControlVideoEnding = keyof typeof CONTROL_VIDEO_ENDINGS

/** Which of the machine's endings a stream's end is; `lost` for any other, such as the link closing under it. */
export function controlVideoEnding(problem: Problem | undefined): ControlVideoEnding | "lost" {
  if (!problem) return "lost"
  const type = problemType(problem)
  const matches = (ending: ControlVideoEnding) =>
    CONTROL_VIDEO_ENDINGS[ending].type === type && CONTROL_VIDEO_ENDINGS[ending].title === problem.title
  return matches("paused") ? "paused" : matches("gone") ? "gone" : matches("failed") ? "failed" : "lost"
}
