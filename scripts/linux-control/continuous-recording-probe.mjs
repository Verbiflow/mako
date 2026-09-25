// Synthetic media only: no display, browser, driver, network or user profile.
import assert from "node:assert/strict"
import sharp from "sharp"
import { mkdtemp, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const runtime = import.meta.resolve("@mako/control-runtime")
const { ControlRecording } = await import(new URL("./control-recording.js", runtime).href)
const { mediaExecutable } = await import(new URL("./control-media.js", runtime).href)
const directory = await mkdtemp(join(tmpdir(), "mako-media-linux-"))
const target = { kind: "page", browser: "fixture", tab: "one", generation: "one", lease: "one" }
let stops = 0
const recording = await ControlRecording.create(target, { directory, fps: 30 }, async () => { stops++ })
const frame = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#304060" } })
  .jpeg().toBuffer()
await recording.frame(frame, 640, 480)
recording.pointer({ x: 320, y: 240, pressed: true })
await delay(1200)
await recording.stop()
const receipt = await recording.settled()
assert.equal(receipt.status, "finished", receipt.error)
assert.equal(stops, 1)
assert.ok(receipt.encodedFrames >= 2)
assert.ok(receipt.encodedFrames <= Math.ceil(receipt.durationMs / 1000) + 4)
assert.ok(Math.abs(receipt.encodedDurationMs - receipt.durationMs) < 34)
assert.ok(receipt.frameRate.unchangedFrameSlots > 10)
assert.ok((await readFile(receipt.video)).length > 100)
assert.ok(!(await readdir(receipt.directory)).some(name => name.startsWith("frame-")))
const timeline = JSON.parse(await readFile(receipt.timeline, "utf8"))
assert.equal(timeline.version, 4)
assert.equal(timeline.pointer.length, 1)
assert.equal(timeline.encodingTiming.frames, receipt.encodedFrames)
console.log(JSON.stringify({ platform: process.platform, arch: process.arch,
  node: process.version, encoder: mediaExecutable("ffmpeg"),
  scope: "Shared recording worker; synthetic source, not compositor or 60fps acceptance",
  receipt }, null, 2))
