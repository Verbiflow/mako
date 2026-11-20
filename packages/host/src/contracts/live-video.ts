import { z } from "zod"
import { ControlVideoBoxSchema } from "./control-video.js"

/**
 * Live video the desktop app encodes for the host with WebCodecs, in a hidden page of its own
 * (`electron/live-video-electron.ts`, `src/live-video/page.ts`): Chromium's H.264 encoder (VideoToolbox, Media
 * Foundation or VA-API, else its OpenH264) in place of FFmpeg. A session is one encode. Its source is one of:
 *
 *   - `frames`: the host sends each picture, a screencast's JPEG, and gets a unit back for it or hears it was dropped.
 *   - `page`: a desk window the desktop made (`desk-page-create`), captured as a tab: frames come only when it paints.
 *   - `window` / `display`: any app's window, or a whole display, as the system's capturer gives it (ScreenCaptureKit,
 *     Windows Graphics Capture, PipeWire or X11). Those repeat an unchanged picture, so the page encodes a frame only
 *     when the picture changed, and once a second while it doesn't.
 *
 * Every unit reaches the host as one encoded `ControlVideoPacket`, and every key unit carries its `avcC`.
 */
export const LiveVideoSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("frames") }).strict(),
  z.object({ kind: z.literal("page"), page: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("window"), windowId: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("display"), displayId: z.string().min(1).max(100) }).strict(),
])
export type LiveVideoSource = z.infer<typeof LiveVideoSourceSchema>

export const LiveVideoSessionSchema = z.string().min(1).max(100)

export const LiveVideoOpenSchema = z.object({
  session: LiveVideoSessionSchema,
  source: LiveVideoSourceSchema,
  fps: z.number().int().min(1).max(120),
  /** The largest picture its viewers draw; none for the source's own size. */
  box: ControlVideoBoxSchema.nullable(),
}).strict()
export type LiveVideoOpen = z.infer<typeof LiveVideoOpenSchema>

/** One picture of a `frames` session: a JPEG, base64, and its place in the capture. */
export const LiveVideoFrameSchema = z.object({
  session: LiveVideoSessionSchema,
  data: z.string().max(16 * 1024 * 1024),
  sequence: z.number().int().min(0).max(0xffffffff),
  capturedAt: z.number(),
}).strict()

/** What the session encodes with: hardware or software, and the codec Chromium took. */
export const LiveVideoOpenedSchema = z.object({ encoder: z.string().max(200) }).strict()

/** Desktop to host, unasked: a session's unit (an encoded `ControlVideoPacket`, base64), a frame it dropped, or its end. */
export const LiveVideoFrameEventSchema = z.union([
  z.object({ kind: z.literal("live-video"), session: LiveVideoSessionSchema, packet: z.string().max(8 * 1024 * 1024) }).strict(),
  z.object({ kind: z.literal("live-video"), session: LiveVideoSessionSchema, dropped: z.number().int().min(0).max(0xffffffff) }).strict(),
  z.object({ kind: z.literal("live-video"), session: LiveVideoSessionSchema, ended: z.string().max(4000) }).strict(),
])

/**
 * The desktop's main process and its live video page, over Electron's IPC. Bytes cross as they are (structured
 * clone), never base64.
 */
export type LiveVideoPageAsk =
  | { type: "open"; session: string; source: LiveVideoPageSource; fps: number; box: { width: number; height: number } | null }
  | { type: "frame"; session: string; data: Uint8Array<ArrayBuffer>; sequence: number; capturedAt: number }
  | { type: "key"; session: string }
  | { type: "resize"; session: string; box: { width: number; height: number } | null }
  | { type: "close"; session: string }

/** A source as the page opens it: the frames the host sends, or a capture the main process has named. */
export type LiveVideoPageSource =
  | { kind: "frames" }
  | { kind: "capture"; media: "tab" | "desktop"; id: string; gate: boolean }

export const LiveVideoPageEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("opened"), session: LiveVideoSessionSchema, encoder: z.string().max(200) }).strict(),
  z.object({ type: z.literal("unit"), session: LiveVideoSessionSchema, packet: z.instanceof(Uint8Array) }).strict(),
  /** A `frames` picture is in the encoder, or held for it: the host may send the next. */
  z.object({ type: z.literal("accepted"), session: LiveVideoSessionSchema, sequence: z.number().int() }).strict(),
  z.object({ type: z.literal("dropped"), session: LiveVideoSessionSchema, sequence: z.number().int() }).strict(),
  z.object({ type: z.literal("ended"), session: LiveVideoSessionSchema, reason: z.string().max(4000) }).strict(),
])
export type LiveVideoPageEvent = z.infer<typeof LiveVideoPageEventSchema>

/** The IPC channel both directions use. */
export const LIVE_VIDEO_CHANNEL = "mako:live-video"
