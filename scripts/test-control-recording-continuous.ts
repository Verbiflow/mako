import assert from "node:assert/strict"
import { randomBytes, createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  stat,
  symlink,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import sharp from "sharp"
import { ControlRecording } from "../packages/control-runtime/src/control-recording.js"
import { mediaExecutable } from "../packages/control-runtime/src/control-media.js"

const execute = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-continuous-recording-"))
const ffmpeg = mediaExecutable("ffmpeg"),
  ffprobe = mediaExecutable("ffprobe")
const target = {
  kind: "page" as const,
  browser: "fixture",
  tab: "one",
  generation: "one",
  lease: "one",
}
const width = 1920,
  height = 1080
const seconds = process.argv.includes("--soak") ? 600 : 60
// The long soak tests lifetime, not an intentionally enormous encoded artifact.
// A noisy strip still exceeds the old source staging cap without hitting the
// separate, legitimate encoded-output budget during ten minutes.
const pixels =
  seconds === 600
    ? Buffer.alloc(width * height * 3, 48)
    : randomBytes(width * height * 3)
if (seconds === 600) randomBytes(width * 150 * 3).copy(pixels)
const frame = await sharp(pixels, { raw: { width, height, channels: 3 } })
  .jpeg({ quality: 90 })
  .toBuffer()
const recording = await ControlRecording.create(
  target,
  { directory: root, fps: 60, cursor: false, maxDurationMs: 600_000 },
  async () => {}
)
const start = performance.now()
let offered = 0,
  sourceFiles = 0,
  maxRss = 0
const initialRss = process.memoryUsage().rss
while (
  performance.now() - start <
  seconds * 1000 - (seconds === 600 ? 500 : 0)
) {
  assert.equal(
    recording.receipt().status,
    "recording",
    recording.receipt().error
  )
  await recording.frame(frame, width, height)
  offered++
  if (offered % 60 === 0) {
    sourceFiles += (await readdir(recording.directory)).filter((name) =>
      /^frame-|^render-/.test(name)
    ).length
    maxRss = Math.max(maxRss, process.memoryUsage().rss)
  }
  await delay(Math.max(1, start + (offered * 1000) / 60 - performance.now()))
}
const liveBytes = (
  await stat(join(recording.directory, "recording.partial.mp4"))
).size
assert.ok(liveBytes > 0, "encoded output exists before stop")
const liveProbe = JSON.parse(
  (
    await execute(ffprobe, [
      "-v",
      "error",
      "-show_format",
      "-of",
      "json",
      join(recording.directory, "recording.partial.mp4"),
    ])
  ).stdout
)
assert.ok(
  Number(liveProbe.format.duration) > seconds / 2,
  "video advances during capture"
)
const stoppedAt = performance.now()
await recording.stop()
const result = await recording.settled()
const finalizationMs = performance.now() - stoppedAt
assert.equal(result.status, "finished", result.error)
assert.equal(sourceFiles, 0)
assert.ok(
  result.frames * frame.length > 512 * 1024 * 1024,
  "accepted source data exceeds former staging cap"
)
assert.equal(result.encodedFrames, Math.ceil((result.durationMs * 60) / 1000))
assert.ok(Math.abs(result.encodedDurationMs! - result.durationMs) < 17)
const timeline = JSON.parse(await readFile(result.timeline!, "utf8"))
assert.equal(timeline.version, 3)
assert.equal(timeline.frames.length, result.frames)
assert.ok(
  timeline.frames.every((value: { file?: string }) => value.file === undefined)
)
await writeFile(
  join(root, "recording-result.json"),
  JSON.stringify(
    {
      root,
      seconds,
      offered,
      acceptedSourceBytes: result.frames * frame.length,
      sourceFiles,
      liveBytes,
      initialRss,
      maxRss,
      finalizationMs,
      recording: result,
    },
    null,
    2
  )
)

// Kill a real encoder after independently confirming a readable fragment.
// The shell exec retains the same PID; no second child can escape the test.
const tools = join(root, "tools")
await mkdir(tools)
const pidFile = join(tools, "encoder.pid")
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
await writeFile(
  join(tools, "ffmpeg"),
  `#!/bin/sh
if [ "$2" != "-encoders" ]; then printf '%s\\n' "$$" > ${quote(pidFile)}; fi
exec ${quote(ffmpeg)} "$@"
`,
  { mode: 0o700 }
)
await symlink(ffprobe, join(tools, "ffprobe"))
const previousRoot = process.env.MAKO_CONTROL_MEDIA_ROOT
process.env.MAKO_CONTROL_MEDIA_ROOT = tools
let crashResult
try {
  const crashed = await ControlRecording.create(
    target,
    { directory: root, fps: 60, cursor: false },
    async () => {}
  )
  await crashed.frame(frame, width, height)
  await delay(3500)
  const beforeKill = JSON.parse(
    (
      await execute(ffprobe, [
        "-v",
        "error",
        "-show_format",
        "-of",
        "json",
        join(crashed.directory, "recording.partial.mp4"),
      ])
    ).stdout
  )
  assert.ok(Number(beforeKill.format.duration) > 0)
  const pid = Number(await readFile(pidFile, "utf8"))
  process.kill(pid, "SIGKILL")
  const deadline = Date.now() + 15000
  while (crashed.receipt().status === "recording" && Date.now() < deadline)
    await delay(20)
  assert.notEqual(crashed.receipt().status, "recording")
  crashResult = await crashed.settled()
  assert.equal(crashResult.status, "interrupted", crashResult.error)
  assert.ok(crashResult.video?.endsWith("recording.partial.mp4"))
  assert.ok(crashResult.encodedFrames! > 0)
  assert.ok(crashResult.encodedDurationMs! <= crashResult.durationMs + 17)
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
  const journal = (
    await readFile(join(crashed.directory, "timeline.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.equal(journal[0].version, 3)
  assert.equal(journal.at(-1).end.status, "interrupted")
} finally {
  if (previousRoot === undefined) delete process.env.MAKO_CONTROL_MEDIA_ROOT
  else process.env.MAKO_CONTROL_MEDIA_ROOT = previousRoot
}

// No-transform native output must survive byte-for-byte, not merely look similar.
const native = await ControlRecording.create(
  { kind: "window", pid: 42, window_id: 3 },
  { directory: root, fps: 60, cursor: false },
  async () => {
    await native.attachVideo(join(native.directory, "recording.mp4"))
  }
)
// Use the finished browser fixture as a real H.264 source; this test exercises
// import/retention rather than the native capture backend.
// Fragmented MP4 does not supply nb_frames, so remux to an ordinary MP4 first.
await execute(ffmpeg, [
  "-v",
  "error",
  "-i",
  result.video!,
  "-t",
  "0.5",
  "-c:v",
  "copy",
  join(native.directory, "recording.mp4"),
])
const digest = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
const original = await digest(join(native.directory, "recording.mp4"))
await native.stop()
const retained = await native.settled()
assert.equal(retained.status, "finished", retained.error)
assert.equal(await digest(retained.video!), original)
assert.ok(!(await readdir(native.directory)).includes("source.mp4"))
const report = {
  scope: "Recorder-only, repeated pixels; no distinct-source/viewer-fps claim",
  tools: await Promise.all(
    [ffmpeg, ffprobe].map(async (path) => ({
      path,
      sha256: await digest(path),
    }))
  ),
  root,
  seconds,
  offered,
  acceptedSourceBytes: result.frames * frame.length,
  sourceFiles,
  liveBytes,
  initialRss,
  maxRss,
  finalizationMs,
  recording: result,
  crash: crashResult,
  nativeRetainedHash: original,
}
await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
