import { z } from "zod"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { toolResultData, toolResultError } from "@mako/control/computer"
import {
  type RecordingOptions,
  type WindowControlTarget,
} from "@mako/control/control"
import type {
  ComputerDriverClient,
  ComputerDriverResult,
} from "./computer-driver-client.js"
import { ControlRecording } from "./control-recording.js"

const stateSchema = z.object({
  generation: z.number().int().positive(),
  recording_id: z.string(),
  target: z.object({
    pid: z.number().int().positive(),
    window_id: z.number().int().positive(),
  }),
  video_active: z.boolean(),
  output_dir: z.string().nullable(),
  last_video_path: z.string().nullable(),
  last_error: z.string().nullable(),
})
function data(result: ComputerDriverResult) {
  const parsed = z
    .looseObject({
      content: z.array(
        z.looseObject({ type: z.string(), text: z.string().optional() })
      ),
      isError: z.boolean().optional(),
      structuredContent: z.record(z.string(), z.json()).optional(),
    })
    .parse(result)
  const error = toolResultError(parsed)
  if (error) throw new Error(error)
  return stateSchema.parse(toolResultData(parsed))
}

/** One host task owns these handles. Driver ownership is independently enforced. */
export class NativeRecordings {
  private closed = false
  private starting = false
  private readonly recordings = new Map<string, ControlRecording>()
  async start(
    target: WindowControlTarget,
    options: RecordingOptions,
    client: ComputerDriverClient,
    tools: Tool[],
    session: string,
    signal: AbortSignal
  ) {
    if (this.closed) throw new Error("Recording task has ended")
    if (
      this.starting ||
      [...this.recordings.values()].some((recording) =>
        ["recording", "finalizing"].includes(recording.receipt().status)
      )
    )
      throw new Error(
        "Finish the current native recording before starting another"
      )
    const start = tools.find((tool) => tool.name === "start_recording")
    const stop = tools.find((tool) => tool.name === "stop_recording")
    if (
      !start?.inputSchema.properties?.window_target ||
      !stop?.inputSchema.properties?.recording_id
    )
      throw new Error(
        "The installed native driver does not support task-owned window recording. Update the shared driver before recording this window."
      )
    for (const [id, recording] of this.recordings) {
      if (this.recordings.size < 64) break
      if (
        ["finished", "interrupted", "failed"].includes(
          recording.receipt().status
        )
      )
        this.recordings.delete(id)
    }
    this.starting = true
    let began: Promise<void> | undefined
    let recording: ControlRecording | undefined
    try {
      recording = await ControlRecording.create(target, options, async () => {
        // Start can complete after cancellation. Wait for completion, then stop by the id supplied before dispatch.
        await began?.catch(() => {})
        if (!began) return
        const result = data(
          await client.callTool(
            "stop_recording",
            { recording_id: recording!.id, session },
            { timeout: 20_000 }
          )
        )
        if (
          result.recording_id !== recording!.id ||
          result.target.pid !== target.pid ||
          result.target.window_id !== target.window_id
        )
          throw new Error(
            "Native recording identity changed during finalization"
          )
        if (!result.last_video_path)
          throw new Error(
            result.last_error ?? "Native capture stopped without a video"
          )
        await recording!.attachVideo(result.last_video_path)
        return result.last_error ?? undefined
      })
      this.recordings.set(recording.id, recording)
      if (this.closed || signal.aborted)
        throw new Error("Recording task ended before capture started")
      const active = recording
      active.markStarted()
      // Do not cancel a dispatched start and lose its receipt. Cleanup waits for this call.
      began = (async () => {
        const result = data(
          await client.callTool(
            "start_recording",
            {
              session,
              recording_id: active.id,
              output_dir: active.directory,
              record_video: true,
              capture_actions: false,
              window_target: { pid: target.pid, window_id: target.window_id },
            },
            { timeout: 20_000 }
          )
        )
        if (
          result.recording_id !== active.id ||
          result.target.pid !== target.pid ||
          result.target.window_id !== target.window_id
        )
          throw new Error("Native recording identity changed during startup")
        if (!result.video_active || result.output_dir !== active.directory)
          throw new Error(
            result.last_error ??
              "Native driver did not start the requested window recording"
          )
      })()
      await began
      if (
        this.closed ||
        signal.aborted ||
        active.receipt().status !== "recording"
      )
        throw new Error("Recording task ended during capture startup")
      return active.receipt()
    } catch (error) {
      if (recording) await recording.stop("Native recording could not start")
      throw error
    } finally {
      this.starting = false
    }
  }
  get(target: WindowControlTarget, id: string) {
    const recording = this.recordings.get(id)
    if (
      !recording ||
      recording.target.kind !== "window" ||
      recording.target.pid !== target.pid ||
      recording.target.window_id !== target.window_id
    )
      throw new Error("Recording does not belong to this target and task")
    return recording
  }
  async status(
    target: WindowControlTarget,
    id: string,
    client: ComputerDriverClient | undefined,
    session: string
  ) {
    const recording = this.get(target, id)
    if (recording.receipt().status !== "recording") return recording.receipt()
    if (!client) return recording.stop("Native driver connection ended")
    const result = data(
      await client.callTool(
        "get_recording_state",
        { session },
        { timeout: 5000 }
      )
    )
    if (
      result.recording_id !== id ||
      result.target.pid !== target.pid ||
      result.target.window_id !== target.window_id
    )
      throw new Error("Native recording identity changed while reading status")
    if (!result.video_active) await recording.stop()
    return recording.receipt()
  }
  connectionEnded() {
    for (const recording of this.recordings.values())
      void recording.stop("Native driver connection ended")
  }
  async close() {
    this.closed = true
    await Promise.all(
      [...this.recordings.values()].map((recording) =>
        recording.release("Task ended")
      )
    )
  }
}
