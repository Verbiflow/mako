import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"

if (!process.versions.electron) {
  const root = await mkdtemp(join(tmpdir(), "mako-chat-preview-"))
  const child = spawn(
    resolve("node_modules/.bin/electron"),
    [fileURLToPath(import.meta.url)],
    { stdio: "inherit", env: { ...process.env, MAKO_PREVIEW_TEST_ROOT: root } }
  )
  child.on("exit", (code) => {
    process.exitCode = code ?? 1
  })
} else {
  void run().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
async function run() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_PREVIEW_TEST_ROOT
  assert.ok(root)
  app.setPath("userData", join(root, "data"))
  await app.whenReady()
  app.setActivationPolicy("prohibited")
  const execute = promisify(execFile)
  const frontmost = async () =>
    Number(
      (
        await execute("osascript", [
          "-l",
          "JavaScript",
          "-e",
          'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier',
        ])
      ).stdout.trim()
    )
  const before = await frontmost()
  const fixture = new BrowserWindow({ show: false, width: 640, height: 360 })
  const viewer = new BrowserWindow({
    show: false,
    width: 1000,
    height: 600,
    webPreferences: { backgroundThrottling: false },
  })
  try {
    await fixture.loadURL(
      "data:text/html,<h1>Native preview fixture</h1><p id='step'>Frame</p><script>setInterval(()=>document.getElementById('step').textContent=Date.now(),200)</script>"
    )
    fixture.showInactive()
    const url = new URL(
      "/scripts/control-preview-browser.html",
      process.env.MAKO_TEST_ORIGIN ?? "http://127.0.0.1:5174/"
    )
    url.searchParams.set("source", fixture.getMediaSourceId())
    await viewer.loadURL(url.href)
    viewer.showInactive()
    const deadline = Date.now() + 25_000
    let outcome
    while (Date.now() < deadline) {
      outcome = await viewer.webContents.executeJavaScript(
        "({status:document.getElementById('result')?.dataset.status,text:document.getElementById('result')?.textContent})"
      )
      if (outcome.status) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    console.log(outcome?.text)
    if (outcome?.status !== "passed") {
      console.log(
        await viewer.webContents.executeJavaScript("document.body.innerHTML")
      )
      await writeFile(
        join(root, "failure.png"),
        (await viewer.webContents.capturePage()).toPNG()
      )
      console.log(root)
    }
    assert.equal(outcome?.status, "passed")
    // Browser frames only: the displayed-size viewer at 1× and 2× device pixels.
    url.searchParams.delete("source")
    for (const zoom of [1, 2]) {
      viewer.webContents.setZoomFactor(zoom)
      await viewer.loadURL(url.href)
      let browserOutcome
      const browserDeadline = Date.now() + 25_000
      while (Date.now() < browserDeadline) {
        browserOutcome = await viewer.webContents.executeJavaScript(
          "({status:document.getElementById('result')?.dataset.status,text:document.getElementById('result')?.textContent})"
        )
        if (browserOutcome.status) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      console.log(browserOutcome?.text)
      if (browserOutcome?.status !== "passed")
        console.log(await viewer.webContents.executeJavaScript(
          "JSON.stringify([...document.querySelectorAll('canvas')].map(c=>{const r=c.getBoundingClientRect();return {pixels:[c.width,c.height],css:[r.width,r.height],style:c.getAttribute('style'),dpr:devicePixelRatio}}))"
        ))
      assert.equal(browserOutcome?.status, "passed", `Browser preview at zoom ${zoom}`)
    }
    // Pinch zoom leaves layout and devicePixelRatio alone, so the viewer must
    // read the visual viewport to keep magnified text sharp.
    viewer.webContents.setZoomFactor(1)
    await viewer.loadURL(url.href)
    await viewer.webContents.setVisualZoomLevelLimits(1, 3)
    const pinchDeadline = Date.now() + 25_000
    while (
      Date.now() < pinchDeadline &&
      !(await viewer.webContents.executeJavaScript("document.getElementById('result')?.dataset.status"))
    )
      await new Promise((resolve) => setTimeout(resolve, 100))
    const measure = `(() => {
      const canvas = document.querySelector('canvas[role="img"]')
      const box = canvas.getBoundingClientRect()
      const scale = visualViewport.scale
      const fit = Math.min(box.width * devicePixelRatio * scale / 1920, box.height * devicePixelRatio * scale / 1080, 1)
      return { pixels: [canvas.width, canvas.height], wanted: [Math.round(1920 * fit), Math.round(1080 * fit)], scale }
    })()`
    const unpinched = await viewer.webContents.executeJavaScript(measure)
    viewer.webContents.debugger.attach()
    await viewer.webContents.debugger.sendCommand("Emulation.setPageScaleFactor", { pageScaleFactor: 2 })
    let pinched = unpinched
    const sharpDeadline = Date.now() + 10_000
    while (Date.now() < sharpDeadline) {
      pinched = await viewer.webContents.executeJavaScript(measure)
      if (pinched.scale === 2 && Math.abs(pinched.pixels[0] - pinched.wanted[0]) <= 1 && Math.abs(pinched.pixels[1] - pinched.wanted[1]) <= 1) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    viewer.webContents.debugger.detach()
    console.log(`Pinch zoom 2×: ${unpinched.pixels.join("×")} → ${pinched.pixels.join("×")} (wanted ${pinched.wanted.join("×")})`)
    assert.equal(pinched.scale, 2, "Pinch zoom applied")
    assert.ok(pinched.pixels[0] > unpinched.pixels[0], "Pinch zoom decodes more detail")
    assert.ok(Math.abs(pinched.pixels[0] - pinched.wanted[0]) <= 1 && Math.abs(pinched.pixels[1] - pinched.wanted[1]) <= 1, "Pinched viewer holds its magnified device pixels")
    assert.equal(
      await frontmost(),
      before,
      "Preview must preserve the user's frontmost application"
    )
    assert.equal(
      BrowserWindow.getAllWindows().length,
      2,
      "The production preview must not create a system window"
    )
    await writeFile(
      join(root, "result.json"),
      JSON.stringify({ ...outcome, preservedFocus: true, windows: 2 }, null, 2)
    )
    console.log(`PASS chat-scoped browser/native preview. Evidence: ${root}`)
  } finally {
    viewer.destroy()
    fixture.destroy()
    app.quit()
  }
}
