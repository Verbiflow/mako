import { z } from "zod"
import { mediaExecutable } from "./control-media.js"
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
} from "node:fs/promises"
import { join, isAbsolute } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { performance } from "node:perf_hooks"
import sharp, { type OverlayOptions } from "sharp"
import {
  RecordingOptionsSchema,
  type RecordingOptions,
  type RecordingReceipt,
  type ControlTarget,
} from "@mako/control/control"

const execute = promisify(execFile)
interface Frame {
  file: string
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
  data: string
  width: number
  height: number
  metadata: { pageScaleFactor?: number; offsetTop?: number; capturedAt?: number }
}
const pointerArtwork = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="32" viewBox="0 0 28 32"><path d="M5 4v21l6-6 4 9 4-2-4-9h8L5 4Z" fill="#302c27" stroke="#fffaf3" stroke-width="1.7" stroke-linejoin="round"/></svg>'
)

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
  private bytes = 0
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
  private readonly options: ReturnType<typeof RecordingOptionsSchema.parse> & { fps: number }
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
    const options = { ...parsed, fps: parsed.fps ?? (target.kind === "page" ? 60 : 30) }
    const root = options.directory ?? (process.env.MAKO_CONTROL_ARTIFACTS
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
    data: string,
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
    this.pendingFrame = { data, width, height, metadata: { ...metadata, capturedAt: metadata.capturedAt ?? Date.now() } }
    return this.flushFrame()
  }
  private flushFrame(): Promise<void> {
    if (this.writing) return this.writing
    if (this.state !== "recording" || !this.pendingFrame) return Promise.resolve()
    const remaining = this.nextWriteAt - performance.now()
    if (remaining > 0) {
      if (!this.frameTimer) this.frameTimer = setTimeout(() => {
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
  private storeFrame({ data, width, height, metadata }: IncomingFrame): Promise<void> {
    const interval = 1000 / this.options.fps
    // Keep cadence when a timer fires late; never queue old frames to catch up.
    const now = performance.now()
    this.nextWriteAt = this.nextWriteAt === -Infinity
      ? now + interval
      : Math.max(this.nextWriteAt + interval, now)
    if (
      data.length > 12_000_000 ||
      this.bytes > 512 * 1024 * 1024 ||
      this.frames.length >= 12_000
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
    const bytes = Buffer.from(data, "base64")
    const file = `frame-${this.frames.length}.jpg`
    this.writing = (async () => {
      const imageMetadata = await sharp(bytes, {
        limitInputPixels: 16_000_000,
      }).metadata()
      if (
        !imageMetadata.width ||
        !imageMetadata.height ||
        width <= 0 ||
        height <= 0
      )
        throw new Error("Invalid recording frame geometry")
      await writeFile(join(this.directory, file), bytes, {
        flag: "wx",
        mode: 0o600,
      })
      this.frames.push({ file, at, width: imageMetadata.width, height: imageMetadata.height, viewportWidth: width, viewportHeight: height, ...metadata })
      this.bytes += bytes.length
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
      this.timeline = join(this.directory, "timeline.json")
      await writeFile(
        this.timeline,
        JSON.stringify(
          {
            version: 2,
            name: this.options.name,
            target: this.target,
            pointerTiming: this.sourceVideo
              ? "native-event-post; dispatch does not confirm application acceptance"
              : "host-dispatch; acknowledged input only",
            startedAt: this.startedAt,
            durationMs: this.endedAt,
            frames: this.frames,
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
      await this.encode()
      this.state = this.error ? "interrupted" : "finished"
    })().catch((error) => {
      this.state = "failed"
      this.error =
        error instanceof Error ? error.message : "Recording finalization failed"
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
  private async encode() {
    const first = this.frames[0]
    if (!first)
      throw new Error("No video frames were received; no video was produced")
    const best = this.frames.reduce((a, b) => a.width * a.height >= b.width * b.height ? a : b)
    const metadata = await sharp(join(this.directory, best.file)).metadata()
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
      const failure = controller.signal.aborted ? controller.signal.reason : error
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

  private async *renderFrames(width: number, height: number): AsyncGenerator<Buffer> {
    const count = Math.max(1, Math.ceil((this.endedAt ?? 0) * this.options.fps / 1000))
    let frameIndex = 0,
      pointerIndex = -1,
      pressIndex = -1
    let previousState = ""
    let rendered: Buffer | undefined
    for (let index = 0; index < count; index++) {
      // Use the recording clock directly. Repeating a static image through concat
      // can double its last duration; CFR has exactly one duration per output frame.
      const at = index * 1000 / this.options.fps
      while (frameIndex + 1 < this.frames.length && this.frames[frameIndex + 1]!.at <= at)
        frameIndex++
      while (pointerIndex + 1 < this.pointers.length && this.pointers[pointerIndex + 1]!.at <= at) {
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
      const image = sharp(
        await readFile(join(this.directory, frame.file))
      ).resize(width, height, {
        fit: "contain",
        background: this.sourceVideo
          ? { r: 0, g: 0, b: 0, alpha: 0 }
          : "#171614",
      })
      const overlays: OverlayOptions[] = []
      if (pointer) {
        const viewportWidth = frame.viewportWidth ?? frame.width
        const viewportHeight = frame.viewportHeight ?? frame.height
        const scale = Math.min(width / viewportWidth, height / viewportHeight)
        const x = Math.round(
          pointer.x * (frame.pageScaleFactor ?? 1) * scale +
            (width - viewportWidth * scale) / 2
        )
        const y = Math.round(
          (pointer.y * (frame.pageScaleFactor ?? 1) +
            (frame.offsetTop ?? 0)) *
            scale +
            (height - viewportHeight * scale) / 2
        )
        if (x >= 0 && y >= 0 && x < width && y < height) {
          const addOverlay = async (
            input: Buffer,
            left: number,
            top: number
          ) => {
            const offsetX = Math.max(0, -left)
            const offsetY = Math.max(0, -top)
            const visibleWidth = Math.min(
              28 - offsetX,
              width - Math.max(0, left)
            )
            const visibleHeight = Math.min(
              32 - offsetY,
              height - Math.max(0, top)
            )
            if (visibleWidth <= 0 || visibleHeight <= 0) return
            const clipped = await sharp(input)
              .extract({
                left: offsetX,
                top: offsetY,
                width: visibleWidth,
                height: visibleHeight,
              })
              .png()
              .toBuffer()
            overlays.push({
              input: clipped,
              left: Math.max(0, left),
              top: Math.max(0, top),
            })
          }
          const press = this.pointers[pressIndex]
          if (
            press &&
            at - press.at < 400 &&
            press.x === pointer.x &&
            press.y === pointer.y
          ) {
            const ring = Buffer.from(
              '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="32"><circle cx="8" cy="8" r="6" fill="none" stroke="#efaa59" stroke-width="2"/></svg>'
            )
            await addOverlay(ring, x - 3, y - 4)
          }
          await addOverlay(pointerArtwork, x - 5, y - 4)
        }
      }
      rendered = await image.ensureAlpha().composite(overlays).raw().toBuffer()
      previousState = state
      yield rendered
    }
  }
}
