import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  mkdir,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import sharp from "sharp"
import { z } from "zod"
import { ControlRecording } from "../packages/control-runtime/src/control-recording.js"
import { mediaExecutable } from "../packages/control-runtime/src/control-media.js"

const execute = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), "mako-recording-stream-"))
const target = {
  kind: "page" as const,
  browser: "fixture",
  tab: "tab",
  generation: "one",
  lease: "lease",
}
async function inspect(video: string) {
  return z
    .object({
      streams: z.array(
        z.object({
          nb_read_frames: z.string(),
          width: z.number(),
          height: z.number(),
        })
      ),
      format: z.object({ duration: z.string() }),
    })
    .parse(
      JSON.parse(
        (
          await execute(mediaExecutable("ffprobe"), [
            "-v",
            "error",
            "-count_frames",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            video,
          ])
        ).stdout
      )
    )
}
try {
  const staticRecording = await ControlRecording.create(
    target,
    { directory, fps: 10, cursor: false },
    async () => {}
  )
  const solid = await sharp({
    create: { width: 160, height: 120, channels: 3, background: "#304060" },
  })
    .jpeg()
    .toBuffer()
  await staticRecording.frame(solid, 160, 120, {
    capturedAt: Date.now() - 240,
  })
  await delay(1374)
  await staticRecording.stop()
  const receipt = await staticRecording.settled()
  assert.equal(receipt.status, "finished", receipt.error)
  const probe = await inspect(receipt.video!)
  const expectedFrames = Math.ceil(receipt.durationMs / 100)
  assert.equal(Number(probe.streams[0]!.nb_read_frames), expectedFrames)
  assert.ok(
    Math.abs(Number(probe.format.duration) * 1000 - receipt.durationMs) < 101,
    "a single static source must cover the recording duration once, within one CFR frame"
  )
  const timeline = JSON.parse(await readFile(receipt.timeline!, "utf8"))
  assert.equal(timeline.frames.length, 1)
  assert.ok(timeline.frames[0].at >= 0)
  assert.ok(
    timeline.frames[0].capturedAt < timeline.startedAt,
    "retain honest source capture time"
  )

  // High-entropy JPEGs expand to PNG staging larger than the old 512 MiB cap.
  // Keep original source files below that cap; only redundant render staging differs.
  const width = 1920,
    height = 1080
  const jpeg = await sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  })
    .jpeg({ quality: 80 })
    .toBuffer()
  const formerRenderBytes = (await sharp(jpeg).ensureAlpha().png().toBuffer())
    .length
  const frameCount = Math.ceil((512 * 1024 * 1024) / formerRenderBytes) + 2
  assert.ok(frameCount * jpeg.length < 512 * 1024 * 1024)
  const dense = await ControlRecording.create(
    target,
    { directory, fps: 60, maxSide: width, cursor: false },
    async () => {}
  )
  for (let i = 0; i < frameCount; i++) {
    await dense.frame(jpeg, width, height)
    await delay(18)
  }
  await dense.stop()
  // Observe the directory while FFmpeg is consuming frames, not only after cleanup.
  let renderedFiles = 0
  while (dense.receipt().status === "finalizing") {
    renderedFiles += (await readdir(dense.directory)).filter((name) =>
      /^render-|^frame-|\.ffconcat$/.test(name)
    ).length
    await delay(10)
  }
  const denseReceipt = await dense.settled()
  assert.equal(denseReceipt.status, "finished", denseReceipt.error)
  assert.equal(denseReceipt.frames, frameCount)
  assert.equal(
    renderedFiles,
    0,
    "streaming must not stage per-frame rendered files"
  )
  const denseProbe = await inspect(denseReceipt.video!)
  assert.equal(denseProbe.streams[0]!.width, width)
  assert.equal(denseProbe.streams[0]!.height, height)
  assert.equal(
    Number(denseProbe.streams[0]!.nb_read_frames),
    Math.ceil((denseReceipt.durationMs * 60) / 1000)
  )
  // A rendering failure after FFmpeg starts must close its stdin and reap it.
  const tools = join(directory, "failing-media")
  await mkdir(tools)
  const pidFile = join(tools, "pid")
  await writeFile(
    join(tools, "ffmpeg"),
    `#!${process.execPath}
if (process.argv.includes('-version')) process.exit(0)
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
`,
    { mode: 0o700 }
  )
  await writeFile(join(tools, "ffprobe"), "fixture")
  const originalMediaRoot = process.env.MAKO_CONTROL_MEDIA_ROOT
  process.env.MAKO_CONTROL_MEDIA_ROOT = tools
  try {
    const broken = await ControlRecording.create(
      target,
      { directory, fps: 60, cursor: false },
      async () => {}
    )
    await broken.frame(solid, 160, 120)
    await delay(120)
    await broken.frame(solid, 160, 120)
    await delay(120)
    await broken.frame(Buffer.from("invalid image"), 160, 120)
    await broken.stop()
    const failure = await broken.settled()
    assert.equal(failure.status, "failed")
    assert.match(failure.error!, /unsupported or corrupt image/)
    const pid = Number(await readFile(pidFile, "utf8"))
    assert.throws(
      () => process.kill(pid, 0),
      { code: "ESRCH" },
      "failed encoder must be reaped before settled"
    )
  } finally {
    if (originalMediaRoot === undefined)
      delete process.env.MAKO_CONTROL_MEDIA_ROOT
    else process.env.MAKO_CONTROL_MEDIA_ROOT = originalMediaRoot
  }
  console.log(
    JSON.stringify({
      passed: true,
      staticDurationMs: receipt.durationMs,
      encodedStaticDurationMs: Number(probe.format.duration) * 1000,
      denseFrames: denseReceipt.frames,
      formerRenderMiB: (frameCount * formerRenderBytes) / 1024 / 1024,
      renderedFiles,
      encoderFailureReaped: true,
      denseDurationMs: denseReceipt.durationMs,
    })
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
