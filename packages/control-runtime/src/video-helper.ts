import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { isAbsolute } from "node:path"
import type { CaptureSize } from "./browser-capture.js"
import type { EncodedVideoSource } from "./browser-video.js"
import { CONTROL_VIDEO_DATA_LIMIT, decodeControlVideo, type ControlVideoPacket } from "./contracts/control-video.js"
import { resolveExecutable } from "./executable.js"
import { spawn } from "./processes.js"

/**
 * Mako's video helper: a small native program that captures and encodes H.264 without FFmpeg
 * (`native/video-linux/mako-video.c` on Linux: XDamage, XShm and XComposite, OpenH264, libyuv, libjpeg-turbo). It
 * captures a display or one window only when its pixels change, or encodes the pictures it's sent. Its units come
 * out as `ControlVideoPacket`s, so nothing here parses H.264.
 */
export type VideoHelperSource = { kind: "display" } | { kind: "window"; windowId: number } | { kind: "frames" }

export interface VideoHelperOptions {
  fps: number
  /** Bits a second; the helper's default follows the size (`liveVideoBitrate`). */
  bitrate?: number
  box?: CaptureSize
  /** Frames between key frames; none asks for one only when told. */
  keyint?: number
  /** A constant quantizer instead of a bitrate, for a recording. */
  quality?: number
  /** OpenH264's screen-content tools: about a third of the bits, two to three times the CPU and one thread. */
  content?: "screen" | "camera"
}

export interface VideoHelperEvents {
  unit(packet: ControlVideoPacket): void
  ended(reason: string): void
}

/** Where the helper is: `MAKO_VIDEO_HELPER`, else `mako-video` on PATH. None where it isn't installed. */
export function videoHelperExecutable(): string | undefined {
  const configured = process.env.MAKO_VIDEO_HELPER
  if (configured) return isAbsolute(configured) && existsSync(configured) ? configured : undefined
  return resolveExecutable("mako-video")
}

/** Whether this machine has an X display the helper can capture (a Wayland session is captured another way). */
export function x11Display(): boolean {
  return process.platform === "linux" && Boolean(process.env.DISPLAY?.trim())
}

const PICTURE = { jpeg: 0, rgb: 1, rgba: 2 } as const

/** One helper process: one capture or one stream of pictures, encoded at one rate. */
export class VideoHelper {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #events: VideoHelperEvents
  #buffer: Buffer = Buffer.alloc(0)
  #tail = ""
  #ended = false
  /** Pictures written and not yet taken by the helper's input. */
  #writing = 0

  constructor(executable: string, source: VideoHelperSource, options: VideoHelperOptions, events: VideoHelperEvents) {
    this.#events = events
    const args = [
      ...(source.kind === "window" ? ["window", String(source.windowId)] : [source.kind]),
      "--fps", String(options.fps),
      ...(options.bitrate ? ["--bitrate", String(Math.round(options.bitrate))] : []),
      ...(options.box ? ["--box", `${options.box.width}x${options.box.height}`] : []),
      ...(options.keyint ? ["--keyint", String(options.keyint)] : []),
      ...(options.quality ? ["--quality", String(options.quality)] : []),
      ...(options.content ? ["--content", options.content] : []),
    ]
    this.#child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] })
    this.#child.stdout.on("data", (chunk: Buffer) => this.#read(chunk))
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#tail = (this.#tail + chunk.toString()).slice(-4096)
    })
    this.#child.stdin.on("error", () => {})
    this.#child.on("error", (error) => this.#end(`The video helper couldn't start: ${error.message}`))
    this.#child.once("close", (code, signal) => {
      const ended = /^ended: (.+)$/m.exec(this.#tail)?.[1]
      const last = this.#tail.trim().split("\n").filter((line) => !line.startsWith("{") && !line.startsWith("ended: ")).at(-1)
      this.#end(ended ?? (last ? `The video helper stopped: ${last}` : `The video helper exited (${code ?? signal})`))
    })
  }

  /** Whether a picture may be sent now: the last one is in the helper. */
  get ready(): boolean {
    return !this.#ended && this.#writing === 0
  }

  /** The next unit is a key frame; a still capture sends its picture again as one. */
  key(): void {
    this.#command("K", Buffer.alloc(0))
  }

  /** The viewers' box: the picture is scaled to fit it; none for the source's own size. */
  box(size: CaptureSize | undefined): void {
    const body = Buffer.alloc(4)
    body.writeUInt16BE(Math.min(size?.width ?? 0, 0xffff), 0)
    body.writeUInt16BE(Math.min(size?.height ?? 0, 0xffff), 2)
    this.#command("B", body)
  }

  rate(bitrate: number): void {
    const body = Buffer.alloc(4)
    body.writeUInt32BE(Math.max(1, Math.round(bitrate)), 0)
    this.#command("R", body)
  }

  /** A picture to encode (a `frames` helper): a JPEG, or raw RGB or RGBA of `size`. `taken` once the helper has it. */
  picture(format: keyof typeof PICTURE, sequence: number, capturedAt: number, bytes: Uint8Array, size?: CaptureSize, taken?: () => void): void {
    const header = Buffer.alloc(13 + (format === "jpeg" ? 0 : 4))
    header.writeUInt8(PICTURE[format], 0)
    header.writeUInt32BE(sequence >>> 0, 1)
    header.writeDoubleBE(capturedAt, 5)
    if (format !== "jpeg") {
      header.writeUInt16BE(size?.width ?? 0, 13)
      header.writeUInt16BE(size?.height ?? 0, 15)
    }
    this.#writing++
    this.#command("F", Buffer.concat([header, bytes]), () => {
      this.#writing--
      taken?.()
    })
  }

  close(): void {
    if (this.#ended) return
    this.#ended = true
    this.#child.stdin.end()
    // Its input's end stops it; one that doesn't is made to.
    setTimeout(() => this.#child.kill("SIGKILL"), 2_000).unref()
  }

  #command(type: "K" | "B" | "R" | "F", body: Uint8Array, written?: () => void): void {
    if (this.#ended || !this.#child.stdin.writable) return
    const header = Buffer.alloc(5)
    header.write(type, 0, "latin1")
    header.writeUInt32BE(body.byteLength, 1)
    this.#child.stdin.cork()
    this.#child.stdin.write(header)
    this.#child.stdin.write(body, written && (() => written()))
    this.#child.stdin.uncork()
  }

  #read(chunk: Buffer): void {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0)
      if (length > CONTROL_VIDEO_DATA_LIMIT + 8192) return this.#fail("The video helper wrote an oversized unit")
      if (this.#buffer.length < 4 + length) return
      const bytes = Uint8Array.prototype.slice.call(this.#buffer, 4, 4 + length)
      this.#buffer = this.#buffer.subarray(4 + length)
      let packet: ControlVideoPacket
      try {
        packet = decodeControlVideo(bytes)
      } catch (error) {
        return this.#fail(error instanceof Error ? error.message : String(error))
      }
      if (!this.#ended) this.#events.unit(packet)
    }
  }

  #fail(reason: string): void {
    this.#child.kill("SIGKILL")
    this.#end(reason)
  }

  #end(reason: string): void {
    const quiet = this.#ended
    this.#ended = true
    if (!quiet) this.#events.ended(reason)
  }
}

/** A display or one window, captured and encoded by the helper, as a live video's source. */
export function helperCapture(executable: string, source: Exclude<VideoHelperSource, { kind: "frames" }>): EncodedVideoSource {
  return async (consumer) => {
    // Open once its first unit comes (a capture starts with the picture as it is), or a moment passes with none (a
    // window that isn't on screen sends nothing until it is); a helper that can't capture ends before either.
    let opened!: (error?: Error) => void
    const opening = new Promise<void>((resolve, reject) => (opened = (error) => (error ? reject(error) : resolve())))
    const timer = setTimeout(() => opened(), 1_000)
    const helper = new VideoHelper(executable, source, { fps: consumer.fps, box: consumer.size() }, {
      unit: (packet) => {
        opened()
        consumer.unit(packet)
      },
      ended: (reason) => {
        opened(new Error(reason))
        consumer.ended(reason)
      },
    })
    try {
      await opening
    } finally {
      clearTimeout(timer)
    }
    return {
      key: () => helper.key(),
      resized: async () => helper.box(consumer.size()),
      stop: async () => helper.close(),
    }
  }
}
