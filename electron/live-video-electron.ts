import { desktopCapturer, ipcMain, WebContentsView, type WebContents } from "electron"
import { join } from "node:path"
import type { DesktopFrame } from "@mako/host/contracts/desktop-channel"
import {
  LIVE_VIDEO_CHANNEL,
  LiveVideoPageEventSchema,
  type LiveVideoPageAsk,
  type LiveVideoPageEvent,
  type LiveVideoPageSource,
  type LiveVideoSource,
} from "@mako/host/contracts/live-video"
import { hostLog, hostWarn } from "@mako/host/base/host-log"
import type { DesktopHandlers } from "./desktop-link.js"
import { electronWindowCapturer } from "./window-capture-electron.js"

export interface LiveVideoAnswersInput {
  /** Where the page (`live-video.html`, `live-video-page.js`) and its preload were built. */
  directory: string
  /** A frame for the host: a session's unit, a dropped picture or its end. */
  frame(frame: DesktopFrame): void
  /** The web contents of a desk window this desktop made, by the id the host knows it by. */
  page(id: string): WebContents | undefined
}

export interface LiveVideoAnswers {
  handlers: DesktopHandlers
  /** End every session: the host they were for went away. */
  forget(): void
  close(): void
}

/** With no session for this long, the page closes and its renderer with it. */
const IDLE_MS = 60_000

interface Opening {
  resolve(encoder: string): void
  reject(error: Error): void
}

/**
 * The desktop's end of live video (`contracts/live-video.ts`): a page with no window, made on the first session,
 * whose WebCodecs encodes what the host asks for, hardware first. Its units go to the host as they come. A desk
 * window is captured as a tab (Chromium sends a frame only when it paints); another app's window or a display
 * through the system's capturer, gated on change.
 */
export function liveVideoAnswers({ directory, frame, page }: LiveVideoAnswersInput): LiveVideoAnswers {
  let view: WebContentsView | undefined
  let loading: Promise<WebContents> | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  const opening = new Map<string, Opening>()
  const sessions = new Set<string>()
  /** `frames` pictures sent to the page and not yet in its encoder, by session and sequence. */
  const accepting = new Map<string, Map<number, { resolve(): void; reject(error: Error): void }>>()

  const contents = (): Promise<WebContents> => {
    clearTimeout(idle)
    if (loading) return loading
    const made = new WebContentsView({
      webPreferences: {
        preload: join(directory, "live-video-preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // It has no window and must keep its timers: pacing and the change gate's refresh run on them.
        backgroundThrottling: false,
        partition: "mako-live-video",
      },
    })
    view = made
    made.webContents.on("render-process-gone", (_event, details) => {
      if (view !== made) return
      hostWarn("desktop", "the live video page stopped", { reason: details.reason })
      shut(`The live video page stopped (${details.reason})`)
    })
    loading = made.webContents.loadFile(join(directory, "live-video.html")).then(() => made.webContents)
    loading.catch(() => {
      if (view === made) shut("The live video page didn't load")
    })
    return loading
  }

  const send = async (ask: LiveVideoPageAsk) => (await contents()).send(LIVE_VIDEO_CHANNEL, ask)

  const ended = (session: string, reason: string) => {
    const open = opening.get(session)
    opening.delete(session)
    open?.reject(new Error(reason))
    for (const pending of accepting.get(session)?.values() ?? []) pending.reject(new Error(reason))
    accepting.delete(session)
    if (sessions.delete(session)) frame({ kind: "live-video", session, ended: reason })
    watchIdle()
  }

  const heard = (event: LiveVideoPageEvent) => {
    switch (event.type) {
      case "opened": {
        const open = opening.get(event.session)
        opening.delete(event.session)
        if (!open) return void send({ type: "close", session: event.session }).catch(() => {})
        sessions.add(event.session)
        return open.resolve(event.encoder)
      }
      case "unit":
        if (sessions.has(event.session)) frame({ kind: "live-video", session: event.session, packet: Buffer.from(event.packet).toString("base64") })
        return
      case "accepted": {
        const waiting = accepting.get(event.session)
        waiting?.get(event.sequence)?.resolve()
        waiting?.delete(event.sequence)
        return
      }
      case "dropped":
        if (sessions.has(event.session)) frame({ kind: "live-video", session: event.session, dropped: event.sequence })
        return
      case "ended":
        return ended(event.session, event.reason)
    }
  }

  const listener = (event: Electron.IpcMainEvent, ...message: unknown[]) => {
    if (!view || event.sender !== view.webContents) return
    const parsed = LiveVideoPageEventSchema.safeParse(message[0])
    if (parsed.success) heard(parsed.data)
  }
  ipcMain.on(LIVE_VIDEO_CHANNEL, listener)

  function watchIdle() {
    clearTimeout(idle)
    if (sessions.size || opening.size || !view) return
    idle = setTimeout(() => shut(), IDLE_MS)
    idle.unref()
  }

  /** Closes the page; its sessions end with `reason`. */
  function shut(reason = "The live video page closed") {
    clearTimeout(idle)
    const closing = view
    view = undefined
    loading = undefined
    for (const session of [...opening.keys(), ...sessions]) ended(session, reason)
    if (closing && !closing.webContents.isDestroyed()) closing.webContents.close()
  }

  /** The page's name for a source: a capture id the main process alone can make. */
  const pageSource = async (source: LiveVideoSource, target: WebContents): Promise<LiveVideoPageSource> => {
    switch (source.kind) {
      case "frames":
        return { kind: "frames" }
      case "page": {
        const contents = page(source.page)
        if (!contents || contents.isDestroyed()) throw new Error("That desk window closed.")
        return { kind: "capture", media: "tab", id: contents.getMediaSourceId(target), gate: false }
      }
      case "window": {
        const id = await electronWindowCapturer.source(source.windowId)
        if (!id) throw new Error("That window isn't on screen to capture.")
        return { kind: "capture", media: "desktop", id, gate: true }
      }
      case "display": {
        const screens = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
        const found = screens.find((screen) => screen.display_id === source.displayId)
        if (!found) throw new Error("That display isn't connected.")
        return { kind: "capture", media: "desktop", id: found.id, gate: true }
      }
    }
  }

  const handlers: DesktopHandlers = {
    "live-video-open": async ({ session, source, fps, box }) => {
      try {
        const target = await contents()
        const named = await pageSource(source, target)
        const encoder = await new Promise<string>((resolve, reject) => {
          opening.set(session, { resolve, reject })
          void send({ type: "open", session, source: named, fps, box }).catch(reject)
        })
        hostLog("desktop", "live video opened", { source: source.kind, encoder })
        return { encoder }
      } finally {
        // A session that didn't open leaves the page with nothing to do.
        opening.delete(session)
        watchIdle()
      }
    },
    "live-video-frame": async ({ session, data, sequence, capturedAt }) => {
      if (!sessions.has(session)) throw new Error("That live video ended.")
      const bytes = Buffer.from(data, "base64")
      let waiting = accepting.get(session)
      if (!waiting) accepting.set(session, (waiting = new Map()))
      const accepted = new Promise<void>((resolve, reject) => waiting.set(sequence, { resolve, reject }))
      await send({ type: "frame", session, data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), sequence, capturedAt })
      await accepted
      return null
    },
    "live-video-key": async ({ session }) => {
      if (sessions.has(session)) await send({ type: "key", session })
      return null
    },
    "live-video-rate": async ({ session, bitrate }) => {
      if (sessions.has(session)) await send({ type: "rate", session, bitrate })
      return null
    },
    "live-video-resize": async ({ session, box }) => {
      if (sessions.has(session)) await send({ type: "resize", session, box })
      return null
    },
    "live-video-close": async ({ session }) => {
      const known = sessions.delete(session) || opening.has(session)
      opening.get(session)?.reject(new Error("The live video closed while it opened."))
      opening.delete(session)
      accepting.delete(session)
      if (known && view) await send({ type: "close", session })
      watchIdle()
      return null
    },
  }

  return {
    handlers,
    forget() {
      for (const session of [...sessions, ...opening.keys()]) void handlers["live-video-close"]?.({ session })
    },
    close() {
      ipcMain.removeListener(LIVE_VIDEO_CHANNEL, listener)
      shut()
    },
  }
}
