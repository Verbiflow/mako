import { rename, stat } from "node:fs/promises"
import { join } from "node:path"
import { Mp4Writer, readMp4 } from "./mp4.js"
import { onMac } from "./platform.js"
import { VideoHelper, videoHelperExecutable } from "./video-helper.js"

/** The quality recordings ask the helper for: VideoToolbox's 0.85, or OpenH264's quantizer 21. */
const RECORDING_QUALITY = 85

/** The helper that encodes recordings here, or why there is none. */
export function recordingEncoder(): string {
  const executable = videoHelperExecutable()
  if (!executable)
    throw new Error("Recording needs Mako's video helper (mako-video), which isn't installed here. Reinstall a complete Mako build, or set MAKO_VIDEO_HELPER to its path.")
  return executable
}

/** How recordings are encoded here, for their timeline. */
export function recordingVideoEncoding() {
  return { codec: "h264" as const, encoder: onMac() ? "mako-video (VideoToolbox)" : "mako-video (OpenH264)" }
}

/**
 * One recording's encoder: the video helper encodes each rendered picture (VideoToolbox on a Mac, OpenH264 on Linux),
 * a key frame a second, and its units are written as fragmented MP4 as they come. A write is complete once the helper
 * has the picture; the worker submits one at a time and the owner bounds source history.
 */
export class RecordingEncoderProcess {
  private readonly helper: VideoHelper
  private readonly writer: Mp4Writer
  private readonly width: number
  private readonly height: number
  private failure?: string
  private closing = false
  private sequence = 0
  /** The time each picture was given, by its sequence, until its unit comes. */
  private readonly times = new Map<number, number>()
  /** Writes into the file, in order. */
  private writing: Promise<void> = Promise.resolve()
  private finishing?: Promise<{ path: string; durationMs: number; retainedFrames?: number; error?: string }>
  private readonly partial: string
  private readonly output: string

  constructor(directory: string, width: number, height: number, fps: number, failed: (reason: string) => void) {
    this.width = width
    this.height = height
    this.partial = join(directory, "recording.partial.mp4")
    this.output = join(directory, "recording.mp4")
    this.writer = new Mp4Writer(this.partial, 1000 / fps)
    const fail = (reason: string) => {
      if (this.failure) return
      this.failure = reason
      failed(reason)
    }
    this.helper = new VideoHelper(recordingEncoder(), { kind: "frames" }, { fps, keyint: fps, quality: RECORDING_QUALITY }, {
      unit: (packet) => {
        const at = this.times.get(packet.sequence)
        this.times.delete(packet.sequence)
        if (at === undefined) return fail("The video helper returned a picture it was never given")
        this.writing = this.writing.then(() => this.writer.add(packet, at)).catch((error: Error) => fail(`Writing the recording failed: ${error.message}`))
      },
      ended: (reason) => fail(`Video encoder ended unexpectedly: ${reason}`),
    })
  }

  /** An RGB picture presented `atMs` into the video. */
  async write(frame: Buffer, atMs: number) {
    if (this.failure) throw new Error(this.failure)
    if (this.closing) throw new Error("Video encoder is closed")
    const sequence = ++this.sequence
    this.times.set(sequence, atMs)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.abort("Video encoder stopped consuming frames")
        reject(new Error(this.failure))
      }, 5000)
      this.helper.picture("rgb", sequence, atMs, frame, { width: this.width, height: this.height }, (error) => {
        clearTimeout(timeout)
        if (error || this.failure) reject(new Error(this.failure ?? `Video encoder input failed: ${error?.message}`))
        else resolve()
      })
    })
  }

  abort(reason: string) {
    this.failure ??= reason
    this.helper.close()
  }

  finish() {
    return (this.finishing ??= this.finalize())
  }

  private async finalize() {
    this.closing = true
    this.helper.close()
    const timeout = setTimeout(() => this.abort("Video encoder shutdown timed out"), 10_000)
    try {
      await this.helper.exited
      await this.writing
      await this.writer.finish()
    } catch (error) {
      this.failure ??= error instanceof Error ? error.message : String(error)
      await this.writer.cancel()
    } finally {
      clearTimeout(timeout)
    }
    // Never publish a path merely because a file exists: the file is read back, and after a failure its readable
    // prefix is what's kept.
    const video = await readMp4(this.partial)
    const durationMs = (video?.duration ?? 0) * 1000
    if (!video || !Number.isFinite(durationMs) || durationMs <= 0 || !video.packets.length)
      throw new Error(this.failure ?? "Video encoder produced no playable frames")
    if ((await stat(this.partial)).size === 0) throw new Error("Video encoder produced an empty file")
    if (!this.failure) await rename(this.partial, this.output)
    return {
      path: this.failure ? this.partial : this.output,
      durationMs,
      retainedFrames: this.failure ? video.packets.length : undefined,
      error: this.failure,
    }
  }
}
