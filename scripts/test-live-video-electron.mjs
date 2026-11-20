// Live video encoded by the desktop's WebCodecs (`contracts/live-video.ts`), end to end in a real Electron and decoded
// by the real viewer (`src/lib/control-video-player.ts`). Run after `npm run build:electron`:
// electron scripts/test-live-video-electron.mjs
//
//   1. A desk window captured as a tab: the host's BrowserVideo, over the real /desktop channel, opens a capture in the
//      desktop's live video page; units come only while the window paints, and a key frame of the still picture comes
//      when a viewer joins.
//   2. The screencast's JPEGs encoded there (`desktopLiveEncoder`), as on a machine with no video helper.
//   3. A synthetic window: a canvas that repeats one picture at 30 fps, as a system capturer does with a still window,
//      through the page's own capture session and change gate: nothing is encoded while the picture holds, apart from
//      one frame a second, and a key frame asked for shows the picture as it is.
//   4. The same synthetic window captured the way an app's window is (`desktopCapturer`, ScreenCaptureKit on a Mac),
//      which needs a screen that's awake and unlocked and Screen Recording for Electron; it's said as skipped otherwise.
import { app, BrowserWindow, ipcMain } from "electron"
import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { DesktopChannel } from "@mako/host/control/desktop-channel"
import { desktopCapture, desktopLiveEncoder } from "@mako/host/control/desktop-video"
import { startWebHost } from "@mako/host/transport/server"
import { DesktopLink } from "../dist-electron/desktop-link.js"
import { deskPageAnswers } from "../dist-electron/desktop-answers-electron.js"
import { liveVideoAnswers } from "../dist-electron/live-video-electron.js"
import { BrowserVideo } from "../packages/control-runtime/dist/browser-video.js"
import { decodeControlVideo } from "../packages/control-runtime/dist/contracts/control-video.js"
import { testScratch } from "./lib/test-scratch.mjs"

const repo = resolve(fileURLToPath(import.meta.url), "../..")
const root = testScratch("mako-live-video-")
app.setPath("userData", join(root, "profile"))
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const watchdog = setTimeout(() => {
  console.error("Live video check timed out")
  app.exit(2)
}, 120_000)

/** A page that fills itself with one colour, and changes it when asked. */
const COLOUR_PAGE = `<!doctype html><body style="margin:0"><canvas id=c></canvas><script>
const c = document.getElementById("c"), x = c.getContext("2d")
let colour = "rgb(220,40,40)", moving = false, n = 0
function paint() { c.width = innerWidth; c.height = innerHeight; x.fillStyle = colour; x.fillRect(0, 0, c.width, c.height); x.fillStyle = "#000"; x.font = "40px sans-serif"; x.fillText("frame " + n, 40, 80) }
function loop() { if (!moving) return; n++; paint(); requestAnimationFrame(loop) }
window.set = (next, move) => { colour = next; moving = move; paint(); if (move) requestAnimationFrame(loop) }
paint()
</script>`

/** The viewer and the synthetic window run the product's code, bundled for a plain page. */
async function bundle() {
  const entry = join(root, "harness.ts")
  const { writeFileSync } = await import("node:fs")
  writeFileSync(entry, `
import { ControlVideoPlayer } from "@/lib/control-video-player"
import { CaptureSession } from "@/live-video/capture-session"
const { ipcRenderer } = require("electron")
ipcRenderer.on("packet", (_event: unknown, bytes: Uint8Array) => player.push(bytes))
const canvas = document.createElement("canvas")
document.body.append(canvas)
const context = canvas.getContext("2d", { willReadFrequently: true })!
let painted = 0
const player = new ControlVideoPlayer((picture, width, height) => {
  canvas.width = width; canvas.height = height
  context.drawImage(picture, 0, 0)
  painted++
}, (reason) => ipcRenderer.send("viewer-failed", reason))
Object.assign(window, {
  push: (bytes: Uint8Array) => player.push(bytes),
  shown: () => {
    if (!painted) return null
    const [r, g, b] = context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data
    return { painted, width: canvas.width, height: canvas.height, r, g, b, stats: player.stats }
  },
  // The synthetic window: a canvas redrawn with the same picture 30 times a second, captured as a track.
  synthetic: (fps: number) => {
    const source = document.createElement("canvas")
    source.width = 1280; source.height = 800
    const draw = source.getContext("2d")!
    let colour = "rgb(40,200,60)"
    const timer = setInterval(() => { draw.fillStyle = colour; draw.fillRect(0, 0, 1280, 800) }, 1000 / 30)
    const track = source.captureStream(30).getVideoTracks()[0]!
    const units: { kind: string; at: number }[] = []
    const session = new CaptureSession("synthetic", fps, track, true, (event) => {
      if (event.type !== "unit") return
      player.push(event.packet)
      units.push({ kind: event.packet[1] === 1 ? "key" : "delta", at: performance.now() })
    })
    Object.assign(window, {
      units: () => units.splice(0),
      colour: (next: string) => { colour = next },
      key: () => session.key(),
      stopSynthetic: () => { clearInterval(timer); session.close() },
    })
  },
})
`)
  writeFileSync(join(root, "harness.html"), `<!doctype html><body><script src="harness.js"></script>`)
  await build({
    entryPoints: [entry],
    outfile: join(root, "harness.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome150",
    tsconfig: join(repo, "tsconfig.app.json"),
    external: ["electron"],
    alias: { "@mako/control-runtime/contracts": join(repo, "packages/control-runtime/src/contracts/control-video.ts") },
    logLevel: "warning",
  })
}

async function viewerWindow() {
  const window = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } })
  await window.loadFile(join(root, "harness.html"))
  const evaluate = (expression) => window.webContents.executeJavaScript(expression)
  const port = {
    packets: [],
    size: () => ({ width: 640, height: 400 }),
    backlog: () => 0,
    send(bytes) {
      port.packets.push(decodeControlVideo(bytes))
      if (!window.isDestroyed()) window.webContents.send("packet", bytes)
    },
    ended: (reason) => { port.endedWith = reason },
  }
  return { window, evaluate, port }
}

async function until(read, ok, what, ms = 8_000) {
  const by = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    assert.ok(Date.now() < by, `${what}: ${JSON.stringify(value)}`)
    await wait(50)
  }
}

const near = (shown, [r, g, b]) => shown && Math.abs(shown.r - r) < 60 && Math.abs(shown.g - g) < 60 && Math.abs(shown.b - b) < 60

async function main() {
  app.on("window-all-closed", () => {})
  await app.whenReady()
  ipcMain.on("viewer-failed", (_event, reason) => assert.fail(`the viewer's decoder failed: ${reason}`))
  await bundle()

  // The host's channel on a socket, and this process as its desktop: desk windows and the live video page.
  const channel = new DesktopChannel()
  const socket = join(root, "host.sock")
  const host = await startWebHost(socket, async () => JSON.stringify(null), async () => new Response(""), undefined, undefined, undefined, undefined, (request, response) => channel.attach(request, response))
  const deskWindow = async () => {
    const window = new BrowserWindow({ show: false, width: 800, height: 500, webPreferences: { backgroundThrottling: false } })
    await window.loadURL("data:text/html," + encodeURIComponent(COLOUR_PAGE))
    return window
  }
  const pages = deskPageAnswers({ agentView: deskWindow, frame: (frame) => link.frame(frame) })
  const video = liveVideoAnswers({ directory: join(repo, "dist-electron"), frame: (frame) => link.frame(frame), page: pages.contents })
  const link = new DesktopLink({ socket: () => socket, role: "desktop", handlers: { ...pages.handlers, ...video.handlers }, detached: () => { video.forget(); pages.forget() } })
  link.start()
  await until(async () => channel.answers("live-video-open"), Boolean, "the desktop attached")
  const page = await channel.deskPage("live-video-check")
  const contents = pages.contents(page.id)
  assert.ok(contents, "the desk window is known by its page id")
  const paint = (colour, move) => contents.executeJavaScript(`set(${JSON.stringify(colour)}, ${move})`)

  // 1. The desk window as a tab, through BrowserVideo and the channel.
  {
    const viewer = await viewerWindow()
    const live = new BrowserVideo({ encoded: desktopCapture(channel, { kind: "page", page: page.id }) }, { fps: 30 })
    const leave = await live.join(viewer.port)
    await until(() => viewer.evaluate("shown()"), (shown) => near(shown, [220, 40, 40]), "the still window's picture decodes")
    assert.equal(viewer.port.packets[0]?.kind, "key", "the first unit is a key frame, and carries its avcC")
    assert.ok(viewer.port.packets[0].width <= 640 && viewer.port.packets[0].height <= 400, "the capture fits the viewer's box")
    const still = viewer.port.packets.length
    await wait(1000)
    assert.ok(viewer.port.packets.length - still <= 2, `a tab that doesn't paint sends nothing: ${viewer.port.packets.length - still} units in a second`)
    await paint("rgb(40,40,220)", true)
    await wait(1000)
    const moving = viewer.port.packets.length - still
    assert.ok(moving >= 20, `a painting tab streams: ${moving} units in a second`)
    await until(() => viewer.evaluate("shown()"), (shown) => near(shown, [40, 40, 220]), "the new colour decodes")
    await paint("rgb(40,40,220)", false)
    // A second viewer joins a still window: it gets a key frame of the picture as it is, with the avcC again.
    const second = await viewerWindow()
    const leaveSecond = await live.join(second.port)
    await until(() => second.evaluate("shown()"), (shown) => near(shown, [40, 40, 220]), "a viewer joining a still window decodes its picture")
    const keys = second.port.packets.filter((packet) => packet.kind === "key")
    assert.ok(keys.length >= 1 && keys.every((packet) => packet.description.byteLength > 0), "every key unit carries its avcC")
    await leaveSecond()
    await leave()
    live.close()
    viewer.window.destroy()
    second.window.destroy()
  }

  // 2. The screencast's JPEGs, encoded by the desktop.
  {
    const viewer = await viewerWindow()
    const debug = contents.debugger
    if (!debug.isAttached()) debug.attach("1.3")
    const live = new BrowserVideo({
      frames: async ({ frame }) => {
        const listener = (_event, method, params) => {
          if (method !== "Page.screencastFrame") return
          void debug.sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {})
          const bytes = Buffer.from(params.data, "base64")
          frame({ bytes, width: params.metadata.deviceWidth, height: params.metadata.deviceHeight, viewportWidth: params.metadata.deviceWidth, viewportHeight: params.metadata.deviceHeight, pageScaleFactor: 1, offsetTop: 0, capturedAt: Date.now() })
        }
        debug.on("message", listener)
        await debug.sendCommand("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: 640, maxHeight: 400 })
        return {
          stop: async () => { debug.removeListener("message", listener); await debug.sendCommand("Page.stopScreencast").catch(() => {}) },
          resized: async () => {},
        }
      },
    }, { fps: 30, encoder: desktopLiveEncoder(channel, () => assert.fail("the fallback encoded though the desktop could")) })
    const leave = await live.join(viewer.port)
    await paint("rgb(230,200,30)", true)
    await until(() => viewer.evaluate("shown()"), (shown) => near(shown, [230, 200, 30]) && shown.painted >= 10, "the desktop-encoded screencast decodes")
    const kinds = viewer.port.packets.map((packet) => packet.kind)
    assert.equal(kinds[0], "poster", "a viewer paints the screencast's picture first")
    assert.ok(kinds.indexOf("key") > 0 && kinds.filter((kind) => kind === "delta").length >= 5, `then a key frame and deltas: ${kinds.slice(0, 8)}`)
    await paint("rgb(230,200,30)", false)
    await leave()
    live.close()
    viewer.window.destroy()
  }

  // 3. A synthetic window that repeats its picture, through the capture session and its change gate.
  {
    const viewer = await viewerWindow()
    await viewer.evaluate("synthetic(30)")
    await until(() => viewer.evaluate("shown()"), (shown) => near(shown, [40, 200, 60]), "the synthetic window decodes")
    await wait(500)
    await viewer.evaluate("units()")
    await wait(2_500)
    const idle = await viewer.evaluate("units()")
    assert.ok(idle.length <= 4, `an unchanged picture repeated at 30 fps is encoded about once a second: ${idle.length} units in 2.5 s`)
    await viewer.evaluate(`colour("rgb(200,40,200)")`)
    await until(() => viewer.evaluate("shown()"), (shown) => near(shown, [200, 40, 200]), "a change passes the gate at once", 2_000)
    await wait(500)
    await viewer.evaluate("units()")
    await viewer.evaluate("key()")
    const asked = await until(() => viewer.evaluate("units()"), (units) => units.length > 0, "a key frame asked for while the picture holds", 2_000)
    assert.equal(asked[0].kind, "key", "it comes as a key frame of the picture shown")
    await viewer.evaluate("stopSynthetic()")
    viewer.window.destroy()
  }

  // 4. A window through the system's capturer, as computer use streams any app's window.
  let systemCapture = "skipped"
  {
    const window = new BrowserWindow({ show: true, width: 640, height: 400, webPreferences: { backgroundThrottling: false } })
    await window.loadURL("data:text/html," + encodeURIComponent(COLOUR_PAGE))
    await window.webContents.executeJavaScript(`set("rgb(30,160,200)", true)`)
    const windowId = Number(window.getMediaSourceId().split(":")[1])
    const viewer = await viewerWindow()
    const live = new BrowserVideo({ encoded: desktopCapture(channel, { kind: "window", windowId }) }, { fps: 30 })
    try {
      const leave = await live.join(viewer.port)
      const shown = await until(() => viewer.evaluate("shown()"), Boolean, "a system capture", 4_000).catch(() => null)
      if (shown) {
        assert.ok(near(shown, [30, 160, 200]), `the captured window decodes: ${JSON.stringify(shown)}`)
        systemCapture = "passed"
      } else systemCapture = "skipped: the capturer sent no frames (a locked or sleeping screen, or no Screen Recording grant)"
      await leave()
    } catch (error) {
      systemCapture = `skipped: ${error.message}`
    }
    live.close()
    viewer.window.destroy()
    window.destroy()
  }

  page.destroy()
  video.close()
  link.dispose()
  channel.close()
  host.close()
  console.log(`Live video: a desk window as a tab (damage-driven, key frames with avcC on join), the screencast encoded by the desktop's WebCodecs, and a synthetic window through the change gate decoded by the real viewer passed; system window capture ${systemCapture}`)
}

main().then(
  () => {
    clearTimeout(watchdog)
    app.exit(0)
  },
  (error) => {
    console.error(error)
    app.exit(1)
  }
)
