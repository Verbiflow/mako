import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import sharp from "sharp"
import { ControlRecording } from "../electron/control-recording.js"

const directory = await mkdtemp(join(tmpdir(), "mako-recording-test-"))
const target = {
  kind: "page" as const,
  browser: "fixture",
  tab: "tab",
  generation: "one",
  lease: "lease",
}
let stops = 0
const recording = await ControlRecording.create(
  target,
  { directory, maxDurationMs: 10_000 },
  async () => {
    stops++
  }
)
const frame = async (color: string) =>
  (
    await sharp({
      create: { width: 640, height: 480, channels: 3, background: color },
    })
      .jpeg()
      .toBuffer()
  ).toString("base64")
await recording.frame(await frame("#3a2828"), 640, 480)
await delay(80)
recording.pointer({ x: 100, y: 100, pressed: true })
await delay(80)
await recording.frame(await frame("#283a28"), 640, 480)
await delay(80)
recording.pointer({ x: 260, y: 180, pressed: false })
await delay(80)
assert.equal((await recording.stop()).status, "finalizing")
await recording.stop()
const result = await recording.settled()
assert.equal(result.status, "finished", result.error)
assert.equal(stops, 1, "stop is idempotent")
assert.ok(result.video)
assert.equal(result.frames, 2)
const probe = JSON.parse(
  (
    await promisify(execFile)("ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      result.video!,
    ])
  ).stdout
)
assert.equal(probe.streams[0].codec_name, "h264")
assert.equal(probe.streams[0].width, 640)
assert.equal(probe.streams[0].height, 480)
assert.ok(Number(probe.format.duration) > 0.25)
const timeline = JSON.parse(await readFile(result.timeline!, "utf8"))
assert.ok(
  Math.abs(
    Number(probe.format.duration) -
      (result.durationMs - timeline.frames[0].at) / 1000
  ) < 0.05,
  "video duration preserves capture intervals within frame rounding"
)
assert.deepEqual(timeline.target, target)
assert.equal(timeline.pointer.length, 2)
assert.ok(
  timeline.pointer.every(
    (point: { at: number }) => point.at <= timeline.durationMs
  )
)
const empty = await ControlRecording.create(
  target,
  { directory },
  async () => {}
)
await empty.stop("target closed")
const failure = await empty.settled()
assert.equal(failure.status, "failed")
assert.equal(failure.video, undefined)
console.log(
  JSON.stringify({
    passed: true,
    video: result.video,
    timeline: result.timeline,
    duration: probe.format.duration,
  })
)

// A native stream must remain visible through the transparent cursor layer.
const nativeTarget = { kind: "window" as const, pid: 42, window_id: 7 }
const nativeRecording = await ControlRecording.create(
  nativeTarget,
  { directory },
  async () => {
    await nativeRecording.attachVideo(
      join(nativeRecording.directory, "recording.mp4")
    )
  }
)
await promisify(execFile)("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=0x304060:s=640x480:r=30:d=0.5",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  join(nativeRecording.directory, "recording.mp4"),
])
const { mkdir, writeFile } = await import("node:fs/promises")
await mkdir(join(nativeRecording.directory, "turn-00001"))
await writeFile(
  join(nativeRecording.directory, "turn-00001", "action.json"),
  JSON.stringify({
    pointer_dispatches: [{ at_ms: 100, x: 0.5, y: 0.5, pressed: true }],
    click_point: { x: 1, y: 1 },
    result_error: false,
  })
)
await nativeRecording.stop()
const nativeReceipt = await nativeRecording.settled()
assert.equal(nativeReceipt.status, "finished", nativeReceipt.error)
const decoded = join(nativeRecording.directory, "decoded.png")
await promisify(execFile)("ffmpeg", [
  "-v",
  "error",
  "-ss",
  "0.2",
  "-i",
  nativeReceipt.video!,
  "-frames:v",
  "1",
  decoded,
])
const pixel = await sharp(decoded)
  .extract({ left: 10, top: 10, width: 1, height: 1 })
  .removeAlpha()
  .raw()
  .toBuffer()
assert.ok(
  Math.abs(pixel[0]! - 48) < 10 &&
    Math.abs(pixel[1]! - 64) < 10 &&
    Math.abs(pixel[2]! - 96) < 10,
  "native source pixels survive alpha overlay"
)
const nativeTimeline = JSON.parse(
  await readFile(nativeReceipt.timeline!, "utf8")
)
assert.deepEqual(
  nativeTimeline.pointer,
  [{ at: 100, x: 320, y: 240, pressed: true }],
  "only dispatch points enter native cursor overlay"
)
console.log(JSON.stringify({ nativeVideo: nativeReceipt.video, decoded }))
