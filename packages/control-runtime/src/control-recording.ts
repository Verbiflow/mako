import { z } from "zod"
import { mediaExecutable } from "./control-media.js"
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
  type FileHandle,
} from "node:fs/promises"
import { join, isAbsolute } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { performance } from "node:perf_hooks"
import sharp from "sharp"
import { renderRecordingImage } from "./recording-render.js"
import {
  RecordingOptionsSchema,
  type RecordingOptions,
  type RecordingReceipt,
  type ControlTarget,
} from "@mako/control/control"

const execute = promisify(execFile)
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
  private encoder?: RecordingEncoder
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
  private sourceEnded = false
  private encodedDurationMs?: number
  private encodedFrames?: number
  private journalPointers = 0
  private readonly encodingTiming = {
    frames: 0,
    waitsOverFrameBudget: 0,
    maxScheduleLagMs: 0,
    maxWorkerWaitMs: 0,
    maxRenderMs: 0,
    maxPipeMs: 0,
    maxQueuedFrames: 0,
    maxQueuedBytes: 0,
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
    const root =
      options.directory ??
      (process.env.MAKO_CONTROL_ARTIFACTS
        ? join(process.env.MAKO_CONTROL_ARTIFACTS, "recordings")
        : join(tmpdir(), "mako-recordings"))
    if (!isAbsolute(root))
      throw new Error("Recording directory must be absolute")
    // Preflight before the capture stream starts; no silent screenshots-only fallback.
    await execute(mediaExecutable("ffmpeg"), ["-version"], {
      timeout: 5000,
      maxBuffer: 16_384,
    })
    mediaExecutable("ffprobe")
    await mkdir(root, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(join(await realpath(root), "recording-"))
    const recording = new ControlRecording(target, directory, options, onStop)
    if (target.kind === "page") {
      recording.encoder = new RecordingEncoder(directory, (reason) => {
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
    if (this.video) receipt.video = this.video
    if (this.timeline) receipt.timeline = this.timeline
    if (this.dimensions) receipt.dimensions = this.dimensions
    if (this.encodedDurationMs !== undefined)
      receipt.encodedDurationMs = this.encodedDurationMs
    if (this.encodedFrames !== undefined)
      receipt.encodedFrames = this.encodedFrames
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
    const [rateNumerator, rateDenominator] = (stream?.r_frame_rate ?? "")
      .split("/")
      .map(Number)
    if (
      !this.options.cursor &&
      Math.max(width, height) <= this.options.maxSide &&
      stream?.codec_name === "h264" &&
      rateDenominator > 0 &&
      rateNumerator / rateDenominator === this.options.fps
    ) {
      this.dimensions = { width, height }
      this.video = path
      return
    }
    this.sourceVideo = join(this.directory, "source.mp4")
    await rename(path, this.sourceVideo)
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
    const file = "cursor-background.png"
    const sizeScale = Math.min(
      1,
      this.options.maxSide / Math.max(width, height)
    )
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
      const imageMetadata = await sharp(bytes, {
        limitInputPixels: 16_000_000,
      }).metadata()
      if (
        !imageMetadata.width ||
        !imageMetadata.height ||
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
            version: 3,
            target: this.target,
            startedAt: this.startedAt,
            fps: this.options.fps,
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
      // Recording needs source history while encoding catches up. A preview's
      // latest-only policy would repeat old pixels until its clock caught up,
      // even though valid intermediate source frames had arrived.
      if (
        this.videoQueue.length >= Math.ceil(this.options.fps * 2) + 2 ||
        this.queuedVideoBytes + bytes.length > 32 * 1024 * 1024
      ) {
        this.dropped++
        void this.stop(
          "Recording encoder backlog exceeded its frame or byte budget"
        )
        return
      }
      const pointerEnd = this.pointers.length
      await this.journal!.writeFile(
        JSON.stringify({
          frame: { ...frame, index },
          pointer: this.pointers.slice(this.journalPointers, pointerEnd),
        }) + "\n"
      )
      this.journalPointers = pointerEnd
      this.frames.push(frame)
      this.videoQueue.push({ bytes, frame })
      this.queuedVideoBytes += bytes.length
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
      } else if (!this.video) await this.encode()
      this.timeline = join(this.directory, "timeline.json")
      await writeFile(
        this.timeline,
        JSON.stringify(
          {
            version: 3,
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
  /** CFR has an explicit clock. Source gaps hold the last image; irregular input
   * must not shorten the video. Source samples and output frames stay separate. */
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
    for (;;) {
      const finalCount = Math.max(1, Math.ceil((this.endedAt ?? 0) / interval))
      if (this.sourceEnded && this.outputFrames >= finalCount) return
      const at = this.outputFrames * interval
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
      if (!this.sourceEnded && remaining < -2000)
        throw new Error(
          "Recording encoder fell more than two seconds behind; capture was interrupted"
        )
      this.encodingTiming.maxScheduleLagMs = Math.max(
        this.encodingTiming.maxScheduleLagMs,
        -remaining
      )
      let next: typeof current
      while (
        this.videoQueue[0] &&
        (!current ||
          this.videoQueue[0].frame.at <= at ||
          (this.sourceEnded && this.outputFrames === finalCount - 1))
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
          !current.bytes.equals(next.bytes) ||
          current.frame.viewportWidth !== next.frame.viewportWidth ||
          current.frame.viewportHeight !== next.frame.viewportHeight ||
          current.frame.pageScaleFactor !== next.frame.pageScaleFactor ||
          current.frame.offsetTop !== next.frame.offsetTop
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
      const workerStart = performance.now()
      const timing = await encoder.write(
        changed
          ? {
              bytes: current.bytes,
              frame: current.frame,
              at,
              pointer: this.pointers[pointerIndex],
              press,
            }
          : undefined
      )
      const workerWait = performance.now() - workerStart
      this.encodingTiming.frames++
      if (workerWait > interval) this.encodingTiming.waitsOverFrameBudget++
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
      previousState = state
      this.firstWrite?.resolve()
      current.frame.firstOutputFrame ??= this.outputFrames
      this.outputFrames++
      if (
        this.outputFrames % this.options.fps === 0 &&
        (await stat(join(this.directory, "recording.partial.mp4"))).size >
          512 * 1024 * 1024
      )
        void this.stop("Recording reached its encoded-video storage limit")
    }
  }
  private async encode() {
    const first = this.frames[0]
    if (!first)
      throw new Error("No video frames were received; no video was produced")
    const best = this.frames.reduce((a, b) =>
      a.width * a.height >= b.width * b.height ? a : b
    )
    const metadata = await sharp(join(this.directory, best.file!)).metadata()
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
    const child = spawn(
      mediaExecutable("ffmpeg"),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-n",
        ...(this.sourceVideo ? ["-i", this.sourceVideo] : []),
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
        ...(this.sourceVideo
          ? [
              "-filter_complex",
              `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2[base];[base][1:v]overlay=shortest=1,fps=${this.options.fps}`,
            ]
          : []),
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
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
    const frames = Readable.from(this.renderFrames(width, height), {
      objectMode: false,
      highWaterMark: 1,
    })
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

  private async *renderFrames(
    width: number,
    height: number
  ): AsyncGenerator<Buffer> {
    const count = Math.max(
      1,
      Math.ceil(((this.endedAt ?? 0) * this.options.fps) / 1000)
    )
    let frameIndex = 0,
      pointerIndex = -1,
      pressIndex = -1
    let previousState = ""
    let rendered: Buffer | undefined
    for (let index = 0; index < count; index++) {
      // Use the recording clock directly. Repeating a static image through concat
      // can double its last duration; CFR has exactly one duration per output frame.
      const at = (index * 1000) / this.options.fps
      while (
        frameIndex + 1 < this.frames.length &&
        this.frames[frameIndex + 1]!.at <= at
      )
        frameIndex++
      while (
        pointerIndex + 1 < this.pointers.length &&
        this.pointers[pointerIndex + 1]!.at <= at
      ) {
        pointerIndex++
        if (this.pointers[pointerIndex]!.pressed) pressIndex = pointerIndex
      }
      const press = this.pointers[pressIndex]
      const pressed = !!press && at - press.at < 400
      const state = `${frameIndex}:${pointerIndex}:${pressed}`
      if (rendered && state === previousState) {
        yield rendered
        continue
      }
      const frame = this.frames[frameIndex]!
      const pointer = this.pointers[pointerIndex]
      rendered = await renderRecordingImage(
        await readFile(join(this.directory, frame.file!)),
        frame,
        at,
        pointer,
        press,
        width,
        height,
        Boolean(this.sourceVideo)
      )
      previousState = state
      yield rendered
    }
  }
}
