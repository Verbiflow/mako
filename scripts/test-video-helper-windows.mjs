// The Windows video helper (native/video-windows/mako-video.cpp) through its Node side (`video-helper.ts`) and
// `BrowserVideo`: Windows Graphics Capture and Media Foundation, no FFmpeg. Run on Windows with a desktop session
// after `npm run build:control-runtime` and `node scripts/build-video-helper.mjs --require`; FFmpeg's ffprobe and
// ffmpeg on PATH check that every unit decodes (a check, not a dependency). The CI job is
// .github/workflows/windows-video.yml.
//
//   node scripts/test-video-helper-windows.mjs [--json <file>]   (measurements written to the file as well)
//
//   1. Pictures in (a JPEG, raw RGB): one unit each, a key frame with its avcC first and at each new size; a key
//      frame when asked; every unit decodes.
//   2. The bitrate command: the same moving pictures cost a fraction after the rate drops, with no new key frame.
//   3. Frames for a recording: Mako's recording encoder writes them as MP4 (mp4.ts), read back with Mediabunny and
//      decoded by FFmpeg.
//   4. A window (a WinForms fixture): a key frame first, a unit for each change at most at the asked rate, each one
//      decoding to the paint it shows; paint-to-unit latency and the helper's CPU.
//   5. A still window: nothing sent and no CPU; a key frame when asked; a smaller box gives a key frame at its size.
//   6. A window under another: its own pixels, never the cover's; its closing ends the video.
//   7. The whole display.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { BrowserVideo } from "../packages/control-runtime/dist/browser.js"
import { VideoHelper, helperCapture } from "../packages/control-runtime/dist/desktop.js"
import { decodeControlVideo } from "../packages/control-runtime/dist/contracts/control-video.js"
import { RecordingEncoderProcess } from "../packages/control-runtime/dist/recording-encoder-process.js"
import { readMp4 } from "../packages/control-runtime/dist/mp4.js"

assert.equal(process.platform, "win32", "This check is for Windows")
const repo = resolve(fileURLToPath(import.meta.url), "../..")
const helper = join(repo, "build", "mako-video.exe")
const scratch = mkdtempSync(join(tmpdir(), "mako-video-win-"))
const jsonOut = process.argv.includes("--json") ? resolve(process.argv[process.argv.indexOf("--json") + 1]) : undefined
const results = {}
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(read, check, what, ms = 10_000) {
  for (const deadline = Date.now() + ms; ; await wait(20)) {
    const value = read()
    if (check(value)) return value
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
  }
}
const percentile = (values, p) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}
const round = (value, places = 1) => (value === null ? null : Math.round(value * 10 ** places) / 10 ** places)
const children = []

/** The units as Annex B: SPS and PPS from each key unit's avcC, then its NAL units. */
function annexB(packets) {
  const parts = []
  for (const packet of packets) {
    if (packet.kind === "key") {
      const d = packet.description, count = d[5] & 0x1f
      let at = 6
      for (let i = 0; i < count; i++) { const n = d[at] << 8 | d[at + 1]; parts.push(Buffer.from([0, 0, 0, 1]), d.subarray(at + 2, at + 2 + n)); at += 2 + n }
      const pps = d[at++]
      for (let i = 0; i < pps; i++) { const n = d[at] << 8 | d[at + 1]; parts.push(Buffer.from([0, 0, 0, 1]), d.subarray(at + 2, at + 2 + n)); at += 2 + n }
    }
    for (let i = 0; i < packet.data.length;) {
      const length = (packet.data[i] << 24 | packet.data[i + 1] << 16 | packet.data[i + 2] << 8 | packet.data[i + 3]) >>> 0
      parts.push(Buffer.from([0, 0, 0, 1]), packet.data.subarray(i + 4, i + 4 + length))
      i += 4 + length
    }
  }
  return Buffer.concat(parts)
}
let checks = 0
/** Decodes the units with FFmpeg: how many frames, and each frame's RGB (all of one size). */
function decode(packets) {
  const file = join(scratch, `check-${checks++}.h264`)
  writeFileSync(file, annexB(packets))
  const frames = Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file], { encoding: "utf8" }).trim())
  const rgb = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 2 ** 31 })
  const { width, height } = packets.at(-1)
  const size = width * height * 3
  const pixel = (index, x, y) => [...rgb.subarray(index * size + (y * width + x) * 3, index * size + (y * width + x) * 3 + 3)]
  return { frames, decoded: rgb.length / size, pixel }
}
/** The stream's color description, as FFmpeg reads it from the SPS. */
function colors(packets) {
  const file = join(scratch, `colors-${checks++}.h264`)
  writeFileSync(file, annexB(packets))
  return execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=profile,color_space,color_primaries,color_transfer,color_range", "-of", "json", file], { encoding: "utf8" })
}
/** CPU milliseconds of every mako-video process running now, by process id. */
function helperCpu() {
  const out = execFileSync("powershell", ["-NoProfile", "-Command", "Get-Process mako-video -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id) $($_.TotalProcessorTime.TotalMilliseconds)\" }"], { encoding: "utf8" })
  return new Map(out.trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(" ").map(Number)))
}
const cpuTotal = (map) => [...map.values()].reduce((total, value) => total + value, 0)
/** A fixture window: its HWND, and the paint times it reports by frame number. */
async function app(mode, { fps = 30, width = 640, height = 400, x = 40, y = 40 } = {}) {
  const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(repo, "scripts/fixtures/win-anim.ps1"),
    "-Fps", String(fps), "-Width", String(width), "-Height", String(height), "-Mode", mode, "-X", String(x), "-Y", String(y)], { stdio: ["ignore", "pipe", "inherit"] })
  children.push(child)
  const paints = []
  let id
  let text = ""
  child.stdout.on("data", (chunk) => {
    text += chunk.toString()
    const lines = text.split(/\r?\n/)
    text = lines.pop()
    for (const line of lines) {
      const [first, second] = line.trim().split(" ")
      if (first === "hwnd") id = Number(second)
      else if (second) paints.push({ frame: Number(first), at: Number(second) })
    }
  })
  await until(() => id, (value) => value !== undefined, `the ${mode} window`, 30_000)
  return { child, id, paints }
}
const viewer = (box) => {
  const packets = []
  const arrivals = []
  const state = { box, ended: undefined }
  return {
    packets,
    arrivals,
    state,
    handle: {
      size: () => state.box,
      backlog: () => 0,
      send: (bytes) => {
        arrivals.push(Date.now())
        packets.push(decodeControlVideo(bytes))
      },
      ended: (reason) => (state.ended = reason),
    },
  }
}

try {
  // 0. The program runs, and says how it's used.
  const usage = (() => {
    try {
      execFileSync(helper, [], { stdio: ["ignore", "pipe", "pipe"] })
      return ""
    } catch (error) {
      return `${error.stderr} (exit ${error.status})`
    }
  })()
  assert.match(usage, /usage: mako-video[\s\S]*exit 64/)

  // 1.
  const sharp = (await import("sharp")).default
  const units = []
  let ended
  const frames = new VideoHelper(helper, { kind: "frames" }, { fps: 30 }, { unit: (packet) => units.push(packet), ended: (reason) => (ended = reason) })
  const jpeg = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg().toBuffer()
  frames.picture("jpeg", 7, 1234.5, jpeg)
  await until(() => units, (sent) => sent.length === 1, "a unit for the JPEG")
  assert.deepEqual([units[0].kind, units[0].sequence, units[0].capturedAt, units[0].width, units[0].height], ["key", 7, 1234.5, 320, 240])
  assert.equal(units[0].description[0], 1, "an avcC record")
  const first = decode(units.slice(0, 1))
  const red = first.pixel(0, 160, 120)
  assert.ok(red[0] > 170 && red[1] < 80 && red[2] < 80, `the JPEG's color comes back: ${red}`)
  frames.picture("rgb", 8, 1240, Buffer.alloc(100 * 50 * 3, 128), { width: 100, height: 50 })
  await until(() => units, (sent) => sent.length === 2, "a unit for the raw picture")
  assert.deepEqual([units[1].kind, units[1].width, units[1].height], ["key", 100, 50], "a new size starts with a key frame")
  const moving = (index, width = 320, height = 240) => {
    const bytes = Buffer.alloc(width * height * 3)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 3
        bytes[at] = (x + index * 5) & 0xff
        bytes[at + 1] = (y * 2 + index * 3) & 0xff
        bytes[at + 2] = ((x ^ y) + index * 7) & 0xff
      }
    return bytes
  }
  const before = units.length
  for (let index = 0; index < 20; index++) {
    await new Promise((done, fail) => frames.picture("rgb", 100 + index, Date.now(), moving(index), { width: 320, height: 240 }, (error) => (error ? fail(error) : done())))
  }
  await until(() => units, (sent) => sent.length === before + 20, "a unit for each picture")
  const run = units.slice(before)
  assert.equal(run[0].kind, "key")
  assert.ok(run.slice(1).every((packet) => packet.kind === "delta"), `no key frame unasked: ${run.map((packet) => packet.kind[0]).join("")}`)
  assert.deepEqual(run.map((packet) => packet.sequence), Array.from({ length: 20 }, (_, index) => 100 + index), "each unit carries its picture's sequence")
  frames.key()
  await until(() => units, (sent) => sent.length === before + 21, "a key frame when asked")
  assert.equal(units.at(-1).kind, "key")
  assert.equal(units.at(-1).sequence, 119, "the key frame shows the picture shown now")
  const runDecoded = decode(units.slice(before))
  assert.equal(runDecoded.frames, 21, "every unit decodes")
  results.colors = JSON.parse(colors(units.slice(before, before + 1))).streams?.[0]
  frames.close()
  await frames.exited
  assert.equal(ended, undefined, "closing isn't an ending")
  console.log(`  frames: JPEG and raw pictures, key frames at new sizes and when asked, all ${runDecoded.frames} decode (${JSON.stringify(results.colors)})`)

  // 3.
  const recordingDirectory = join(scratch, "recording")
  mkdirSync(recordingDirectory)
  let recordingFailure
  const recording = new RecordingEncoderProcess(recordingDirectory, 320, 240, 30, (reason) => (recordingFailure = reason))
  for (let index = 0; index < 60; index++) await recording.write(moving(index), (index * 1000) / 30)
  const written = await recording.finish()
  assert.equal(recordingFailure, undefined)
  assert.equal(written.error, undefined)
  const video = await readMp4(written.path)
  assert.ok(video, "Mediabunny reads the MP4")
  assert.deepEqual([video.width, video.height, video.packets.length], [320, 240, 60])
  assert.ok(Math.abs(video.duration - 2) < 0.1, `its duration follows the pictures' times: ${video.duration}`)
  const recordedFrames = Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", written.path], { encoding: "utf8" }).trim())
  assert.equal(recordedFrames, 60, "FFmpeg decodes every frame of the recording")
  const keys = video.packets.filter((packet) => packet.key).length
  assert.equal(keys, 2, "a key frame a second")
  results.recording = { codec: video.codec, frames: video.packets.length, duration: video.duration, bytes: readFileSync(written.path).byteLength, keys }
  console.log(`  recording: 60 pictures → ${written.path.split(/[\\/]/).at(-1)}, ${video.duration.toFixed(2)} s, Mediabunny and FFmpeg read all 60`)

  // 4.
  const target = await app("anim", { fps: 30, width: 640, height: 400, x: 40, y: 40 })
  const windowVideo = new BrowserVideo({ encoded: helperCapture(helper, { kind: "window", windowId: target.id }) }, { fps: 30 })
  const watcher = viewer(undefined)
  const leave = await windowVideo.join(watcher.handle)
  await until(() => watcher.packets, (sent) => sent.length > 0, "the window's first unit", 15_000)
  assert.equal(watcher.packets[0].kind, "key")
  await wait(1000)
  const from = watcher.packets.length
  const cpu0 = helperCpu()
  const t0 = Date.now()
  await wait(5000)
  const seconds = (Date.now() - t0) / 1000
  const activeCpu = (cpuTotal(helperCpu()) - cpuTotal(cpu0)) / 1000 / seconds
  const rateWindow = (watcher.packets.length - from) / seconds
  const paintRate = target.paints.filter((paint) => paint.at >= t0 && paint.at <= t0 + seconds * 1000).length / seconds
  assert.deepEqual([watcher.packets[0].width, watcher.packets[0].height], [640, 400], "the window's own size")
  assert.ok(rateWindow >= Math.min(15, paintRate * 0.6) && rateWindow <= 31, `units follow the window's paints, at most 30 a second: ${rateWindow.toFixed(1)} units/s for ${paintRate.toFixed(1)} paints/s`)
  const windowDecoded = decode(watcher.packets)
  assert.equal(windowDecoded.frames, watcher.packets.length, "every unit decodes")
  // Which paint each unit shows, from its marker, and how long after that paint the unit reached Node.
  const latencies = []
  for (let index = from; index < watcher.packets.length; index++) {
    const [r, g] = windowDecoded.pixel(index, 32, 32)
    const low = Math.round((r - 8) / 16) & 15, mid = Math.round((g - 8) / 16) & 15
    const arrival = watcher.arrivals[index]
    const paint = target.paints.filter((candidate) => (candidate.frame & 255) === (mid << 4 | low) && candidate.at <= arrival).at(-1)
    if (paint) latencies.push(arrival - paint.at)
  }
  assert.ok(latencies.length >= (watcher.packets.length - from) * 0.8, `most units show a paint they follow: ${latencies.length} of ${watcher.packets.length - from}`)
  results.window = {
    size: "640x400",
    paintsPerSecond: round(paintRate),
    unitsPerSecond: round(rateWindow),
    helperCpuPercent: round(activeCpu * 100),
    paintToUnitMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: percentile(latencies, 1) },
    kbps: round((watcher.packets.slice(from).reduce((total, packet) => total + packet.data.byteLength, 0) * 8) / seconds / 1000),
  }
  console.log(`  window: ${rateWindow.toFixed(1)} units/s for ${paintRate.toFixed(1)} paints/s, ${(activeCpu * 100).toFixed(1)}% CPU, paint to unit p50 ${results.window.paintToUnitMs.p50} ms p95 ${results.window.paintToUnitMs.p95} ms, all ${windowDecoded.frames} decode`)
  await leave()
  windowVideo.close()
  target.child.kill()

  // The helper's own numbers, run directly for its summary: capture, conversion and encoding per frame.
  const direct = await app("anim", { fps: 60, width: 1280, height: 720, x: 0, y: 0 })
  const summary = await new Promise((done) => {
    const child = spawn(helper, ["window", String(direct.id), "--fps", "60"], { stdio: ["pipe", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("close", () => done(JSON.parse(stderr.trim().split("\n").at(-1))))
    setTimeout(() => child.stdin.end(), 5000)
  })
  results.window1280x720at60 = summary
  console.log(`  window 1280x720 at up to 60: ${JSON.stringify(summary)}`)
  direct.child.kill()

  // 5.
  const still = await app("still", { width: 640, height: 400 })
  const stillVideo = new BrowserVideo({ encoded: helperCapture(helper, { kind: "window", windowId: still.id }) }, { fps: 30 })
  const stillWatcher = viewer(undefined)
  const leaveStill = await stillVideo.join(stillWatcher.handle)
  await until(() => stillWatcher.packets, (sent) => sent.length > 0, "the still window's first unit", 15_000)
  await wait(1000)
  const stillFrom = stillWatcher.packets.length
  const idle0 = helperCpu()
  const i0 = Date.now()
  await wait(3000)
  const idleSeconds = (Date.now() - i0) / 1000
  const idleCpu = (cpuTotal(helperCpu()) - cpuTotal(idle0)) / 1000
  const idleUnits = stillWatcher.packets.length - stillFrom
  assert.ok(idleUnits <= 1, `a still window sends nothing: ${idleUnits} units in ${idleSeconds} s`)
  assert.ok(idleCpu / idleSeconds <= 0.02, `the helper waits while nothing changes: ${idleCpu} CPU s in ${idleSeconds} s`)
  results.idle = { units: idleUnits, seconds: round(idleSeconds), helperCpuPercent: round((idleCpu / idleSeconds) * 100, 2) }
  stillVideo.refresh(stillWatcher.handle)
  const keyed = await until(() => stillWatcher.packets.slice(stillFrom), (sent) => sent.some((packet) => packet.kind === "key"), "a key frame of the still window")
  stillWatcher.state.box = { width: 320, height: 200 }
  const resizedFrom = stillWatcher.packets.length
  await stillVideo.resized()
  const small = await until(() => stillWatcher.packets.slice(resizedFrom), (sent) => sent.some((packet) => packet.kind === "key"), "a key frame at the smaller box")
  assert.deepEqual([small.at(-1).width, small.at(-1).height], [320, 200])
  console.log(`  still: ${idleUnits} units and ${results.idle.helperCpuPercent}% CPU in ${idleSeconds} s; a key frame when asked (${keyed.length} unit), a smaller box at 320x200`)
  await leaveStill()
  stillVideo.close()
  still.child.kill()

  // 6.
  const covered = await app("anim", { width: 640, height: 400, x: 100, y: 100 })
  const coveredVideo = new BrowserVideo({ encoded: helperCapture(helper, { kind: "window", windowId: covered.id }) }, { fps: 30 })
  const coveredWatcher = viewer(undefined)
  await coveredVideo.join(coveredWatcher.handle)
  await until(() => coveredWatcher.packets, (sent) => sent.length > 0, "the covered window's first unit", 15_000)
  const cover = await app("red", { width: 400, height: 300, x: 150, y: 150 })
  await wait(1500)
  const coveredDecoded = decode(coveredWatcher.packets)
  const under = coveredDecoded.pixel(coveredWatcher.packets.length - 1, 150, 200)
  assert.notDeepEqual(under.map((value) => value > 200), [true, false, false], `the covering window never shows: ${under}`)
  covered.child.kill()
  await until(() => coveredWatcher.state.ended, Boolean, "the window's end to end the video", 15_000)
  assert.match(coveredWatcher.state.ended, /window closed/i)
  console.log(`  window under another: its own pixels (${under}), its closing ends the video`)
  coveredVideo.close()
  cover.child.kill()

  // 7.
  const busy = await app("anim", { width: 640, height: 400, x: 0, y: 0 })
  const display = new BrowserVideo({ encoded: helperCapture(helper, { kind: "display" }) }, { fps: 30 })
  const displayWatcher = viewer(undefined)
  const leaveDisplay = await display.join(displayWatcher.handle)
  await until(() => displayWatcher.packets, (sent) => sent.length > 0, "the display's first unit", 15_000)
  assert.equal(displayWatcher.packets[0].kind, "key")
  await wait(500)
  const displayFrom = displayWatcher.packets.length
  const d0 = helperCpu()
  const dt0 = Date.now()
  await wait(4000)
  const displaySeconds = (Date.now() - dt0) / 1000
  const displayCpu = (cpuTotal(helperCpu()) - cpuTotal(d0)) / 1000 / displaySeconds
  const displayRate = (displayWatcher.packets.length - displayFrom) / displaySeconds
  assert.ok(displayRate >= 5, `the display's units follow the window animating on it: ${displayRate.toFixed(1)}/s`)
  const displayDecoded = decode(displayWatcher.packets)
  assert.equal(displayDecoded.frames, displayWatcher.packets.length, "every unit of the display decodes")
  const { width: displayWidth, height: displayHeight } = displayWatcher.packets.at(-1)
  results.display = { size: `${displayWidth}x${displayHeight}`, unitsPerSecond: round(displayRate), helperCpuPercent: round(displayCpu * 100) }
  console.log(`  display: ${displayWidth}x${displayHeight}, ${displayRate.toFixed(1)} units/s, ${(displayCpu * 100).toFixed(1)}% CPU, all ${displayDecoded.frames} decode`)
  await leaveDisplay()
  display.close()
  busy.child.kill()

  // 2. The same pictures (a moving pattern with fine texture) at 4 and 0.3 Mbit/s, and at 4 then 0.3 by the R command.
  const textured = (index) => {
    const bytes = Buffer.alloc(640 * 360 * 3)
    let seed = 12345
    for (let y = 0; y < 360; y++)
      for (let x = 0; x < 640; x++) {
        seed = (seed * 1103515245 + 12345) >>> 0
        const grain = (seed >>> 28) * 4
        const at = (y * 640 + x) * 3
        bytes[at] = ((x + index * 6) ^ (y >> 2)) & 0xff
        bytes[at + 1] = (((y + index * 4) * 3) + grain) & 0xff
        bytes[at + 2] = ((x * y) / 64 + index * 5 + grain) & 0xff
      }
    return bytes
  }
  const pictures = Array.from({ length: 90 }, (_, index) => textured(index))
  /** Unit sizes for the 90 pictures, sent at 30 a second; `change` is a bitrate sent before picture 45. */
  async function sizes(bitrate, change) {
    const sent = []
    const encoder = new VideoHelper(helper, { kind: "frames" }, { fps: 30, bitrate }, { unit: (packet) => sent.push(packet), ended: (reason) => assert.fail(reason) })
    const start = Date.now()
    for (let index = 0; index < 90; index++) {
      if (index === 45 && change) encoder.rate(change)
      await new Promise((done, fail) => encoder.picture("rgb", index, start + index * 33, pictures[index], { width: 640, height: 360 }, (error) => (error ? fail(error) : done())))
      await wait(33)
    }
    await until(() => sent, (units) => units.length >= 90, "a unit for each picture")
    encoder.close()
    await encoder.exited
    const mean = (from, to) => sent.slice(from, to).reduce((total, packet) => total + packet.data.byteLength, 0) / (to - from)
    return { first: mean(15, 45), last: mean(60, 90), keys: sent.filter((packet) => packet.kind === "key").length }
  }
  const high = await sizes(4_000_000)
  const low = await sizes(300_000)
  const changed = await sizes(4_000_000, 300_000)
  const kbps = (bytes) => Math.round((bytes * 30 * 8) / 1000)
  results.bitrate = { high: kbps(high.last), low: kbps(low.last), changedBefore: kbps(changed.first), changedAfter: kbps(changed.last), keysAfterChange: changed.keys - 1 }
  console.log(`  bitrate, kbit/s on a textured 640x360 at 30 fps: asked 4000 → ${results.bitrate.high}, asked 300 → ${results.bitrate.low}, 4000 then 300 by command → ${results.bitrate.changedBefore} then ${results.bitrate.changedAfter}`)
  assert.ok(low.last < high.last * 0.5, "a lower bitrate spends fewer bits")
  assert.equal(changed.keys, 1, "a new rate needs no key frame")
  assert.ok(changed.last < changed.first * 0.6, "the bitrate command takes effect")

  // Which encoder: `auto` takes a hardware H.264 encoder where the machine has one and Windows' software encoder
  // otherwise; `software` and `hardware` ask for one outright (MAKO_VIDEO_ENCODER, which the helper reads). Every
  // branch is run here. On a machine with no hardware encoder (a hosted runner has no GPU), `auto` must fall back
  // and encode, and `hardware` must refuse and say why rather than encode nothing in silence.
  async function encodedWith(choice) {
    const before = process.env.MAKO_VIDEO_ENCODER
    process.env.MAKO_VIDEO_ENCODER = choice
    const units = []
    let ended
    try {
      const encoder = new VideoHelper(helper, { kind: "frames" }, { fps: 30, bitrate: 1_000_000 }, { unit: (packet) => units.push(packet), ended: (reason) => (ended = reason) })
      const start = Date.now()
      for (let index = 0; index < 20 && ended === undefined; index++) {
        // A helper that has refused may never take the picture: it is waited for two seconds at most.
        await Promise.race([new Promise((done) => encoder.picture("rgb", index, start + index * 33, pictures[index], { width: 640, height: 360 }, () => done())), wait(2_000)])
        await wait(33)
      }
      await until(() => units, (sent) => sent.length >= 20 || ended !== undefined, `units from the ${choice} encoder`).catch(() => undefined)
      encoder.close()
      await encoder.exited
      const summary = encoder.said.split("\n").filter((line) => line.startsWith("{")).at(-1)
      return { units: units.length, keys: units.filter((packet) => packet.kind === "key").length, ended, encoder: summary ? JSON.parse(summary).encoder : undefined, said: encoder.said.split("\n").filter((line) => !line.startsWith("{")).join(" | ").slice(0, 300) }
    } finally {
      if (before === undefined) delete process.env.MAKO_VIDEO_ENCODER
      else process.env.MAKO_VIDEO_ENCODER = before
    }
  }
  const auto = await encodedWith("auto")
  const software = await encodedWith("software")
  const hardware = await encodedWith("hardware")
  results.encoders = { auto, software, hardware }
  console.log(`  encoders: auto → ${auto.encoder} (${auto.units} units); software → ${software.encoder} (${software.units} units); hardware → ${hardware.encoder ?? hardware.ended ?? hardware.said} (${hardware.units} units)`)
  assert.ok(auto.units >= 20 && auto.keys >= 1 && /^Media Foundation \((software|hardware: .+)\)$/.test(auto.encoder ?? ""), `auto encodes with one of the two: ${JSON.stringify(auto)}`)
  assert.ok(software.units >= 20 && software.encoder === "Media Foundation (software)", `software is Windows' own encoder: ${JSON.stringify(software)}`)
  if (auto.encoder === "Media Foundation (software)") {
    // No hardware encoder here: asked for outright, it is refused in words, and `auto` above is the fallback at work.
    assert.equal(hardware.units, 0, "no unit comes from a hardware encoder this machine doesn't have")
    assert.match(`${hardware.ended ?? ""} ${hardware.said}`, /No hardware H\.264 encoder could start/, `the refusal says why: ${JSON.stringify(hardware)}`)
  } else assert.ok(hardware.units >= 20 && /hardware/.test(hardware.encoder ?? ""), `this machine's hardware encoder encodes: ${JSON.stringify(hardware)}`)

  console.log(JSON.stringify(results, null, 2))
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2))
  console.log("Windows video helper passed")
} finally {
  for (const child of children.reverse()) child.kill()
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
}
process.exit(0)
