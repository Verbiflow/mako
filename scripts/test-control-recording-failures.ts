import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile, symlink } from "node:fs/promises"
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
    assert.equal(journal[0].version, 3)
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
    { directory: root, fps: 60, cursor: false },
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
      })
      .parse(JSON.parse(await readFile(shortStallResult.timeline!, "utf8")))
    assert.equal(timeline.frames.length, 4)
    assert.ok(
      timeline.encodingTiming.maxQueuedFrames >= 2,
      "Test must exercise source backlog"
    )
    for (let index = 0; index < colors.length; index++) {
      const seconds = (timeline.frames[index + 1]!.at + 60) / 1000
      const { stdout } = await execute(
        "ffmpeg",
        [
          "-v",
          "error",
          "-ss",
          String(seconds),
          "-i",
          shortStallResult.video!,
          "-frames:v",
          "1",
          "-vf",
          "crop=2:2:10:10",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ],
        { encoding: "buffer" }
      )
      assert.equal(stdout.length, 12)
      assert.ok(
        stdout[index]! > 180 &&
          stdout[(index + 1) % 3]! < 80 &&
          stdout[(index + 2) % 3]! < 80,
        `Source state ${colors[index]} must survive the encoder stall at ${seconds}s`
      )
    }
  } finally {
    if (pausedPid !== undefined) process.kill(pausedPid, "SIGCONT")
    await shortStall.stop()
    await shortStall.settled()
    if (previous === undefined) delete process.env.MAKO_CONTROL_MEDIA_ROOT
    else process.env.MAKO_CONTROL_MEDIA_ROOT = previous
  }

  // A stalled encoder must not turn bursty source frames into unbounded memory.
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
    assert.notEqual(
      backlog.receipt().status,
      "recording",
      "Source byte budget must interrupt capture"
    )
    process.kill(pausedPid, "SIGCONT")
    pausedPid = undefined
    backlogResult = await backlog.settled()
    assert.equal(backlogResult.status, "interrupted", backlogResult.error)
    assert.match(backlogResult.error!, /backlog exceeded/)
    assert.ok(
      backlogResult.video,
      "Completed video prefix survives source overflow"
    )
    const timeline = JSON.parse(await readFile(backlogResult.timeline!, "utf8"))
    assert.ok(timeline.encodingTiming.maxQueuedBytes <= 32 * 1024 * 1024)
    assert.ok(timeline.encodingTiming.maxQueuedBytes > 24 * 1024 * 1024)
    const encoderPid = Number(await readFile(pidFile, "utf8"))
    assert.throws(() => process.kill(encoderPid, 0), { code: "ESRCH" })
  } finally {
    if (pausedPid !== undefined) process.kill(pausedPid, "SIGCONT")
    await backlog.stop()
    await backlog.settled()
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
    stalledPipe: stalledResult,
  }
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[2] === "--fixture") await owner(process.argv[3]!)
else await test()
