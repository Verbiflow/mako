import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// macOS's file-change service on the desk, from the mock bridge's scenes:
// the notice a degraded fseventsd raises with its numbers,
// Settings › Diagnostics' readout of it and the day's samples, "Restart it"
// walking its steps to the outcome with before and after, and a healthy
// Mac, where no notice shows and Diagnostics reads tens of milliseconds.
// Checks each and writes the screenshots into <out>.
//
//   node scripts/file-events-screenshots.mjs <out> [--port 20026]
if (process.versions.electron) {
  void shoot().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const args = process.argv.slice(2)
  const out = resolve(args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--port") ?? "file-events-screenshots")
  const port = Number(args[args.indexOf("--port") + 1]) || 20026
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  await mkdir(join(out, "electron"), { recursive: true })
  const server = await createServer({ server: { host: "127.0.0.1", port, strictPort: true, watch: null } })
  await server.listen()
  await writeFile(join(out, "electron", "package.json"), JSON.stringify({ name: "mako-file-events-screenshots", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_FILE_EVENTS_SHOTS: out, MAKO_FILE_EVENTS_URL: `http://127.0.0.1:${port}/` }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electronPath, [join(out, "electron")], { env, stdio: "inherit" })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`File events screenshots: ${out}`)
}

async function shoot() {
  const { app, BrowserWindow } = await import("electron")
  const out = process.env.MAKO_FILE_EVENTS_SHOTS
  app.setPath("userData", join(out, "electron", "profile"))
  await app.whenReady()
  const width = 1280
  const height = 860
  const window = new BrowserWindow({ width, height, show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const pause = (ms) => new Promise((done) => setTimeout(done, ms))
  const until = async (code, what) => {
    const end = Date.now() + 30_000
    while (!(await evaluate(code))) {
      if (Date.now() > end) throw new Error(`Timed out: ${what}. Page: ${(await evaluate("document.body.innerText")).slice(0, 600)}`)
      await pause(50)
    }
  }
  /** `fn` run in the page with `args` passed as values, never written into its code. */
  const call = async (fn, ...args) => {
    const { result: global } = await page.debugger.sendCommand("Runtime.evaluate", { expression: "globalThis" })
    const { result, exceptionDetails } = await page.debugger.sendCommand("Runtime.callFunctionOn", {
      objectId: global.objectId, functionDeclaration: fn.toString(), arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true,
    })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result.value
  }
  const text = (selector) => call((query) => document.querySelector(query)?.innerText ?? "", selector)
  const pressButton = (within, name) => call((query, label) => [...document.querySelectorAll(`${query} button`)].find((button) => button.innerText.trim() === label).click(), within, name)
  const capture = async (name, selector) => {
    await evaluate("document.fonts.ready")
    await evaluate("document.activeElement?.blur()")
    if (selector) await call((query) => document.querySelector(query).scrollIntoView({ block: "center" }), selector)
    await pause(450)
    const box = selector
      ? await call((query) => {
        const r = document.querySelector(query).getBoundingClientRect()
        return { x: Math.max(0, Math.floor(r.x) - 16), y: Math.max(0, Math.floor(r.y) - 16), width: Math.ceil(r.width) + 32, height: Math.ceil(r.height) + 32 }
      }, selector)
      : undefined
    await writeFile(join(out, name), (await page.capturePage(box)).toPNG())
  }
  const settings = (section) => call((detail) => window.dispatchEvent(new CustomEvent("mako:settings", { detail })), section)
  const closeSettings = () => evaluate(`window.dispatchEvent(new CustomEvent("mako:close-settings"))`)
  const load = async (scene) => {
    await window.loadURL(`${process.env.MAKO_FILE_EVENTS_URL}?mock${scene ? `&app=${scene}` : ""}`)
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false })
    await until(`document.querySelector("textarea, [contenteditable=true]")`, "the desk")
  }

  {
    // Degraded: the notice above the panes, with what fseventsd holds and how late it delivers.
    await load("fseventsd")
    await until(`document.querySelector('[data-file-events-notice="degraded"]')`, "the degraded notice")
    const notice = await text('[data-file-events-notice="degraded"]')
    assert.match(notice, /macOS's file-change service is degraded/)
    assert.match(notice, /holds 10\.5 GB of memory \(normally under 50 MB\) and delivers file changes 2\.6 s late \(normally under 100 ms\)/)
    assert.match(notice, /Every app that watches files waits on it, not just Mako\. Restarting it fixes this; macOS asks for your password\./)
    assert.match(notice, /Restart it/)
    await capture(`fseventsd-desk-degraded.png`)
    await capture(`fseventsd-notice-degraded.png`, '[data-file-events-notice="degraded"]')

    // Diagnostics: the same numbers, the day's samples with what Mako was doing, and the restart.
    await settings("diagnostics")
    await until(`document.querySelector('[data-file-events-readout="degraded"]')`, "the readout")
    const readout = await text('[data-file-events-readout="degraded"]')
    assert.match(readout, /Degraded for 47 minutes\. fseventsd holds 10\.5 GB/)
    assert.match(readout, /96 samples, memory 9\.8 GB to 10\.5 GB, median delay/)
    assert.match(readout, /turns? running/)
    await capture(`fseventsd-diagnostics-degraded.png`, '[data-file-events-readout="degraded"]')
    await closeSettings()
    await until(`!document.querySelector('[data-file-events-readout]')`, "settings closed")

    // Restart it: the steps, then before and after, with the evidence to show.
    await pressButton('[data-file-events-notice="degraded"]', "Restart it")
    await until(`document.querySelector('[data-file-events-notice="restarting"]')`, "the restart under way")
    assert.match(await text('[data-file-events-notice="restarting"]'), /Enter your password in the macOS dialog/)
    await capture(`fseventsd-notice-restarting.png`, '[data-file-events-notice="restarting"]')
    await until(`document.querySelector('[data-file-events-notice="restarted"]')`, "the restart's outcome")
    const restarted = await text('[data-file-events-notice="restarted"]')
    assert.match(restarted, /macOS's file-change service restarted/)
    assert.match(restarted, /File changes now arrive in 54 ms \(was 2\.6 s\), and it holds 8\.2 MB \(was 10\.5 GB\)\. Mako rescanned the folders it watches\./)
    await capture(`fseventsd-notice-restarted.png`, '[data-file-events-notice="restarted"]')
    await settings("diagnostics")
    await until(`document.querySelector('[data-file-events-readout="healthy"]')`, "the readout after the restart")
    assert.match(await text('[data-file-events-readout="healthy"]'), /Last restart\s+Restarted .*File changes now arrive in 54 ms \(was 2\.6 s\).*still in the history after/s)
    await capture(`fseventsd-diagnostics-restarted.png`, '[data-file-events-readout="healthy"]')
    await closeSettings()

    // Not now: the notice goes, and the host keeps it gone for the day.
    await load("fseventsd")
    await until(`document.querySelector('[data-file-events-notice="degraded"]')`, "the degraded notice again")
    await pressButton('[data-file-events-notice="degraded"]', "Not now")
    await until(`!document.querySelector('[data-file-events-notice]')`, "the notice gone after Not now")
    await pause(800)
    assert.equal(await evaluate(`document.querySelector("[data-file-events-notice]")`), null, "and it stays gone")

    // A healthy Mac: nothing above the panes; Diagnostics reads tens of milliseconds and a few megabytes.
    await load(null)
    await pause(800)
    assert.equal(await evaluate(`document.querySelector("[data-file-events-notice]")`), null, "a healthy Mac shows no notice")
    await settings("diagnostics")
    await until(`document.querySelector('[data-file-events-readout="healthy"]')`, "the healthy readout")
    assert.match(await text('[data-file-events-readout="healthy"]'), /Healthy\. File changes arrive in 52 ms at the median of the last 6 checks \(slowest 66 ms\)\. fseventsd \(pid 19513\) holds 11\.8 MB\./)
    await capture(`fseventsd-diagnostics-healthy.png`, '[data-file-events-readout="healthy"]')
  }
  app.exit(0)
}
