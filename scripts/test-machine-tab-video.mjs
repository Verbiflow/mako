// A cloud machine's tab as live video, encoded inside the machine's own Chromium by its capture extension
// (`packages/control-runtime/src/machine-capture.ts`, `src/live-video/machine-capture.ts`), against a real Chromium.
// Run on Linux with Debian's Chromium, after `npm run build:control-runtime`; scripts/test-machine-tab-video-docker.sh
// runs it in a container from a Mac.
//
//   1. The extension's pages are never listed as tabs.
//   2. A viewer paints the screencast's first frame as a poster, then gets a key frame with its configuration first, sized to its box and shaped like the tab, then a unit
//      for each frame the page paints, at the asked rate, with nothing from the host's screencast.
//   3. A still page sends nothing; a viewer that asks again gets a key frame of the picture as it is.
//   4. The capture follows the tab through a navigation, and a new box changes the picture's size.
//   5. Once the last viewer leaves, the extension stops encoding: its renderer idles.
import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { BrowserService, BrowserVideo } from "../packages/control-runtime/dist/browser.js"
import { MACHINE_BROWSER_ID, MachineBrowser, MachineTabVideo, writeMachineCaptureExtension } from "../packages/control-runtime/dist/desktop.js"
import { BrowserCommandSchema, BrowserTargetSchema, controlVideoCodec, decodeControlVideo } from "../packages/control-runtime/dist/contracts.js"

const repo = resolve(fileURLToPath(import.meta.url), "../..")
const root = await mkdtemp(join(tmpdir(), "mako-machine-tab-video-"))
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(read, check, what, ms = 10_000) {
  for (const deadline = Date.now() + ms; ; await wait(50)) {
    const value = await read()
    if (check(value)) return value
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
  }
}
/** CPU seconds of the extension's renderer, the process its offscreen document runs in, and its resident memory. */
let extensionRss = 0
async function extensionCpu() {
  let ticks = 0
  for (const pid of (await readdir("/proc")).filter((name) => /^\d+$/.test(name))) {
    try {
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8")
      if (!command.includes("--extension-process")) continue
      const fields = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1].split(" ")
      ticks += Number(fields[11]) + Number(fields[12])
      extensionRss = Number(/VmRSS:\s+(\d+)/.exec(await readFile(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) / 1024
    } catch {}
  }
  return ticks / 100
}

const PAGE = (label) => `<!doctype html><title>${label}</title><body style="margin:0;background:#fff">
<canvas id=c style="position:fixed;inset:0;width:100vw;height:100vh"></canvas><script>
const c = document.getElementById("c"), x = c.getContext("2d")
let n = 0, moving = true
function draw() { n++; c.width = innerWidth; c.height = innerHeight; x.fillStyle = "hsl(" + (n * 5 % 360) + ",70%,60%)"; x.fillRect(0, 0, c.width, c.height); x.fillStyle = "#000"; x.font = "40px sans-serif"; x.fillText("${label} " + n, 40, 80); if (moving) requestAnimationFrame(draw) }
window.hold = () => { moving = false }
draw()
</script>`
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html" })
  response.end(PAGE(request.url === "/second" ? "second" : "first"))
})
await new Promise((done) => server.listen(0, "127.0.0.1", done))
const origin = `http://127.0.0.1:${server.address().port}`

const script = await readFile(join(repo, "packages/host/dist/control/machine-capture.page.mjs"), "utf8")
const machine = new MachineBrowser({
  executable: "/usr/bin/chromium",
  profile: join(root, "profile"),
  sandbox: process.getuid?.() !== 0,
  captureExtension: () => writeMachineCaptureExtension(join(root, "capture"), script),
})
const browser = new BrowserService([machine.definition])
const command = (input) => browser.execute("test", BrowserCommandSchema.parse(input), AbortSignal.timeout(30_000))
const capture = new MachineTabVideo(() => machine.definition.endpoint())
try {
  await command({ action: "connect", browser: MACHINE_BROWSER_ID })
  const { navigation, ...opened } = await command({ action: "open", browser: MACHINE_BROWSER_ID, url: `${origin}/first` })
  assert.ok(!navigation?.fault, `the page loads: ${JSON.stringify(navigation?.fault)}`)
  const target = BrowserTargetSchema.parse(opened)

  // 1.
  const tabs = await command({ action: "tabs", browser: MACHINE_BROWSER_ID })
  assert.ok(tabs.length > 0 && tabs.every((tab) => !tab.url.startsWith("chrome-extension://")), `no extension page is a tab: ${tabs.map((tab) => tab.url).join(", ")}`)

  // 2.
  let screencast = 0
  const video = new BrowserVideo({
    encoded: capture.source(target.tab),
    poster: (size) => browser.previewPoster("test", target, () => {}, size),
    frames: async () => {
      screencast++
      return { stop: async () => {}, resized: async () => {} }
    },
  }, { fps: 30 })
  let box = { width: 640, height: 400 }
  const packets = []
  const viewer = {
    size: () => box,
    backlog: () => 0,
    send: (bytes) => packets.push({ ...decodeControlVideo(bytes), at: performance.now(), arrived: Date.now() }),
    ended: (reason) => assert.fail(`the live video ended: ${reason}`),
  }
  const joined = performance.now()
  const leave = await video.join(viewer)
  const first = await until(() => packets, (sent) => sent.some((packet) => packet.kind === "key"), "the first key frame")
  assert.equal(first[0].kind, "poster", "the viewer paints the tab's picture before the first key frame")
  const key = first.find((packet) => packet.kind === "key")
  assert.ok(first[0].at < key.at)
  assert.match(controlVideoCodec(key.description), /^avc1\./)
  assert.ok(key.width <= 640 && key.height <= 400, `the picture fits the box: ${key.width}x${key.height}`)
  // The capture follows the tab's size, which can settle a moment after it starts (a headless window's first layout).
  await wait(1000)
  const [width, height] = JSON.parse(JSON.stringify(await command({ action: "evaluate", target, expression: "JSON.stringify([innerWidth, innerHeight])" })).match(/\[\d+,\d+\]/)[0])
  const settled = packets.findLast((packet) => packet.kind === "key")
  assert.ok(Math.abs(settled.width / settled.height - width / height) < 0.03, `the picture is the tab's shape (${width}x${height}), not letterboxed: ${settled.width}x${settled.height}`)
  const firstKeyMs = Math.round(key.at - joined)
  const posterMs = Math.round(first[0].at - joined)
  const start = packets.length
  await wait(2000)
  const rate = (packets.length - start) / 2
  assert.ok(rate >= 25 && rate <= 33, `about 30 units a second while the page paints: ${rate}`)
  assert.equal(screencast, 0, "the screencast never encoded")
  const lag = packets.slice(start).map((packet) => packet.arrived - packet.capturedAt)
  console.log(`  poster in ${posterMs} ms, first key frame in ${firstKeyMs} ms; ${rate} units/s at ${key.width}x${key.height}`)

  // 3.
  await command({ action: "evaluate", target, expression: "hold()" })
  await wait(500)
  const still = packets.length
  await wait(2000)
  assert.ok(packets.length - still <= 1, `a still page sends nothing: ${packets.length - still} units in 2 s`)
  video.refresh(viewer)
  const asked = await until(() => packets.slice(still), (sent) => sent.some((packet) => packet.kind === "key"), "a key frame of the still picture")
  assert.equal(asked.find((packet) => packet.kind === "key").kind, "key")

  // 4.
  const navigated = await command({ action: "navigate", target, url: `${origin}/second` })
  assert.ok(!navigated.navigation?.fault)
  const afterNavigation = packets.length
  await wait(1500)
  assert.ok(packets.length - afterNavigation >= 30, `the capture followed the tab: ${packets.length - afterNavigation} units after it navigated`)
  box = { width: 320, height: 200 }
  await video.resized()
  const smaller = await until(() => packets.slice(afterNavigation), (sent) => sent.some((packet) => packet.width <= 320 && packet.height <= 200 && packet.kind === "key"), "a key frame at the new box")
  assert.ok(smaller.length > 0)

  // 5.
  await leave()
  video.close()
  await wait(500)
  const idle0 = await extensionCpu()
  await wait(2000)
  const idle = (await extensionCpu()) - idle0
  assert.ok(idle < 0.06, `the extension idles once nobody watches: ${idle.toFixed(2)} CPU s in 2 s`)
  console.log(`  ${lag.length} units, capture to viewer p50 ${lag.sort((a, b) => a - b)[lag.length >> 1]} ms; idle extension ${(idle / 2 * 100).toFixed(1)}% CPU, ${Math.round(extensionRss)} MB resident`)
  console.log("machine tab video passed")
} finally {
  capture.close()
  browser.close()
  machine.close()
  server.close()
}
