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
import { ControlRecording } from "../packages/control-runtime/src/control-recording.js"
import { RecordingEncoder } from "../packages/control-runtime/src/recording-encoder.js"
import { readMp4 } from "../packages/control-runtime/src/mp4.js"

const execute = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), "mako-recording-stream-"))
const target = {
  kind: "page" as const,
  browser: "fixture",
  tab: "tab",
  generation: "one",
  lease: "lease",
}
/** The file as the recording's own MP4 reader sees it, in the shape FFprobe gave. */
async function inspect(video: string) {
  const read = await readMp4(video)
  assert.ok(read, `${video} is a readable MP4`)
  return { streams: [{ nb_read_frames: String(read.packets.length), width: read.width, height: read.height }], format: { duration: String(read.duration) } }
}
try {
  const staticRecording = await ControlRecording.create(
    target,
    { directory, fps: 10, cursor: false, idle: "keep" },
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
  assert.equal(Number(probe.streams[0]!.nb_read_frames), receipt.encodedFrames)
  assert.ok(receipt.encodedFrames! <= Math.ceil(receipt.durationMs / 1000) + 2,
    "Static pixels should be held, not encoded at the requested maximum rate")
  assert.ok(receipt.frameRate!.unchangedFrameSlots > 5)
  assert.ok(
    Math.abs(Number(probe.format.duration) * 1000 - receipt.durationMs) < 101,
    "a single static source must cover the recording duration once, within one requested frame interval"
  )
  const timeline = JSON.parse(await readFile(receipt.timeline!, "utf8"))
  assert.equal(timeline.frames.length, 1)
  assert.ok(timeline.frames[0].at >= 0)
  assert.ok(
    timeline.frames[0].capturedAt < timeline.startedAt,
    "retain honest source capture time"
  )

  // Exercise both in-flight slots while replacing and repeating owned pixels.
  // Decode every output: detaching an old frame before its pipe write completes,
  // or detaching the cached repeat, must not silently produce corrupt video.
  const orderedDirectory = join(directory, "ordered")
  await mkdir(orderedDirectory)
  const ordered = new RecordingEncoder(orderedDirectory, () => {})
  try {
    await ordered.initialize(1920, 1080, 60)
    const colors = [[40, 80, 120], [180, 100, 60], [70, 160, 110]]
    const images = await Promise.all(colors.map(async ([r, g, b]) =>
      sharp({ create: { width: 1920, height: 1080, channels: 3,
        background: { r, g, b } } }).png().toBuffer()
    ))
    const pending: Promise<unknown>[] = []
    const expected: number[][] = []
    for (let index = 0; index < 72; index++) {
      if (pending.length === 2) await pending.shift()
      const color = Math.floor(index / 3) % colors.length
      expected.push(colors[color]!)
      pending.push(ordered.write(index * 1000 / 60, index * 1000 / 60, index % 3 === 0 ? {
        bytes: images[color]!, frame: { width: 1920, height: 1080 },
      } : undefined))
    }
    await Promise.all(pending)
    const result = await ordered.finish()
    // FFmpeg on PATH decodes it: a check, not a dependency.
    await execute("ffmpeg", [
      "-v", "error", "-i", result.path, "-vf", "scale=1:1", "-fps_mode", "passthrough", "-f", "image2",
      join(orderedDirectory, "frame-%03d.png"),
    ])
    const decoded = (await readdir(orderedDirectory)).filter(name => name.endsWith(".png")).sort()
    assert.equal(decoded.length, expected.length)
    for (const [index, color] of expected.entries()) {
      const pixel = await sharp(join(orderedDirectory, decoded[index]!)).removeAlpha().raw().toBuffer()
      for (const [channel, value] of color.entries())
        assert.ok(Math.abs(pixel[channel]! - value) <= 4,
          `Replaced/repeated frame ${index} channel ${channel} changed: ${[...pixel.subarray(0, 3)]} for ${color}`)
    }
  } finally {
    ordered.abort("Ordered-frame test complete")
    await ordered.finish().catch(() => {})
  }

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
    { directory, fps: 60, maxSide: width, cursor: false, idle: "keep" },
    async () => {}
  )
  for (let i = 0; i < frameCount; i++) {
    await dense.frame(jpeg, width, height)
    await delay(18)
  }
  await dense.stop()
  // Observe the directory while the encoder is consuming frames, not only after cleanup.
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
    denseReceipt.encodedFrames
  )
  assert.ok(denseReceipt.encodedFrames! <= Math.ceil(denseReceipt.durationMs / 1000) + 2)
  assert.ok(Math.abs(Number(denseProbe.format.duration) * 1000 - denseReceipt.durationMs) < 18)
  // Header-only dimensions must retain the previous decoder's pixel limit.
  // Deliberately malformed PNG dimensions are refused before decoder allocation.
  const oversized = await sharp({ create: { width: 2, height: 2, channels: 3,
    background: "black" } }).png().toBuffer()
  oversized.writeUInt32BE(100_000, 16)
  oversized.writeUInt32BE(100_000, 20)
  const refused = await ControlRecording.create(target, { directory }, async () => {})
  await refused.frame(oversized, 1920, 1080)
  await refused.stop()
  const refusal = await refused.settled()
  assert.equal(refusal.status, "failed")
  assert.match(refusal.error!, /Invalid recording frame geometry/)
  assert.equal(refusal.frames, 0)
  // A rendering failure after the encoder starts must close its input and reap it.
  const tools = join(directory, "failing-media")
  await mkdir(tools)
  const pidFile = join(tools, "pid")
  await writeFile(
    join(tools, "mako-video"),
    `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
`,
    { mode: 0o700 }
  )
  const originalHelper = process.env.MAKO_VIDEO_HELPER
  process.env.MAKO_VIDEO_HELPER = join(tools, "mako-video")
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
    if (originalHelper === undefined) delete process.env.MAKO_VIDEO_HELPER
    else process.env.MAKO_VIDEO_HELPER = originalHelper
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
