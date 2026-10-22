import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import sharp from "sharp"
import { z } from "zod"
import type { BrowserFrame, CaptureSize } from "../packages/control-runtime/src/browser-capture.js"
import {
  BrowserVideo,
  ffmpegLiveEncoder,
  type BrowserVideoViewer,
  type LiveEncoderFactory,
  type VideoSourceFrame,
} from "../packages/control-runtime/src/browser-video.js"
import { mediaExecutable } from "../packages/control-runtime/src/control-media.js"
import {
  controlVideoCodec,
  decodeControlVideo,
  encodeControlVideo,
  type ControlVideoPacket,
} from "../packages/control-runtime/src/contracts/control-video.js"
import { MovVideoInput } from "../packages/control-runtime/src/mov-video-input.js"

const execute = promisify(execFile)
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The wire format: a key unit carries its configuration, nothing else does, and framing is exact.
{
  const description = Uint8Array.from([1, 0x64, 0x00, 0x1f, 0xff])
  const common = { width: 640, height: 360, sequence: 7, capturedAt: 1_760_000_000_123.5, data: Uint8Array.from([0, 0, 0, 1, 0x65]) }
  const decoded = decodeControlVideo(encodeControlVideo({ ...common, kind: "key", description }))
  assert.equal(decoded.kind, "key")
  assert.deepEqual({ ...decoded, description: [...decoded.description], data: [...decoded.data] }, { ...common, kind: "key", description: [...description], data: [...common.data] })
  assert.equal(controlVideoCodec(description), "avc1.64001f")
  const delta = encodeControlVideo({ ...common, kind: "delta" })
  assert.deepEqual(Object.keys(decodeControlVideo(delta)).sort(), ["capturedAt", "data", "height", "kind", "sequence", "width"])
  assert.equal(decodeControlVideo(encodeControlVideo({ ...common, kind: "poster" })).kind, "poster")
  assert.throws(() => encodeControlVideo({ ...common, kind: "key", description: new Uint8Array() }), /Invalid/)
  assert.throws(() => decodeControlVideo(delta.subarray(0, delta.length - 1)), /Invalid/)
  const unknown = Uint8Array.from(delta)
  unknown[1] = 3
  assert.throws(() => decodeControlVideo(unknown), /Invalid/)
  const keyless = Uint8Array.from(encodeControlVideo({ ...common, kind: "key", description }))
  keyless[1] = 0
  assert.throws(() => decodeControlVideo(keyless), /Invalid/, "a delta never carries a configuration")
  assert.throws(() => controlVideoCodec(Uint8Array.from([0, 1, 2, 3])), /AVC/)
}

// The shared MOV input: RGB24 samples have one exact size, JPEG samples carry their own.
{
  const raw = new MovVideoInput(4, 2, 30)
  assert.equal(raw.frameBytes, 24)
  assert.throws(() => raw.frame(0, 23), /Invalid/)
  const jpeg = new MovVideoInput(4, 2, 30, "jpeg")
  assert.equal(jpeg.frameBytes, undefined)
  const first = jpeg.frame(0, 1000), second = jpeg.frame(16.7, 2345)
  const trun = first.indexOf("trun")
  assert.equal(first.readUInt32BE(trun + 20), 1000)
  assert.equal(second.readUInt32BE(trun + 20), 2345)
  assert.equal(second.readUInt32BE(second.length - 8), 2345 + 8, "mdat covers exactly the sample")
  assert.throws(() => jpeg.frame(16.7, 10), /Invalid/, "time must advance")
  assert.throws(() => jpeg.frame(40, 0), /Invalid/)
}

const jpegFrame = async (width: number, height: number, color: string) =>
  sharp({ create: { width, height, channels: 3, background: color } })
    .composite([{ input: Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><text x="10" y="40" font-size="32" fill="black">${color}</text></svg>`) }])
    .jpeg({ quality: 90 }).toBuffer()

// The real encoder: each frame leaves as one unit within milliseconds, not when
// the next frame arrives; the first is a key frame with its configuration; odd
// sizes lose an edge row and column; and the units decode.
{
  const colors = ["red", "blue", "green", "white"]
  const frames = await Promise.all(colors.map((color) => jpegFrame(641, 361, color)))
  const units: Array<ControlVideoPacket & { after: number }> = []
  let submittedAt = 0
  const drained: number[] = []
  const encoder = ffmpegLiveEncoder({ width: 641, height: 361 }, 30,
    (unit) => units.push({ ...unit, after: performance.now() - submittedAt }),
    () => drained.push(performance.now()),
    (reason) => assert.fail(reason))
  for (const [index, bytes] of frames.entries()) {
    assert.ok(encoder.ready())
    submittedAt = performance.now()
    encoder.submit({ bytes, width: 641, height: 361, sequence: index + 1, capturedAt: Date.now() })
    await wait(400)
    assert.equal(units.length, index + 1, `frame ${index + 1} left the encoder before the next was sent`)
  }
  encoder.close()
  assert.ok(units.every((unit) => unit.after < 300), `units arrive promptly: ${units.map((unit) => Math.round(unit.after)).join(", ")} ms`)
  assert.deepEqual(units.map((unit) => unit.kind), ["key", "delta", "delta", "delta"])
  assert.deepEqual(units.map((unit) => unit.sequence), [1, 2, 3, 4])
  assert.ok(units.every((unit) => unit.width === 640 && unit.height === 360))
  const keyUnit = units[0]!
  assert.equal(keyUnit.kind, "key")
  const description = keyUnit.description
  assert.match(controlVideoCodec(description), /^avc1\.[0-9a-f]{6}$/)
  // Rebuild Annex B from the avcC parameter sets and length-prefixed units, and decode it.
  const start = Buffer.from([0, 0, 0, 1])
  const parts: Buffer[] = []
  let offset = 6
  const sps = description[5]! & 0x1f
  for (let index = 0; index < sps; index++) {
    const length = (description[offset]! << 8) | description[offset + 1]!
    parts.push(start, Buffer.from(description.subarray(offset + 2, offset + 2 + length)))
    offset += 2 + length
  }
  const pps = description[offset++]!
  for (let index = 0; index < pps; index++) {
    const length = (description[offset]! << 8) | description[offset + 1]!
    parts.push(start, Buffer.from(description.subarray(offset + 2, offset + 2 + length)))
    offset += 2 + length
  }
  for (const unit of units)
    for (let at = 0; at < unit.data.length;) {
      const length = new DataView(unit.data.buffer, unit.data.byteOffset + at, 4).getUint32(0)
      parts.push(start, Buffer.from(unit.data.subarray(at + 4, at + 4 + length)))
      at += 4 + length
    }
  const child = execute(mediaExecutable("ffprobe"), ["-v", "error", "-f", "h264", "-count_frames", "-show_entries", "stream=nb_read_frames,width,height", "-of", "json", "pipe:0"])
  child.child.stdin!.end(Buffer.concat(parts))
  const probe = z.object({ streams: z.array(z.object({ nb_read_frames: z.string(), width: z.number(), height: z.number() })) })
    .parse(JSON.parse((await child).stdout))
  assert.deepEqual(probe.streams[0], { width: 640, height: 360, nb_read_frames: "4" })
}

// Fan-out, with a fake encoder whose first unit is a key frame.
interface FakeEncoder { size: CaptureSize; submitted: VideoSourceFrame[]; closed: boolean; fail: (reason: string) => void }
const encoders: FakeEncoder[] = []
const fake: LiveEncoderFactory = (size, _fps, unit, drained, failed) => {
  const state: FakeEncoder = { size, submitted: [], closed: false, fail: failed }
  encoders.push(state)
  return {
    ready: () => !state.closed,
    submit(frame) {
      state.submitted.push(frame)
      queueMicrotask(() => {
        if (state.closed) return
        const common = { width: frame.width, height: frame.height, sequence: frame.sequence, capturedAt: frame.capturedAt, data: Uint8Array.from([0, 0, 0, 1, frame.sequence]) }
        unit(state.submitted.length === 1 ? { ...common, kind: "key", description: Uint8Array.from([1, 66, 0, 30]) } : { ...common, kind: "delta" })
        drained()
      })
    },
    close() { state.closed = true },
  }
}
const viewer = (box?: CaptureSize) => {
  const received: ControlVideoPacket[] = []
  let ended: string | undefined
  const self = {
    backlog: 0,
    received,
    get ended() { return ended },
    size: () => box,
    send: (bytes: Uint8Array) => { received.push(decodeControlVideo(bytes)) },
  }
  const handle: BrowserVideoViewer = { size: () => self.size(), backlog: () => self.backlog, send: (bytes) => self.send(bytes), ended: (reason) => { ended = reason } }
  return { self, handle }
}
let emit: ((frame: BrowserFrame) => void) | undefined
let endCapture: ((reason: string) => void) | undefined
let demand: (() => CaptureSize | undefined) | undefined
let stops = 0, resizes = 0
const video = new BrowserVideo(async (consumer) => {
  emit = consumer.frame
  endCapture = consumer.ended
  demand = consumer.size
  return { stop: async () => { stops++ }, resized: async () => { resizes++ } }
}, { encoder: fake, fps: 1000 })
const frame = (width = 640, height = 360): BrowserFrame => ({ bytes: Buffer.from([0xff, 0xd8]), width, height, viewportWidth: width, viewportHeight: height, pageScaleFactor: 1, offsetTop: 0, capturedAt: Date.now() })
const settle = () => wait(5)

const kinds = (packets: ControlVideoPacket[]) => packets.map((packet) => packet.kind)
const first = viewer({ width: 640, height: 360 })
const leaveFirst = await video.join(first.handle)
assert.deepEqual(demand?.(), { width: 640, height: 360 })
emit!(frame())
await settle()
assert.deepEqual(kinds(first.self.received), ["poster", "key"], "the first frame paints at once as a poster, then arrives as a key frame")
emit!(frame())
await settle()
assert.deepEqual(kinds(first.self.received), ["poster", "key", "delta"], "one poster only")
assert.equal(encoders.length, 1)

// A second viewer paints the current picture at once and gets its key frame without the page changing.
const second = viewer({ width: 960, height: 540 })
const leaveSecond = await video.join(second.handle)
await settle()
assert.deepEqual(demand?.(), { width: 960, height: 540 }, "the capture is asked for the largest viewer")
assert.ok(resizes >= 1)
assert.equal(encoders.length, 2, "a joining viewer restarts the encoder")
assert.equal(encoders[0]!.closed, true)
assert.deepEqual(second.self.received.map((packet) => [packet.kind, packet.sequence]), [["poster", 2], ["key", 2]], "the newest frame, as a poster and again as a key frame")
assert.deepEqual(kinds(first.self.received), ["poster", "key", "delta", "key"], "a viewer already painting gets no poster")

// A viewer that falls behind skips deltas, then gets one key frame once it drains, not one per frame.
second.self.backlog = 10 * 1024 * 1024
emit!(frame())
await settle()
assert.equal(second.self.received.length, 2, "nothing queues behind a full viewer")
assert.equal(first.self.received.length, 5, "a slow viewer never slows another")
second.self.backlog = 0
emit!(frame())
await settle()
assert.equal(second.self.received.length, 2, "after falling behind it waits for a key frame")
await wait(1100)
assert.equal(encoders.length, 3, "one recovery key frame, at most one a second")
assert.equal(second.self.received.at(-1)?.kind, "key")
emit!(frame())
await settle()
assert.equal(second.self.received.at(-1)?.kind, "delta", "then deltas resume")

// A new frame size means a new encoder and a key frame with the new size.
emit!(frame(960, 540))
await settle()
assert.equal(encoders.length, 4)
assert.deepEqual(encoders.at(-1)!.size, { width: 960, height: 540 })
assert.deepEqual([first.self.received.at(-1)?.kind, first.self.received.at(-1)?.width], ["key", 960])

// A viewer that lost its picture asks again: the newest frame as a poster, then a key frame; a viewer painting already gets no poster.
await wait(1000)
const beforeRefresh = second.self.received.length
video.refresh(first.handle)
await settle()
assert.deepEqual(kinds(first.self.received.slice(-2)), ["poster", "key"])
assert.deepEqual(kinds(second.self.received.slice(beforeRefresh)), ["key"])
video.refresh(first.handle)
await settle()
assert.equal(first.self.received.at(-1)?.kind, "poster", "a second ask within the second repaints the poster but waits for its key frame")
await wait(1100)
assert.equal(first.self.received.at(-1)?.kind, "key", "the key frame comes once a second has passed")

// Leaving: the capture follows the remaining viewers; the last one stops capture and encoding.
await leaveSecond()
assert.deepEqual(demand?.(), { width: 640, height: 360 })
await leaveFirst()
assert.equal(stops, 1)
assert.equal(encoders.at(-1)!.closed, true)

// Three encoder failures in a row end the stream for its viewers.
const third = viewer()
await video.join(third.handle)
assert.equal(demand?.(), undefined, "a viewer without a box takes full size")
emit!(frame())
await settle()
for (let attempt = 0; attempt < 3; attempt++) encoders.at(-1)!.fail("encoder crashed")
assert.equal(third.self.ended, "encoder crashed")
await assert.rejects(video.join(viewer().handle), /ended/)

// The capture ending ends its viewers.
const other = new BrowserVideo(async (consumer) => { endCapture = consumer.ended; return { stop: async () => {}, resized: async () => {} } }, { encoder: fake })
const watcher = viewer()
await other.join(watcher.handle)
endCapture!("Recording target detached")
assert.equal(watcher.self.ended, "Recording target detached")

console.log("Browser video: wire format, shared MOV input, prompt real encoding that decodes, posters and key frames on join and on asking again, slow-viewer recovery, resize, leave and failure passed")
