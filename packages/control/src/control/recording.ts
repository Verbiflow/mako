import { z } from "zod"
import { ControlTargetSchema, type ControlTarget } from "./contract.js"
import type { ControlCall } from "./client.js"

export const RecordingOptionsSchema = z
  .object({
    directory: z.string().min(1).optional(),
    name: z.string().min(1).max(80).default("Recording"),
    cursor: z.boolean().default(true),
    maxDurationMs: z.number().int().min(1000).max(600_000).default(120_000),
    maxSide: z.number().int().min(320).max(2560).default(1920),
    fps: z.number().int().min(1).max(60).optional(),
  })
  .strict()
export type RecordingOptions = z.input<typeof RecordingOptionsSchema>
export const RecordingReceiptSchema = z.object({
  id: z.string().min(1),
  target: ControlTargetSchema,
  status: z.enum([
    "recording",
    "finalizing",
    "finished",
    "interrupted",
    "failed",
  ]),
  directory: z.string(),
  startedAt: z.number(),
  durationMs: z.number().nonnegative(),
  frames: z.number().int().nonnegative(),
  droppedFrames: z.number().int().nonnegative(),
  sampledFrames: z.number().int().nonnegative().optional(),
  /** Retained video, which may be shorter than capture after interruption. */
  encodedFrames: z.number().int().nonnegative().optional(),
  encodedDurationMs: z.number().nonnegative().optional(),
  video: z.string().optional(),
  timeline: z.string().optional(),
  dimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  error: z.string().optional(),
})
export type RecordingReceipt = z.infer<typeof RecordingReceiptSchema>

export function recordingReceipt(
  receipt: RecordingReceipt,
  target: ControlTarget,
  id?: string
) {
  if (
    !sameRecordingTarget(receipt.target, target) ||
    (id !== undefined && receipt.id !== id)
  )
    throw new Error(
      "Recording response does not belong to the requested target and recording"
    )
  return receipt
}

/** The recording is host-owned and survives cells. Stop never repeats input. */
export class RecordingHandle {
  constructor(
    private readonly call: ControlCall,
    readonly initial: RecordingReceipt
  ) {}
  status() {
    return this.request("status")
  }
  stop() {
    return this.request("stop")
  }
  private async request(operation: "status" | "stop") {
    return recordingReceipt(
      RecordingReceiptSchema.parse(
        await this.call("recording", {
          operation,
          target: this.initial.target,
          id: this.initial.id,
        })
      ),
      this.initial.target,
      this.initial.id
    )
  }
  toJSON() {
    return this.initial
  }
}

/** Recording schemas are also imported by the renderer; identity needs no Node runtime. */
function sameRecordingTarget(left: ControlTarget, right: ControlTarget): boolean {
  if (left.kind === "window")
    return right.kind === "window" && left.pid === right.pid && left.window_id === right.window_id
  return right.kind === "page" && left.browser === right.browser && left.tab === right.tab &&
    left.generation === right.generation && left.lease === right.lease
}
