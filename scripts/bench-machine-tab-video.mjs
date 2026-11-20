// A cloud machine's tab as live video: the screencast's JPEGs through the video helper (`frames`; FFmpeg before it) against the
// capture extension's WebCodecs inside the machine's Chromium (`extension`), both through the product's
// `BrowserVideo` to one viewer. Linux with Debian's Chromium (and the video helper for `frames`), after
// `npm run build:control-runtime`. Prints one JSON line.
//
//   node scripts/bench-machine-tab-video.mjs '{"mode":"extension","width":1280,"height":800,"fps":30,"seconds":12,"scene":"moving"}'
import { mkdtemp, readFile, readdir } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { BrowserService, BrowserVideo } from "../packages/control-runtime/dist/browser.js"
import { MACHINE_BROWSER_ID, MachineBrowser, MachineTabVideo, writeMachineCaptureExtension } from "../packages/control-runtime/dist/desktop.js"
import { BrowserCommandSchema, BrowserTargetSchema, decodeControlVideo } from "../packages/control-runtime/dist/contracts.js"

const config = JSON.parse(process.argv[2])
const { mode, width, height, fps, seconds = 12, scene = "moving" } = config
const repo = resolve(fileURLToPath(import.meta.url), "../..")
const root = await mkdtemp(join(tmpdir(), "mako-bench-tab-"))
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10 : null
}
const cgroup = async () => Number(/usage_usec (\d+)/.exec(await readFile("/sys/fs/cgroup/cpu.stat", "utf8"))[1])
async function ticks() {
  const out = {}
  for (const pid of (await readdir("/proc")).filter((name) => /^\d+$/.test(name))) {
    try {
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8")
      const fields = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1].split(" ")
      let kind = /chrom/.test(command) ? (/--type=([\w-]+)/.exec(command)?.[1] ?? "browser") : /ffmpeg/.test(command) ? "ffmpeg" : /node/.test(command) ? "host" : "other"
      if (kind === "renderer" && command.includes("--extension-process")) kind = "extension"
      out[kind] = (out[kind] ?? 0) + Number(fields[11]) + Number(fields[12])
    } catch {}
  }
  return out
}

const PAGE = `<!doctype html><title>bench</title><body style="margin:0;background:#fff;font:14px sans-serif;overflow:hidden">
<canvas id=c style="position:absolute;inset:0;width:100vw;height:100vh"></canvas>
<div id=t style="position:absolute;left:24px;top:24px;width:560px;height:740px;overflow:hidden;color:#222"></div>
<script>
const scene = ${JSON.stringify(scene)}
const c = document.getElementById('c'), x = c.getContext('2d'), t = document.getElementById('t')
t.innerHTML = Array.from({length: 400}, (_, i) => '<div>' + i + ' — the agent opened the settings page and changed the value of field ' + i + ' to something new</div>').join('')
let n = 0
function draw() {
  n++
  const w = c.width = innerWidth * devicePixelRatio, h = c.height = innerHeight * devicePixelRatio
  x.fillStyle = '#f5f5f7'; x.fillRect(0, 0, w, h)
  for (let i = 0; i < 6; i++) { x.fillStyle = 'hsl(' + ((n * 2 + i * 60) % 360) + ',70%,60%)'; x.fillRect((n * 7 + i * 300) % w, (i * 220 + n * 3) % h, 260, 160) }
  x.fillStyle = '#000'; x.font = '28px monospace'; x.fillText('frame ' + n, w - 520, 60)
  t.scrollTop = (n * 2) % 8000
  if (scene === 'busy') { const end = performance.now() + 40; while (performance.now() < end); }
  if (scene !== 'static') requestAnimationFrame(draw)
}
draw()
</script>`
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" })
  response.end(PAGE)
})
await new Promise((done) => server.listen(0, "127.0.0.1", done))

const script = await readFile(join(repo, "packages/host/dist/control/machine-capture.page.mjs"), "utf8")
const machine = new MachineBrowser({
  executable: "/usr/bin/chromium",
  profile: join(root, "profile"),
  sandbox: process.getuid?.() !== 0,
  window: { width, height },
  captureExtension: mode === "extension" ? () => writeMachineCaptureExtension(join(root, "capture"), script) : undefined,
})
const browser = new BrowserService([machine.definition])
const command = (input) => browser.execute("bench", BrowserCommandSchema.parse(input), AbortSignal.timeout(30_000))
const capture = new MachineTabVideo(() => machine.definition.endpoint())
await command({ action: "connect", browser: MACHINE_BROWSER_ID })
const { navigation: _, ...opened } = await command({ action: "open", browser: MACHINE_BROWSER_ID, url: `http://127.0.0.1:${server.address().port}/` })
const target = BrowserTargetSchema.parse(opened)
await wait(1000)
const video = new BrowserVideo(mode === "extension"
  ? { encoded: capture.source(target.tab), poster: (size) => browser.previewPoster("bench", target, () => {}, size) }
  : {
      frames: async ({ frame, ended, size }) => ({
        stop: await browser.previewStream("bench", target, () => {}, frame, ended, size),
        resized: () => browser.previewResized("bench", target),
      }),
    }, { fps })
const stats = { units: 0, bytes: 0, keys: 0, lag: [], first: undefined, firstVideo: undefined, size: undefined }
const joined = performance.now()
const leave = await video.join({
  size: () => ({ width, height }),
  backlog: () => 0,
  send: (bytes) => {
    const packet = decodeControlVideo(bytes)
    stats.first ??= Math.round(performance.now() - joined)
    if (packet.kind === "poster") return
    stats.firstVideo ??= Math.round(performance.now() - joined)
    stats.units++
    stats.bytes += bytes.byteLength
    if (packet.kind === "key") stats.keys++
    stats.size = `${packet.width}x${packet.height}`
    stats.lag.push(Date.now() - packet.capturedAt)
  },
  ended: (reason) => {
    console.error(`ended: ${reason}`)
    process.exit(1)
  },
})
await wait(2000)
Object.assign(stats, { units: 0, bytes: 0, keys: 0, lag: [] })
const [u0, p0, t0] = [await cgroup(), await ticks(), performance.now()]
await wait(seconds * 1000)
const elapsed = (performance.now() - t0) / 1000
const [u1, p1] = [await cgroup(), await ticks()]
console.log(JSON.stringify({
  ...config,
  cpu: Math.round(((u1 - u0) / 1e4 / elapsed) * 10) / 10,
  byProcess: Object.fromEntries(Object.keys(p1).map((kind) => [kind, Math.round(((p1[kind] - (p0[kind] ?? 0)) / elapsed) * 10) / 10]).filter(([, value]) => value >= 0.5)),
  outFps: Math.round((stats.units / elapsed) * 10) / 10,
  kbps: Math.round((stats.bytes * 8) / elapsed / 1000),
  lagMs: { p50: percentile(stats.lag, 50), p95: percentile(stats.lag, 95) },
  firstPaintMs: stats.first,
  firstVideoMs: stats.firstVideo,
  size: stats.size,
}))
await leave()
video.close()
capture.close()
browser.close()
machine.close()
server.close()
process.exit(0)
