// Container-recovery experiment, not capture/viewer throughput acceptance.
// Uses synthetic pixels and the shipped encoder; never reads a desktop or browser.
import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { recordingVideoEncoding } from "../packages/control-runtime/dist/control-media.js"

const execute = promisify(execFile)
const root = resolve(process.argv[2] ?? `vendor/control-media/${process.platform}-${process.arch}`)
const ffmpeg = join(root, "ffmpeg")
const ffprobe = join(root, "ffprobe")
const directory = await mkdtemp(join(tmpdir(), "mako-media-continuity-"))
const width = 1920, height = 1080, fps = 60, frames = 180
const version = (await execute(ffmpeg, ["-version"])).stdout.split("\n")[0]
const results = []
const encoding = recordingVideoEncoding()

async function inspect(path) {
  try {
    const { stdout, stderr } = await execute(ffprobe, [
      "-v", "error", "-count_frames", "-show_entries",
      "stream=width,height,nb_read_frames:format=duration", "-of", "json", path,
    ], { timeout: 15000, maxBuffer: 65536 })
    const value = JSON.parse(stdout)
    return { readable: true, ...value, diagnostics: stderr.slice(-2048) }
  } catch (error) {
    return { readable: false, diagnostics: String(error.stderr ?? error.message).slice(-2048) }
  }
}

async function boxes(path) {
  const bytes = await readFile(path)
  const types = []
  for (let offset = 0; offset + 8 <= bytes.length;) {
    let size = bytes.readUInt32BE(offset)
    const type = bytes.toString("ascii", offset + 4, offset + 8)
    if (size === 1) {
      if (offset + 16 > bytes.length) break
      size = Number(bytes.readBigUInt64BE(offset + 8))
    }
    if (size === 0) size = bytes.length - offset
    if (!Number.isSafeInteger(size) || size < 8 || offset + size > bytes.length) break
    types.push(type)
    offset += size
  }
  return types
}

const containers = {
  faststart: "+faststart",
  fragmented: "+frag_keyframe+empty_moov+default_base_moof",
  hybrid: "+frag_keyframe+empty_moov+default_base_moof+hybrid_fragmented",
}
for (const [mode, flags] of Object.entries(containers)) {
  for (const termination of ["clean", "kill"]) {
    const output = join(directory, `${mode}-${termination}.mp4`)
    const args = [
      "-hide_banner", "-loglevel", "error", "-n",
      "-f", "rawvideo", "-pixel_format", "yuv420p",
      "-video_size", `${width}x${height}`, "-framerate", String(fps),
      "-i", "pipe:0", "-an", ...encoding.args, "-pix_fmt", "yuv420p",
      // Match codec/GOP in both arms; isolate the output-container difference.
      "-g", String(fps), "-bf", "0",
      "-movflags", flags,
      "-flush_packets", "1", "-stats_period", "0.1", "-progress", "pipe:1", output,
    ]
    const child = spawn(ffmpeg, args, { stdio: ["pipe", "pipe", "pipe"] })
    let stderr = "", progress = "", encoded = 0
    let inputError
    child.stdin.on("error", error => { inputError = error })
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096) })
    child.stdout.on("data", chunk => {
      progress += chunk
      const lines = progress.split("\n")
      progress = lines.pop() ?? ""
      for (const line of lines) if (line.startsWith("frame=")) encoded = Number(line.slice(6))
    })
    const closed = new Promise((resolveClose, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolveClose({ code, signal }))
    })
    // Observe rejection even if spawning fails before the write loop finishes.
    void closed.catch(() => {})
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30000)
    try {
      const frame = Buffer.alloc(width * height * 3 / 2, 128)
      for (let index = 0; index < frames; index++) {
        // Moving luma band over a neutral background; fixed source geometry.
        frame.fill(32, 0, width * height)
        const top = (index * 5) % (height - 40)
        frame.fill(200, top * width, (top + 40) * width)
        if (inputError) throw inputError
        await new Promise((resolveWrite, reject) => {
          child.stdin.write(frame, error => error ? reject(error) : resolveWrite())
        })
      }
      // Leave stdin open and allow complete GOPs to reach the muxer.
      const deadline = Date.now() + 5000
      while (encoded < fps * 2 && Date.now() < deadline) await delay(50)
      assert.ok(encoded >= fps * 2, `Encoder did not advance: ${stderr}`)
      const beforeStop = await inspect(output)
      const boxesBeforeStop = await boxes(output)
      const bytesBeforeStop = (await stat(output)).size
      if (termination === "kill") child.kill("SIGKILL")
      else child.stdin.end()
      const exit = await closed
      const afterStop = await inspect(output)
      const boxesAfterStop = await boxes(output)
      const entry = { mode, termination, args, encodedBeforeStop: encoded,
        bytesBeforeStop, beforeStop, exit, afterStop, stderr,
        boxesBeforeStop, boxesAfterStop, bytesAfterStop: (await stat(output)).size }
      results.push(entry)
      if (termination === "clean") {
        assert.equal(exit.code, 0, stderr)
        assert.equal(afterStop.readable, true)
        assert.equal(Number(afterStop.streams[0].nb_read_frames), frames)
        assert.equal(afterStop.streams[0].width, width)
        assert.equal(afterStop.streams[0].height, height)
        if (mode === "hybrid") {
          assert.ok(boxesBeforeStop.includes("moof"))
          assert.ok(!boxesAfterStop.includes("moof"), "Hybrid must finalize to ordinary MP4")
        }
      } else if (mode !== "faststart") {
        assert.equal(exit.signal, "SIGKILL")
        assert.equal(beforeStop.readable, true)
        assert.equal(afterStop.readable, true)
        assert.ok(Number(afterStop.streams[0].nb_read_frames) >= fps)
      } else {
        assert.equal(exit.signal, "SIGKILL")
        assert.equal(beforeStop.readable, false)
        assert.equal(afterStop.readable, false)
      }
    } finally {
      clearTimeout(timeout)
      child.stdin.destroy()
      child.kill("SIGKILL")
      await closed.catch(() => {})
    }
  }
}
const report = { version: 1, scope: "Synthetic output-container recovery only; no capture, cursor, viewer, network or throughput claim",
  platform: process.platform, arch: process.arch, encoderVersion: version,
  encoderSha256: createHash("sha256").update(await readFile(ffmpeg)).digest("hex"),
  width, height, fps, inputFrames: frames, results }
await writeFile(join(directory, "result.json"), JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify({ directory, results: results.map(result => ({
  mode: result.mode, termination: result.termination,
  readableBeforeStop: result.beforeStop.readable, readableAfterStop: result.afterStop.readable,
  decodedFrames: result.afterStop.streams?.[0]?.nb_read_frames,
})) }, null, 2))
