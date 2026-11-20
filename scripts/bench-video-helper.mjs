// The Linux video helper (native/video-linux/mako-video.c) against FFmpeg's x11grab and libx264 (Mako's live video
// arguments), on an Xvfb screen with a plain Xlib app. Runs on Linux with the helper's build dependencies, Xvfb and,
// for the `ffmpeg` mode and the decode check, FFmpeg; scripts/bench-video-helper.sh runs it in a container. One JSON
// line per case.
//
//   node scripts/bench-video-helper.mjs '{"mode":"helper|window|ffmpeg|none","width":1280,"height":800,"fps":30,"seconds":12,"scene":"moving|still"}'
import { execFileSync, spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { decodeControlVideo } from "../packages/control-runtime/dist/contracts/control-video.js"
import { liveVideoBitrate } from "../packages/control-runtime/dist/contracts/control-video.js"

const config = JSON.parse(process.argv[2])
const { mode, width, height, fps, seconds = 12, scene = "moving", box, threads, bitrate: asked } = config
const repo = resolve(fileURLToPath(import.meta.url), "../..")
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const cgroup = () => Number(/usage_usec (\d+)/.exec(readFileSync("/sys/fs/cgroup/cpu.stat", "utf8"))[1])
const cpu = (pid) => {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")
    return (Number(fields[11]) + Number(fields[12])) / 100
  } catch {
    return 0
  }
}
const helper = "/tmp/mako-video"
execFileSync("sh", ["-c", `gcc -O2 -o ${helper} ${join(repo, "native/video-linux/mako-video.c")} $(pkg-config --cflags --libs x11 xext xdamage xfixes xcomposite openh264 libturbojpeg) -lyuv -lm`])
execFileSync("gcc", ["-O2", "-o", "/tmp/xanim", join(repo, "scripts/fixtures/xanim.c"), "-lX11"])

const env = { ...process.env, DISPLAY: ":99" }
const children = []
children.push(spawn("Xvfb", [":99", "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp"], { stdio: "ignore" }))
await wait(1000)
const app = spawn("/tmp/xanim", [String(fps), String(width), String(height), ...(scene === "still" ? ["still"] : [])], { env, stdio: ["ignore", "pipe", "ignore"] })
children.push(app)
const windowId = await new Promise((done) => app.stdout.once("data", (data) => done(data.toString().trim())))
await wait(500)

const bitrate = asked ?? liveVideoBitrate(box ?? { width, height }, fps)
let encoder, read = () => ({}), units = 0, bytes = 0, lags = [], stream = []
if (mode === "helper" || mode === "window") {
  const args = [...(mode === "window" ? ["window", windowId] : ["display"]), "--fps", String(fps), "--bitrate", String(bitrate), ...(box ? ["--box", `${box.width}x${box.height}`] : []), ...(threads ? ["--threads", String(threads)] : [])]
  encoder = spawn(helper, args, { env, stdio: ["pipe", "pipe", "pipe"] })
  let buffer = Buffer.alloc(0), summary = ""
  encoder.stderr.on("data", (data) => (summary += data))
  encoder.stdout.on("data", (data) => {
    buffer = Buffer.concat([buffer, data])
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
      const length = buffer.readUInt32BE(0)
      const packet = decodeControlVideo(buffer.subarray(4, 4 + length))
      buffer = buffer.subarray(4 + length)
      units++
      bytes += length
      lags.push(Date.now() - packet.capturedAt)
      stream.push(packet)
    }
  })
  read = async () => {
    encoder.stdin.end()
    await new Promise((done) => encoder.once("exit", done))
    return JSON.parse(summary.trim().split("\n").at(-1))
  }
} else if (mode === "ffmpeg") {
  const { liveVideoEncoding } = await import("../packages/control-runtime/dist/control-media.js")
  encoder = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "x11grab", "-draw_mouse", "0", "-framerate", String(fps), "-video_size", `${width}x${height}`, "-i", ":99",
    ...(box ? ["-vf", `scale=${box.width}:${box.height}:force_original_aspect_ratio=decrease`] : []), ...liveVideoEncoding(box ?? { width, height }, fps), "-f", "h264", "pipe:1"], { env, stdio: ["ignore", "pipe", "inherit"] })
  encoder.stdout.on("data", (data) => (bytes += data.length))
  read = async () => {
    encoder.kill("SIGINT")
    return {}
  }
}
children.push(...(encoder ? [encoder] : []))
await wait(2000)
const [u0, e0, units0, bytes0, t0] = [cgroup(), encoder ? cpu(encoder.pid) : 0, units, bytes, performance.now()]
lags = []
await wait(seconds * 1000)
const elapsed = (performance.now() - t0) / 1000
const [u1, e1] = [cgroup(), encoder ? cpu(encoder.pid) : 0]
const sentUnits = units - units0, sentBytes = bytes - bytes0
const summary = await read()
// Every unit decodes: the stream as Annex B, through FFmpeg's decoder (a check, not a dependency).
let decoded
if (stream.length) {
  const parts = []
  for (const packet of stream) {
    if (packet.kind === "key") {
      const d = packet.description, spsLength = d.readUInt16BE?.(6) ?? (d[6] << 8 | d[7])
      const sps = d.subarray(8, 8 + spsLength), ppsLength = d[9 + spsLength] << 8 | d[10 + spsLength], pps = d.subarray(11 + spsLength, 11 + spsLength + ppsLength)
      parts.push(Buffer.from([0, 0, 0, 1]), sps, Buffer.from([0, 0, 0, 1]), pps)
    }
    for (let at = 0; at < packet.data.length;) {
      const length = (packet.data[at] << 24 | packet.data[at + 1] << 16 | packet.data[at + 2] << 8 | packet.data[at + 3]) >>> 0
      parts.push(Buffer.from([0, 0, 0, 1]), packet.data.subarray(at + 4, at + 4 + length))
      at += 4 + length
    }
  }
  writeFileSync("/tmp/out.h264", Buffer.concat(parts))
  decoded = Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", "/tmp/out.h264"], { encoding: "utf8" }).trim())
}
const sorted = [...lags].sort((a, b) => a - b)
console.log(JSON.stringify({
  ...config,
  bitrateTarget: bitrate,
  containerCpu: Math.round(((u1 - u0) / 1e4 / elapsed) * 10) / 10,
  encoderCpu: encoder ? Math.round(((e1 - e0) / elapsed) * 1000) / 10 : null,
  outFps: mode === "ffmpeg" ? null : Math.round((sentUnits / elapsed) * 10) / 10,
  kbps: Math.round((sentBytes * 8) / elapsed / 1000),
  lagMs: sorted.length ? [sorted[sorted.length >> 1], sorted[Math.floor(sorted.length * 0.95)]] : undefined,
  units: stream.length,
  decoded,
  helper: summary.frames === undefined ? undefined : summary,
}))
for (const child of children.reverse()) child.kill("SIGKILL")
process.exit(0)
