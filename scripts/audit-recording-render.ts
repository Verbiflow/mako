/// <reference lib="es2024.arraybuffer" />
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { PerformanceObserver } from "node:perf_hooks"
import sharp from "sharp"
import { renderRecordingImage } from "../packages/control-runtime/src/recording-render.js"

// Serial A/B allocation probe, not a browser FPS or installed-host benchmark.
// Run once normally and once with --defer-release to measure the former lifetime.
// An optional --source=<fixture-image> uses a known capture; no UI is controlled.
const sourcePath = process.argv.find(arg => arg.startsWith("--source="))?.slice(9)
const source = sourcePath ? await readFile(sourcePath) : Buffer.from(
  '<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">' +
  '<defs><linearGradient id="g"><stop stop-color="#31536e"/>' +
  '<stop offset="1" stop-color="#cfad83"/></linearGradient></defs>' +
  '<path fill="url(#g)" d="M0 0h1920v1080H0z"/>' +
  '<text x="100" y="200" font-size="36" fill="white">Recording pixel and cursor fixture</text></svg>'
)
const input = await sharp(source).resize(1920, 1080).jpeg({ quality: 90 }).toBuffer()
const gc = { count: 0, durationMs: 0 }
const observer = new PerformanceObserver(list => {
  for (const entry of list.getEntries()) {
    gc.count++
    gc.durationMs += entry.duration
  }
})
observer.observe({ entryTypes: ["gc"] })
const release = !process.argv.includes("--defer-release")
const frames = 1200
const initialCpu = process.cpuUsage(), start = performance.now()
let peakRssBytes = 0
try {
  for (let index = 0; index < frames; index++) {
    const pixels = await renderRecordingImage(input, { width: 1920, height: 1080 },
      100, { at: 0, x: 400, y: 400, pressed: true }, undefined, 1920, 1080, "rgb")
    assert.equal(pixels.byteOffset, 0)
    assert.equal(pixels.byteLength, pixels.buffer.byteLength)
    assert.ok(pixels.buffer instanceof ArrayBuffer)
    if (release) pixels.buffer.transfer(0)
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss)
  }
  await new Promise<void>(resolve => setImmediate(resolve))
} finally {
  observer.disconnect()
}
const cpu = process.cpuUsage(initialCpu)
console.log(JSON.stringify({ scope: "Serial render allocation probe; no encoder or browser",
  release, frames, elapsedMs: performance.now() - start,
  cpuMs: (cpu.user + cpu.system) / 1000, gc, peakRssBytes }))
