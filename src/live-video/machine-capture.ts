/**
 * Live video of a tab in a cloud machine's own Chromium, encoded inside that Chromium: the offscreen document of the
 * capture extension the host loads into it (`packages/host/src/control/machine-video.ts`). The host drives it over
 * DevTools: `makoCapture.open` captures a tab with `chrome.tabCapture` (the extension's service worker names the
 * stream; Chromium accepts it without a gesture because the browser was started with the extension allowlisted), and
 * each event comes back through the `makoVideo` binding the host added, as JSON with the packet in base64.
 *
 * Capturing from here rather than from the page itself keeps the encoder off the page's main thread (a page busy for
 * 40 ms a frame held an in-page encoder to 13 fps where this one kept up with every frame it painted), keeps the
 * capture across navigations (it follows the tab, not the document), works for pages that aren't secure contexts,
 * and shows the page no "sharing this tab" bar that would shrink its viewport.
 */
import type { LiveVideoPageEvent } from "@mako/host/contracts/live-video"
import { liveVideoEncoderAvailable } from "@/lib/live-video-encoder"
import { CaptureSession, captureTrack, type Box } from "./capture-session"

/** What the host calls, through `Runtime.evaluate` in this document. */
export interface MachineCapture {
  open(session: string, tab: string, fps: number, box: Box): Promise<string>
  key(session: string): void
  rate(session: string, bitrate: number): void
  resize(session: string, box: Box): Promise<void>
  close(session: string): void
}

/** The extension's runtime, as much of it as this document uses (offscreen documents get `chrome.runtime` alone). */
declare const chrome: { runtime: { sendMessage(message: { tab: string }): Promise<{ id?: string; error?: string } | undefined> } }

declare global {
  interface Window {
    makoCapture?: MachineCapture
    /** The binding the host adds with `Runtime.addBinding`; absent until it attaches. */
    makoVideo?: (payload: string) => void
  }
}

/** Chromium has had `Uint8Array.prototype.toBase64` since 140; the DOM library doesn't declare it yet. */
function base64(bytes: Uint8Array): string {
  // SAFETY: every Chromium this runs in (Debian's, 140 and later) has the method.
  return (bytes as Uint8Array & { toBase64(): string }).toBase64()
}

/** Each session's capture, and what it captures, so a new box can capture it again. */
const sessions = new Map<string, { capture: CaptureSession; tab: string; fps: number; box: Box; bitrate?: number }>()

function emit(event: LiveVideoPageEvent): void {
  if (event.type === "ended") {
    sessions.get(event.session)?.capture.close()
    sessions.delete(event.session)
  }
  const send = window.makoVideo
  if (!send) {
    // Nobody is listening any more: the host's connection went away, so nothing it opened is wanted.
    for (const session of sessions.values()) session.capture.close()
    sessions.clear()
    return
  }
  send(JSON.stringify(event.type === "unit" ? { ...event, packet: base64(event.packet) } : event))
}

/** The tab's capture at most `box`'s size, as the session's encode from now on: its first unit is a key frame. */
async function capture(session: string, tab: string, fps: number, box: Box): Promise<void> {
  // Chromium names no new stream for a tab while another captures it.
  const bitrate = sessions.get(session)?.bitrate
  sessions.get(session)?.capture.close()
  sessions.delete(session)
  const named = await chrome.runtime.sendMessage({ tab })
  if (!named?.id) throw new Error(named?.error ?? "The capture extension didn't name the tab's stream")
  const track = await captureTrack("tab", named.id, fps, box)
  const made = new CaptureSession(session, fps, track, false, emit)
  if (bitrate !== undefined) made.rate(bitrate)
  sessions.set(session, { capture: made, tab, fps, box, bitrate })
}

window.makoCapture = {
  async open(session, tab, fps, box) {
    // The encoder's check and the capture's start overlap: a viewer waits for its first key frame on both.
    const [encoder] = await Promise.all([liveVideoEncoderAvailable(fps), capture(session, tab, fps, box)])
    if (!encoder) {
      window.makoCapture?.close(session)
      throw new Error("This Chromium has no H.264 encoder")
    }
    return encoder
  },
  key: (session) => sessions.get(session)?.capture.key(),
  rate(session, bitrate) {
    const open = sessions.get(session)
    if (!open) return
    open.bitrate = bitrate
    open.capture.rate(bitrate)
  },
  // A tab capture's track never settles `applyConstraints` (Chromium 156, headless), so a new box is a new capture.
  async resize(session, box) {
    const open = sessions.get(session)
    if (open && (open.box?.width !== box?.width || open.box?.height !== box?.height)) await capture(session, open.tab, open.fps, box)
  },
  close(session) {
    sessions.get(session)?.capture.close()
    sessions.delete(session)
  },
}
