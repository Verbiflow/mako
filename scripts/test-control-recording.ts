import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import sharp from "sharp"
import { ControlRecording } from "../packages/control-runtime/src/control-recording.js"

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
const frame = async (color: string, width = 640, height = 480) =>
  (
    await sharp({
      create: { width, height, channels: 3, background: color },
    })
      .jpeg()
      .toBuffer()
  )
await recording.frame(await frame("#3a2828", 480, 300), 1600, 1000)
await delay(80)
recording.pointer({ x: 100, y: 100, pressed: true })
await delay(80)
await recording.frame(await frame("#283a28", 1600, 1000), 1600, 1000)
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
assert.equal(result.frameRate?.requestedFps, 60, "Browser recording targets 60 fps")
assert.equal(probe.streams[0].width, 1600)
assert.equal(probe.streams[0].height, 1000)
if (process.platform === "darwin") assert.equal(probe.streams[0].has_b_frames, 0)
assert.ok(Number(probe.format.duration) > 0.25)
const timeline = JSON.parse(await readFile(result.timeline!, "utf8"))
assert.equal(timeline.videoEncoding.codec, process.platform === "darwin" ? "h264_videotoolbox" : "libx264")
assert.equal(timeline.videoEncoding.hardwareRequired, process.platform === "darwin")
assert.ok(
  Math.abs(
    Number(probe.format.duration) -
      result.durationMs / 1000
  ) < 0.05,
  "video duration preserves capture intervals within frame rounding"
)
assert.deepEqual(timeline.target, target)
assert.deepEqual(result.dimensions, { width: 1600, height: 1000 })
assert.deepEqual(timeline.frames.map((f: {width:number;height:number;viewportWidth:number;viewportHeight:number}) => [f.width,f.height,f.viewportWidth,f.viewportHeight]), [[480,300,1600,1000],[1600,1000,1600,1000]])
assert.equal(timeline.pointer.length, 2)
// Inspect decoded video, not just the event journal. Pointer coordinates are in
// the reported viewport even when the first JPEG has fewer pixels. Events must
// not be painted retroactively into earlier output frames.
const snapshot = async (at: number) => {
  const { stdout } = await promisify(execFile)("ffmpeg", [
    "-v", "error", "-i", result.video!, "-vf", "fps=60", "-ss", String(at / 1000),
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 })
  assert.equal(stdout.length, 1600 * 1000 * 3)
  return stdout
}
const hasCursor = (pixels: Buffer, x: number, y: number) => {
  let bright = 0
  for (let row = y - 5; row < y + 30; row++)
    for (let column = x - 6; column < x + 25; column++) {
      const offset = (row * 1600 + column) * 3
      if (pixels[offset]! > 180 && pixels[offset + 1]! > 180 && pixels[offset + 2]! > 180) bright++
    }
  return bright > 10
}
assert.equal(hasCursor(await snapshot(Math.max(0, timeline.pointer[0].at - 40)), 100, 100), false)
const firstPointer = await snapshot(timeline.pointer[0].at + 40)
assert.equal(hasCursor(firstPointer, 100, 100), true, "Cursor uses viewport coordinates, not small JPEG coordinates")
assert.equal(hasCursor(firstPointer, 30, 30), false)
const movedPointer = await snapshot(timeline.pointer[1].at + 40)
assert.equal(hasCursor(movedPointer, 260, 180), true)
assert.equal(hasCursor(movedPointer, 100, 100), false, "Cursor movement removes the old cursor")
const beforeChange = await snapshot(timeline.frames[1].at - 40)
const afterChange = await snapshot(timeline.frames[1].at + 40)
const colorOffset = (500 * 1600 + 800) * 3
assert.ok(beforeChange[colorOffset]! > beforeChange[colorOffset + 1]!, "Future green pixels cannot replace the earlier red source")
assert.ok(afterChange[colorOffset + 1]! > afterChange[colorOffset]!, "New source pixels reach the video")
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
assert.equal(nativeTimeline.fps, 30, "Native output keeps the actual driver rate")
assert.deepEqual(
  nativeTimeline.pointer,
  [{ at: 100, x: 320, y: 240, pressed: true }],
  "only dispatch points enter native cursor overlay"
)
console.log(JSON.stringify({ nativeVideo: nativeReceipt.video, decoded }))

// A burst keeps only its latest queued frame, including when stop interrupts the timer.
const sampled = await ControlRecording.create(target, { directory, fps: 10 }, async () => {})
await sampled.frame(await frame("red"), 640, 480)
await sampled.frame(await frame("green"), 640, 480)
await sampled.frame(await frame("blue", 640, 478), 640, 480)
await sampled.stop()
const sampledResult = await sampled.settled()
assert.equal(sampledResult.status, "finished", sampledResult.error)
assert.equal(sampledResult.frames, 2)
assert.equal(sampledResult.sampledFrames, 1)
const sampledTimeline = JSON.parse(await readFile(sampledResult.timeline!, "utf8"))
assert.equal(sampledTimeline.frames.at(-1).height, 478, "Stop admits the latest source, not the older queued frame")
assert.equal(sampledTimeline.version, 4)
assert.ok(sampledTimeline.frames.every((entry: { file?: string }) => !entry.file), "Browser recording does not stage source files")
console.log("Recording sampling: bounded latest frame and final-frame flush passed")
