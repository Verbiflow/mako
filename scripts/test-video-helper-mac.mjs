// The Mac video helper (native/video-macos/main.swift) through its Node side (`video-helper.ts`) and `BrowserVideo`:
// ScreenCaptureKit and VideoToolbox, no FFmpeg. Run on a Mac after `npm run build:control-runtime`, with the screen
// awake and unlocked and Screen Recording allowed for the app running it (the terminal, or Mako): it says which, and
// skips the capture checks, when it isn't.
//
//   node scripts/test-video-helper-mac.mjs
//
//   1. Pictures in (a JPEG, raw RGB): one unit each, a key frame with its avcC at each new size.
//   2. An app's window (an AppKit fixture): a key frame first, a unit for each change at the asked rate, nothing while
//      it's still and a key frame when asked, a smaller box, its end ending the video.
//   3. Another app's window and the whole display, captured as they are.
// Every unit is checked to decode where FFmpeg's ffprobe is on PATH (a check, not a dependency).
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { BrowserVideo } from "../packages/control-runtime/dist/browser.js"
import { VideoHelper, helperCapture } from "../packages/control-runtime/dist/desktop.js"
import { decodeControlVideo } from "../packages/control-runtime/dist/contracts/control-video.js"

const repo = resolve(fileURLToPath(import.meta.url), "../..")
const scratch = mkdtempSync(join(tmpdir(), "mako-video-mac-"))
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(read, check, what, ms = 10_000) {
  for (const deadline = Date.now() + ms; ; await wait(25)) {
    const value = read()
    if (check(value)) return value
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
  }
}
const helper = join(scratch, "mako-video")
execFileSync("xcrun", ["swiftc", "-O", "-target", "arm64-apple-macos14", "-o", helper, join(repo, "native/video-macos/main.swift")], { stdio: ["ignore", "ignore", "inherit"] })
const fixture = join(scratch, "mac-anim")
execFileSync("xcrun", ["swiftc", "-O", "-o", fixture, join(repo, "scripts/fixtures/mac-anim.swift")], { stdio: ["ignore", "ignore", "inherit"] })
const children = []
const ffprobe = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v ffprobe"], { encoding: "utf8" }).trim() || undefined
  } catch {
    return undefined
  }
})()
/** How many of the units decode, through FFmpeg where it's installed; null where it isn't. */
function decodable(packets) {
  if (!ffprobe) return null
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
  const file = join(scratch, "check.h264")
  writeFileSync(file, Buffer.concat(parts))
  return Number(execFileSync(ffprobe, ["-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file], { encoding: "utf8" }).trim())
}
const viewer = (box) => {
  const packets = []
  const state = { box, ended: undefined }
  return { packets, state, handle: { size: () => state.box, backlog: () => 0, send: (bytes) => packets.push(decodeControlVideo(bytes)), ended: (reason) => (state.ended = reason) } }
}

try {
  // 1.
  const units = []
  const frames = new VideoHelper(helper, { kind: "frames" }, { fps: 30 }, { unit: (packet) => units.push(packet), ended: (reason) => assert.fail(reason) })
  const sharp = (await import("sharp")).default
  const jpeg = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg().toBuffer()
  frames.picture("jpeg", 7, 1234.5, jpeg)
  await until(() => units, (sent) => sent.length === 1, "a unit for the JPEG")
  assert.deepEqual([units[0].kind, units[0].sequence, units[0].capturedAt, units[0].width, units[0].height], ["key", 7, 1234.5, 320, 240])
  assert.equal(units[0].description[0], 1, "an avcC record")
  frames.picture("rgb", 8, 1240, Buffer.alloc(100 * 50 * 3, 128), { width: 100, height: 50 })
  await until(() => units, (sent) => sent.length === 2, "a unit for the raw picture")
  assert.deepEqual([units[1].kind, units[1].width, units[1].height], ["key", 100, 50])
  frames.close()
  console.log(`  pictures: JPEG and raw RGB encoded by VideoToolbox; ${decodable([units[1]]) ?? "no ffprobe to"} decode`)

  // 2.
  const app = spawn(fixture, ["30", "640", "400"], { stdio: ["ignore", "pipe", "ignore"] })
  children.push(app)
  const windowId = Number(await new Promise((done) => app.stdout.once("data", (data) => done(data.toString().trim()))))
  await wait(500)
  const windowVideo = new BrowserVideo({ encoded: helperCapture(helper, { kind: "window", windowId }) }, { fps: 30 })
  const watcher = viewer(undefined)
  let leave
  try {
    leave = await windowVideo.join(watcher.handle)
    await until(() => watcher.packets, (sent) => sent.length > 0, "the window's first unit", 5_000)
  } catch (error) {
    const message = String(error?.message ?? error)
    console.log(`  SKIPPED window and display capture: ${message}. Allow Screen Recording for the app running this (System Settings › Privacy & Security › Screen & System Audio Recording) with the screen awake and unlocked.`)
    process.exit(0)
  }
  assert.equal(watcher.packets[0].kind, "key")
  const from = watcher.packets.length
  await wait(2000)
  const rate = (watcher.packets.length - from) / 2
  assert.ok(rate >= 20 && rate <= 31, `units follow the window's changes at most 30 a second: ${rate}`)
  const [width, height] = [watcher.packets[0].width, watcher.packets[0].height]
  const decoded = decodable(watcher.packets)
  if (decoded !== null) assert.equal(decoded, watcher.packets.length, "every unit decodes")
  console.log(`  window: ${rate} units/s at ${width}x${height}${decoded === null ? "" : `, all ${decoded} decode`}`)
  app.kill("SIGKILL")
  await until(() => watcher.state.ended, Boolean, "the window's end to end the video")
  await leave?.()
  windowVideo.close()

  const stillApp = spawn(fixture, ["1", "640", "400", "still"], { stdio: ["ignore", "pipe", "ignore"] })
  children.push(stillApp)
  const stillId = Number(await new Promise((done) => stillApp.stdout.once("data", (data) => done(data.toString().trim()))))
  await wait(500)
  const stillVideo = new BrowserVideo({ encoded: helperCapture(helper, { kind: "window", windowId: stillId }) }, { fps: 30 })
  const stillWatcher = viewer(undefined)
  const leaveStill = await stillVideo.join(stillWatcher.handle)
  await wait(1000)
  const stillFrom = stillWatcher.packets.length
  await wait(2000)
  assert.ok(stillWatcher.packets.length - stillFrom <= 1, `a still window sends nothing: ${stillWatcher.packets.length - stillFrom} units in 2 s`)
  stillVideo.refresh(stillWatcher.handle)
  await until(() => stillWatcher.packets.slice(stillFrom), (sent) => sent.some((packet) => packet.kind === "key"), "a key frame of the still window")
  stillWatcher.state.box = { width: 320, height: 200 }
  const resizedFrom = stillWatcher.packets.length
  await stillVideo.resized()
  stillVideo.refresh(stillWatcher.handle)
  const small = await until(() => stillWatcher.packets.slice(resizedFrom), (sent) => sent.some((packet) => packet.kind === "key" && packet.width <= 320), "a key frame at the smaller box")
  console.log(`  still window: nothing sent, a key frame when asked, ${small.at(-1).width}x${small.at(-1).height} at a 320x200 box`)
  await leaveStill()
  stillVideo.close()

  // 3.
  const others = JSON.parse(execFileSync(fixture, ["list"], { encoding: "utf8" }))
  const other = others.find((window) => window.owner !== "mac-anim")
  if (other) {
    const otherVideo = new BrowserVideo({ encoded: helperCapture(helper, { kind: "window", windowId: other.id }) }, { fps: 30 })
    const otherWatcher = viewer({ width: 1280, height: 800 })
    const leaveOther = await otherVideo.join(otherWatcher.handle)
    otherVideo.refresh(otherWatcher.handle)
    await until(() => otherWatcher.packets, (sent) => sent.some((packet) => packet.kind === "key"), `a key frame of ${other.owner}'s window`)
    console.log(`  ${other.owner}'s window: ${otherWatcher.packets.at(-1).width}x${otherWatcher.packets.at(-1).height}`)
    await leaveOther()
    otherVideo.close()
  }
  const display = new BrowserVideo({ encoded: helperCapture(helper, { kind: "display" }) }, { fps: 30 })
  const displayWatcher = viewer({ width: 1920, height: 1200 })
  const leaveDisplay = await display.join(displayWatcher.handle)
  display.refresh(displayWatcher.handle)
  await until(() => displayWatcher.packets, (sent) => sent.some((packet) => packet.kind === "key"), "a key frame of the display")
  console.log(`  display: ${displayWatcher.packets.at(-1).width}x${displayWatcher.packets.at(-1).height}`)
  await leaveDisplay()
  display.close()
  console.log("mac video helper passed")
} finally {
  for (const child of children) child.kill("SIGKILL")
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(0)
