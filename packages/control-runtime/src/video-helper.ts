import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { CaptureSize } from "./browser-capture.js"
import type { VideoSource, LiveEncoderFactory } from "./browser-video.js"
import { CONTROL_VIDEO_DATA_LIMIT, decodeControlVideo, type ControlVideoPacket } from "./contracts/control-video.js"
import { resolveExecutable } from "./executable.js"
import { onMac, onWindows, type LinuxDesktop } from "./platform.js"
import { spawn } from "./processes.js"

/**
 * Mako's video helper: a small native program that captures and encodes H.264 without FFmpeg
 * (`native/video-linux/mako-video.c` on Linux: XDamage, XShm and XComposite, OpenH264, libyuv, libjpeg-turbo, and on
 * Wayland the ScreenCast portal and PipeWire; `native/video-macos/main.swift`: ScreenCaptureKit and VideoToolbox;
 * `native/video-windows/mako-video.cpp`: Windows Graphics Capture and Media Foundation). It captures a display or one
 * window only when its pixels change, or encodes the pictures it's sent. Its units come out as `ControlVideoPacket`s,
 * so nothing here parses H.264.
 */
export type VideoHelperSource =
  | { kind: "display" }
  | { kind: "window"; windowId: number }
  /**
   * What the person shares through the ScreenCast portal (Wayland): a window, or a monitor where the portal shares no
   * windows. The portal asks once; `restore` is the file its restore token is kept in, so it doesn't ask again.
   * `still`: the compositor sends a frame only when something changes (wlroots'), so a still screen's first frame
   * comes from the Screenshot portal.
   */
  | { kind: "portal"; types: "monitor" | "window"; restore: string; still?: boolean }
  | { kind: "frames" }
  /** A video's frames under the transparent pictures sent for their times (a recording's pointer); Mac only. */
  | { kind: "overlay"; video: string }
  /** The same on Linux: the video's units are sent (`video`), decoded with OpenH264, and drawn under the pictures. */
  | { kind: "composite" }

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

/** The helper's file name here: an `.exe` on Windows. */
export function videoHelperName(): string {
  return onWindows() ? "mako-video.exe" : "mako-video"
}

/**
 * Where the helper is: `MAKO_VIDEO_HELPER` (the host sets it to a packaged app's), else the helper on PATH (a Linux
 * machine's), else a checkout's build (`scripts/build-video-helper.mjs`, beside this package's `src` and `dist`). None
 * where it isn't installed.
 */
export function videoHelperExecutable(): string | undefined {
  const configured = process.env.MAKO_VIDEO_HELPER
  if (configured) return isAbsolute(configured) && existsSync(configured) ? configured : undefined
  const checkout = fileURLToPath(new URL(`../../../build/${videoHelperName()}`, import.meta.url))
  return resolveExecutable(videoHelperName()) ?? (existsSync(checkout) ? checkout : undefined)
}

/**
 * How the helper shows a window the driver named, where it can: by its id on a Mac, on Windows and wherever X draws it. On
 * Wayland no outside process may read a window by id, so it shows the monitor the person shares through the portal
 * (asked once, then restored from the token kept in `folder`), with the window where it is on that monitor.
 */
export function helperWindowSource(
  windowId: number,
  desktop: LinuxDesktop | undefined
): Extract<VideoHelperSource, { kind: "window" | "portal" }> | undefined {
  if (onMac() || onWindows() || desktop?.session === "x11") return { kind: "window", windowId }
  if (desktop?.session === "wayland") return portalMonitor(desktop)
  return undefined
}

/**
 * The monitor the person shares through the portal on a Wayland desktop: live video and recordings alike, so the
 * person is asked once per user, whichever Mako process asks.
 */
export function portalMonitor(desktop: LinuxDesktop, env: NodeJS.ProcessEnv = process.env): Extract<VideoHelperSource, { kind: "portal" }> {
  const state = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state")
  return { kind: "portal", types: "monitor", restore: join(state, "mako", "portal-monitor.token"), still: desktop.compositor === "wlroots" }
}

const PICTURE = { jpeg: 0, rgb: 1, rgba: 2 } as const

/** One helper process: one capture or one stream of pictures, encoded at one rate. */
export class VideoHelper {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #events: VideoHelperEvents
  #buffer: Buffer = Buffer.alloc(0)
  #tail = ""
  /** Asked to stop: no more commands, and its exit is no failure. Units it still writes are heard. */
  #closing = false
  #ended = false
  /** Pictures written and not yet taken by the helper's input. */
  #writing = 0
  /** Settles once the helper exited and every unit it wrote was heard. */
  readonly exited: Promise<void>
  #exit!: () => void

  constructor(executable: string, source: VideoHelperSource, options: VideoHelperOptions, events: VideoHelperEvents) {
    this.#events = events
    this.exited = new Promise((resolve) => (this.#exit = resolve))
    // The helper writes the portal's restore token there, as the person's alone.
    if (source.kind === "portal") mkdirSync(dirname(source.restore), { recursive: true, mode: 0o700 })
    const args = [
      ...(source.kind === "window"
        ? ["window", String(source.windowId)]
        : source.kind === "overlay"
          ? ["overlay", source.video]
          : source.kind === "portal"
            ? ["portal", "--types", source.types, "--restore", source.restore, ...(source.still ? ["--still", "screenshot"] : [])]
            : [source.kind]),
      "--fps", String(options.fps),
      ...(options.bitrate ? ["--bitrate", String(Math.round(options.bitrate))] : []),
      ...(options.box ? ["--box", `${options.box.width}x${options.box.height}`] : []),
      ...(options.keyint ? ["--keyint", String(options.keyint)] : []),
      ...(options.quality ? ["--quality", String(options.quality)] : []),
      ...(options.content ? ["--content", options.content] : []),
    ]
    // A helper written in JavaScript (a test's stand-in) runs under this Node: Windows runs no script by its shebang.
    const [file, prefix] = /\.[cm]?js$/.test(executable) ? [process.execPath, [executable]] : [executable, []]
    // A console program under a windowless app opens a console window on Windows unless told not to.
    this.#child = spawn(file, [...prefix, ...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
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
      this.#exit()
    })
  }

  /** Whether a picture may be sent now: the last one is in the helper. */
  get ready(): boolean {
    return !this.#ended && !this.#closing && this.#writing === 0
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

  /**
   * A picture to encode (a `frames` or `overlay` helper): a JPEG, or raw RGB or RGBA of `size`. `taken` once the
   * helper's input has it, or with why it couldn't.
   */
  picture(format: keyof typeof PICTURE, sequence: number, capturedAt: number, bytes: Uint8Array, size?: CaptureSize, taken?: (error?: Error) => void): void {
    const header = Buffer.alloc(13 + (format === "jpeg" ? 0 : 4))
    header.writeUInt8(PICTURE[format], 0)
    header.writeUInt32BE(sequence >>> 0, 1)
    header.writeDoubleBE(capturedAt, 5)
    if (format !== "jpeg") {
      header.writeUInt16BE(size?.width ?? 0, 13)
      header.writeUInt16BE(size?.height ?? 0, 15)
    }
    this.#writing++
    const sent = this.#command("F", Buffer.concat([header, bytes]), (error) => {
      this.#writing--
      taken?.(error ?? undefined)
    })
    if (!sent) {
      this.#writing--
      taken?.(new Error(this.#ended ? "The video helper has ended" : "The video helper is closing"))
    }
  }

  /**
   * One unit of the video underneath a `composite` helper: its length-prefixed NAL units, with the avcC on a key unit.
   * `taken` once the helper's input has it.
   */
  video(data: Uint8Array, description: Uint8Array | undefined, taken: (error?: Error) => void): void {
    const header = Buffer.alloc(2)
    header.writeUInt16BE(description?.byteLength ?? 0, 0)
    const sent = this.#command("V", Buffer.concat([header, description ?? Buffer.alloc(0), data]), (error) => taken(error ?? undefined))
    if (!sent) taken(new Error(this.#ended ? "The video helper has ended" : "The video helper is closing"))
  }

  /** Its input ends: it encodes what it has, writes its last units and exits. */
  close(): void {
    if (this.#ended || this.#closing) return
    this.#closing = true
    this.#child.stdin.end()
    // Its input's end stops it; one that doesn't is made to.
    setTimeout(() => this.#child.kill("SIGKILL"), 2_000).unref()
  }

  /** False when the command wasn't sent: the helper has ended or is closing. */
  #command(type: "K" | "B" | "R" | "F" | "V", body: Uint8Array, written?: (error?: Error | null) => void): boolean {
    if (this.#ended || this.#closing || !this.#child.stdin.writable) return false
    const header = Buffer.alloc(5)
    header.write(type, 0, "latin1")
    header.writeUInt32BE(body.byteLength, 1)
    this.#child.stdin.cork()
    this.#child.stdin.write(header)
    this.#child.stdin.write(body, written)
    this.#child.stdin.uncork()
    return true
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
    const quiet = this.#ended || this.#closing
    this.#ended = true
    if (!quiet) this.#events.ended(reason)
  }
}

/** A display or one window, captured and encoded by the helper, as a live video's source. */
export function helperCapture(executable: string, source: Extract<VideoHelperSource, { kind: "display" | "window" | "portal" }>): VideoSource {
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
      rate: (bitrate) => helper.rate(bitrate),
      resized: async () => helper.box(consumer.size()),
      stop: async () => helper.close(),
    }
  }
}

/**
 * The screencast's JPEGs encoded by the helper's `frames` mode (VideoToolbox on a Mac, OpenH264 on Linux, Media
 * Foundation on Windows): one
 * process per encoder, a unit back for each picture with its sequence and capture time.
 */
export function helperLiveEncoder(executable: string): LiveEncoderFactory {
  return (size, fps, unit, drained, failed) => {
    const helper = new VideoHelper(executable, { kind: "frames" }, { fps, box: size }, {
      unit: (packet) => {
        unit(packet)
        drained()
      },
      ended: failed,
    })
    return {
      ready: () => helper.ready,
      submit(frame) {
        helper.picture("jpeg", frame.sequence, frame.capturedAt, frame.bytes, undefined, (error) => {
          if (error) return failed(error.message)
          drained()
        })
      },
      key: () => helper.key(),
      rate: (bitrate) => helper.rate(bitrate),
      close: () => helper.close(),
    }
  }
}
