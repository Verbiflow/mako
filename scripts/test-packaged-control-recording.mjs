import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

// Run with the candidate's Electron executable and ELECTRON_RUN_AS_NODE=1.
const [appArgument, outputArgument] = process.argv.slice(2)
assert.ok(appArgument && outputArgument, "Pass the candidate Mako.app and an evidence directory")
const app = resolve(appArgument)
const output = resolve(outputArgument)
assert.equal(process.execPath, join(app, "Contents/MacOS/Mako"))
// An installed recording must not find Homebrew or shell-installed encoders.
process.env.PATH = "/usr/bin:/bin";
const archive = join(app, "Contents/Resources/app.asar")
const { mediaExecutable } = await import(pathToFileURL(join(archive, "dist-electron/control-media.js")).href)
for (const name of ["ffmpeg", "ffprobe"]) assert.equal(mediaExecutable(name), join(app, "Contents/Resources/control-media/darwin-arm64", name))
const require = createRequire(join(archive, "package.json"))
const sharp = require("sharp")
const { ControlRecording } = await import(
  pathToFileURL(join(archive, "dist-electron/control-recording.js")).href
)
await mkdir(output, { recursive: true })
let stops = 0
const target = { kind: "page", browser: "fixture", tab: "tab", generation: "one", lease: "lease" }
const recording = await ControlRecording.create(target, { directory: output }, async () => { stops++ })
for (const [index, color] of ["#305070", "#507030"].entries()) {
  const frame = await sharp({ create: { width: 640, height: 480, channels: 3, background: color } }).jpeg().toBuffer()
  await recording.frame(frame.toString("base64"), 640, 480)
  recording.pointer({ x: 100 + index * 160, y: 120, pressed: index === 0 })
  await delay(150)
}
await recording.stop()
await recording.stop()
const receipt = await recording.settled()
assert.equal(receipt.status, "finished", receipt.error)
assert.equal(stops, 1)
const { stdout } = await promisify(execFile)(mediaExecutable("ffprobe"), ["-v", "error", "-show_streams", "-show_format", "-of", "json", receipt.video])
const probe = JSON.parse(stdout)
assert.equal(probe.streams[0].codec_name, "h264")
assert.equal(probe.streams[0].width, 640)
assert.equal(probe.streams[0].height, 480)
assert.ok(Number(probe.format.duration) >= 0.25)
const timeline = JSON.parse(await readFile(receipt.timeline, "utf8"))
assert.equal(timeline.pointer.length, 2)
assert.deepEqual(timeline.target, target)
await promisify(execFile)(mediaExecutable("ffmpeg"), ["-v", "error", "-i", receipt.video, "-frames:v", "1", join(receipt.directory, "decoded.png")])
await writeFile(join(output, "result.json"), JSON.stringify({ passed: true, executable: process.execPath, receipt, probe }, null, 2) + "\n")
console.log(JSON.stringify({ passed: true, evidence: output, video: receipt.video }))

// Exercise native video composition through the same packaged binaries.
const native = await ControlRecording.create({ kind: "window", pid: 42, window_id: 7 }, { directory: output }, async () => {
  await native.attachVideo(join(native.directory, "recording.mp4"))
})
const cleanFrame = join(native.directory, "source.png")
await sharp({ create: { width: 640, height: 480, channels: 3, background: "#305070" } }).png().toFile(cleanFrame)
await promisify(execFile)(mediaExecutable("ffmpeg"), ["-v", "error", "-loop", "1", "-i", cleanFrame, "-t", "0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(native.directory, "recording.mp4")])
await mkdir(join(native.directory, "turn-00001"))
await writeFile(join(native.directory, "turn-00001/action.json"), JSON.stringify({ pointer_dispatches: [{ at_ms: 100, x: 0.5, y: 0.5, pressed: true }], result_error: false }))
await native.stop()
const nativeReceipt = await native.settled()
assert.equal(nativeReceipt.status, "finished", nativeReceipt.error)
const nativeDecoded = join(native.directory, "decoded.png")
await promisify(execFile)(mediaExecutable("ffmpeg"), ["-v", "error", "-ss", "0.2", "-i", nativeReceipt.video, "-frames:v", "1", nativeDecoded])
const originalPixel = await sharp(cleanFrame).extract({ left: 10, top: 10, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
const preservedPixel = await sharp(nativeDecoded).extract({ left: 10, top: 10, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
assert.ok(preservedPixel.every((value, index) => Math.abs(value - originalPixel[index]) < 10), "Transparent cursor composition retains original native pixels")
const cursorPixels = await sharp(nativeDecoded).extract({ left: 315, top: 235, width: 45, height: 50 }).removeAlpha().raw().toBuffer()
assert.ok(cursorPixels.some(value => value > 180), "The dispatched cursor is visible in the video")
const nativeTimeline = JSON.parse(await readFile(nativeReceipt.timeline, "utf8"))
assert.deepEqual(nativeTimeline.pointer, [{ at: 100, x: 320, y: 240, pressed: true }])
await writeFile(join(output, "native-result.json"), JSON.stringify({ passed: true, nativeReceipt, nativeDecoded }, null, 2) + "\n")
console.log(JSON.stringify({ nativePassed: true, video: nativeReceipt.video }))
