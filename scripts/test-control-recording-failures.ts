import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import sharp from "sharp"
import { z } from "zod"
import { ControlRecording } from "../packages/control-runtime/src/control-recording.js"
import { mediaExecutable } from "../packages/control-runtime/src/control-media.js"

const execute = promisify(execFile)
const target = {
  kind: "page" as const,
  browser: "fixture",
  tab: "one",
  generation: "one",
  lease: "one",
}
const image = (
  await sharp({
    create: { width: 640, height: 480, channels: 3, background: "#304060" },
  })
    .jpeg()
    .toBuffer()
)

async function owner(directory: string) {
  const recording = await ControlRecording.create(
    target,
    { directory, fps: 60, cursor: false },
    async () => {}
  )
  await recording.frame(image, 640, 480)
  assert.equal(
    recording.receipt().status,
    "recording",
    recording.receipt().error
  )
  console.log(JSON.stringify({ directory: recording.directory }))
}

async function test() {
  const root = await mkdtemp(join(tmpdir(), "mako-recording-failures-"))
  const ffmpeg = mediaExecutable("ffmpeg"),
    ffprobe = mediaExecutable("ffprobe")
  const tools = join(root, "tools"),
    pidFile = join(root, "encoder.pid")
  await mkdir(tools)
  await symlink(ffprobe, join(tools, "ffprobe"))
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  await writeFile(
    join(tools, "ffmpeg"),
    `#!/bin/sh
if [ "$2" != "-encoders" ]; then printf '%s\\n' "$$" > ${quote(pidFile)}; fi
exec ${quote(ffmpeg)} "$@"
`,
    { mode: 0o700 }
  )
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), "--fixture", root],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MAKO_CONTROL_MEDIA_ROOT: tools },
    }
  )
  const closed = new Promise<void>((resolve, reject) => {
    child.once("close", () => resolve())
    child.once("error", reject)
  })
  let stdout = "",
    stderr = ""
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4096)
  })
  let ownerResult
  try {
    const deadline = Date.now() + 10_000
    while (
      !stdout.includes("\n") &&
      Date.now() < deadline &&
      child.exitCode === null
    )
      await delay(20)
    assert.ok(
      stdout.includes("\n"),
      stderr || "Fixture did not acknowledge encoder readiness"
    )
    const { directory } = z
      .object({ directory: z.string() })
      .parse(JSON.parse(stdout.trim()))
    const partial = join(directory, "recording.partial.mp4")
    const encoderPid = Number(await readFile(pidFile, "utf8"))
    await delay(3000)
    const inspect = async () =>
      JSON.parse(
        (
          await execute(ffprobe, [
            "-v",
            "error",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_frames:format=duration",
            "-of",
            "json",
            partial,
          ])
        ).stdout
      )
    assert.ok(Number((await inspect()).streams[0].nb_read_frames) > 0)
    child.kill("SIGKILL")
    await closed
    const gone = () => {
      try {
        process.kill(encoderPid, 0)
        return false
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH")
          return true
        throw error
      }
    }
    const cleanupDeadline = Date.now() + 10_000
    while (!gone() && Date.now() < cleanupDeadline) await delay(20)
    assert.ok(gone(), "Encoder must exit after its host/worker pipe disappears")
    const retained = await inspect()
    assert.ok(Number(retained.streams[0].nb_read_frames) > 0)
    const journal = (await readFile(join(directory, "timeline.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    assert.equal(journal[0].version, 4)
    assert.ok(journal.some((entry) => entry.frame))
    assert.ok(
      !journal.some((entry) => entry.end),
      "A killed host cannot fabricate a completed receipt"
    )
    ownerResult = {
      directory,
      retained,
      encoderGone: true,
      journalClosed: false,
    }
  } finally {
    child.kill("SIGKILL")
    await closed
  }

  // Pause the actual encoder while distinct source states arrive. A latest-only
  // recorder loses these states even when the encoder subsequently catches up.
  const previous = process.env.MAKO_CONTROL_MEDIA_ROOT
  process.env.MAKO_CONTROL_MEDIA_ROOT = tools
  let shortStallResult
  let pausedPid: number | undefined
  const shortStall = await ControlRecording.create(
    target,
    { directory: root, fps: 60, cursor: true },
    async () => {}
  )
  try {
    const colors = ["#e02020", "#20e020", "#2020e0"]
    const images = await Promise.all(
      colors.map((background) =>
        sharp({
          create: { width: 640, height: 480, channels: 3, background },
        })
          .jpeg()
          .toBuffer()
      )
    )
    await shortStall.frame(image, 640, 480)
    await delay(100)
    pausedPid = Number(await readFile(pidFile, "utf8"))
    process.kill(pausedPid, "SIGSTOP")
    for (const bytes of images) {
      await delay(120)
      await shortStall.frame(bytes, 640, 480)
    }
    // Cursor-only transitions during a stalled pipe must keep their original
    // presentation times even without another browser screenshot.
    shortStall.pointer({ x: 100, y: 100, pressed: true })
    await delay(120)
    shortStall.pointer({ x: 300, y: 100, pressed: false })
    await delay(120)
    process.kill(pausedPid, "SIGCONT")
    pausedPid = undefined
    await delay(600)
    await shortStall.stop()
    shortStallResult = await shortStall.settled()
    assert.equal(shortStallResult.status, "finished", shortStallResult.error)
    const timeline = z
      .object({
        frames: z.array(z.object({ at: z.number() })),
        encodingTiming: z.object({ maxQueuedFrames: z.number() }),
        pointer: z.array(z.object({ at: z.number(), x: z.number(), y: z.number() })),
      })
      .parse(JSON.parse(await readFile(shortStallResult.timeline!, "utf8")))
    assert.equal(timeline.frames.length, 4)
    // Fast seeking into a held VFR frame can return the next sample. Decode
    // every actual sample and inspect its presentation interval instead.
    const decoded = join(root, "short-stall-decoded")
    await mkdir(decoded)
    await execute(ffmpeg, ["-v", "error", "-i", shortStallResult.video!,
      "-fps_mode", "passthrough", join(decoded, "%03d.png")])
    const files = (await readdir(decoded)).sort()
    const packets = z.array(z.object({ pts_time: z.string(), duration_time: z.string() }))
      .parse(JSON.parse((await execute(ffprobe, ["-v", "error", "-show_packets",
        "-show_entries", "packet=pts_time,duration_time", "-of", "json",
        shortStallResult.video!])).stdout).packets)
    assert.equal(files.length, packets.length)
    for (let index = 0; index < colors.length; index++) {
      const seconds = (timeline.frames[index + 1]!.at + 60) / 1000
      const sample = packets.findIndex(packet => Number(packet.pts_time) <= seconds &&
        Number(packet.pts_time) + Number(packet.duration_time) > seconds)
      assert.ok(sample >= 0, "Each transient state has a presentation interval")
      const pixel = await sharp(join(decoded, files[sample]!))
        .extract({ left: 10, top: 10, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
      assert.ok(pixel[index]! > 180 && pixel[(index + 1) % 3]! < 80 && pixel[(index + 2) % 3]! < 80,
        `Source state ${colors[index]} must survive the encoder stall at ${seconds}s`)
    }
    for (const point of timeline.pointer) {
      const seconds = (point.at + 60) / 1000
      const sample = packets.findIndex(packet => Number(packet.pts_time) <= seconds &&
        Number(packet.pts_time) + Number(packet.duration_time) > seconds)
      assert.ok(sample >= 0)
      const pixels = await sharp(join(decoded, files[sample]!))
        .extract({ left: point.x - 6, top: point.y - 5, width: 32, height: 36 })
        .removeAlpha().raw().toBuffer()
      let bright = 0
      for (let offset = 0; offset < pixels.length; offset += 3)
        if (pixels[offset]! > 180 && pixels[offset + 1]! > 180 && pixels[offset + 2]! > 180) bright++
      assert.ok(bright > 10, `Cursor transition at ${point.at}ms must survive encoder suspension`)
    }
  } finally {
    if (pausedPid !== undefined) process.kill(pausedPid, "SIGCONT")
    await shortStall.stop()
    await shortStall.settled()
    if (previous === undefined) delete process.env.MAKO_CONTROL_MEDIA_ROOT
    else process.env.MAKO_CONTROL_MEDIA_ROOT = previous
  }

  // A stalled encoder reduces temporal sampling within a bounded source queue.
  // Resume the actual process and require complete, correctly timed output.
  process.env.MAKO_CONTROL_MEDIA_ROOT = tools
  let backlogResult
  const backlog = await ControlRecording.create(
    target,
    { directory: root, fps: 60, cursor: false },
    async () => {}
  )
  try {
    const dense = (
      await sharp(randomBytes(1920 * 1080 * 3), {
        raw: { width: 1920, height: 1080, channels: 3 },
      })
        .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
        .toBuffer()
    )
    const different = await sharp(dense).negate()
      .jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer()
    await backlog.frame(image, 640, 480)
    await delay(1500)
    pausedPid = Number(await readFile(pidFile, "utf8"))
    process.kill(pausedPid, "SIGSTOP")
    for (let i = 0; i < 30; i++) {
      await delay(18)
      await backlog.frame(dense, 640, 480)
    }
    assert.equal(backlog.receipt().status, "recording",
      "Exact repeated pixels share queued storage without dropping source observations")
    for (let i = 0; i < 90 && backlog.receipt().status === "recording"; i++) {
      await delay(18)
      await backlog.frame(i % 2 ? dense : different, 640, 480)
    }
    assert.equal(backlog.receipt().status, "recording",
      "Source pressure must reduce frame rate rather than interrupt capture")
    assert.ok(backlog.receipt().droppedFrames > 0,
      "This test must exercise the bounded source-byte queue")
    process.kill(pausedPid, "SIGCONT")
    pausedPid = undefined
    const finalImage = await sharp({ create: { width: 640, height: 480,
      channels: 3, background: "#20e020" } }).png().toBuffer()
    await backlog.frame(finalImage, 640, 480)
    await delay(600)
    await backlog.stop()
    backlogResult = await backlog.settled()
    assert.equal(backlogResult.status, "finished", backlogResult.error)
    assert.ok(backlogResult.frameRate!.skippedFrameSlots > 60,
      "The reduced temporal sampling must be reported")
    assert.ok(backlogResult.frameRate!.encodedFps < 40)
    assert.ok(Math.abs(backlogResult.encodedDurationMs! - backlogResult.durationMs) < 18,
      "Backpressure must not speed up or shorten the recording")
    assert.ok(
      backlogResult.video,
      "The entire recording survives source overflow"
    )
    const timeline = JSON.parse(await readFile(backlogResult.timeline!, "utf8"))
    assert.ok(timeline.encodingTiming.maxQueuedBytes <= 32 * 1024 * 1024)
    assert.ok(timeline.encodingTiming.maxQueuedBytes > 24 * 1024 * 1024)
    const probe = JSON.parse((await execute(ffprobe, ["-v", "error",
      "-show_packets", "-show_entries", "packet=pts_time,duration_time",
      "-of", "json", backlogResult.video!])).stdout)
    const packets = z.array(z.object({ pts_time: z.string(), duration_time: z.string() }))
      .parse(probe.packets)
    assert.ok(packets.some(packet => Number(packet.duration_time) > 0.5),
      "The video must hold an image during the actual encoder stall")
    assert.ok(packets.every((packet, index) => index === 0 ||
      Number(packet.pts_time) > Number(packets[index - 1]!.pts_time)),
      "Presentation timestamps must remain ordered")
    const backlogPixels = join(root, "backlog-decoded")
    await mkdir(backlogPixels)
    await execute(ffmpeg, ["-v", "error", "-i", backlogResult.video!,
      "-vf", "scale=1:1", "-fps_mode", "passthrough", join(backlogPixels, "%04d.png")])
    const lastPixel = (await readdir(backlogPixels)).sort().at(-1)!
    const pixel = await sharp(join(backlogPixels, lastPixel)).removeAlpha().raw().toBuffer()
    assert.ok(pixel[1]! > 180 && pixel[0]! < 80 && pixel[2]! < 80,
      "The final exact source state must survive pressure")
    const encoderPid = Number(await readFile(pidFile, "utf8"))
    assert.throws(() => process.kill(encoderPid, 0), { code: "ESRCH" })
  } finally {
    if (pausedPid !== undefined) process.kill(pausedPid, "SIGCONT")
    await backlog.stop()
    await backlog.settled()
    if (previous === undefined) delete process.env.MAKO_CONTROL_MEDIA_ROOT
    else process.env.MAKO_CONTROL_MEDIA_ROOT = previous
  }

  // Throttle the actual encoder below capture rate for longer than the retained
  // history. The video must lose temporal samples evenly, never freeze.
  process.env.MAKO_CONTROL_MEDIA_ROOT = tools
  let sustainedResult
  let throttling = false
  let throttled: Promise<void> | undefined
  const sustained = await ControlRecording.create(
    target,
    { directory: root, fps: 60, cursor: false },
    async () => {}
  )
  try {
    const shades = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      sharp({ create: { width: 640, height: 480, channels: 3,
        background: { r: index * 20, g: 64, b: 255 - index * 20 } } }).jpeg().toBuffer()))
    await sustained.frame(shades[0]!, 640, 480)
    await delay(300)
    const encoderPid = Number(await readFile(pidFile, "utf8"))
    throttling = true
    throttled = (async () => {
      while (throttling) {
        process.kill(encoderPid, "SIGSTOP")
        await delay(80)
        process.kill(encoderPid, "SIGCONT")
        await delay(5)
      }
    })()
    const started = performance.now()
    for (let index = 1; performance.now() - started < 6000; index++) {
      await delay(16)
      await sustained.frame(shades[index % shades.length]!, 640, 480)
    }
    throttling = false
    await throttled
    await sustained.stop()
    sustainedResult = await sustained.settled()
    assert.equal(sustainedResult.status, "finished", sustainedResult.error)
    const timeline = JSON.parse(await readFile(sustainedResult.timeline!, "utf8"))
    assert.ok(timeline.encodingTiming.maxScheduleLagMs > 1900,
      "This test must fill the retained encoder history")
    const packets = z.array(z.object({ pts_time: z.string(), duration_time: z.string() }))
      .parse(JSON.parse((await execute(ffprobe, ["-v", "error", "-show_packets",
        "-show_entries", "packet=pts_time,duration_time", "-of", "json",
        sustainedResult.video!])).stdout).packets)
    const longest = Math.max(...packets.map(packet => Number(packet.duration_time)))
    assert.ok(longest < 0.5, `Sustained pressure froze the video for ${longest}s`)
    assert.ok(sustainedResult.frameRate!.skippedFrameSlots > 0 &&
      sustainedResult.frameRate!.encodedFps < 55, "The reduced sampling must be reported")
  } finally {
    throttling = false
    await throttled
    await sustained.stop()
    await sustained.settled()
    if (previous === undefined) delete process.env.MAKO_CONTROL_MEDIA_ROOT
    else process.env.MAKO_CONTROL_MEDIA_ROOT = previous
  }

  // Accept part of a raw frame, then stop reading. The worker must detect lack
  // of pipe progress, kill/reap this child and preserve an explicit failure.
  await writeFile(
    join(tools, "ffmpeg"),
    `#!${process.execPath}
if (process.argv.includes('-encoders')) { console.log(' V..... h264_videotoolbox\\n V..... libx264'); process.exit(0) }
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
process.stdin.once('data', () => process.stdin.pause())
setInterval(() => {}, 1000)
`,
    { mode: 0o700 }
  )
  process.env.MAKO_CONTROL_MEDIA_ROOT = tools
  let stalledResult
  try {
    const recording = await ControlRecording.create(
      target,
      { directory: root, cursor: false },
      async () => {}
    )
    const started = performance.now()
    await recording.frame(image, 640, 480)
    stalledResult = await recording.settled()
    assert.equal(stalledResult.status, "failed")
    assert.match(stalledResult.error!, /stopped consuming frames/)
    assert.equal(stalledResult.video, undefined)
    assert.ok(
      performance.now() - started < 15_000,
      "Stalled encoder cleanup is bounded"
    )
    const encoderPid = Number(await readFile(pidFile, "utf8"))
    assert.throws(() => process.kill(encoderPid, 0), { code: "ESRCH" })
  } finally {
    if (previous === undefined) delete process.env.MAKO_CONTROL_MEDIA_ROOT
    else process.env.MAKO_CONTROL_MEDIA_ROOT = previous
  }
  const result = {
    root,
    ownerDeath: ownerResult,
    shortStall: shortStallResult,
    backlog: backlogResult,
    sustained: sustainedResult,
    stalledPipe: stalledResult,
  }
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[2] === "--fixture") await owner(process.argv[3]!)
else await test()
