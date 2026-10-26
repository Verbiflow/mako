import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// A turn's media as the transcript draws it, from `scripts/media-shelf-browser.html`
// (src/dev/media-shelf-check.tsx): every scene in light and dark, the whole
// conversation column, written into <out> as <scene>-<theme>.png. `--hover`
// holds what a selector matches in hover; `--page <url> --name <name>` draws
// another page the same way, such as a reference rendering to compare with.
//
//   node scripts/turn-media-ui-screenshots.mjs <out> [--port 20028] [--scenes a,b] [--themes dark,light] [--hover selector] [--width 860]
if (process.versions.electron) {
  void shoot().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const args = process.argv.slice(2)
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
  const out = resolve(args.find((arg, at) => !arg.startsWith("--") && !args[at - 1]?.startsWith("--")) ?? "turn-media-screenshots")
  const port = Number(option("--port")) || 20028
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  await mkdir(join(out, "electron"), { recursive: true })
  const server = await createServer({ server: { host: "127.0.0.1", port, strictPort: true, watch: null } })
  await server.listen()
  await writeFile(join(out, "electron", "package.json"), JSON.stringify({ name: "mako-turn-media-screenshots", main: fileURLToPath(import.meta.url) }))
  const env = {
    ...process.env,
    MAKO_MEDIA_SHOTS: out,
    MAKO_MEDIA_URL: `http://127.0.0.1:${port}/scripts/media-shelf-browser.html`,
    MAKO_MEDIA_SCENES: option("--scenes") ?? "conversation,uncited,mixed,html,tall,show,recording",
    MAKO_MEDIA_THEMES: option("--themes") ?? "dark,light",
    MAKO_MEDIA_HOVER: option("--hover") ?? "",
    MAKO_MEDIA_WIDTH: option("--width") ?? "860",
    // Another page to draw the same way, by URL (a reference rendering), named <name>-<theme>.png.
    MAKO_MEDIA_PAGE: option("--page") ?? "",
    MAKO_MEDIA_NAME: option("--name") ?? "",
  }
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
  console.log(`Turn media screenshots: ${out}`)
}

async function shoot() {
  const { app, BrowserWindow, nativeTheme } = await import("electron")
  const out = process.env.MAKO_MEDIA_SHOTS
  const width = Number(process.env.MAKO_MEDIA_WIDTH)
  app.setPath("userData", join(out, "electron", "profile"))
  await app.whenReady()
  console.log("ready")
  const window = new BrowserWindow({ width, height: 1000, show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const pause = (ms) => new Promise((done) => setTimeout(done, ms))
  for (const theme of process.env.MAKO_MEDIA_THEMES.split(",")) {
    nativeTheme.themeSource = theme
    const reference = process.env.MAKO_MEDIA_PAGE
    for (const scene of reference ? [process.env.MAKO_MEDIA_NAME || "page"] : process.env.MAKO_MEDIA_SCENES.split(",")) {
      await window.loadURL(reference ? `${reference}?theme=${theme}` : `${process.env.MAKO_MEDIA_URL}?scene=${scene}&theme=${theme}`)
      await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height: 4000, deviceScaleFactor: 2, mobile: false })
      await evaluate("document.fonts.ready.then(() => true)")
      // Everything the scene draws, settled: pictures decoded, pages measured.
      const end = Date.now() + 15_000
      while (Date.now() < end) {
        const ready = await evaluate(`[...document.images].every((image) => image.complete) && document.querySelectorAll("[data-exchange], .col").length > 0`)
        if (ready) break
        await pause(100)
      }
      await pause(1500)
      if (process.env.MAKO_MEDIA_HOVER) {
        // Held in hover as a pointer resting on it would: a hidden window has no pointer.
        await page.debugger.sendCommand("DOM.enable")
        await page.debugger.sendCommand("CSS.enable")
        const { root } = await page.debugger.sendCommand("DOM.getDocument", { depth: 0 })
        const { nodeIds } = await page.debugger.sendCommand("DOM.querySelectorAll", { nodeId: root.nodeId, selector: process.env.MAKO_MEDIA_HOVER })
        for (const nodeId of nodeIds) await page.debugger.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] })
        await pause(400)
      }
      const height = await evaluate(`Math.ceil(Math.max(...[...document.querySelectorAll("[data-exchange], .col")].map((el) => el.getBoundingClientRect().bottom)) + 32)`)
      const image = await page.capturePage({ x: 0, y: 0, width, height: Math.min(height, 4000) })
      await writeFile(join(out, `${scene}-${theme}.png`), image.toPNG())
      console.log(`${scene}-${theme}.png ${height}px`)
    }
  }
  app.exit(0)
}
