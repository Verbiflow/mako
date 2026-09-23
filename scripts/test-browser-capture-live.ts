import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { BrowserService } from "../electron/browser-service.js"
import {
  BrowserCommandSchema,
  BrowserTargetSchema,
} from "../electron/contracts/browser-control.js"
import { RecordingReceiptSchema } from "@mako/control/control"

const executable =
  process.env.CHROMIUM_EXECUTABLE ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/chromium")
const root = await mkdtemp(join(tmpdir(), "mako-capture-live-"))
const output = process.argv[2] ? resolve(process.argv[2]) : root
const fixture = createServer((_request, response) => {
  response.setHeader("content-type", "text/html")
  response.end(
    `<style>body{margin:0;background:#e7eee3;color:#152015;font:24px sans-serif}button{margin:40px;padding:20px}#box{width:100px;height:100px;background:#1833dc;animation:move 2s linear infinite alternate}@keyframes move{to{transform:translateX(500px)}}footer{position:fixed;bottom:0;right:0;background:#a30;padding:20px}</style><button aria-label="Save form">Save</button><div id="box"></div><footer>pixel corner</footer>`
  )
})
fixture.listen(0, "127.0.0.1")
await once(fixture, "listening")
const address = z.object({ port: z.number() }).parse(fixture.address())
const child = spawn(
  executable,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${join(root, "profile")}`,
    "--no-first-run",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--no-default-browser-check",
    "--window-size=1600,1100",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
)
let browser: BrowserService | undefined
try {
  const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
    let stderr = ""
    const timeout = setTimeout(
      () => reject(new Error("Chromium startup timed out")),
      15_000
    )
    child.once("error", reject)
    child.once("exit", () => {
      clearTimeout(timeout)
      reject(new Error("Chromium exited before its endpoint"))
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16_384)
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) {
        clearTimeout(timeout)
        resolveEndpoint(match[1]!)
      }
    })
  })
  browser = new BrowserService(
    [{ id: "scratch", name: "Scratch", endpoint: async () => endpoint }],
    undefined,
    { focusPolicy: process.env.CAPTURE_FOCUS === "lease" ? "lease" : "action" }
  )
  const service = browser
  const run = (command: z.input<typeof BrowserCommandSchema>) =>
    service.execute(
      "job",
      BrowserCommandSchema.parse(command),
      AbortSignal.timeout(10_000)
    )
  await run({ action: "connect", browser: "scratch" })
  const opened = BrowserTargetSchema.extend({ navigation: z.json() }).parse(
    await run({
      action: "open",
      browser: "scratch",
      background: process.env.CAPTURE_BACKGROUND === "1",
      disposition: process.env.CAPTURE_WINDOW === "1" ? "window" : "tab",
      url: `http://127.0.0.1:${address.port}`,
    })
  )
  const { navigation: _navigation, ...target } = opened
  const frames: {
    width: number
    height: number
    latencyMs: number
    at: number
  }[] = []
  const stop = await browser.previewStream(
    "job",
    target,
    () => {},
    (f) =>
      frames.push({
        width: f.width,
        height: f.height,
        latencyMs: Date.now() - f.capturedAt,
        at: performance.now(),
      }),
    (reason) => {
      throw new Error(reason)
    }
  )
  const start = RecordingReceiptSchema.parse(
    await run({
      action: "recording",
      target,
      operation: "start",
      options: { directory: output, maxSide: 2560, fps: 60 },
    })
  )
  for (let i = 0; i < 5; i++) {
    await delay(500)
    await run({
      action: "screenshot",
      target,
      region: { x: 30, y: 30, width: 250, height: 100 },
      format: "png",
      maxSide: 2048,
    })
  }
  await stop()
  await delay(500)
  await run({ action: "recording", target, operation: "stop", id: start.id })
  let receipt = start
  for (let i = 0; i < 300; i++) {
    receipt = RecordingReceiptSchema.parse(
      await run({
        action: "recording",
        target,
        operation: "status",
        id: start.id,
      })
    )
    if (!["recording", "finalizing"].includes(receipt.status)) break
    await delay(100)
  }
  assert.equal(receipt.status, "finished", receipt.error)
  const timeline = z
    .object({
      frames: z.array(
        z.object({
          width: z.number(),
          height: z.number(),
          viewportWidth: z.number(),
          viewportHeight: z.number(),
        })
      ),
    })
    .parse(JSON.parse(await readFile(receipt.timeline!, "utf8")))
  assert.ok(
    frames.length > 30,
    `Expected live delivery, got ${frames.length} frames`
  )
  assert.ok(timeline.frames.length > 30)
  assert.ok(
    timeline.frames.every((f) => f.width > 1000 && f.height > 600),
    "No clipped screenshot pixels enter the recording"
  )
  assert.equal(
    new Set(timeline.frames.map((f) => `${f.width}x${f.height}`)).size,
    1,
    "Recording dimensions stay fixed during clipped screenshots"
  )
  const probe = JSON.parse(
    (
      await promisify(execFile)("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        receipt.video!,
      ])
    ).stdout
  )
  assert.deepEqual(receipt.dimensions, {
    width: probe.streams[0].width,
    height: probe.streams[0].height,
  })
  const latencies = frames.map((f) => f.latencyMs).sort((a, b) => a - b)
  const report = {
    disposition: process.env.CAPTURE_WINDOW === "1" ? "window" : "tab",
    background: process.env.CAPTURE_BACKGROUND === "1",
    focusPolicy: process.env.CAPTURE_FOCUS === "lease" ? "lease" : "action",
    browserVersion: await run({
      action: "cdp",
      target,
      method: "Browser.getVersion",
      params: {},
    }),
    previewFrames: frames.length,
    deliveredFps: (frames.length * 1000) / (frames.at(-1)!.at - frames[0]!.at),
    captureDeliveryMs: {
      median: latencies[Math.floor(latencies.length / 2)],
      p95: latencies[Math.floor(latencies.length * 0.95)],
    },
    clippedScreenshots: 5,
    recording: receipt,
    encodedDuration: probe.format.duration,
  }
  await writeFile(
    join(receipt.directory, "acceptance.json"),
    JSON.stringify(report, null, 2)
  )
  console.log(JSON.stringify(report, null, 2))
} finally {
  browser?.close()
  fixture.closeAllConnections()
  await new Promise<void>((resolveClose) => fixture.close(() => resolveClose()))
  child.kill("SIGTERM")
  await Promise.race([once(child, "exit"), delay(3000)]).catch(() => {})
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL")
  await rm(join(root, "profile"), { recursive: true, force: true })
}
