import { spawn } from "node:child_process"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { rename, stat } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { mediaExecutable, recordingVideoEncoding } from "./control-media.js"

const execute = promisify(execFile)

/** One encoder process per recording. A write is complete only after pipe admission;
 * the worker submits one raw frame at a time and the owner bounds source history. */
export class RecordingEncoderProcess {
  private readonly child
  private readonly closed: Promise<void>
  private failure?: string
  private closing = false
  private finishing?: Promise<{
    path: string
    durationMs: number
    retainedFrames?: number
    error?: string
  }>
  private readonly partial: string
  private readonly output: string

  constructor(
    directory: string,
    width: number,
    height: number,
    fps: number,
    failed: (reason: string) => void
  ) {
    this.partial = join(directory, "recording.partial.mp4")
    this.output = join(directory, "recording.mp4")
    this.child = spawn(
      mediaExecutable("ffmpeg"),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-n",
        // One conversion pipeline per recording; bound its pool independently
        // of the codec's internal encoding work.
        "-filter_threads",
        "1",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgba",
        "-video_size",
        `${width}x${height}`,
        "-framerate",
        String(fps),
        "-i",
        "pipe:0",
        "-an",
        ...recordingVideoEncoding().args,
        "-pix_fmt",
        "yuv420p",
        "-g",
        String(fps),
        "-movflags",
        "+frag_keyframe+empty_moov+default_base_moof",
        "-flush_packets",
        "1",
        this.partial,
      ],
      { stdio: ["pipe", "ignore", "pipe"] }
    )
    let tail = ""
    const fail = (reason: string) => {
      if (this.failure) return
      this.failure = reason
      failed(reason)
    }
    this.child.stderr.on("data", (data: Buffer) => {
      tail = (tail + data.toString()).slice(-4096)
    })
    this.child.stdin.on("error", (error) =>
      fail(`Video encoder input failed: ${error.message}`)
    )
    this.child.on("error", (error) =>
      fail(`Video encoder failed: ${error.message}`)
    )
    this.closed = new Promise((resolve) => {
      this.child.once("close", (code) => {
        if (code !== 0 || !this.closing)
          fail(`Video encoder ended unexpectedly: ${tail || `exit ${code}`}`)
        resolve()
      })
    })
  }

  async write(frame: Buffer) {
    if (this.failure) throw new Error(this.failure)
    if (this.closing) throw new Error("Video encoder is closed")
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.abort("Video encoder stopped consuming frames")
        reject(new Error(this.failure))
      }, 5000)
      this.child.stdin.write(frame, (error) => {
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve()
      })
    })
  }

  abort(reason: string) {
    this.failure ??= reason
    this.child.kill("SIGKILL")
  }

  finish() {
    return (this.finishing ??= this.finalize())
  }

  private async finalize() {
    this.closing = true
    this.child.stdin.end()
    const timeout = setTimeout(
      () => this.abort("Video encoder shutdown timed out"),
      10_000
    )
    try {
      await this.closed
    } finally {
      clearTimeout(timeout)
    }
    // Never publish a path merely because a file exists. After a crash, decode
    // the retained prefix; successful capture is checked by its container metadata.
    const probe = z
      .object({
        streams: z.array(z.object({ nb_read_frames: z.string().optional() })),
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
                ...(this.failure ? ["-count_frames"] : []),
                "-show_entries",
                "stream=nb_read_frames:format=duration",
                "-of",
                "json",
                this.partial,
              ],
              { timeout: 20_000, maxBuffer: 65536 }
            )
          ).stdout
        )
      )
    const durationMs = Number(probe.format.duration) * 1000
    if (
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      (this.failure && !(Number(probe.streams[0]?.nb_read_frames) > 0))
    )
      throw new Error(
        this.failure ?? "Video encoder produced no playable frames"
      )
    if ((await stat(this.partial)).size === 0)
      throw new Error("Video encoder produced an empty file")
    if (!this.failure) await rename(this.partial, this.output)
    return {
      path: this.failure ? this.partial : this.output,
      durationMs,
      retainedFrames: this.failure
        ? Number(probe.streams[0]!.nb_read_frames)
        : undefined,
      error: this.failure,
    }
  }
}
