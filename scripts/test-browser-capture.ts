import assert from "node:assert/strict"
import sharp from "sharp"
import { z } from "zod"
import {
  BrowserCapture,
  type CaptureConnection,
  type BrowserFrame,
} from "../packages/control-runtime/src/browser-capture.js"

const jpeg = (
  await sharp({
    create: { width: 480, height: 300, channels: 3, background: "white" },
  })
    .jpeg()
    .toBuffer()
).toString("base64")
const calls: string[] = []
const listeners = new Set<Parameters<CaptureConnection["onEvent"]>[0]>()
let failStop = false
const connection: CaptureConnection = {
  async send(method) {
    calls.push(method)
    if (failStop && method === "Page.stopScreencast")
      throw new Error("stop failed")
    return {}
  },
  onEvent(listener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  onClose() {
    return () => {}
  },
}
let eventSequence = 0
const emit = (data = jpeg) => {
  for (const listener of listeners)
    listener({
      cursor: ++eventSequence,
      method: "Page.screencastFrame",
      sessionId: "session",
      params: {
        sessionId: 1,
        data,
        metadata: {
          deviceWidth: 1600,
          deviceHeight: 1000,
          pageScaleFactor: 1,
          offsetTop: 0,
        },
      },
    })
}
const capture = new BrowserCapture(connection, "session")
const preview: BrowserFrame[] = [],
  recording: BrowserFrame[] = []
const ended: string[] = []
const stopPreview = await capture.subscribe({
  frame: (f) => preview.push(f),
  ended: (r) => ended.push(r),
})
const stopRecording = await capture.subscribe({
  frame: (f) => recording.push(f),
  ended: (r) => ended.push(r),
})
assert.equal(calls.filter((c) => c === "Page.startScreencast").length, 1)
emit()
assert.deepEqual(
  [
    preview[0]?.width,
    preview[0]?.height,
    preview[0]?.viewportWidth,
    preview[0]?.viewportHeight,
  ],
  [480, 300, 1600, 1000]
)
assert.equal(recording.length, 1)
assert.equal(preview[0]!.bytes, recording[0]!.bytes, "Preview and recording share the one decoded byte buffer")
assert.deepEqual(preview[0]!.bytes, Buffer.from(jpeg, "base64"), "Capture preserves the exact encoded source")
await capture.screenshot(async () => {
  emit()
  return "still"
})
assert.equal(recording.length, 1, "Screenshot-transient frames are excluded")
emit()
assert.equal(recording.length, 2, "Stream resumes after screenshot")
await assert.rejects(
  capture.screenshot(async () => {
    throw new Error("screenshot failed")
  }),
  /screenshot failed/
)
emit()
assert.equal(recording.length, 3, "Failed screenshot also resumes stream")
await stopPreview()
const before = calls.filter((c) => c === "Page.stopScreencast").length
emit()
assert.equal(preview.length, 3)
assert.equal(recording.length, 4)
assert.equal(calls.filter((c) => c === "Page.stopScreencast").length, before)
await stopRecording()
assert.equal(
  calls.filter((c) => c === "Page.stopScreencast").length,
  before + 1
)
await stopRecording()
assert.equal(
  calls.filter((c) => c === "Page.stopScreencast").length,
  before + 1,
  "Release is idempotent"
)
const stop = await capture.subscribe({
  frame: () => {},
  ended: (r) => ended.push(r),
})
failStop = true
await assert.rejects(stop(), /exact tab attachment/)
assert.equal(calls.filter((c) => c === "Target.detachFromTarget").length, 1)
await assert.rejects(
  capture.subscribe({ frame: () => {}, ended: () => {} }),
  /ended/
)
assert.equal(listeners.size, 0)
// Chrome encodes exactly the pixels the largest consumer shows: previews give
// their viewer's size, a recording takes full size, and the screencast restarts
// only when that changes.
const sized: Array<{ method: string; params?: unknown }> = []
const sizedConnection: CaptureConnection = {
  async send(method, params) {
    sized.push({ method, params })
    return {}
  },
  onEvent: () => () => {},
  onClose: () => () => {},
}
const ScreencastStart = z.object({ maxWidth: z.number(), maxHeight: z.number() }).passthrough()
const starts = () => sized.filter((call) => call.method === "Page.startScreencast").map((call) => ScreencastStart.parse(call.params))
const viewer = new BrowserCapture(sizedConnection, "sized")
let box = { width: 700, height: 420 }
const stopSmall = await viewer.subscribe({ frame: () => {}, ended: () => {}, size: () => box })
assert.deepEqual(starts().map(({ maxWidth, maxHeight }) => [maxWidth, maxHeight]), [[700, 420]], "a preview alone streams its viewer's size")
box = { width: 699.5, height: 419.2 }
await viewer.resized()
assert.equal(starts().length, 1, "a size that rounds to the same pixels keeps the stream")
const stopFull = await viewer.subscribe({ frame: () => {}, ended: () => {} })
assert.deepEqual(starts().at(-1), { format: "jpeg", quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 }, "a recording takes full size")
assert.equal(sized.filter((call) => call.method === "Page.stopScreencast").length, 1, "growing restarts the stream once")
await stopFull()
assert.deepEqual([starts().at(-1)!.maxWidth, starts().at(-1)!.maxHeight], [700, 420], "the stream shrinks back when the recording ends")
box = { width: 2400, height: 1350 }
await viewer.resized()
assert.deepEqual([starts().at(-1)!.maxWidth, starts().at(-1)!.maxHeight], [1920, 1080], "a retina viewer never asks past 1080p")
await stopSmall()
console.log(
  "Browser capture: shared stream, actual pixels, screenshot isolation, independent consumers, failed-stop cleanup and viewer-sized screencasts passed"
)
