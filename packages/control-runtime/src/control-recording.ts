import { z } from "zod"
import { mediaExecutable, recordingVideoEncoding } from "./control-media.js"
import { RecordingEncoder } from "./recording-encoder.js"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  stat,
  rename,
  readdir,
  realpath,
  open,
  rm,
  type FileHandle,
} from "node:fs/promises"
import { join, isAbsolute } from "node:path"
import { randomUUID } from "node:crypto"
import { performance } from "node:perf_hooks"
import { heavy } from "./heavy-packages.js"
import { imageSize } from "image-size"
import { RecordingRenderer } from "./recording-render.js"
import {
  RECORDING_IDLE_HOLD_MS,
  RecordingOptionsSchema,
  type RecordingOptions,
  type RecordingReceipt,
  type ControlTarget,
} from "@mako/control/control"
import { controlRecordingsRoot } from "@mako/control/program"

const execute = promisify(execFile)
/** Whether this FFmpeg can rewrite packet timestamps without decoding. */
function streamTimestampFilter() {
  return execute(mediaExecutable("ffmpeg"), ["-hide_banner", "-bsfs"], { timeout: 5000, maxBuffer: 65536 })
    .then(({ stdout }) => /^setts$/m.test(stdout), () => false)
}
function recordingImageSize(bytes: Buffer) {
  try {
    return imageSize(bytes)
  } catch (cause) {
    throw new Error("Invalid recording frame: unsupported or corrupt image", { cause })
  }
}
interface Frame {
  file?: string
  firstOutputFrame?: number
  at: number
  width: number
  height: number
  viewportWidth?: number
  viewportHeight?: number
  pageScaleFactor?: number
  offsetTop?: number
  capturedAt?: number
}
interface Pointer {
  at: number
  x: number
  y: number
  pressed: boolean
}
interface IncomingFrame {
  data: Buffer
  width: number
  height: number
  metadata: {
    pageScaleFactor?: number
    offsetTop?: number
    capturedAt?: number
  }
}

function sameVideoImage(a: { bytes: Buffer; frame: Frame }, b: { bytes: Buffer; frame: Frame }) {
  return a.bytes.equals(b.bytes) &&
    a.frame.viewportWidth === b.frame.viewportWidth &&
    a.frame.viewportHeight === b.frame.viewportHeight &&
    a.frame.pageScaleFactor === b.frame.pageScaleFactor &&
    a.frame.offsetTop === b.frame.offsetTop
}

/** Explicit recording only. Frames and action evidence never enter model context. */
export class ControlRecording {
  readonly id = randomUUID()
  private startedAt = Date.now()
  private start = performance.now()
  private endedAt: number | undefined
  private state: RecordingReceipt["status"] = "recording"
  private error: string | undefined
  private readonly frames: Frame[] = []
  private readonly pointers: Pointer[] = []
  private readonly renderer = new RecordingRenderer()
  private encoder?: RecordingEncoder
  private videoEncoding?: ReturnType<typeof recordingVideoEncoding>
  private journal?: FileHandle
  private live?: Promise<void>
  private firstWrite?: {
    promise: Promise<void>
    resolve: () => void
    reject: (error: Error) => void
  }
  private readonly videoQueue: { bytes: Buffer; frame: Frame }[] = []
  private queuedVideoBytes = 0
  private videoWake?: () => void
  private outputFrames = 0
  private skippedFrameSlots = 0
  private unchangedFrameSlots = 0
  private sourceEnded = false
  private encodedDurationMs?: number
  private encodedFrames?: number
  private journalPointers = 0
  /** Why a native video kept its idle time, when trimming was asked for. */
  private idleKept: string | undefined
  /** Still stretches cut from the video, by the wall-clock time each cut starts. */
  private readonly idleTrims: { at: number; videoAt: number; trimmedMs: number }[] = []
  private readonly encodingTiming = {
    frames: 0,
    waitsOverFrameBudget: 0,
    maxScheduleLagMs: 0,
    maxWorkerWaitMs: 0,
    maxRenderMs: 0,
    maxPipeMs: 0,
    maxQueuedFrames: 0,
    maxQueuedBytes: 0,
    workerWaitMs: 0,
    renderMs: 0,
    pipeMs: 0,
    changedFrames: 0,
    sourceMetadataMs: 0,
    journalWriteMs: 0,
    // One sample per encoded second, bounded by the recording duration limit.
    progress: new Array<{
      atMs: number
      frames: number
      renderMs: number
      pipeMs: number
      workerWaitMs: number
      scheduleLagMs: number
    }>(),
  }
  private dropped = 0
  private writing: Promise<void> | undefined
  private pendingFrame: IncomingFrame | undefined
  private frameTimer: ReturnType<typeof setTimeout> | undefined
  private nextWriteAt = -Infinity
  private sampled = 0
  private finishing: Promise<void> | undefined
  private captureStopped: Promise<void | string> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private sourceVideo: string | undefined
  private sourceFrames: number | undefined
  private video: string | undefined
  private timeline: string | undefined
  private dimensions: RecordingReceipt["dimensions"]
  readonly target: ControlTarget
  readonly directory: string
  private readonly options: ReturnType<typeof RecordingOptionsSchema.parse> & {
    fps: number
  }
  private readonly onStop: () => Promise<void | string>
  private constructor(
    target: ControlTarget,
    directory: string,
    options: ReturnType<typeof RecordingOptionsSchema.parse> & { fps: number },
    onStop: () => Promise<void | string>
  ) {
    this.target = target
    this.directory = directory
    this.options = options
    this.onStop = onStop
  }

  static async create(
    target: ControlTarget,
    input: RecordingOptions,
    onStop: () => Promise<void | string>
  ) {
    const parsed = RecordingOptionsSchema.parse(input)
    const options = {
      ...parsed,
      fps: parsed.fps ?? (target.kind === "page" ? 60 : 30),
    }
    const root = options.directory ?? controlRecordingsRoot()
    if (!isAbsolute(root))
      throw new Error("Recording directory must be absolute")
    // Preflight before the capture stream starts; no silent screenshots-only fallback.
    const encoding = recordingVideoEncoding()
    const encoders = await execute(mediaExecutable("ffmpeg"), ["-hide_banner", "-encoders"], {
      timeout: 5000,
      maxBuffer: 131_072,
    })
    if (!encoders.stdout.split("\n").some((line) => line.trim().split(/\s+/)[1] === encoding.codec))
      throw new Error(`Recording requires ${encoding.codec}, which is missing from this FFmpeg build. Install the current Mako recording tools. No software fallback was started.`)
    mediaExecutable("ffprobe")
    await mkdir(root, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(join(await realpath(root), "recording-"))
    const recording = new ControlRecording(target, directory, options, onStop)
    if (target.kind === "page") {
      recording.videoEncoding = encoding
      recording.encoder = new RecordingEncoder(directory, (reason) => {
        recording.firstWrite?.reject(new Error(reason))
        void recording.stop(reason)
      })
      try {
        await recording.encoder.ready
      } catch (error) {
        await recording.stop("Recording worker could not start")
        await recording.settled()
        throw error
      }
      // Loading the worker is startup work, not captured time. Complete it
      // before subscribing so capture does not begin with a frozen first frame.
      recording.start = performance.now()
      recording.startedAt = Date.now()
    }
    recording.timer = setTimeout(() => {
      void recording.stop("Recording reached its duration limit")
    }, options.maxDurationMs)
    recording.timer.unref()
    return recording
  }
  receipt(): RecordingReceipt {
    const receipt: RecordingReceipt = {
      id: this.id,
      target: this.target,
      status: this.state,
      directory: this.directory,
      startedAt: this.startedAt,
      durationMs: this.endedAt ?? performance.now() - this.start,
      frames: this.sourceFrames ?? this.frames.length,
      droppedFrames: this.dropped,
      sampledFrames: this.sampled,
    }
    if (this.encoder) receipt.frameRate = {
      requestedFps: this.options.fps,
      encodedFps: (this.encodedFrames ?? this.outputFrames) * 1000 /
        Math.max(1, this.encodedDurationMs ?? receipt.durationMs),
      skippedFrameSlots: this.skippedFrameSlots,
      unchangedFrameSlots: this.unchangedFrameSlots,
    }
    if (this.video) receipt.video = this.video
    if (this.timeline) receipt.timeline = this.timeline
    if (this.dimensions) receipt.dimensions = this.dimensions
    if (this.encodedDurationMs !== undefined)
      receipt.encodedDurationMs = this.encodedDurationMs
    if (this.encodedFrames !== undefined)
      receipt.encodedFrames = this.encodedFrames
    if (this.idleTrims.length)
      receipt.idleTrimmedMs = this.idleTrims.reduce((total, trim) => total + trim.trimmedMs, 0)
    if (this.error) receipt.error = this.error
    return receipt
  }
  markStarted() {
    this.startedAt = Date.now()
    this.start = performance.now()
  }
  async attachVideo(path: string) {
    if (path !== join(this.directory, "recording.mp4"))
      throw new Error("Native video path does not match this recording")
    const probe = z
      .object({
        streams: z.array(
          z.object({
            codec_type: z.string(),
            codec_name: z.string().optional(),
            r_frame_rate: z.string().optional(),
            width: z.number().optional(),
            height: z.number().optional(),
            nb_frames: z.string().optional(),
          })
        ),
        format: z.object({ duration: z.string() }),
      })
      .parse(
        JSON.parse(
          (
            await execute(
              mediaExecutable("ffprobe"),
              [
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                path,
              ],
              { timeout: 5000, maxBuffer: 65536 }
            )
          ).stdout
        )
      )
    const stream = probe.streams.find((s) => s.codec_type === "video")
    const width = z.number().int().positive().max(16_384).parse(stream?.width)
    const height = z.number().int().positive().max(16_384).parse(stream?.height)
    this.endedAt = z
      .number()
      .positive()
      .max(610_000)
      .parse(Number(probe.format.duration) * 1000)
    this.sourceFrames = z
      .number()
      .int()
      .nonnegative()
      .parse(Number(stream?.nb_frames))
    // These points are emitted at the native event-posting boundary, independent
    // of AX/screenshot capture. Pre-action element centers are never substituted.
    if (this.options.cursor) {
      const entries = (await readdir(this.directory))
        .filter((name) => /^turn-[0-9]{5}$/.test(name))
        .sort()
      if (entries.length > 20_000)
        throw new Error("Native recording exceeded its action budget")
      const actionSchema = z.object({
        pointer_dispatches: z
          .array(
            z.object({
              at_ms: z.number().nonnegative(),
              x: z.number().min(0).max(1),
              y: z.number().min(0).max(1),
              pressed: z.boolean(),
            })
          )
          .max(2048),
      })
      for (const entry of entries) {
        const actionPath = join(this.directory, entry, "action.json")
        if ((await stat(actionPath)).size > 1_048_576) continue
        const action = actionSchema.safeParse(
          JSON.parse(await readFile(actionPath, "utf8"))
        )
        if (!action.success) continue
        for (const point of action.data.pointer_dispatches) {
          if (point.at_ms <= this.endedAt)
            this.pointers.push({
              at: point.at_ms,
              x: point.x * width,
              y: point.y * height,
              pressed: point.pressed,
            })
          if (this.pointers.length > 20_000)
            throw new Error("Native recording exceeded its pointer budget")
        }
      }
      this.pointers.sort((a, b) => a.at - b.at)
    }
    // The driver writes frames only when the window changes, so its video has
    // a variable rate; that plays as it is. It is re-encoded only to draw
    // pointer events onto it.
    const playable =
      !this.pointers.length &&
      Math.max(width, height) <= this.options.maxSide &&
      stream?.codec_name === "h264"
    this.sourceVideo = join(this.directory, "source.mp4")
    await rename(path, this.sourceVideo)
    if (this.options.idle === "trim") {
      const trimmed = join(this.directory, playable ? "recording.mp4" : "source-trimmed.mp4")
      if (await this.trimNativeIdle(this.sourceVideo, trimmed)) {
        if (!playable) this.sourceVideo = trimmed
        else await rm(this.sourceVideo)
      }
    }
    if (playable) {
      this.dimensions = { width, height }
      if (!this.idleTrims.length) await rename(this.sourceVideo, path)
      this.video = path
      return
    }
    const file = "cursor-background.png"
    const sizeScale = Math.min(
      1,
      this.options.maxSide / Math.max(width, height)
    )
    const sharp = await heavy.sharp.load("recording frame")
    await sharp({
      create: {
        width: Math.max(2, Math.round(width * sizeScale)),
        height: Math.max(2, Math.round(height * sizeScale)),
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toFile(join(this.directory, file))
    this.frames.push({ file, at: 0, width, height })
  }
  pointer(point: {
    x: number
    y: number
    pressed: boolean
    dispatchedAt?: number
  }) {
    if (this.state !== "recording" || !this.options.cursor) return
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return
    if (this.pointers.length >= 20_000) {
      void this.stop("Recording reached its action limit")
      return
    }
    this.pointers.push({
      at: Math.max(0, (point.dispatchedAt ?? performance.now()) - this.start),
      x: point.x,
      y: point.y,
      pressed: point.pressed,
    })
  }
  frame(
    data: Buffer,
    width: number,
    height: number,
    metadata: {
      pageScaleFactor?: number
      offsetTop?: number
      capturedAt?: number
    } = {}
  ): Promise<void> {
    if (this.state !== "recording") return Promise.resolve()
    if (this.pendingFrame) this.sampled++
    this.pendingFrame = {
      data,
      width,
      height,
      metadata: { ...metadata, capturedAt: metadata.capturedAt ?? Date.now() },
    }
    return this.flushFrame()
  }
  private flushFrame(): Promise<void> {
    if (this.writing) return this.writing
    if (this.state !== "recording" || !this.pendingFrame)
      return Promise.resolve()
    const remaining = this.nextWriteAt - performance.now()
    if (remaining > 0) {
      if (!this.frameTimer)
        this.frameTimer = setTimeout(() => {
          this.frameTimer = undefined
          void this.flushFrame()
        }, Math.ceil(remaining))
      return Promise.resolve()
    }
    const pending = this.pendingFrame
    this.pendingFrame = undefined
    clearTimeout(this.frameTimer)
    this.frameTimer = undefined
    return this.storeFrame(pending)
  }
  private storeFrame({
    data,
    width,
    height,
    metadata,
  }: IncomingFrame): Promise<void> {
    const interval = 1000 / this.options.fps
    // Keep cadence when a timer fires late; never queue old frames to catch up.
    const now = performance.now()
    this.nextWriteAt =
      this.nextWriteAt === -Infinity
        ? now + interval
        : Math.max(this.nextWriteAt + interval, now)
    if (
      data.length > 9_000_000 ||
      this.frames.length >=
        Math.ceil((this.options.maxDurationMs * this.options.fps) / 1000) + 2
    ) {
      void this.stop("Recording reached its frame or storage limit")
      return Promise.resolve()
    }
    const receivedAt = performance.now() - this.start
    const capturedAt =
      metadata.capturedAt === undefined
        ? receivedAt
        : metadata.capturedAt - this.startedAt
    const at =
      capturedAt >= 0 && capturedAt <= receivedAt + 100
        ? capturedAt
        : receivedAt
    if (this.frames.length && at < this.frames[this.frames.length - 1]!.at) {
      this.dropped++
      return Promise.resolve()
    }
    const bytes = data
    this.writing = (async () => {
      const metadataStart = performance.now()
      // Capture already uses this bounded header reader. Do not dispatch a
      // second libvips job just for dimensions on every received frame; the
      // encoder still decodes and validates pixels before acknowledging them.
      const imageMetadata = recordingImageSize(bytes)
      this.encodingTiming.sourceMetadataMs += performance.now() - metadataStart
      if (
        !imageMetadata.width ||
        !imageMetadata.height ||
        imageMetadata.width * imageMetadata.height > 16_000_000 ||
        width <= 0 ||
        height <= 0 ||
        !Number.isFinite(width) ||
        !Number.isFinite(height)
      )
        throw new Error("Invalid recording frame geometry")
      const frame: Frame = {
        at,
        width: imageMetadata.width,
        height: imageMetadata.height,
        viewportWidth: width,
        viewportHeight: height,
        ...metadata,
      }
      if (!this.dimensions) {
        let resolve!: () => void, reject!: (error: Error) => void
        const promise = new Promise<void>((yes, no) => {
          resolve = yes
          reject = no
        })
        this.firstWrite = { promise, resolve, reject }
        void promise.catch(() => {})
        const scale = Math.min(
          1,
          this.options.maxSide / Math.max(width, height)
        )
        this.dimensions = {
          width: Math.max(2, Math.floor((width * scale) / 2) * 2),
          height: Math.max(2, Math.floor((height * scale) / 2) * 2),
        }
        this.journal = await open(
          join(this.directory, "timeline.jsonl"),
          "wx",
          0o600
        )
        this.timeline = join(this.directory, "timeline.jsonl")
        await this.journal.writeFile(
          JSON.stringify({
            version: 4,
            target: this.target,
            startedAt: this.startedAt,
            fps: this.options.fps,
            outputTiming: "presentation-timestamps",
            dimensions: this.dimensions,
          }) + "\n"
        )
        await this.encoder!.initialize(
          this.dimensions.width,
          this.dimensions.height,
          this.options.fps
        )
      }
      const index = this.frames.length
      const queued = { bytes, frame }
      const tail = this.videoQueue.at(-1)
      // Exact repeated pixels add no transition. Keep the first timestamp and
      // still journal every source observation and pointer event. Never merge
      // across a different intervening image or geometry.
      const repeated = tail !== undefined && sameVideoImage(tail, queued)
      // Keep source history within a strict budget. When the encoder cannot
      // keep up, retain the newest samples and report evictions. Timestamps hold
      // the last encoded image across the gap; neither speed nor sharpness changes.
      while (!repeated && this.videoQueue.length && (
        this.videoQueue.length >= Math.ceil(this.options.fps * 2) + 2 ||
        this.queuedVideoBytes + bytes.length > 32 * 1024 * 1024
      )) {
        this.queuedVideoBytes -= this.videoQueue.shift()!.bytes.length
        this.dropped++
      }
      const pointerEnd = this.pointers.length
      const journalStart = performance.now()
      await this.journal!.writeFile(
        JSON.stringify({
          frame: { ...frame, index },
          pointer: this.pointers.slice(this.journalPointers, pointerEnd),
        }) + "\n"
      )
      this.encodingTiming.journalWriteMs += performance.now() - journalStart
      this.journalPointers = pointerEnd
      this.frames.push(frame)
      if (!repeated) {
        this.videoQueue.push(queued)
        this.queuedVideoBytes += bytes.length
      }
      this.encodingTiming.maxQueuedFrames = Math.max(
        this.encodingTiming.maxQueuedFrames,
        this.videoQueue.length
      )
      this.encodingTiming.maxQueuedBytes = Math.max(
        this.encodingTiming.maxQueuedBytes,
        this.queuedVideoBytes
      )
      this.videoWake?.()
      this.live ??= this.encodeLive().catch((error) => {
        const reason =
          error instanceof Error ? error.message : "Live video encoding failed"
        this.firstWrite?.reject(new Error(reason))
        this.encoder?.abort(reason)
        void this.stop(reason)
      })
      if (index === 0) await this.firstWrite!.promise
    })()
      .catch((error) => {
        void this.stop(
          error instanceof Error ? error.message : "Recording frame failed"
        )
      })
      .finally(() => {
        this.writing = undefined
        void this.flushFrame()
      })
    return this.writing
  }
  async stop(reason?: string): Promise<RecordingReceipt> {
    if (this.finishing) return this.receipt()
    this.endedAt = performance.now() - this.start
    this.state = "finalizing"
    this.error = reason
    clearTimeout(this.timer)
    clearTimeout(this.frameTimer)
    this.finishing = (async () => {
      this.captureStopped = this.onStop()
      const cleanup = await this.captureStopped
      if (cleanup && !this.error) this.error = cleanup
      await this.writing
      const pending = this.pendingFrame
      this.pendingFrame = undefined
      if (pending) await this.storeFrame(pending)
      this.sourceEnded = true
      this.videoWake?.()
      await this.live
      if (this.encoder) {
        const result = await this.encoder.finish()
        this.video = result.path
        this.encodedDurationMs = result.durationMs
        this.encodedFrames = result.retainedFrames ?? this.outputFrames
        if (result.error) this.error ??= result.error
      } else if (!this.video) await this.encodeNativeOverlay()
      this.timeline = join(this.directory, "timeline.json")
      await writeFile(
        this.timeline,
        JSON.stringify(
          {
            version: 4,
            name: this.options.name,
            target: this.target,
            pointerTiming:
              this.target.kind === "window"
                ? "native-event-post; dispatch does not confirm application acceptance"
                : "host-dispatch; dispatch does not confirm application acceptance",
            startedAt: this.startedAt,
            durationMs: this.endedAt,
            frames: this.frames,
            encodedFrames: this.encodedFrames ?? this.sourceFrames,
            submittedFrames: this.encoder ? this.outputFrames : undefined,
            encodingTiming: this.encoder ? this.encodingTiming : undefined,
            frameRate: this.receipt().frameRate,
            outputTiming: this.encoder ? "presentation-timestamps" : "native-capture",
            // Frame and pointer times are wall-clock. Video time is wall-clock
            // time less every cut that starts before it.
            idle: { mode: this.options.idle, holdMs: RECORDING_IDLE_HOLD_MS, trims: this.idleTrims, kept: this.idleKept ?? null },
            videoEncoding: this.videoEncoding,
            encodedDurationMs: this.encodedDurationMs,
            pointer: this.pointers,
            droppedFrames: this.dropped,
            sampledFrames: this.sampled,
            fps: this.options.fps,
            interruption: this.error ?? null,
          },
          null,
          2
        ),
        { mode: 0o600 }
      )
      this.state = this.error ? "interrupted" : "finished"
    })()
      .catch((error) => {
        this.state = "failed"
        this.error ??=
          error instanceof Error
            ? error.message
            : "Recording finalization failed"
      })
      .finally(async () => {
        this.sourceEnded = true
        this.videoWake?.()
        if (this.state === "failed")
          this.encoder?.abort(this.error ?? "Recording cleanup")
        await this.live
        await this.encoder?.finish().catch(() => {})
        await this.journal
          ?.writeFile(
            JSON.stringify({
              end: this.receipt(),
              pointer: this.pointers.slice(this.journalPointers),
            }) + "\n"
          )
          .catch(() => {})
        await this.journal?.close().catch(() => {})
        this.videoQueue.length = 0
        this.queuedVideoBytes = 0
      })
    return this.receipt()
  }
  async release(reason: string) {
    await this.stop(reason)
    await this.captureStopped?.catch(() => {})
  }
  async settled() {
    await this.finishing
    return this.receipt()
  }
  /** Presentation time follows capture time, independently of encoding rate.
   * Source gaps hold the last image; catching up never speeds up the video. */
  private async encodeLive() {
    const encoder = this.encoder!
    const interval = 1000 / this.options.fps
    let current: (typeof this.videoQueue)[number] | undefined
    let previousState = "",
      imageRevision = 0
    let pointerIndex = -1,
      pressIndex = -1
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer)
          if (this.videoWake === wake) this.videoWake = undefined
          resolve()
        }
        const timer = setTimeout(wake, Math.max(1, ms))
        this.videoWake = wake
      })
    let submittedFrames = 0
    let nextOrdinal = 0
    let lastSubmittedAt = -Infinity
    let lastChangeAt = 0
    let trimmed = 0
    let sealCopies = 0
    const trim = this.options.idle === "trim"
    let nextProgressAt = 1000
    const pending: Promise<void>[] = []
    try {
      for (;;) {
        if (pending.length === 2) await pending.shift()
        const finalCount = Math.max(
          1,
          Math.ceil((this.endedAt ?? 0) / interval)
        )
        if (this.sourceEnded && lastSubmittedAt >= (finalCount - 1) * interval) break
        const elapsed = this.endedAt ?? performance.now() - this.start
        const due = Math.max(0, Math.floor(elapsed / interval))
        // Start at zero even when initial capture/encoder startup is slow. Later
        // backpressure skips old opportunities rather than building a catch-up
        // loop. Preserve a final sample so the retained duration matches capture.
        let ordinal = submittedFrames === 0 ? 0 : Math.max(nextOrdinal, due)
        if (this.sourceEnded) ordinal = Math.min(ordinal, finalCount - 1)
        // Retain transient states during a short stall when history still fits;
        // do not lose a popup merely because identical opportunities were skipped.
        // Sustained pressure trails capture by at most two seconds and skips the
        // oldest history evenly. Jumping to the present would freeze the video
        // for the whole backlog.
        const pressExpiry = this.pointers[pressIndex]?.at !== undefined
          ? this.pointers[pressIndex]!.at + 400 : Infinity
        const nextChangeAt = Math.min(
          this.videoQueue[0]?.frame.at ?? Infinity,
          this.pointers[pointerIndex + 1]?.at ?? Infinity,
          pressExpiry > lastSubmittedAt ? pressExpiry : Infinity
        )
        if (current && Number.isFinite(nextChangeAt)) {
          const changeOrdinal = Math.max(nextOrdinal, Math.ceil(nextChangeAt / interval))
          const oldestOrdinal = Math.ceil((elapsed - 2000) / interval)
          ordinal = Math.min(ordinal, Math.max(changeOrdinal, oldestOrdinal))
        }
        const at = ordinal * interval
        if (
          !this.sourceEnded &&
          this.endedAt !== undefined &&
          at >= this.endedAt
        ) {
          await wait(interval)
          continue
        }
        const remaining = this.start + at - performance.now()
        if (!this.sourceEnded && remaining > 0) {
          await wait(remaining)
          continue
        }
        this.skippedFrameSlots += Math.max(0, ordinal - nextOrdinal)
        // Stop can revisit the last coalesced slot to close the exact duration.
        if (ordinal < nextOrdinal) this.unchangedFrameSlots--
        nextOrdinal = ordinal + 1
        this.encodingTiming.maxScheduleLagMs = Math.max(
          this.encodingTiming.maxScheduleLagMs,
          -remaining
        )
        let next: typeof current
        while (
          this.videoQueue[0] &&
          (!current ||
            this.videoQueue[0].frame.at <= at ||
            (this.sourceEnded && ordinal === finalCount - 1))
        ) {
          if (next) this.sampled++
          next = this.videoQueue.shift()!
          this.queuedVideoBytes -= next.bytes.length
          // The first output may precede the first source timestamp by a fraction
          // of one frame. Do not pull later future samples into that first output.
          if (!current) break
        }
        if (next) {
          if (
            !current ||
            !sameVideoImage(current, next)
          )
            imageRevision++
          current = next
        }
        if (!current) throw new Error("No video frame was available")
        while (
          pointerIndex + 1 < this.pointers.length &&
          this.pointers[pointerIndex + 1]!.at <= at
        ) {
          pointerIndex++
          if (this.pointers[pointerIndex]!.pressed) pressIndex = pointerIndex
        }
        const press = this.pointers[pressIndex]
        const state = `${imageRevision}:${pointerIndex}:${!!press && at - press.at < 400}`
        const changed = state !== previousState
        const finalFrame = this.sourceEnded && ordinal === finalCount - 1
        const still = at - lastChangeAt
        // A one-second heartbeat publishes playable fragments during still
        // scenes. Cursor transitions and the final sample are never coalesced.
        // Trimming seals the hold instead. A fragment reaches disk once a
        // keyframe follows it and leaves the encoder once a frame follows that,
        // so the hold ends with two copies on consecutive slots, the first
        // always forced to a keyframe: a crash mid-pause keeps every change.
        const sealing = trim && !changed && !finalFrame && still >= RECORDING_IDLE_HOLD_MS && sealCopies < 2
        if (!changed && !finalFrame && !sealing && (trim || at - lastSubmittedAt < 1000)) {
          this.unchangedFrameSlots++
          continue
        }
        const hold = RECORDING_IDLE_HOLD_MS + sealCopies * interval
        if (trim && submittedFrames > 0 && !sealing && still > hold) {
          this.idleTrims.push({ at: lastChangeAt + hold, videoAt: lastChangeAt + hold - trimmed, trimmedMs: still - hold })
          trimmed += still - hold
        }
        const frameAt = sealing ? lastChangeAt + hold : at
        sealCopies = changed ? 0 : sealCopies + (sealing ? 1 : 0)
        if (changed) lastChangeAt = at
        const outputIndex = submittedFrames
        const reportProgress = at >= nextProgressAt
        if (reportProgress) nextProgressAt = at + 1000
        const workerStart = performance.now()
        const recordedFrame = current.frame
        const write = encoder
          .write(
            frameAt,
            frameAt - trimmed,
            changed
              ? {
                  bytes: current.bytes,
                  frame: current.frame,
                  pointer: this.pointers[pointerIndex],
                  press,
                }
              : undefined
          )
          .then(async (timing) => {
            const workerWait = performance.now() - workerStart
            this.encodingTiming.frames++
            this.encodingTiming.workerWaitMs += workerWait
            this.encodingTiming.renderMs += timing.renderMs
            this.encodingTiming.pipeMs += timing.pipeMs
            if (changed) this.encodingTiming.changedFrames++
            if (workerWait > interval)
              this.encodingTiming.waitsOverFrameBudget++
            this.encodingTiming.maxWorkerWaitMs = Math.max(
              this.encodingTiming.maxWorkerWaitMs,
              workerWait
            )
            this.encodingTiming.maxRenderMs = Math.max(
              this.encodingTiming.maxRenderMs,
              timing.renderMs
            )
            this.encodingTiming.maxPipeMs = Math.max(
              this.encodingTiming.maxPipeMs,
              timing.pipeMs
            )
            this.firstWrite?.resolve()
            recordedFrame.firstOutputFrame ??= outputIndex
            this.outputFrames++
            if (reportProgress)
              this.encodingTiming.progress.push({
                atMs: performance.now() - this.start,
                frames: this.outputFrames,
                renderMs: this.encodingTiming.renderMs,
                pipeMs: this.encodingTiming.pipeMs,
                workerWaitMs: this.encodingTiming.workerWaitMs,
                scheduleLagMs: Math.max(
                  0,
                  performance.now() - this.start - (ordinal + 1) * interval
                ),
              })
            if (
              reportProgress &&
              (await stat(join(this.directory, "recording.partial.mp4"))).size >
                512 * 1024 * 1024
            )
              void this.stop(
                "Recording reached its encoded-video storage limit"
              )
          })
        // Observe rejection immediately even while the older frame is pending.
        // Awaiting it below still propagates the original failure.
        void write.catch(() => {})
        pending.push(write)
        submittedFrames++
        lastSubmittedAt = at
        previousState = state
      }
      await Promise.all(pending)
    } catch (error) {
      encoder.abort(
        error instanceof Error ? error.message : "Video pipeline failed"
      )
      await Promise.allSettled(pending)
      throw error
    }
  }
  /** Wall-clock time to video time, past every trimmed still stretch. */
  private videoTime(at: number) {
    let shifted = at
    for (const trim of this.idleTrims) shifted -= Math.min(Math.max(at - trim.at, 0), trim.trimmedMs)
    return shifted
  }

  /**
   * Cuts still stretches from a native video without re-encoding it. The
   * driver writes no frame while a window is still, so each stretch is a gap
   * in presentation times; packets after it move back, and the last frame is
   * held at most one hold. Presentation and decode times are cut at their own
   * gaps, and every packet is checked to stay decodable before FFmpeg runs.
   * Anything unexpected keeps the wall-clock video and says why.
   */
  private async trimNativeIdle(source: string, output: string): Promise<boolean> {
    const keep = (reason: string) => {
      this.idleKept = reason
      return false
    }
    try {
      const { stdout } = await execute(mediaExecutable("ffprobe"), [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "packet=pts_time,dts_time:format=duration",
        "-of", "json", source,
      ], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 })
      const probe = z.object({
        packets: z.array(z.object({ pts_time: z.string(), dts_time: z.string() })).max(40_000),
        format: z.object({ duration: z.string() }),
      }).parse(JSON.parse(stdout))
      const packets = probe.packets.map((packet) => ({ pts: Number(packet.pts_time), dts: Number(packet.dts_time) }))
      if (!packets.length || packets.some((packet) => !Number.isFinite(packet.pts) || !Number.isFinite(packet.dts)))
        return keep("The native video has packets without timestamps; idle time was kept")
      const hold = RECORDING_IDLE_HOLD_MS / 1000
      const steps = (times: number[]) => {
        const found: { from: number; to: number; removed: number }[] = []
        for (let index = 1; index < times.length; index++) {
          const gap = times[index]! - times[index - 1]!
          if (gap > hold) found.push({ from: times[index - 1]!, to: times[index]!, removed: gap - hold })
        }
        return found
      }
      const presentation = steps(packets.map((packet) => packet.pts).sort((a, b) => a - b))
      const decode = steps(packets.map((packet) => packet.dts))
      const last = Math.max(...packets.map((packet) => packet.pts))
      const tail = Math.max(0, Number(probe.format.duration) - last - hold)
      if (!presentation.length && !tail) return false
      if (!(await streamTimestampFilter()))
        return keep("This FFmpeg build cannot shift packet timestamps; idle time was kept")
      if (presentation.length > 500) return keep("The native video has too many still stretches to trim; idle time was kept")
      const shift = (cuts: typeof presentation, time: number) =>
        cuts.reduce((total, cut) => total + (time >= (cut.from + cut.to) / 2 ? cut.removed : 0), 0)
      let previous = -Infinity
      for (const packet of packets) {
        const dts = packet.dts - shift(decode, packet.dts)
        if (dts <= previous || dts > packet.pts - shift(presentation, packet.pts) + 1e-6)
          return keep("Trimming would make the native video undecodable; idle time was kept")
        previous = dts
      }
      const expression = (variable: string, cuts: typeof presentation) =>
        `${variable}-(${cuts.map((cut) => `gte(${variable}*TB\\,${(cut.from + cut.to) / 2})*${cut.removed}`).join("+") || "0"})/TB`
      const filters = [`pts=${expression("PTS", presentation)}`, `dts=${expression("DTS", decode)}`]
      if (tail) filters.push(`duration=if(gte(PTS*TB\\,${last - 0.0005})\\,min(DURATION\\,${hold}/TB)\\,DURATION)`)
      await execute(mediaExecutable("ffmpeg"), [
        "-hide_banner", "-loglevel", "error", "-n", "-i", source,
        "-map", "0:v", "-c", "copy", "-bsf:v", `setts=${filters.join(":")}`,
        "-movflags", "+faststart", output,
      ], { timeout: 60_000, maxBuffer: 65536 })
      const removed = presentation.reduce((total, cut) => total + cut.removed, 0) + tail
      const duration = Number(z.object({ format: z.object({ duration: z.string() }) }).parse(JSON.parse((await execute(mediaExecutable("ffprobe"), [
        "-v", "error", "-show_entries", "format=duration", "-of", "json", output,
      ], { timeout: 5000, maxBuffer: 65536 })).stdout)).format.duration)
      if (Math.abs(duration - (Number(probe.format.duration) - removed)) > 0.1) {
        await rm(output, { force: true })
        return keep("The trimmed native video had an unexpected length; idle time was kept")
      }
      let total = 0
      for (const cut of [...presentation, ...(tail ? [{ from: last, to: last + hold + tail, removed: tail }] : [])]) {
        this.idleTrims.push({ at: (cut.from + hold) * 1000, videoAt: (cut.from + hold) * 1000 - total, trimmedMs: cut.removed * 1000 })
        total += cut.removed * 1000
      }
      return true
    } catch (error) {
      await rm(output, { force: true })
      return keep(`Idle time was kept: ${error instanceof Error ? error.message.slice(0, 200) : "trimming failed"}`)
    }
  }

  private async encodeNativeOverlay() {
    const frame = this.frames[0]
    if (!this.sourceVideo || !frame?.file)
      throw new Error("Native capture stopped without a video to finalize")
    const sharp = await heavy.sharp.load("recording video")
    const metadata = await sharp(join(this.directory, frame.file)).metadata()
    const sizeScale = Math.min(
      1,
      this.options.maxSide /
        Math.max(metadata.width ?? 1600, metadata.height ?? 1000)
    )
    const width = Math.max(
      2,
      Math.floor(((metadata.width ?? 1600) * sizeScale) / 2) * 2
    )
    const height = Math.max(
      2,
      Math.round(
        (width * (metadata.height ?? 1000)) / (metadata.width ?? 1600) / 2
      ) * 2
    )
    this.dimensions = { width, height }
    const output = join(this.directory, "recording.mp4")
    this.videoEncoding = recordingVideoEncoding()
    const child = spawn(
      mediaExecutable("ffmpeg"),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-n",
        "-filter_threads",
        "1",
        "-filter_complex_threads",
        "1",
        "-i",
        this.sourceVideo,
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgba",
        "-video_size",
        `${width}x${height}`,
        "-framerate",
        String(this.options.fps),
        "-i",
        "pipe:0",
        "-filter_complex",
        // A native video holds its last frame until stop, but a filter graph
        // ends that stream where the frame starts; the overlay frames set the length.
        `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,tpad=stop=-1:stop_mode=clone[base];[base][1:v]overlay=shortest=1,fps=${this.options.fps}`,
        ...this.videoEncoding.args,
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        output,
      ],
      { cwd: this.directory, stdio: ["pipe", "ignore", "pipe"] }
    )
    let tail = ""
    child.stderr.on("data", (data: Buffer) => {
      tail = (tail + data.toString()).slice(-4096)
    })
    const encoding = new Promise<void>((resolve, reject) => {
      child.on("error", reject)
      child.on("close", (code) => {
        if (code === 0) resolve()
        else reject(new Error(`Video encoding failed: ${tail}`))
      })
    })
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort(new Error("Video encoding timed out"))
      child.kill("SIGKILL")
    }, 120_000)
    // pipeline bounds queued buffers and waits for stdin backpressure. No rendered
    // images accumulate on disk, even for a dense full-resolution recording.
    const frames = Readable.from(
      this.renderNativeOverlayFrames({ ...frame, file: frame.file }, width, height),
      { objectMode: false, highWaterMark: 1 }
    )
    const streaming = pipeline(frames, child.stdin, {
      signal: controller.signal,
    })
    try {
      await Promise.all([streaming, encoding])
    } catch (error) {
      const failure = controller.signal.aborted
        ? controller.signal.reason
        : error
      controller.abort()
      child.kill("SIGKILL")
      await Promise.allSettled([streaming, encoding])
      throw failure
    } finally {
      clearTimeout(timeout)
    }
    if ((await stat(output)).size === 0)
      throw new Error("Video encoder produced an empty file")
    this.video = output
  }

  private async *renderNativeOverlayFrames(
    frame: Frame & { file: string },
    width: number,
    height: number
  ): AsyncGenerator<Buffer> {
    const trimmed = this.idleTrims.reduce((total, trim) => total + trim.trimmedMs, 0)
    const count = Math.max(
      1,
      Math.ceil((((this.endedAt ?? 0) - trimmed) * this.options.fps) / 1000)
    )
    const pointers = this.pointers.map((point) => ({ ...point, at: this.videoTime(point.at) }))
    let pointerIndex = -1,
      pressIndex = -1
    let previousState = ""
    let rendered: Buffer | undefined
    for (let index = 0; index < count; index++) {
      // Use the recording clock directly: exactly one duration per output frame.
      const at = (index * 1000) / this.options.fps
      while (
        pointerIndex + 1 < pointers.length &&
        pointers[pointerIndex + 1]!.at <= at
      ) {
        pointerIndex++
        if (pointers[pointerIndex]!.pressed) pressIndex = pointerIndex
      }
      const press = pointers[pressIndex]
      const pressed = !!press && at - press.at < 400
      const state = `${pointerIndex}:${pressed}`
      if (rendered && state === previousState) {
        yield rendered
        continue
      }
      const pointer = pointers[pointerIndex]
      rendered = await this.renderer.render(
        await readFile(join(this.directory, frame.file)),
        frame,
        at,
        pointer,
        press,
        width,
        height,
        "transparent"
      )
      previousState = state
      yield rendered
    }
  }
}
