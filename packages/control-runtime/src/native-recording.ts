import { join } from "node:path"
import { z } from "zod"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { toolResultData, toolResultError } from "@mako/control/computer"
import {
  ControlFault,
  type RecordingOptions,
  type WindowControlTarget,
} from "@mako/control/control"
import type { ComputerDriverResult } from "./computer-driver-client.js"
import type { JsonObject } from "./json.js"
import { ControlRecording } from "./control-recording.js"
import { Mp4Writer } from "./mp4.js"
import { onWindows, type LinuxDesktop } from "./platform.js"
import { VideoHelper, helperWindowSource, videoHelperExecutable } from "./video-helper.js"

/** A helper recording's top rate: what the helper encodes live. */
export const HELPER_RECORDING_MAX_FPS = 30

/**
 * A path as the driver reports it, spelled as Node spells it: on Windows the driver's canonical form is a verbatim
 * path (`\\?\C:\…`, `\\?\UNC\server\…`) for the same file that `realpath` names `C:\…`.
 */
function plainPath(path: string): string {
  if (!onWindows() || !path.startsWith("\\\\?\\")) return path
  return path.startsWith("\\\\?\\UNC\\") ? `\\\\${path.slice(8)}` : path.slice(4)
}
const driverPath = z.string().transform(plainPath)

const stateSchema = z.object({
  generation: z.number().int().positive(),
  recording_id: z.string(),
  target: z.object({
    pid: z.number().int().positive(),
    window_id: z.number().int().positive(),
  }),
  video_active: z.boolean(),
  fps: z.number().int().min(1).max(60).optional(),
  output_dir: driverPath.nullable(),
  last_video_path: driverPath.nullable(),
  last_error: z.string().nullable(),
})
const resultSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.json()).optional(),
})
function data(result: ComputerDriverResult) {
  const parsed = resultSchema.parse(result)
  const error = toolResultError(parsed)
  if (error) throw new Error(error)
  return stateSchema.parse(toolResultData(parsed))
}

/** Older drivers have a fixed 30 fps source. New drivers declare their backend ceiling. */
export function nativeRecordingRate(tool: Tool | undefined) {
  const property = tool?.inputSchema.properties?.fps
  if (property === undefined) return { maxFps: 30, configurable: false }
  const rate = z.object({
    type: z.literal("integer"),
    minimum: z.literal(1),
    maximum: z.number().int().min(1).max(60),
  }).parse(property)
  return { maxFps: rate.maximum, configurable: true }
}

/** A driver call under the task's current driver session, renewed when the driver ended it. */
export type NativeDriverCall = (name: string, args: JsonObject, timeout: number) => Promise<ComputerDriverResult>

/** One host task owns these handles. Driver ownership is independently enforced. */
export class NativeRecordings {
  private closed = false
  private starting = false
  /**
   * Where Mako records a window itself with the video helper and never the driver's FFmpeg recorder: the window by
   * its X id on X11 (XComposite), and on Wayland, where nothing outside the compositor may read a window by id, the
   * monitor the person shares through the ScreenCast portal. The session names it: a person's Linux desktop, or a
   * standalone job's own X server. None where the driver records (a Mac, Windows).
   */
  constructor(private readonly helperDesktop: LinuxDesktop | undefined) {}
  private readonly recordings = new Map<string, ControlRecording>()
  /** Recordings the video helper makes, whose video the driver knows nothing of. */
  private readonly helpers = new Set<string>()
  async start(
    target: WindowControlTarget,
    options: RecordingOptions,
    call: NativeDriverCall,
    tools: Tool[],
    signal: AbortSignal
  ) {
    if (this.closed)
      throw new ControlFault(
        "session-closed",
        "Recording task has ended",
        "not-dispatched"
      )
    if (
      this.starting ||
      [...this.recordings.values()].some((recording) =>
        ["recording", "finalizing"].includes(recording.receipt().status)
      )
    )
      throw new ControlFault(
        "target-busy",
        "Finish the current native recording before starting another",
        "not-dispatched"
      )
    const desktop = this.helperDesktop
    if (desktop) return this.startHelper(target, options, desktop, call, tools, signal)
    const start = tools.find((tool) => tool.name === "start_recording")
    const stop = tools.find((tool) => tool.name === "stop_recording")
    if (
      !start?.inputSchema.properties?.window_target ||
      !stop?.inputSchema.properties?.recording_id
    )
      throw new ControlFault(
        "unsupported",
        "The installed native driver does not support task-owned window recording. Update the shared driver before recording this window.",
        "not-dispatched"
      )
    const rate = nativeRecordingRate(start)
    const fps = options.fps ?? rate.maxFps
    if (fps > rate.maxFps || (!rate.configurable && fps !== 30))
      throw new ControlFault(
        "unsupported",
        rate.configurable
          ? `This native backend supports up to ${rate.maxFps} fps; no capture was started.`
          : "This driver captures at a fixed 30 fps. Update it to request another source rate; no capture was started.",
        "not-dispatched"
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
      recording = await ControlRecording.create(target, { ...options, fps }, async () => {
        // Start can complete after cancellation. Wait for completion, then stop by the id supplied before dispatch.
        await began?.catch(() => {})
        if (!began) return
        const result = data(await call("stop_recording", { recording_id: recording!.id }, 20_000))
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
        const args: JsonObject = {
          recording_id: active.id,
          output_dir: active.directory,
          record_video: true,
          capture_actions: false,
          window_target: { pid: target.pid, window_id: target.window_id },
        }
        if (rate.configurable) args.fps = fps
        const result = data(await call("start_recording", args, 20_000))
        if (
          result.recording_id !== active.id ||
          result.target.pid !== target.pid ||
          result.target.window_id !== target.window_id
        )
          throw new Error("Native recording identity changed during startup")
        if (rate.configurable && result.fps !== fps)
          throw new Error("Native driver did not acknowledge the requested capture rate")
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
  /**
   * The window (X11) or the shared monitor (Wayland), recorded by the video helper at a constant quality into the
   * recording's MP4 as its units come. With a pointer asked for, a window's comes from the driver's action journal
   * (where its pointer actions landed; no video of its own), drawn in by the helper when the recording finishes, and
   * a shared monitor's is the screen's own, in the picture. The portal asks the person once, then restores their answer.
   */
  private async startHelper(
    target: WindowControlTarget,
    options: RecordingOptions,
    desktop: LinuxDesktop,
    call: NativeDriverCall,
    tools: Tool[],
    signal: AbortSignal
  ) {
    const executable = videoHelperExecutable()
    const window = helperWindowSource(target.window_id, desktop)
    // A shared monitor is recorded with its pointer in the picture, where the agent's pointer input moved it. A window
    // by its X id carries none, so the driver journals where its pointer actions landed and the helper draws them in.
    const source = window?.kind === "portal" && options.cursor !== false ? { ...window, cursor: "embedded" as const } : window
    if (!executable || !source)
      throw new ControlFault("unsupported", "Recording on this Linux desktop needs Mako's video helper (mako-video); no capture was started.", "not-dispatched")
    const fps = options.fps ?? HELPER_RECORDING_MAX_FPS
    if (fps > HELPER_RECORDING_MAX_FPS)
      throw new ControlFault("unsupported", `This desktop's recording supports up to ${HELPER_RECORDING_MAX_FPS} fps; no capture was started.`, "not-dispatched")
    const journal = source.kind === "window" && options.cursor !== false && tools.some((tool) => tool.name === "start_recording" && tool.inputSchema.properties?.window_target)
    this.starting = true
    let helper: VideoHelper | undefined
    let writer: Mp4Writer | undefined
    let writing: Promise<void> = Promise.resolve()
    let failure: string | undefined
    let recording: ControlRecording | undefined
    let journaling = false
    let origin = performance.now()
    try {
      recording = await ControlRecording.create(target, { ...options, fps }, async () => {
        // The picture holds until the recording stops: what happened after its last change is still in the video.
        const stopped = performance.now() - origin
        helper?.close()
        await helper?.exited
        await writing
        await writer?.finish(stopped)
        if (journaling) await call("stop_recording", { recording_id: recording!.id }, 20_000).catch(() => undefined)
        if (!writer?.frames) throw new Error(failure ?? `The capture sent no picture${helper?.said ? ` (${helper.said.split("\n").join("; ")})` : ""}`)
        await recording!.attachVideo(join(recording!.directory, "recording.mp4"))
        return failure
      })
      const active = recording
      this.recordings.set(active.id, active)
      this.helpers.add(active.id)
      writer = new Mp4Writer(join(active.directory, "recording.mp4"), 1000 / fps)
      active.markStarted()
      origin = performance.now()
      let first!: () => void
      const firstUnit = new Promise<void>((resolve) => (first = resolve))
      helper = new VideoHelper(executable, source, { fps, quality: 85, content: "screen" }, {
        unit: (packet) => {
          first()
          const at = performance.now() - origin
          writing = writing.then(() => writer!.add(packet, at)).catch((error: Error) => void (failure ??= error.message))
        },
        ended: (reason) => {
          failure ??= reason
          first()
          void active.stop(reason)
        },
      })
      if (journal) {
        const started = await call("start_recording", { recording_id: active.id, output_dir: active.directory, record_video: false, capture_actions: false, window_target: { pid: target.pid, window_id: target.window_id } }, 20_000).catch(() => undefined)
        journaling = started !== undefined && !started.isError
      }
      // The first picture, or the portal's answer while it asks the person; a still screen's comes from a screenshot.
      await Promise.race([firstUnit, new Promise((resolve) => setTimeout(resolve, 3000).unref())])
      if (this.closed || signal.aborted) throw new Error("Recording task ended during capture startup")
      // The capture refused (the person declined, or the window is gone): no recording was made.
      if (failure && !writer?.frames)
        throw new ControlFault("unsupported", `${failure}; no recording was made.`, "not-dispatched")
      return active.receipt()
    } catch (error) {
      if (recording) await recording.stop("Recording could not start")
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
    call: NativeDriverCall | undefined
  ) {
    const recording = this.get(target, id)
    if (recording.receipt().status !== "recording" || this.helpers.has(id)) return recording.receipt()
    if (!call) return recording.stop("Native driver connection ended")
    const result = data(await call("get_recording_state", {}, 5000))
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
        recording.release("Task ended").then(() => recording.settled())
      )
    )
  }
}
