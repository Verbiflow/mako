// The Linux video helper (native/video-linux/mako-video.c) through its Node side (`video-helper.ts`) and
// `BrowserVideo`, on an Xvfb screen. Linux with the helper's build dependencies, Xvfb and FFmpeg (whose decoder
// checks the stream; nothing ships it); scripts/test-video-helper.sh runs it in a container from a Mac.
//
//   1. A display: a key frame with its avcC first, then a unit for each change at the asked rate, every one decodable.
//   2. A still screen sends nothing and the helper uses no CPU; a viewer asking again gets a key frame of it.
//   3. A smaller box gives a key frame at that size.
//   4. A window covered by another: its own pixels, never the cover's; its end ends the video.
//   5. Pictures in (a JPEG, raw RGB): one unit each.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { BrowserVideo } from "../packages/control-runtime/dist/browser.js"
import { VideoHelper, helperCapture } from "../packages/control-runtime/dist/desktop.js"
import { decodeControlVideo } from "../packages/control-runtime/dist/contracts/control-video.js"

const repo = resolve(fileURLToPath(import.meta.url), "../..")
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(read, check, what, ms = 10_000) {
  for (const deadline = Date.now() + ms; ; await wait(25)) {
    const value = read()
    if (check(value)) return value
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
  }
}
const helper = "/tmp/mako-video"
execFileSync("sh", ["-c", `gcc -O2 -Wall -Werror -o ${helper} ${join(repo, "native/video-linux/mako-video.c")} $(pkg-config --cflags --libs x11 xext xdamage xfixes xcomposite openh264 libturbojpeg) -lyuv -lm`])
execFileSync("gcc", ["-O2", "-o", "/tmp/xanim", join(repo, "scripts/fixtures/xanim.c"), "-lX11"])
process.env.DISPLAY = ":98"
const children = [spawn("Xvfb", [":98", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: "ignore" })]
await wait(800)
async function app(...args) {
  const child = spawn("/tmp/xanim", args, { stdio: ["ignore", "pipe", "ignore"] })
  children.push(child)
  const id = Number(await new Promise((done) => child.stdout.once("data", (data) => done(data.toString().trim()))))
  return { child, id }
}
/** The helper's CPU seconds, from /proc. */
function helperCpu() {
  let ticks = 0
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").startsWith(helper)) continue
      const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")
      ticks += Number(fields[11]) + Number(fields[12])
    } catch {}
  }
  return ticks / 100
}
/** The units as Annex B, decoded by FFmpeg: the frame count, and the last frame's RGB at a point. */
function decode(packets, at) {
  const parts = []
  for (const packet of packets) {
    if (packet.kind === "key") {
      const d = packet.description, sps = d[6] << 8 | d[7], pps = d[9 + sps] << 8 | d[10 + sps]
      parts.push(Buffer.from([0, 0, 0, 1]), d.subarray(8, 8 + sps), Buffer.from([0, 0, 0, 1]), d.subarray(11 + sps, 11 + sps + pps))
    }
    for (let i = 0; i < packet.data.length;) {
      const length = (packet.data[i] << 24 | packet.data[i + 1] << 16 | packet.data[i + 2] << 8 | packet.data[i + 3]) >>> 0
      parts.push(Buffer.from([0, 0, 0, 1]), packet.data.subarray(i + 4, i + 4 + length))
      i += 4 + length
    }
  }
  writeFileSync("/tmp/check.h264", Buffer.concat(parts))
  const frames = Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", "/tmp/check.h264"], { encoding: "utf8" }).trim())
  const last = packets.at(-1)
  const rgb = execFileSync("ffmpeg", ["-v", "error", "-i", "/tmp/check.h264", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 1 << 30 })
  const frame = rgb.subarray(rgb.length - last.width * last.height * 3)
  const offset = ((at?.[1] ?? 0) * last.width + (at?.[0] ?? 0)) * 3
  return { frames, pixel: [...frame.subarray(offset, offset + 3)], size: [last.width, last.height] }
}
const viewer = (box) => {
  const packets = []
  const state = { box, ended: undefined }
  return {
    packets,
    state,
    handle: { size: () => state.box, backlog: () => 0, send: (bytes) => packets.push(decodeControlVideo(bytes)), ended: (reason) => (state.ended = reason) },
  }
}

try {
  // 1.
  const moving = await app("30", "1280", "800")
  const display = new BrowserVideo({ encoded: helperCapture(helper, { kind: "display" }) }, { fps: 30 })
  const watcher = viewer(undefined)
  const leave = await display.join(watcher.handle)
  await until(() => watcher.packets, (sent) => sent.length > 0, "the first unit")
  assert.equal(watcher.packets[0].kind, "key")
  const before = watcher.packets.length
  await wait(2000)
  const rate = (watcher.packets.length - before) / 2
  assert.ok(rate >= 15 && rate <= 31, `units follow the screen's changes, at most 30 a second: ${rate}`)
  const decoded = decode(watcher.packets)
  assert.equal(decoded.frames, watcher.packets.length, "every unit decodes")
  assert.deepEqual(decoded.size, [1280, 800])
  console.log(`  display: ${rate} units/s at 1280x800, all ${decoded.frames} decode`)

  // 2.
  moving.child.kill("SIGKILL")
  await app("1", "1280", "800", "still")
  await wait(700)
  const stillFrom = watcher.packets.length
  const cpu0 = helperCpu()
  await wait(2000)
  const idleCpu = helperCpu() - cpu0
  assert.ok(watcher.packets.length - stillFrom <= 1, `a still screen sends nothing: ${watcher.packets.length - stillFrom} units in 2 s`)
  assert.ok(idleCpu <= 0.02, `the helper sleeps while nothing changes: ${idleCpu} CPU s in 2 s`)
  display.refresh(watcher.handle)
  await until(() => watcher.packets.slice(stillFrom), (sent) => sent.some((packet) => packet.kind === "key"), "a key frame of the still screen")
  console.log(`  still: 0 units, ${(idleCpu * 50).toFixed(1)}% CPU; a key frame when asked`)

  // 3.
  watcher.state.box = { width: 640, height: 400 }
  const resizedFrom = watcher.packets.length
  await display.resized()
  const small = await until(() => watcher.packets.slice(resizedFrom), (sent) => sent.some((packet) => packet.kind === "key"), "a key frame at the smaller box")
  assert.deepEqual([small.at(-1).width, small.at(-1).height], [640, 400])
  await leave()
  display.close()

  // 4.
  const target = await app("30", "640", "400")
  const windowVideo = new BrowserVideo({ encoded: helperCapture(helper, { kind: "window", windowId: target.id }) }, { fps: 30 })
  const windowWatcher = viewer(undefined)
  await windowVideo.join(windowWatcher.handle)
  await until(() => windowWatcher.packets, (sent) => sent.length > 0, "the window's first unit")
  await app("1", "400", "300", "red")
  await wait(1000)
  const covered = decode(windowWatcher.packets, [100, 200])
  assert.deepEqual(covered.size, [640, 400], "the window's own size")
  assert.notDeepEqual(covered.pixel.map((value) => value > 200), [true, false, false], `the covering window never shows: ${covered.pixel}`)
  target.child.kill("SIGKILL")
  await until(() => windowWatcher.state.ended, Boolean, "the window's end to end the video")
  assert.match(windowWatcher.state.ended, /window closed/)
  console.log(`  window: its own pixels under a cover (${covered.pixel}), its end ends the video`)

  // 5.
  const units = []
  let ended
  const frames = new VideoHelper(helper, { kind: "frames" }, { fps: 30 }, { unit: (packet) => units.push(packet), ended: (reason) => (ended = reason) })
  const jpeg = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240", "-frames:v", "1", "-f", "mjpeg", "pipe:1"])
  frames.picture("jpeg", 7, 1234.5, jpeg)
  await until(() => units, (sent) => sent.length === 1, "a unit for the JPEG")
  assert.deepEqual([units[0].kind, units[0].sequence, units[0].capturedAt, units[0].width, units[0].height], ["key", 7, 1234.5, 320, 240])
  frames.picture("rgb", 8, 1240, Buffer.alloc(100 * 50 * 3, 128), { width: 100, height: 50 })
  await until(() => units, (sent) => sent.length === 2, "a unit for the raw picture")
  assert.deepEqual([units[1].kind, units[1].width, units[1].height], ["key", 100, 50], "a new size starts with a key frame")
  frames.close()
  assert.equal(ended, undefined)
  console.log("video helper passed")
} finally {
  for (const child of children.reverse()) child.kill("SIGKILL")
}
process.exit(0)
