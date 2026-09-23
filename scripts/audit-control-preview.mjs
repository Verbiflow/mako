// Measures the real viewer's composited pixels, not IPC callbacks or <img> load events.
// Offscreen Electron composition is not a physical display or installed-host claim.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

if (process.versions.electron) {
  const { app } = await import("electron")
  void audit().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
} else {
  const { build, preview } = await import("vite")
  const baseline = process.argv.includes("--baseline")
  const root = await mkdtemp(join(tmpdir(), "mako-preview-latency-"))
  const config = {
    plugins: baseline ? [{ name: "original-preview-image", enforce: "pre", transform(source, id) {
      if (!id.endsWith("/src/components/inspector/control-preview-image.tsx")) return
      assert.ok(source.includes("createControlPreviewPainter"))
      return `export function ControlPreviewImage({frame,label,className}) { return <img src={\`data:\${frame.image.mimeType};base64,\${frame.image.data}\`} alt={label} className={className} decoding="async" /> }`
    } }] : [],
    cacheDir: join(root, "cache"),
    build: { outDir: join(root, "dist"), rolldownOptions: { input: resolve("scripts/control-preview-performance.html") } },
    preview: { host: "127.0.0.1", port: 0, strictPort: false },
    logLevel: "warn",
  }
  await build(config)
  const server = await preview(config)
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-preview-audit", main: fileURLToPath(import.meta.url) }))
  const viewers = process.argv.includes("--two-viewers") ? 2 : 1
  const env = { ...process.env, MAKO_PREVIEW_AUDIT_ROOT: root, MAKO_PREVIEW_BASELINE: baseline ? "1" : "0", MAKO_PREVIEW_RECORDING: process.argv.includes("--recording") ? "1" : "0", MAKO_PREVIEW_AUDIT_URL: `${server.resolvedUrls.local[0]}scripts/control-preview-performance.html?viewers=${viewers}` }
  delete env.ELECTRON_RUN_AS_NODE
  const { default: electron } = await import("electron")
  try {
    const child = spawn(electron, [root], { env, stdio: "inherit" })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", code => resolve(code ?? 1))
    })
  } finally { await new Promise(resolve => server.httpServer.close(resolve)) }
  console.log(`Preview measurement artifacts: ${root}`)
}

async function audit() {
  const { app, BrowserWindow, ipcMain } = await import("electron")
  const { DeskBrowser } = await import("../dist-electron/desk-browser.js")
  const { deskPageForWindow } = await import("../dist-electron/desk-browser-window.js")
  const { BrowserService } = await import("@mako/control-runtime/browser")
  const { ControlPreviews } = await import("../dist-electron/control-previews.js")
  const { BrowserCommandSchema } = await import("@mako/control-runtime/contracts")
  const root = process.env.MAKO_PREVIEW_AUDIT_ROOT
  assert.ok(root)
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  if (process.platform === "darwin") app.setActivationPolicy("prohibited")
  const watchdog = setTimeout(() => app.exit(2), 90_000)
  const viewer = new BrowserWindow({ show: false, width: 640, height: 480,
    webPreferences: { offscreen: true, backgroundThrottling: false, preload: resolve("dist-electron/preload.cjs") } })
  viewer.webContents.setFrameRate(60)
  let source, captureStarts = 0, captureStops = 0
  const desk = new DeskBrowser({ allowsUrl: url => url === "about:blank", createPage: async () => {
    source = new BrowserWindow({ show: false, width: 1920, height: 1080, enableLargerThanScreen: true,
      webPreferences: { backgroundThrottling: false } })
    source.setContentSize(1920, 1080)
    await source.loadURL(`data:text/html,${encodeURIComponent(fixtureHTML())}`)
    const page = deskPageForWindow(source)
    return { ...page, send(method, params) {
      if (method === "Page.startScreencast") captureStarts++
      if (method === "Page.stopScreencast") captureStops++
      return page.send(method, params)
    } }
  } })
  const browser = new BrowserService(() => [desk.definition])
  const run = command => browser.execute("preview-audit", BrowserCommandSchema.parse(command), AbortSignal.timeout(10_000))
  let notifications = 0, reads = 0, bytes = 0
  const previews = new ControlPreviews(browser, image => image, activity => {
    notifications++
    viewer.webContents.send("mako:event", { type: "control-activity", activity })
  })
  ipcMain.handle("mako:control-preview", (_event, id, watching, watcher) => {
    const value = previews.read(id, watching, watcher)
    if (!watching) return null
    reads++; bytes += JSON.stringify(value).length
    return value
  })
  const samples = [], latencies = { click: [], type: [], scroll: [] }
  let rectangle, lastSequence, lastAck = 0, pendingInput, paints = 0, invalid = 0
  viewer.webContents.on("paint", (_event, _dirty, image) => {
    const now = performance.now() // Same process/clock as input dispatch below.
    if (!rectangle) return
    paints++
    const pixels = image.toBitmap(), { width, height } = image.getSize()
    assert.equal(pixels.length, width * height * 4)
    const scale = width / 640
    const y = Math.floor((rectangle.y + rectangle.width * 450 / 1920) * scale)
    const words = []
    for (let byte = 0; byte < 6; byte++) {
      let value = 0
      for (let bit = 0; bit < 8; bit++) {
        const x = Math.floor((rectangle.x + rectangle.width * ((byte * 8 + bit + .5) / 48)) * scale)
        const offset = (y * width + x) * 4
        value = (value << 1) | (pixels[offset] > 127 ? 1 : 0)
      }
      words.push(value)
    }
    if (words[4] !== 165 || words[5] !== (words[0] ^ words[1] ^ words[2] ^ words[3] ^ 165)) { invalid++; return }
    const sequence = words[0] * 256 + words[1], ack = words[2] * 256 + words[3]
    if (sequence !== lastSequence) { samples.push({ sequence, at: now }); lastSequence = sequence }
    lastAck = ack
    if (pendingInput && ack === pendingInput.ack) {
      latencies[pendingInput.kind].push(now - pendingInput.at)
      pendingInput = undefined
    }
  })
  const until = async (check, label) => {
    const deadline = performance.now() + 10_000
    while (!await check()) {
      if (performance.now() >= deadline) {
        await writeFile(join(root, "failure.png"), (await viewer.webContents.capturePage()).toPNG())
        console.error({ rectangle, paints, invalid, notifications, reads, samples: samples.slice(-3) })
        assert.fail(`Timed out: ${label}`)
      }
      await delay(10)
    }
  }
  try {
    await viewer.loadURL(process.env.MAKO_PREVIEW_AUDIT_URL)
    await run({ action: "connect", browser: "mako" })
    const target = await run({ action: "open", browser: "mako" })
    previews.observe({ conversationId: "preview-audit", kind: "browser", operation: "observe", target: "fixture", status: "observed" })
    previews.browserTarget("preview-audit", target, () => {})
    await until(async () => {
      rectangle = await viewer.webContents.executeJavaScript(`(()=>{const image=document.querySelector('canvas, img');if(!image || !(image.width>300 || image.naturalWidth))return null;const r=image.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width}})()`)
      return rectangle
    }, "production preview image")
    await delay(2000)
    if (process.env.MAKO_PREVIEW_BASELINE !== "1") assert.ok(samples.length > 10, "Valid composited pixel sequence")
    let recording = process.env.MAKO_PREVIEW_RECORDING === "1"
      ? await run({ action: "recording", target, operation: "start", options: { directory: join(root, "recording"), fps: 60, maxSide: 1920 } })
      : undefined
    samples.length = 0; paints = 0; invalid = 0; reads = 0; bytes = 0; notifications = 0
    const cpuBefore = new Map(app.getAppMetrics().map(value => [value.pid, value.cpu.cumulativeCPUUsage ?? 0]))
    const started = performance.now()
    await delay(4000)
    const elapsed = performance.now() - started
    const animated = samples.splice(0)
    const cpuSeconds = app.getAppMetrics().reduce((sum, value) => sum + Math.max(0, (value.cpu.cumulativeCPUUsage ?? 0) - (cpuBefore.get(value.pid) ?? 0)), 0)
    const transfer = { reads, bytes, notifications }
    const gaps = animated.slice(1).map((frame, index) => frame.at - animated[index].at)
    const animation = { elapsedMs: elapsed, distinctFrames: animated.length, fps: animated.length > 1 ? (animated.length - 1) * 1000 / (animated.at(-1).at - animated[0].at) : 0, gapsMs: stats(gaps), ...transfer, cpuCoreEquivalent: cpuSeconds * 1000 / elapsed, paints, invalidPixelSamples: invalid }
    await writeFile(join(root, "animation.json"), JSON.stringify(animation, null, 2))
    if (process.env.MAKO_PREVIEW_BASELINE === "1") {
      console.log(JSON.stringify({ mode: "original async img", animated: animation }, null, 2))
      return
    }
    assert.ok(animation.fps > 45, `Composited unique fps: ${animation.fps}`)
    assert.equal(invalid, 0, "Every sampled image contains valid fixture pixels")
    for (const kind of ["click", "type", "scroll"]) {
      if (kind === "type") await run({ action: "click", target, at: { x: 400, y: 50 } })
      for (let i = 0; i < 12; i++) {
        // Arming changes no pixels: the trusted input's DOM event paints the acknowledgment.
        const ack = await source.webContents.executeJavaScript("++window.fixture.nextAck")
        pendingInput = { kind, ack, at: performance.now() }
        if (kind === "click") await run({ action: "click", target, at: { x: 100, y: 50 } })
        else if (kind === "type") await run({ action: "type", target, text: "a" })
        else await run({ action: "scroll", target, at: { x: 1000, y: 800 }, deltaY: 70 })
        await until(() => !pendingInput, `${kind} visible acknowledgment ${ack}, last ${lastAck}`)
      }
    }
    const oracle = await source.webContents.executeJavaScript("({clicks:fixture.clicks,text:document.querySelector('input').value,scroll:document.querySelector('main').scrollTop})")
    assert.equal(oracle.clicks, 12)
    assert.equal(oracle.text, "a".repeat(12))
    assert.ok(oracle.scroll > 0)
    await source.webContents.executeJavaScript("fixture.paused=true")
    await delay(500)
    samples.length = 0
    await delay(1000)
    assert.equal(samples.length, 0, "Static pixels cannot inflate displayed fps")
    const fidelity = await viewer.webContents.executeJavaScript("previewAudit.fidelity()")
    assert.equal(fidelity.length, new URL(process.env.MAKO_PREVIEW_AUDIT_URL).searchParams.get("viewers") === "2" ? 2 : 1)
    for (const image of fidelity) {
      assert.deepEqual([image.width, image.height], [1920, 1080])
      assert.equal(image.differences, 0, "Viewer retains every decoded source pixel")
      assert.equal(image.bytes, 1920 * 1080 * 4)
    }
    await writeFile(join(root, "viewer.png"), (await viewer.webContents.capturePage()).toPNG())
    await writeFile(join(root, "source.png"), (await source.webContents.capturePage()).toPNG())
    assert.equal(captureStarts, 1, "All viewers and recording share the same capture")
    const consumers = fidelity.length
    if (consumers === 2) {
      await viewer.webContents.executeJavaScript(`document.querySelector('[aria-label="Hide preview"]').click()`)
      await delay(100)
      assert.equal(captureStops, 0, "Closing one viewer preserves its sibling")
    }
    await viewer.webContents.executeJavaScript(`document.querySelector('[aria-label="Hide preview"]').click()`)
    await delay(100)
    if (recording) {
      assert.equal(captureStops, 0, "Closing every viewer preserves recording")
      await run({ action: "recording", target, operation: "stop", id: recording.id })
      await until(async () => {
        recording = await run({ action: "recording", target, operation: "status", id: recording.id })
        return !["recording", "finalizing"].includes(recording.status)
      }, "recording finalization")
      assert.equal(recording.status, "finished", recording.error)
    }
    await until(() => captureStops === 1, "last consumer stops capture")
    const report = {
      boundary: "production browser capture → ControlPreviews → Electron IPC/preload → production React overlay → offscreen compositor pixels",
      clock: "input dispatch and compositor delivery use the same main-process performance.now; excludes physical display scanout",
      dimensions: { source: [1920, 1080], preview: rectangle }, electron: process.versions.electron,
      animated: animation,
      inputToVisibleMs: Object.fromEntries(Object.entries(latencies).map(([key, values]) => [key, stats(values)])),
      oracle, fidelity, consumers, captureStarts, captureStops, recording,
      paints, invalidPixelSamples: invalid,
    }
    await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } finally {
    previews.close(); browser.close(); desk.close(); viewer.destroy()
    ipcMain.removeHandler("mako:control-preview"); clearTimeout(watchdog)
  }
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return { count: sorted.length, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))], max: sorted.at(-1) }
}

function fixtureHTML() { return `<style>body{margin:0;background:#181b20;color:#dbe5ef;font:14px monospace}button,input{position:absolute;top:20px;height:60px}button{left:20px;width:180px}input{left:300px;width:400px}canvas{position:fixed;top:400px;left:0}main{position:absolute;top:600px;height:450px;width:1900px;overflow:auto}pre{font:14px/21px monospace}</style>
<button>Save</button><input><canvas width="1920" height="100"></canvas><main><pre>${Array.from({ length: 300 }, (_, i) => `${i}  const result = await tab.locator({ role: "button", name: "Save ${i}" }).click(); // independently checked text`).join("\n")}</pre></main>
<script>
window.fixture={sequence:0,nextAck:0,ack:0,clicks:0,paused:false};
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
function paint(){const f=fixture;const words=[f.sequence>>8,f.sequence&255,f.ack>>8,f.ack&255,165];words.push(words.reduce((a,b)=>a^b,0));words.forEach((value,byte)=>{for(let bit=0;bit<8;bit++){ctx.fillStyle=value&(1<<(7-bit))?'white':'black';ctx.fillRect((byte*8+bit)*40,0,40,100)}})}
function ack(){fixture.ack=fixture.nextAck;paint()}
document.querySelector('button').onclick=()=>{fixture.clicks++;ack()};document.querySelector('input').oninput=ack;document.querySelector('main').onscroll=ack;
function animate(){if(!fixture.paused){fixture.sequence=(fixture.sequence+1)&65535;paint()}requestAnimationFrame(animate)}animate();
</script>`

}
