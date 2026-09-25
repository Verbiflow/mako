// The production native preview component, fed by the installed host's exact
// authorized window. Offscreen presentation is not physical display scanout.
import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

export async function startInstalledNativePreview(options) {
  const { preview } = await import("vite")
  const server = await preview({ configFile: false, build: { outDir: resolve(options.dist) }, preview: { host: "127.0.0.1", port: 0 }, logLevel: "warn" })
  const { default: electron } = await import("electron")
  const env = { ...process.env, MAKO_NATIVE_PREVIEW: JSON.stringify({ ...options, url: `${server.resolvedUrls.local[0]}scripts/control-preview-performance.html?viewers=2` }) }
  delete env.ELECTRON_RUN_AS_NODE
  const child = fork(fileURLToPath(import.meta.url), [], { execPath: electron, env, stdio: ["ignore", "inherit", "inherit", "ipc"] })
  let resolveReady, rejectReady, report
  const ready = new Promise((yes, no) => { resolveReady = yes; rejectReady = no })
  child.on("message", message => {
    if (message.ready) resolveReady()
    if (message.report) report = message.report
  })
  const done = new Promise((yes, no) => {
    child.once("error", no)
    child.once("exit", code => code === 0 && report ? yes(report) : no(new Error(`Native preview fixture exited ${code}`)))
  }).finally(() => new Promise(done => server.httpServer.close(done)))
  void done.catch(rejectReady)
  const startup = setTimeout(() => { rejectReady(new Error("Native preview startup timed out")); child.kill("SIGTERM") }, 45000)
  try { await ready } finally { clearTimeout(startup) }
  return { done, pid: child.pid, stop: () => child.kill("SIGTERM") }
}

if (process.versions.electron && process.env.MAKO_NATIVE_PREVIEW) {
  // Do not await app.whenReady at module scope: Electron waits for its ESM
  // entrypoint to finish loading before emitting ready.
  void runNativePreview().catch(error => { console.error(error); process.exit(1) })
}

async function runNativePreview() {
  const { app, BrowserWindow, ipcMain } = await import("electron")
  const { invokeRuntime, invokeRuntimePreview, subscribeRuntime } = await import("../../dist-electron/runtime-connection.js")
  const options = JSON.parse(process.env.MAKO_NATIVE_PREVIEW)
  app.setPath("userData", join(options.root, "native-viewer-profile"))
  await app.whenReady()
  app.setActivationPolicy("prohibited")
  const window = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { offscreen: true, backgroundThrottling: false, preload: resolve("dist-electron/preload.cjs") } })
  window.webContents.setFrameRate(60)
  const client = randomUUID(), watchers = new Set()
  const read = (watching, watcher) => invokeRuntimePreview(options.socket, client, [options.conversation, watching, watcher])
  ipcMain.handle("mako:control-preview", async (_event, _id, watching, watcher) => {
    if (watching) watchers.add(watcher); else watchers.delete(watcher)
    return read(watching, watcher)
  })
  ipcMain.handle("mako:control-preview-source", () => invokeRuntime(options.socket, client, "mako:control-preview-source", [options.conversation]))
  const emit = activity => window.webContents.send("mako:event", { type: "control-activity", activity: { ...activity, conversationId: "preview-audit" } })
  const unsubscribe = subscribeRuntime(options.socket, client, packet => {
    if (packet.channel === "event" && packet.payload.type === "control-activity" && packet.payload.activity.conversationId === options.conversation)
      emit(packet.payload.activity)
  }, () => {}, { observer: true })
  const watchdog = setTimeout(() => app.exit(2), 45000)
  let failed = false
  try {
    await window.loadURL(options.url)
    const initial = await read(true, "native-audit-startup")
    await read(false, "native-audit-startup")
    assert.ok(initial?.window, "Installed host must authorize a native target")
    assert.equal(initial.window.pid, options.target.pid)
    assert.equal(initial.window.windowId, options.target.window_id)
    emit(initial.activity)
    const deadline = Date.now() + 10000
    let ready = false
    while (Date.now() < deadline) {
      ready = await window.webContents.executeJavaScript("document.querySelectorAll('video').length===2 && [...document.querySelectorAll('video')].every(v=>v.videoWidth>0 && v.readyState>=2)")
      if (ready) break
      await delay(50)
    }
    assert.ok(ready, "Both production native previews must play video, not a screenshot fallback")
    await window.webContents.executeJavaScript(`window.nativePreviewSamples=[...document.querySelectorAll('video')].map(v=>{const r={width:v.videoWidth,height:v.videoHeight,frames:0,times:[]};function frame(t){r.frames++;r.times.push(t);v.requestVideoFrameCallback(frame)}v.requestVideoFrameCallback(frame);return r})`)
    process.send?.({ ready: true })
    const start = performance.now()
    await delay(15000)
    const elapsedMs = performance.now() - start
    const samples = await window.webContents.executeJavaScript("nativePreviewSamples")
    const report = { boundary: "Installed native-window authorization → Electron getUserMedia → two production video previews → offscreen compositor; counts delivered video frames, not distinct animation", target: options.target, elapsedMs,
      viewers: samples.map(sample => ({ width: sample.width, height: sample.height, frames: sample.frames, deliveredFps: sample.frames * 1000 / elapsedMs,
        maxGapMs: Math.max(0, ...sample.times.slice(1).map((time, index) => time - sample.times[index])) })) }
    assert.ok(report.viewers.every(viewer => viewer.frames > 30), "Native video must keep delivering frames during recording/input")
    await writeFile(join(options.root, "native-preview.png"), (await window.webContents.capturePage()).toPNG())
    await writeFile(join(options.root, "native-preview.json"), JSON.stringify(report, null, 2))
    process.send?.({ report })
  } catch (error) { failed = true; console.error(error) }
  finally {
    clearTimeout(watchdog); unsubscribe(); window.destroy()
    for (const watcher of watchers) await read(false, watcher).catch(() => {})
    app.exit(failed ? 1 : 0)
  }
}
