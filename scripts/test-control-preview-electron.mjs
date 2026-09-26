// Private synthetic Electron window, never the user's Mako profile or renderer.
import { app, BrowserWindow, nativeImage } from "electron"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { DeskBrowser } from "../dist-electron/desk-browser.js"
import { deskPageForWindow } from "../dist-electron/desk-browser-window.js"
import { BrowserService } from "../packages/control-runtime/dist/browser-service.js"
import { ControlPreviews } from "../dist-electron/control-previews.js"
import { BrowserCommandSchema } from "../packages/control-runtime/dist/contracts/browser-control.js"
const clips = process.env.CAPTURE_CLIPS !== "0"
const fps = Number(process.env.CAPTURE_FPS ?? 60)
assert.ok(Number.isInteger(fps) && fps >= 1 && fps <= 60)
const root = mkdtempSync(join(tmpdir(), "mako-preview-proof-"))
const output = process.argv[2] ? resolve(process.argv[2]) : root
mkdirSync(output, { recursive: true })
app.setPath("userData", join(root, "profile"))
const watchdog = setTimeout(() => app.exit(2), 60000)
async function main() {
  await app.whenReady()
  app.dock?.hide()
  const desk = new DeskBrowser({ allowsUrl: url => url === "about:blank", createPage: async () => {
    const window = new BrowserWindow({ show: false, width: 1600, height: 1000, enableLargerThanScreen: true, webPreferences: { backgroundThrottling: false } })
    window.setContentSize(1600, 1000)
    await window.loadURL('data:text/html,' + encodeURIComponent(`<style>body{margin:0;font:13px monospace;background:#181b20;color:#e3e8ef;display:grid;grid-template-columns:250px 1fr}aside{background:#222730;padding:20px;line-height:24px}main{padding:20px;position:relative}pre{font:13px/19px monospace;color:#afd4ff}#box{position:absolute;top:36px;width:12px;height:12px;background:#c4ed8f;animation:move 2s linear infinite alternate}@keyframes move{to{transform:translateX(900px)}}button{padding:10px 30px;margin:0 0 16px 30px}</style><aside>Fixture files<br>${Array.from({length:60},(_,i)=>'src/control/fixture-'+i+'.ts').join('<br>')}</aside><main><button>Save</button><div id="box"></div><pre>${Array.from({length:80},(_,i)=>String(i+1).padStart(3)+'  const result = await tab.locator({ role: "button", name: "Save '+i+'" }).click();').join('\n')}</pre></main>`))
    return deskPageForWindow(window)
  } })
  const browser = new BrowserService(() => [desk.definition])
  const run = command => browser.execute("binding-owner", BrowserCommandSchema.parse(command), AbortSignal.timeout(10000))
  let frames = 0, lastId, largestBytes = 0
  const thumbnailTimes = [], deliveryTimes = []
  const previews = new ControlPreviews(browser, image => {
    const start = performance.now()
    const source = nativeImage.createFromBuffer(Buffer.from(image.data, "base64"))
    const size = source.getSize()
    const resized = source.resize({ width: Math.min(size.width, 1440), quality: "good" })
    const result = { data: resized.toJPEG(85).toString("base64"), mimeType: "image/jpeg" }
    thumbnailTimes.push(performance.now() - start)
    return result
  }, () => {
    const value = previews.read("conversation", true)
    if (value?.frame && value.frame.id !== lastId) {
      lastId = value.frame.id; frames++; deliveryTimes.push(performance.now())
      largestBytes = Math.max(largestBytes, value.frame.image.bytes.byteLength)
    }
  })
  try {
    await run({ action: "connect", browser: "mako" })
    const target = await run({ action: "open", browser: "mako" })
    previews.observe({ conversationId: "conversation", kind: "browser", operation: "observe", target: "desk", status: "observed" })
    previews.browserTarget("conversation", target, () => {}, "binding-owner")
    previews.read("conversation", true)
    const cpuBefore = new Map(app.getAppMetrics().map(value => [value.pid, value.cpu.cumulativeCPUUsage ?? 0]))
    const measuredAt = performance.now()
    const recording = await run({ action: "recording", target, operation: "start", options: { directory: output, maxSide: 2560, fps } })
    for (let i = 0; i < (clips ? 5 : 10); i++) {
      await delay(500)
      previews.browserTarget("conversation", { ...target }, () => {}, "binding-owner")
      if (!clips) continue
      if (i % 2 === 0) await run({ action: "screenshot", target, region: { x: 0, y: 0, width: 300, height: 200 }, maxSide: 2048 })
      else await run({ action: "cdp", target, method: "Page.captureScreenshot", params: { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 300, height: 200, scale: 1 } } })
    }
    const frame = previews.read("conversation", true).frame
    writeFileSync(join(output, "preview.jpg"), Buffer.from(frame.image.bytes))
    previews.read("conversation", false)
    const before = frames
    await delay(250)
    assert.equal(frames, before, "Hidden preview stops publishing")
    const captureElapsedMs = performance.now() - measuredAt
    const cpuSeconds = app.getAppMetrics().reduce((sum, value) => sum + Math.max(0, (value.cpu.cumulativeCPUUsage ?? 0) - (cpuBefore.get(value.pid) ?? 0)), 0)
    await run({ action: "recording", target, operation: "stop", id: recording.id })
    let result
    for (let i = 0; i < 300; i++) {
      result = await run({ action: "recording", target, operation: "status", id: recording.id })
      if (!["recording", "finalizing"].includes(result.status)) break
      await delay(100)
    }
    assert.equal(result.status, "finished", result.error)
    assert.ok(frames > 40, `Preview must stream: received ${frames}`)
    const timeline = JSON.parse(readFileSync(result.timeline, "utf8"))
    assert.ok(timeline.frames.every(frame => frame.width === 1600 && frame.height === 1000), "Close-up stills never replace video frames")
    // Read the actual moving marker from decoded video. Encoded frame hashes
    // can differ through compression noise even when source pixels repeat.
    // The independent test decoder is full FFmpeg on PATH. The shipped minimal
    // encoder deliberately has no rawvideo output muxer; do not bloat it for a test.
    const decoder = spawn("ffmpeg", ["-v", "error", "-i", result.video,
      "-an", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] })
    let errors = ""
    decoder.stderr.on("data", chunk => { errors = (errors + chunk.toString()).slice(-4096) })
    const exited = new Promise((done, reject) => { decoder.once("close", done); decoder.once("error", reject) })
    const pixels = Buffer.allocUnsafe(1600 * 1000 * 3)
    let filled = 0, previousMarker, distinctFrames = 0, decodedFrames = 0
    for await (const chunk of decoder.stdout) {
      let offset = 0
      while (offset < chunk.length) {
        const count = Math.min(pixels.length - filled, chunk.length - offset)
        chunk.copy(pixels, filled, offset, offset + count)
        filled += count; offset += count
        if (filled !== pixels.length) continue
        decodedFrames++
        let sum = 0, matches = 0
        for (let x = 250; x < 1500; x++) {
          const at = (40 * 1600 + x) * 3
          if (pixels[at + 1] > 190 && pixels[at + 1] > pixels[at] + 20 && pixels[at + 2] < 190) {
            sum += x; matches++
          }
        }
        if (matches > 3) {
          const marker = Math.round(sum / matches)
          if (marker !== previousMarker) distinctFrames++
          previousMarker = marker
        }
        filled = 0
      }
    }
    assert.equal(await exited, 0, errors)
    assert.equal(filled, 0, "Decoded frames must be complete")
    assert.equal(decodedFrames, result.encodedFrames)
    assert.ok(distinctFrames > frames * 0.7, "Video must contain moving source pixels, not just a high output fps")
    const player = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
    let playback
    try {
      const document = join(root, "playback.html")
      writeFileSync(document, '<video muted></video>')
      await player.loadFile(document)
      playback = await player.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
        const video=document.querySelector('video');
        const timer=setTimeout(()=>reject(new Error('Recording playback timed out')),5000);
        video.onerror=()=>{clearTimeout(timer);reject(new Error('Recording is not playable'))};
        video.onloadeddata=()=>{video.currentTime=video.duration*0.8};
        video.onseeked=()=>{clearTimeout(timer);resolve({width:video.videoWidth,height:video.videoHeight,duration:video.duration,currentTime:video.currentTime})};
        video.src=${JSON.stringify(pathToFileURL(result.video).href)};
      })`)
      assert.equal(playback.width, 1600)
      assert.equal(playback.height, 1000)
      assert.ok(Math.abs(playback.duration * 1000 - result.encodedDurationMs) < 17)
      assert.ok(playback.currentTime > 0)
    } finally { player.destroy() }
    thumbnailTimes.sort((a, b) => a - b)
    const report = { clippedScreenshots: clips ? 5 : 0, requestedFps: fps,
      distinctVideoMarkerFrames: distinctFrames, decodedVideoFrames: decodedFrames,
      videoMarkerFps: distinctFrames * 1000 / result.durationMs, playback,
      captureElapsedMs, electronCpuCoreEquivalent: cpuSeconds * 1000 / captureElapsedMs, electron: process.versions.electron, chrome: process.versions.chrome, frames, deliveredFps: (frames - 1) * 1000 / (deliveryTimes.at(-1) - deliveryTimes[0]), thumbnailReencodes: thumbnailTimes.length, thumbnailMs: { median: thumbnailTimes[Math.floor(thumbnailTimes.length / 2)] ?? 0, p95: thumbnailTimes[Math.floor(thumbnailTimes.length * .95)] ?? 0 }, largestPreviewBytes: largestBytes, recording: result }
    writeFileSync(join(output, "preview-acceptance.json"), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } finally { previews.close(); browser.close(); desk.close() }
}
main().then(() => { clearTimeout(watchdog); app.exit(0) }, error => { console.error(error); clearTimeout(watchdog); app.exit(1) })
