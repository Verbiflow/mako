/**
 * Live video the desktop app encodes, as the host sees it, with the desktop channel scripted
 * (`packages/host/src/control/desktop-video.ts`): the screencast's frames sent to the desktop's encoder, at most four
 * out, and FFmpeg taking over when no desktop answers or its encoder won't open; a capture the
 * desktop encodes (`EncodedVideoSource`) joined by `BrowserVideo`, which asks it for key frames rather than restarting
 * an encoder, and falls back to the screencast when the capture can't start or stops; and an app window's preview
 * streamed to a remote viewer through the capture, which only a desktop app can make.
 * The desktop's real page runs in `test-live-video-electron.mjs`.
 */
import assert from "node:assert/strict"
import {
  BrowserVideo,
  type BrowserVideoViewer,
  type EncodedVideoSource,
  type LiveEncoderFactory,
  type VideoSourceFrame,
} from "@mako/control-runtime/browser"
import type { BrowserFrame } from "@mako/control-runtime/browser"
import { decodeControlVideo, encodeControlVideo, type ControlVideoPacket } from "@mako/control-runtime/contracts"
import type { DesktopMethod, DesktopParams, DesktopResult } from "@mako/host/contracts/desktop-channel"
import type { LiveVideoListener } from "@mako/host/control/desktop-channel"
import { desktopCapture, desktopLiveEncoder, desktopPreviewCapture, type LiveVideoChannel } from "@mako/host/control/desktop-video"
import { ControlPreviews, type PreviewBrowser } from "@mako/host/control/previews"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = () => wait(5)
const description = Uint8Array.from([1, 0x64, 0, 0x1f, 0xff])
const packet = (sequence: number, kind: "key" | "delta", width = 640, height = 360): ControlVideoPacket => {
  const common = { width, height, sequence, capturedAt: 1_760_000_000_000 + sequence, data: Uint8Array.from([0, 0, 0, 1, sequence & 0xff]) }
  return kind === "key" ? { ...common, kind, description } : { ...common, kind }
}

/** The desktop channel, scripted: what it was asked, how it answers, and the units it sends on its own. */
class ScriptedChannel implements LiveVideoChannel {
  answering = true
  asked: { method: DesktopMethod; params: DesktopParams<DesktopMethod> }[] = []
  listeners = new Map<string, LiveVideoListener>()
  /** Answers held until the test settles them, by method. */
  holding = new Set<DesktopMethod>()
  held: { method: DesktopMethod; resolve: (value: DesktopResult<DesktopMethod>) => void; reject: (error: Error) => void }[] = []
  refuseOpen?: string

  answers(): boolean {
    return this.answering
  }

  ask<Method extends DesktopMethod>(method: Method, params: DesktopParams<Method>): Promise<DesktopResult<Method>> {
    this.asked.push({ method, params })
    if (method === "live-video-open" && this.refuseOpen) return Promise.reject(new Error(this.refuseOpen))
    return new Promise<DesktopResult<Method>>((resolve, reject) => {
      const answer = method === "live-video-open" ? { encoder: "avc1.640034 prefer-hardware" } : null
      // SAFETY: the answers above are each method's result: `live-video-open` an encoder, every other live video method null.
      const settle = (value: DesktopResult<DesktopMethod>) => resolve(value as DesktopResult<Method>)
      if (this.holding.has(method)) this.held.push({ method, resolve: settle, reject })
      else queueMicrotask(() => settle(answer))
    })
  }

  liveVideo(session: string, listener: LiveVideoListener): () => void {
    this.listeners.set(session, listener)
    return () => this.listeners.delete(session)
  }

  sessions(method: DesktopMethod) {
    return this.asked.filter((ask) => ask.method === method)
  }

  /** The session the newest open named. */
  get session(): string {
    const open = this.sessions("live-video-open").at(-1)?.params
    assert.ok(open && "session" in open)
    return open.session
  }

  send(session: string, unit: ControlVideoPacket) {
    this.listeners.get(session)?.packet(encodeControlVideo(unit))
  }
}

const frame = (sequence: number, width = 640, height = 360): VideoSourceFrame => ({ bytes: Buffer.from([0xff, 0xd8, sequence]), width, height, sequence, capturedAt: 1_760_000_000_000 + sequence })

// The desktop encodes the screencast's frames: at most four out, a unit or a drop back for each.
{
  const channel = new ScriptedChannel()
  channel.holding.add("live-video-frame")
  const units: ControlVideoPacket[] = []
  let drained = 0
  const failures: string[] = []
  const encoder = desktopLiveEncoder(channel, () => assert.fail("FFmpeg encoded though the desktop could"))({ width: 640, height: 360 }, 30, (unit) => units.push(unit), () => drained++, (reason) => failures.push(reason))
  assert.equal(encoder.ready(), false, "nothing is sent before the encoder opened")
  await settle()
  assert.deepEqual(channel.sessions("live-video-open")[0]?.params, { session: channel.session, source: { kind: "frames" }, fps: 30, box: null })
  assert.equal(encoder.ready(), true)
  encoder.submit(frame(1))
  const sent = channel.sessions("live-video-frame")[0]?.params
  assert.ok(sent && "data" in sent)
  assert.deepEqual([Buffer.from(sent.data, "base64").at(-1), sent.sequence], [1, 1])
  for (let sequence = 2; sequence <= 4; sequence++) {
    assert.equal(encoder.ready(), true, "the next frame crosses while one decodes")
    encoder.submit(frame(sequence))
  }
  assert.equal(encoder.ready(), false, "four frames out fill it")
  for (const held of channel.held.splice(0)) held.resolve(null)
  await settle()
  assert.equal(encoder.ready(), false, "a frame taken is still out until its unit or its drop comes back")
  channel.send(channel.session, packet(1, "key"))
  assert.equal(encoder.ready(), true, "a unit back makes room")
  channel.listeners.get(channel.session)?.dropped(2)
  channel.send(channel.session, packet(3, "delta"))
  channel.send(channel.session, packet(99, "delta"))
  assert.deepEqual(units.map((unit) => [unit.kind, unit.sequence]), [["key", 1], ["delta", 3]], "a unit for a frame it never sent is ignored")
  assert.equal(units[0]?.kind === "key" && [...units[0].description].join(), [...description].join())
  channel.listeners.get(channel.session)?.ended("The live video page stopped")
  assert.deepEqual(failures, ["The live video page stopped"])
  assert.equal(encoder.ready(), false)
  encoder.close()
  assert.equal(channel.sessions("live-video-close").length, 0, "an ended session isn't closed again")
}

// No desktop answering, or its encoder not opening: FFmpeg encodes, and the video never hears of it.
{
  const fallbackUnits: ControlVideoPacket[] = []
  let fallbacks = 0
  const fallback: LiveEncoderFactory = (_size, _fps, unit, drained) => {
    fallbacks++
    let closed = false
    return {
      ready: () => !closed,
      submit(sent) {
        unit(packet(sent.sequence, "key"))
        drained()
      },
      close() { closed = true },
    }
  }
  const absent = new ScriptedChannel()
  absent.answering = false
  desktopLiveEncoder(absent, fallback)({ width: 640, height: 360 }, 30, () => {}, () => {}, () => {})
  assert.equal(fallbacks, 1)
  assert.equal(absent.asked.length, 0, "a desktop that isn't there isn't asked")

  const refusing = new ScriptedChannel()
  refusing.refuseOpen = "No H.264 encoder in this browser"
  const factory = desktopLiveEncoder(refusing, fallback)
  let drained = 0
  const encoder = factory({ width: 640, height: 360 }, 30, (unit) => fallbackUnits.push(unit), () => drained++, () => assert.fail("a refused open isn't a failure"))
  await settle()
  assert.equal(fallbacks, 2, "FFmpeg takes over the encode")
  assert.equal(drained, 1, "and the video is told it can send")
  assert.ok(encoder.ready())
  encoder.submit(frame(7))
  assert.deepEqual(fallbackUnits.map((unit) => unit.sequence), [7])
  factory({ width: 640, height: 360 }, 30, () => {}, () => {}, () => {})
  assert.equal(fallbacks, 3, "for a while after, FFmpeg encodes without asking the desktop again")
  assert.equal(refusing.sessions("live-video-open").length, 1)
}

// A capture the desktop encodes: opened with the viewers' box and rate, asked for key frames, resized and closed.
{
  const channel = new ScriptedChannel()
  let box: { width: number; height: number } | undefined = { width: 800, height: 500 }
  const units: ControlVideoPacket[] = []
  const endings: string[] = []
  const capture = await desktopCapture(channel, { kind: "page", page: "desk-7" })({ unit: (unit) => units.push(unit), ended: (reason) => endings.push(reason), size: () => box, fps: 60 })
  assert.deepEqual(channel.sessions("live-video-open")[0]?.params, { session: channel.session, source: { kind: "page", page: "desk-7" }, fps: 60, box: { width: 800, height: 500 } })
  channel.send(channel.session, packet(1, "key"))
  assert.deepEqual(units.map((unit) => unit.kind), ["key"])
  capture.key()
  assert.equal(channel.sessions("live-video-key").length, 1)
  box = undefined
  await capture.resized()
  assert.deepEqual(channel.sessions("live-video-resize")[0]?.params, { session: channel.session, box: null })
  await capture.stop()
  assert.equal(channel.sessions("live-video-close").length, 1)
  channel.send(channel.session, packet(2, "delta"))
  assert.equal(units.length, 1, "nothing is heard after it stopped")

  const absent = new ScriptedChannel()
  absent.answering = false
  await assert.rejects(desktopCapture(absent, { kind: "window", windowId: 4 })({ unit: () => {}, ended: () => {}, size: () => undefined, fps: 30 }), /desktop app/)
  const previewCapture = desktopPreviewCapture(channel, (browser, tab) => (browser === "mako" ? tab : undefined))
  assert.equal(previewCapture.tab({ browser: "chromium", tab: "t1", generation: "g", lease: "l" }), undefined, "only a tab of Mako's own is captured as a tab")
  assert.ok(previewCapture.tab({ browser: "mako", tab: "desk-7", generation: "g", lease: "l" }))
  assert.ok(previewCapture.window({ pid: 10, windowId: 4 }))
  assert.equal(desktopPreviewCapture(absent, () => "desk-7").window({ pid: 10, windowId: 4 }), undefined)
}

// BrowserVideo over an encoded capture: no posters, no encoder here; key frames are asked of the capture, at most one
// a second for a viewer that fell behind; the screencast takes over when the capture can't start or stops.
interface ScriptedCapture { unit: (packet: ControlVideoPacket) => void; ended: (reason: string) => void; keys: number; stopped: boolean; resizes: number }
const captures: ScriptedCapture[] = []
let refuseCapture: string | undefined
const encoded: EncodedVideoSource = async (consumer) => {
  if (refuseCapture) throw new Error(refuseCapture)
  const capture: ScriptedCapture = { unit: consumer.unit, ended: consumer.ended, keys: 0, stopped: false, resizes: 0 }
  captures.push(capture)
  return {
    key: () => { capture.keys++ },
    resized: async () => { capture.resizes++ },
    stop: async () => { capture.stopped = true },
  }
}
const viewer = () => {
  const received: ControlVideoPacket[] = []
  /** What the viewer has backed up, and why its video ended, once it did. */
  interface ViewerState { backlog: number; ended?: string }
  const state: ViewerState = { backlog: 0 }
  const handle: BrowserVideoViewer = {
    size: () => ({ width: 640, height: 360 }),
    backlog: () => state.backlog,
    send: (bytes) => { received.push(decodeControlVideo(bytes)) },
    ended: (reason) => { state.ended = reason },
  }
  return { handle, received, state }
}
let frameSource: { frame: (frame: BrowserFrame) => void; stopped: boolean } | undefined
let frameSources = 0
const frames = async (consumer: { frame: (frame: BrowserFrame) => void }) => {
  frameSources++
  const source = { frame: consumer.frame, stopped: false }
  frameSource = source
  return { stop: async () => { source.stopped = true }, resized: async () => {} }
}
const fakeEncoder: LiveEncoderFactory = (_size, _fps, unit, drained) => {
  let first = true
  return {
    ready: () => true,
    submit(sent) {
      queueMicrotask(() => {
        unit(packet(sent.sequence, first ? "key" : "delta", sent.width, sent.height))
        first = false
        drained()
      })
    },
    close() {},
  }
}
const browserFrame = (): BrowserFrame => ({ bytes: Buffer.from([0xff, 0xd8]), width: 640, height: 360, viewportWidth: 640, viewportHeight: 360, pageScaleFactor: 1, offsetTop: 0, capturedAt: Date.now() })
{
  const video = new BrowserVideo({ frames, encoded }, { fps: 1000, encoder: fakeEncoder })
  const first = viewer()
  const leaveFirst = await video.join(first.handle)
  assert.equal(captures.length, 1)
  assert.equal(frameSources, 0, "the capture is used, not the screencast")
  assert.equal(captures[0]!.keys, 0, "a new capture's first unit is a key frame; none is asked for")
  captures[0]!.unit(packet(1, "key"))
  captures[0]!.unit(packet(2, "delta"))
  assert.deepEqual(first.received.map((unit) => unit.kind), ["key", "delta"], "no poster: nothing here has the picture")
  const second = viewer()
  const leaveSecond = await video.join(second.handle)
  assert.equal(captures[0]!.keys, 1, "a joining viewer asks the capture for a key frame")
  captures[0]!.unit(packet(3, "delta"))
  assert.equal(second.received.length, 0, "it waits for its key frame")
  captures[0]!.unit(packet(4, "key"))
  assert.deepEqual(second.received.map((unit) => unit.kind), ["key"])
  // Falling behind: it skips, then gets one key frame once it drains, not before a second has passed.
  second.state.backlog = 10 * 1024 * 1024
  captures[0]!.unit(packet(5, "delta"))
  second.state.backlog = 0
  captures[0]!.unit(packet(6, "delta"))
  assert.equal(captures[0]!.keys, 1, "at most one key frame a second")
  await wait(1100)
  assert.equal(captures[0]!.keys, 2, "the key frame comes once a second has passed, though the picture is still")
  // A key frame asked for that never comes is asked for again.
  await wait(2200)
  assert.equal(captures[0]!.keys, 3)
  captures[0]!.unit(packet(7, "key"))
  assert.equal(second.received.at(-1)?.kind, "key")
  // The capture stops: the screencast and this host's encoder take over, from a poster and a key frame.
  captures[0]!.ended("The capture ended: its window or tab closed")
  await settle()
  assert.equal(captures[0]!.stopped, true)
  assert.equal(frameSources, 1)
  assert.equal(first.state.ended, undefined, "the viewers stay")
  frameSource!.frame(browserFrame())
  await settle()
  assert.deepEqual(first.received.slice(-1).map((unit) => unit.kind), ["key"], "a viewer already painting gets the key frame")
  frameSource!.frame(browserFrame())
  await settle()
  assert.equal(first.received.at(-1)?.kind, "delta")
  captures[0]!.unit(packet(50, "delta"))
  assert.notEqual(first.received.at(-1)?.sequence, 50, "the stopped capture is no longer heard")
  await leaveSecond()
  await leaveFirst()
  assert.equal(frameSource!.stopped, true)
  video.close()
}
{
  refuseCapture = "Mako's desktop app isn't open to capture this."
  const video = new BrowserVideo({ frames, encoded }, { fps: 1000, encoder: fakeEncoder })
  const watcher = viewer()
  const before = frameSources
  await video.join(watcher.handle)
  assert.equal(frameSources, before + 1, "a capture that can't start leaves the video to the screencast")
  frameSource!.frame(browserFrame())
  await settle()
  assert.deepEqual(watcher.received.map((unit) => unit.kind), ["poster", "key"])
  video.close()
  refuseCapture = undefined
}
{
  const video = new BrowserVideo({ encoded }, { fps: 1000 })
  const watcher = viewer()
  await video.join(watcher.handle)
  captures.at(-1)!.ended("The capture ended: its window or tab closed")
  assert.equal(watcher.state.ended, "The capture ended: its window or tab closed", "with nothing to fall back on, the viewers' video ends")
  refuseCapture = "That window isn't on screen to capture."
  await assert.rejects(new BrowserVideo({ encoded }).join(viewer().handle), /on screen/)
  refuseCapture = undefined
}

// An app window's preview streams to a remote viewer through the desktop's capture; without one it's refused.
{
  const browser: PreviewBrowser = { previewStream: async () => async () => {}, previewResized: async () => {} }
  const windows: number[] = []
  const previews = new ControlPreviews(browser, async () => null, () => {}, {
    fps: 1000,
    capture: {
      tab: () => undefined,
      window: (target) => {
        windows.push(target.windowId)
        return encoded
      },
    },
  })
  previews.observe({ conversationId: "c1", kind: "computer", operation: "click", target: "Blender", status: "running" })
  previews.computerTarget("c1", { pid: 42, windowId: 7 }, () => {})
  const sent: ControlVideoPacket[] = []
  const endings: string[] = []
  previews.watchVideo("c1", "s1", { width: 1280, height: 800 }, { send: (bytes) => { sent.push(decodeControlVideo(bytes)); return true }, end: (why) => endings.push(why.reason) })
  await settle()
  assert.deepEqual(windows, [7])
  captures.at(-1)!.unit(packet(1, "key", 1280, 800))
  captures.at(-1)!.unit(packet(2, "delta", 1280, 800))
  assert.deepEqual(sent.map((unit) => unit.kind), ["key", "delta"])
  // The agent moves to another window: the viewer moves with it.
  const before = captures.at(-1)!
  previews.observe({ conversationId: "c1", kind: "computer", operation: "click", target: "Finder", status: "running" })
  previews.computerTarget("c1", { pid: 43, windowId: 9 }, () => {})
  await settle()
  assert.equal(before.stopped, true)
  assert.deepEqual(windows, [7, 9])
  assert.deepEqual(endings, [])
  previews.close()

  // With no desktop app attached, a watched window's viewers are told why rather than left waiting.
  const detached = new ControlPreviews(browser, async () => null, () => {}, { capture: { tab: () => undefined, window: () => undefined } })
  detached.observe({ conversationId: "c1", kind: "computer", operation: "click", target: "Blender", status: "running" })
  const told: string[] = []
  detached.watchVideo("c1", "s1", undefined, { send: () => true, end: (why) => told.push(why.reason) })
  detached.computerTarget("c1", { pid: 42, windowId: 7 }, () => {})
  assert.match(told[0] ?? "", /desktop app is open/)
  detached.close()

  const without = new ControlPreviews(browser, async () => null, () => {})
  without.observe({ conversationId: "c1", kind: "computer", operation: "click", target: "Blender", status: "running" })
  without.computerTarget("c1", { pid: 42, windowId: 7 }, () => {})
  const refused: string[] = []
  without.watchVideo("c1", "s1", undefined, { send: () => true, end: (why) => refused.push(why.reason) })
  assert.match(refused[0] ?? "", /desktop app/)
  without.close()
}

console.log("Desktop video: frames to the desktop's encoder with backpressure and drops, FFmpeg when it can't, captures opened, keyed, resized and closed, BrowserVideo over a capture with key asks, recovery and the screencast taking over, and app windows streamed to remote viewers passed")
