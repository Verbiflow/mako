/**
 * The WebCodecs live encoder's contract (`src/lib/live-video-encoder.ts`) against a scripted VideoEncoder: frames in,
 * `ControlVideoPacket`s out. Every key unit carries the `avcC` WebCodecs gave only once; `key()` and a new size make
 * key units; at most four frames are inside a hardware encoder and two inside a software one, and only the newest
 * waiting frame is held; an encoder that holds a full queue is flushed; outputs that skip a frame say it was dropped;
 * a missing hardware encoder falls back to software, and so does one that fails while encoding. Then the change gate.
 * The real encoder and decoder run in `test-live-video-electron.mjs`.
 */
import assert from "node:assert/strict"
import type { ControlVideoPacket } from "@mako/control-runtime/contracts"
import { LiveVideoEncoder, liveVideoEncoderAvailable, type LiveFrame, type LiveFrameTag, type LiveVideoChunk, type LiveVideoCodec, type LiveVideoCodecs } from "../src/lib/live-video-encoder.ts"
import { ChangeGate } from "../src/lib/live-video-gate.ts"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A frame as the encoder reads one. */
interface FakeFrame extends LiveFrame { timestamp: number; closed: boolean }
function frame(width = 1280, height = 800, timestamp = 0): FakeFrame {
  const made: FakeFrame = {
    displayWidth: width, displayHeight: height, visibleRect: { x: 0, y: 0, width, height }, closed: false, timestamp,
    close() { made.closed = true },
  }
  return made
}

interface Encode { timestamp: number; key: boolean; width: number; height: number }
interface Made {
  config?: VideoEncoderConfig
  encodes: Encode[]
  closed: boolean
  flushes: number
  output(index: number, type: EncodedVideoChunkType, describe?: boolean): void
  error(message: string): void
  flushed?: () => void
}

/** WebCodecs, scripted: which configs are supported, and every encoder made, whose outputs the test sends. */
function scripted(supported: (config: VideoEncoderConfig) => boolean) {
  const made: Made[] = []
  const codecs: LiveVideoCodecs<FakeFrame> = {
    supported: async (config) => supported(config),
    wrap: (source, width, height, timestamp) => {
      assert.ok(!source.closed, "a frame is wrapped before it's closed")
      return frame(width, height, timestamp)
    },
    create(output, error) {
      const encoder: Made = {
        encodes: [], closed: false, flushes: 0,
        output(index, type, describe = false) {
          const sent = encoder.encodes[index]!
          const chunk: LiveVideoChunk = { type, timestamp: sent.timestamp, byteLength: 3, copyTo: (target) => target.set([0, 0, index]) }
          output(chunk, describe ? { decoderConfig: { codec: "avc1.640034", description: Uint8Array.from([1, 0x64, 0, 0x34, 0xff]) } } : undefined)
        },
        error: (message) => error(new Error(message)),
      }
      made.push(encoder)
      const codec: LiveVideoCodec<FakeFrame> = {
        configure: (config) => { encoder.config = config },
        encode: (input, options) => {
          encoder.encodes.push({ timestamp: input.timestamp, key: options.keyFrame === true, width: input.displayWidth, height: input.displayHeight })
        },
        flush: () => new Promise<void>((resolve) => { encoder.flushes++; encoder.flushed = resolve }),
        close: () => { encoder.closed = true },
      }
      return codec
    },
  }
  return { codecs, made }
}

function events() {
  const units: ControlVideoPacket[] = []
  const drained: { tag: LiveFrameTag; sent: boolean }[] = []
  const failures: string[] = []
  return {
    units, drained, failures,
    handlers: {
      unit: (packet: ControlVideoPacket) => units.push(packet),
      drained: (tag: LiveFrameTag, sent: boolean) => drained.push({ tag, sent }),
      failed: (reason: string) => failures.push(reason),
    },
  }
}
const tag = (sequence: number): LiveFrameTag => ({ sequence, capturedAt: 1_760_000_000_000 + sequence })

// Hardware first; every key unit carries the avcC, which WebCodecs gave with the first alone.
{
  const { codecs, made } = scripted(() => true)
  const heard = events()
  const encoder = new LiveVideoEncoder(30, heard.handlers, codecs)
  assert.ok(encoder.ready())
  const first = frame()
  encoder.encode(first, tag(1))
  await wait(1)
  assert.equal(made.length, 1)
  assert.equal(made[0]!.config?.hardwareAcceleration, "prefer-hardware")
  assert.equal(made[0]!.config?.codec, "avc1.640034")
  assert.equal(made[0]!.config?.latencyMode, "realtime")
  assert.deepEqual(made[0]!.config?.avc, { format: "avc" })
  assert.equal(made[0]!.encodes[0]?.key, true, "the first frame is a key frame")
  assert.ok(first.closed, "the encoder closes the frames it takes")
  made[0]!.output(0, "key", true)
  encoder.encode(frame(), tag(2))
  made[0]!.output(1, "delta")
  encoder.key()
  encoder.encode(frame(), tag(3))
  assert.equal(made[0]!.encodes[2]?.key, true, "key() makes the next frame a key frame")
  made[0]!.output(2, "key")
  assert.deepEqual(heard.units.map((unit) => [unit.kind, unit.sequence]), [["key", 1], ["delta", 2], ["key", 3]])
  const keys = heard.units.filter((unit) => unit.kind === "key")
  assert.ok(keys.every((unit) => unit.kind === "key" && [...unit.description].join() === "1,100,0,52,255"), "a key frame without metadata still carries the avcC")
  assert.deepEqual(heard.units[2]?.capturedAt, tag(3).capturedAt)
  assert.deepEqual(heard.drained.map(({ sent }) => sent), [true, true, true])
  assert.equal(encoder.encoder, "avc1.640034 prefer-hardware")
  encoder.close()
  assert.ok(made[0]!.closed)
}

// A key frame before any configuration is refused, not sent without its avcC.
{
  const { codecs, made } = scripted(() => true)
  const heard = events()
  const encoder = new LiveVideoEncoder(30, heard.handlers, codecs)
  encoder.encode(frame(), tag(1))
  await wait(1)
  made[0]!.output(0, "key", false)
  assert.equal(heard.units.length, 0)
  assert.match(heard.failures[0] ?? "", /without its configuration/)
}

// In flight: four in a hardware encoder; past that only the newest waits, and it starts as one comes out.
{
  const { codecs, made } = scripted(() => true)
  const heard = events()
  const encoder = new LiveVideoEncoder(30, heard.handlers, codecs, 10_000)
  encoder.encode(frame(), tag(1))
  await wait(1)
  for (const sequence of [2, 3, 4]) encoder.encode(frame(), tag(sequence))
  assert.equal(made[0]!.encodes.length, 4)
  assert.equal(encoder.ready(), false, "four frames inside a hardware encoder fill it")
  encoder.encode(frame(), tag(5))
  encoder.encode(frame(), tag(6))
  assert.equal(made[0]!.encodes.length, 4, "nothing more starts")
  assert.deepEqual(heard.drained, [{ tag: tag(5), sent: false }], "a newer frame replaces the one waiting")
  made[0]!.output(0, "key", true)
  assert.equal(made[0]!.encodes.length, 5, "the waiting frame starts once one comes out")
  // Frame 2 never comes out: an output for frame 3 says it was dropped.
  made[0]!.output(2, "delta")
  assert.deepEqual(heard.drained.slice(1).map(({ tag: { sequence }, sent }) => [sequence, sent]), [[1, true], [2, false], [3, true]])
  assert.deepEqual(heard.units.map((unit) => unit.sequence), [1, 3])
  encoder.close()
}

// An encoder that holds a full queue without output is flushed; what the flush didn't return was dropped.
{
  const { codecs, made } = scripted(() => true)
  const heard = events()
  const encoder = new LiveVideoEncoder(30, heard.handlers, codecs, 20)
  encoder.encode(frame(), tag(1))
  await wait(1)
  for (const sequence of [2, 3, 4]) encoder.encode(frame(), tag(sequence))
  await wait(40)
  assert.equal(made[0]!.flushes, 1, "a stalled encoder is flushed")
  made[0]!.output(0, "key", true)
  made[0]!.output(1, "delta")
  made[0]!.flushed?.()
  await wait(1)
  assert.deepEqual(heard.drained.map(({ tag: { sequence }, sent }) => [sequence, sent]), [[1, true], [2, true], [3, false], [4, false]])
  assert.ok(encoder.ready())
  encoder.close()
}

// No hardware encoder: software, two frames at a time.
{
  const { codecs, made } = scripted((config) => config.hardwareAcceleration !== "prefer-hardware")
  const heard = events()
  const encoder = new LiveVideoEncoder(30, heard.handlers, codecs)
  encoder.encode(frame(), tag(1))
  await wait(1)
  assert.equal(made.length, 1)
  assert.equal(made[0]!.config?.hardwareAcceleration, "prefer-software")
  assert.equal(made[0]!.config?.codec, "avc1.42e034", "OpenH264 makes Baseline only")
  encoder.encode(frame(), tag(2))
  assert.equal(encoder.ready(), false, "two frames fill a software encoder")
  assert.equal(await liveVideoEncoderAvailable(30, codecs.supported), "avc1.42e034 prefer-software")
  encoder.close()
}

// The hardware encoder failing while it encodes: software takes over at the same size, from a key frame, with its own avcC.
{
  const { codecs, made } = scripted(() => true)
  const heard = events()
  const encoder = new LiveVideoEncoder(30, heard.handlers, codecs)
  encoder.encode(frame(), tag(1))
  await wait(1)
  made[0]!.output(0, "key", true)
  encoder.encode(frame(), tag(2))
  made[0]!.error("Encoding error")
  assert.deepEqual(heard.drained.at(-1), { tag: tag(2), sent: false }, "the frame inside it is dropped")
  await wait(1)
  assert.equal(made.length, 2)
  assert.equal(made[0]!.closed, true)
  assert.equal(made[1]!.config?.codec, "avc1.42e034")
  assert.equal(made[1]!.config?.hardwareAcceleration, "prefer-hardware", "Baseline on the hardware is tried next")
  encoder.encode(frame(), tag(3))
  assert.equal(made[1]!.encodes[0]?.key, true)
  made[1]!.error("Encoding error")
  await wait(1)
  assert.equal(made[2]!.config?.hardwareAcceleration, "prefer-software")
  made[2]!.error("Encoding error")
  assert.match(heard.failures[0] ?? "", /Encoding error/, "with nothing left it fails")
  assert.equal(heard.units.length, 1)
}

// A new size is a new encoder and a key frame; odd sizes lose an edge row and column; oversize fails.
{
  const { codecs, made } = scripted(() => true)
  const heard = events()
  const encoder = new LiveVideoEncoder(60, heard.handlers, codecs)
  encoder.encode(frame(641, 361), tag(1))
  await wait(1)
  assert.deepEqual([made[0]!.config?.width, made[0]!.config?.height], [640, 360])
  assert.deepEqual([made[0]!.encodes[0]?.width, made[0]!.encodes[0]?.height], [640, 360])
  assert.equal(made[0]!.config?.framerate, 60)
  made[0]!.output(0, "key", true)
  encoder.encode(frame(1280, 720), tag(2))
  await wait(1)
  assert.equal(made.length, 2)
  assert.equal(made[0]!.closed, true)
  assert.equal(made[1]!.encodes[0]?.key, true)
  made[1]!.output(0, "key", true)
  assert.deepEqual(heard.units.map((unit) => [unit.kind, unit.width, unit.height]), [["key", 640, 360], ["key", 1280, 720]])
  encoder.encode(frame(5120, 2880), tag(3))
  assert.match(heard.failures[0] ?? "", /outside/)
}

// The change gate: a change passes, then two more of the same picture, then one a second while it holds.
{
  let now = 0
  let picture = Uint8Array.from([1, 2, 3])
  const gate = new ChangeGate<FakeFrame>(() => picture, 2, 1000, () => now)
  const passed = (ms: number) => {
    now += ms
    return gate.admit(frame())
  }
  assert.equal(passed(0), true, "the first frame passes")
  assert.deepEqual([passed(33), passed(33), passed(33), passed(33)], [true, true, false, false], "two to settle, then nothing")
  const idle = Array.from({ length: 60 }, () => passed(33)).filter(Boolean).length
  assert.equal(idle, 2, "about one a second while the picture holds")
  picture = Uint8Array.from([1, 2, 4])
  assert.equal(passed(33), true, "a change passes at once")
  const unsampled = new ChangeGate<FakeFrame>(() => undefined)
  assert.equal(unsampled.admit(frame()), true, "a frame that can't be sampled passes")
}

console.log("Live video encoder: avcC on every key, key on request and on resize, in-flight limits and the newest held, stall flush, drops, hardware-to-software fallback, and the change gate passed")
