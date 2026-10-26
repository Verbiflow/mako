import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Changes › Turn and "Undo this turn" from `scripts/turn-review.html`
// (src/dev/turn-review-check.tsx), light and dark: the scope menu's turns,
// a turn's diff with who wrote each stretch beside it, the same with only
// the thread's lines, the undo's preview in its three groups, and after it.
// Checks each and writes the screenshots into <out>.
//
//   node scripts/turn-review-screenshots.mjs <out> [--port 20025]
if (process.versions.electron) {
  void shoot().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const args = process.argv.slice(2)
  const out = resolve(args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--port") ?? "turn-review-screenshots")
  const port = Number(args[args.indexOf("--port") + 1]) || 20025
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  await mkdir(join(out, "electron"), { recursive: true })
  const server = await createServer({ server: { host: "127.0.0.1", port, strictPort: true, watch: null } })
  await server.listen()
  await writeFile(join(out, "electron", "package.json"), JSON.stringify({ name: "mako-turn-review-screenshots", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_TURN_SHOTS: out, MAKO_TURN_URL: `http://127.0.0.1:${port}/scripts/turn-review.html` }
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
  console.log(`Turn review screenshots: ${out}`)
}

async function shoot() {
  const { app, BrowserWindow, nativeTheme } = await import("electron")
  const out = process.env.MAKO_TURN_SHOTS
  app.setPath("userData", join(out, "electron", "profile"))
  await app.whenReady()
  const width = 900
  const height = 940
  const window = new BrowserWindow({ width, height, show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const pause = (ms) => new Promise((done) => setTimeout(done, ms))
  const until = async (code, what) => {
    const end = Date.now() + 20_000
    while (!(await evaluate(code))) {
      if (Date.now() > end) throw new Error(`Timed out: ${what}. Page: ${(await evaluate("document.body.innerText")).slice(0, 600)}`)
      await pause(50)
    }
  }
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  /** A real press, for controls that open on the pointer (menus). */
  const pointer = async (selector) => {
    const { x, y } = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    for (const type of ["mousePressed", "mouseReleased"]) await page.debugger.sendCommand("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 })
  }
  const press = async (key, code = key) => {
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: { j: 74, ArrowRight: 39, Escape: 27 }[key] })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key, code })
  }
  const capture = async (name, selector) => {
    await evaluate("document.fonts.ready")
    if (!selector) await evaluate("document.activeElement?.blur()")
    await pause(350)
    const box = selector
      ? await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.x) - 24), y: Math.max(0, Math.floor(r.y) - 24), width: Math.ceil(r.width) + 48, height: Math.ceil(r.height) + 48 } })()`)
      : undefined
    await writeFile(join(out, name), (await page.capturePage(box)).toPNG())
  }
  /** The stream scrolled so `path`'s header is at its top. */
  const scrollTo = async (path) => {
    const done = await evaluate(`(async () => {
      const scroller = [...document.querySelectorAll("[data-review-stream] *")].find((el) => el.scrollHeight > el.clientHeight + 10 && getComputedStyle(el).overflowY === "auto")
      for (let i = 0; i < 80; i++) {
        const header = document.querySelector(${JSON.stringify(`[data-review-file="${path}"]`)})
        if (header) {
          const top = header.getBoundingClientRect().top - scroller.getBoundingClientRect().top
          if (Math.abs(top) < 2) return true
          scroller.scrollTop += top
        } else scroller.scrollTop += 300
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      return false
    })()`)
    assert.ok(done, `scrolled to ${path}`)
  }
  const writers = () => evaluate(`[...document.querySelectorAll("[data-review-stream] [data-writer]")].map((el) => [el.dataset.writer, el.textContent])`)
  for (const theme of ["dark", "light"]) {
    nativeTheme.themeSource = theme
    await window.loadURL(`${process.env.MAKO_TURN_URL}?theme=${theme}`)
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false })
    await until(`document.querySelectorAll("[data-review-file]").length >= 2 && document.querySelector("[data-turn-bar]")`, "the turn's files")

    // The scope menu: every turn of the conversation that changed files here.
    await pointer("[data-changes] button[aria-label^='Showing: Turn']")
    await until(`document.querySelector("[data-turn-picker]")`, "the scope menu")
    await pointer("[data-turn-picker]")
    await until(`document.querySelectorAll("[data-turn-choice]").length === 3`, "every turn listed")
    assert.deepEqual(await evaluate(`[...document.querySelectorAll("[data-turn-choice]")].map((el) => el.dataset.turnChoice)`), ["3", "2", "1"])
    await capture(`attr-review-turn-picker-${theme}.png`)
    await press("Escape")
    await press("Escape")
    await pause(200)

    // The fetch helper, where the person and another thread wrote inside the turn's span.
    await scrollTo("src/net/fetch-retry.ts")
    await until(`[...document.querySelectorAll("[data-review-stream] [data-writer]")].some((el) => el.dataset.writer === "person")`, "the writers' rows")
    const rows = await writers()
    assert.ok(rows.some(([writer, words]) => writer === "other" && words.includes("Move logging under telemetry")), JSON.stringify(rows))
    assert.ok(rows.some(([writer, words]) => writer === "person" && words.includes("You")), JSON.stringify(rows))
    assert.ok(rows.some(([writer]) => writer === "turn"), JSON.stringify(rows))
    await capture(`attr-review-turn-writers-${theme}.png`)

    // Only this thread's lines: no writer rows, others' lines are context.
    await click("[data-turn-bar] [role=switch]")
    await until(`document.querySelector("[data-turn-bar] [role=switch]").getAttribute("aria-checked") === "true" && document.querySelectorAll("[data-review-file]").length >= 2`, "only the thread's lines")
    await scrollTo("src/net/fetch-retry.ts")
    await pause(400)
    assert.deepEqual(await writers(), [], "no writer rows when only the thread's lines show")
    await capture(`attr-review-turn-only-${theme}.png`)
    await click("[data-turn-bar] [role=switch]")

    // The undo's preview, three groups, then after it.
    await click("[data-turn-bar] [data-undo-turn]")
    await until(`document.querySelector("[data-turn-undo='ready']")`, "the undo preview")
    assert.deepEqual(await evaluate(`[...document.querySelectorAll("[data-undo-group]")].map((el) => el.dataset.undoGroup)`), ["Undo", "Kept", "Can't split"])
    await capture(`attr-review-undo-preview-${theme}.png`, "[data-slot=dialog-content]")
    await click("[data-turn-undo-confirm]")
    await until(`document.querySelector("[data-turn-undo='done']")`, "the undo done")
    await capture(`attr-review-undo-done-${theme}.png`, "[data-slot=dialog-content]")
  }
  app.exit(0)
}
