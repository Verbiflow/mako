import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import sharp from "sharp"
import { z } from "zod"
import { RECORDING_IDLE_HOLD_MS } from "../packages/control/src/control/recording.js"
import { ControlRecording } from "../packages/control-runtime/src/control-recording.js"
import { mediaExecutable } from "../packages/control-runtime/src/control-media.js"
import { resolveExecutable } from "../packages/control-runtime/src/executable.js"

// An agent starts a recording, then thinks for seconds between actions. Still
// stretches longer than a second play for exactly a second; the timeline keeps
// wall-clock times and every cut, and `idle: "keep"` keeps real time.
const execute = promisify(execFile)
// Recording runs on the configured media tools; inspection needs a full FFmpeg.
const inspector = resolveExecutable("ffmpeg") ?? assert.fail("Inspecting recordings needs a full FFmpeg on PATH")
const root = await mkdtemp(join(tmpdir(), "mako-recording-idle-"))
const page = { kind: "page" as const, browser: "fixture", tab: "one", generation: "one", lease: "one" }
const solid = (r: number, g: number, b: number) =>
  sharp({ create: { width: 640, height: 360, channels: 3, background: { r, g, b } } }).jpeg({ quality: 90 }).toBuffer()
const [red, green, blue] = await Promise.all([solid(220, 30, 30), solid(30, 200, 60), solid(30, 60, 220)])

// A variable-rate video holds each frame until the next, so the frame showing
// at a time is found at a fixed rate, never by seeking to the next frame.
async function colourAt(video: string, seconds: number) {
  const { stdout } = await execute(inspector, [
    "-v", "error", "-i", video, "-frames:v", "1",
    "-vf", `fps=30,trim=start=${seconds},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 1024 })
  const [r = 0, g = 0, b = 0] = stdout
  return r > g && r > b ? "red" : g > r && g > b ? "green" : "blue"
}
const durationOf = async (video: string) =>
  Number((await execute(mediaExecutable("ffprobe"), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video])).stdout) * 1000
const TimelineSchema = z.object({
  idle: z.object({
    mode: z.enum(["trim", "keep"]),
    trims: z.array(z.object({ at: z.number(), videoAt: z.number(), trimmedMs: z.number() })),
    kept: z.string().nullable(),
  }),
})

async function browserRecording(idle: "trim" | "keep") {
  const recording = await ControlRecording.create(page, { directory: root, fps: 30, cursor: false, idle }, async () => {})
  await recording.frame(red, 640, 360)
  await delay(300)
  await recording.frame(green, 640, 360)
  await delay(2500)
  await recording.frame(blue, 640, 360)
  await delay(2200)
  await recording.stop()
  const receipt = await recording.settled()
  assert.equal(receipt.status, "finished", JSON.stringify(receipt))
  const timeline = TimelineSchema.parse(JSON.parse(await readFile(receipt.timeline!, "utf8")))
  return { receipt, timeline, video: receipt.video! }
}

try {
  const trimmed = await browserRecording("trim")
  // A pause plays its hold and the two sealing frames that flush it to disk.
  const hold = RECORDING_IDLE_HOLD_MS + 2000 / 30
  const cuts = trimmed.timeline.idle.trims
  assert.equal(cuts.length, 2, `A still middle and a still tail are each cut: ${JSON.stringify(cuts)}`)
  assert.ok(Math.abs(cuts[0]!.trimmedMs - (2500 - hold)) < 80, JSON.stringify(cuts))
  assert.ok(Math.abs(cuts[0]!.videoAt - (300 + hold)) < 120, JSON.stringify(cuts))
  assert.ok(Math.abs(cuts[1]!.trimmedMs - (2200 - hold)) < 120, JSON.stringify(cuts))
  const removed = trimmed.receipt.idleTrimmedMs!
  assert.ok(Math.abs(removed - cuts[0]!.trimmedMs - cuts[1]!.trimmedMs) < 1)
  assert.ok(Math.abs(trimmed.receipt.durationMs - 5000) < 250, "durationMs stays wall-clock")
  const encoded = await durationOf(trimmed.video)
  assert.ok(Math.abs(encoded - (trimmed.receipt.durationMs - removed)) < 70,
    `The video is wall-clock time less the cuts: ${encoded} vs ${trimmed.receipt.durationMs} - ${removed}`)
  assert.equal(await colourAt(trimmed.video, 0.1), "red")
  assert.equal(await colourAt(trimmed.video, 1.0), "green", "The result of the second change shows for the hold")
  assert.equal(await colourAt(trimmed.video, 1.5), "blue", "The next change follows one hold later, not 2.5 s later")

  const kept = await browserRecording("keep")
  assert.equal(kept.timeline.idle.trims.length, 0)
  assert.equal(kept.receipt.idleTrimmedMs, undefined)
  assert.ok(Math.abs(await durationOf(kept.video) - kept.receipt.durationMs) < 70, "idle: keep plays in real time")
  assert.equal(await colourAt(kept.video, 2.0), "green", "Kept idle time shows the still page in real time")

  // A native driver writes frames only while the window changes, with B-frames
  // and decode times far behind presentation times, and holds the last frame
  // until stop. Mirror that: red to 2.1 s, nothing until 4.6 s, then blue,
  // whose last frame lasts three seconds.
  const native = join(root, "native.mp4")
  await execute(inspector, [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0xdc1e1e:s=640x360:r=30:d=2.1",
    "-f", "lavfi", "-i", "color=c=0x1e3cdc:s=640x360:r=30:d=2.9",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v];[v]select='not(between(t\\,2.1\\,4.6))'[o]",
    "-map", "[o]", "-fps_mode", "vfr", "-c:v", "libx264", "-bf", "2", "-x264-params", "b-adapt=0", "-pix_fmt", "yuv420p",
    "-bsf:v", "setts=duration=if(gte(PTS*TB\\,4.96)\\,3/TB\\,DURATION)", native,
  ])
  for (const cursor of [false, true]) {
    let recording: ControlRecording | undefined
    recording = await ControlRecording.create({ kind: "window", pid: 1, window_id: 1 }, { directory: root, fps: 30, cursor }, async () => {
      const path = join(recording!.directory, "recording.mp4")
      await copyFile(native, path)
      await recording!.attachVideo(path)
    })
    // Without pointer events there is nothing to draw, and the video passes through.
    if (cursor) recording.pointer({ x: 320, y: 180, pressed: true })
    await recording.stop()
    const receipt = await recording.settled()
    assert.equal(receipt.status, "finished", JSON.stringify(receipt))
    const timeline = TimelineSchema.parse(JSON.parse(await readFile(receipt.timeline!, "utf8")))
    if (timeline.idle.kept) {
      assert.match(timeline.idle.kept, /cannot shift packet timestamps/, "Only an FFmpeg without setts keeps native idle time")
      console.log(`native idle trimming skipped: ${timeline.idle.kept}`)
      break
    }
    const nativeCuts = timeline.idle.trims
    assert.equal(nativeCuts.length, 2, JSON.stringify(nativeCuts))
    assert.ok(Math.abs(nativeCuts[0]!.trimmedMs - 1500) < 100, JSON.stringify(nativeCuts))
    assert.ok(Math.abs(nativeCuts[1]!.trimmedMs - 2000) < 60, JSON.stringify(nativeCuts))
    const video = receipt.video!
    const length = await durationOf(video)
    assert.ok(Math.abs(length - (receipt.durationMs - receipt.idleTrimmedMs!)) < 100, `${length} vs ${JSON.stringify(receipt)}`)
    assert.equal(await colourAt(video, 2.9), "red")
    assert.equal(await colourAt(video, 3.2), "blue", "The native gap plays for one hold")
    await execute(inspector, ["-v", "error", "-xerror", "-i", video, "-f", "null", "-"])
    if (!cursor) assert.equal(z.string().parse((await execute(mediaExecutable("ffprobe"), ["-v", "error", "-select_streams", "v", "-show_entries", "stream=has_b_frames", "-of", "csv=p=0", video])).stdout.trim()), "2",
      "A playable native video is cut by shifting packets, not re-encoded")
  }
  console.log("recording idle: still stretches play for one second in browser and native video, cuts are timestamped, and idle: keep plays in real time")
} finally {
  await rm(root, { recursive: true, force: true })
}
