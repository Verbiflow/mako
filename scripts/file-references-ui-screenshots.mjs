import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// File links in an answer from `scripts/file-references-check.html`
// (src/dev/file-references-check.tsx), light and dark: found files link with
// their reason, spellings with no file stay text, and a real tie opens the
// chooser, which the keyboard drives and a filter narrows; a file the person
// picked opens on a click and asks again on Option-click (Alt on Linux), and
// picking from a tie makes that link one. Checks each and writes the
// screenshots into <out>.
//
//   node scripts/file-references-ui-screenshots.mjs <out> [--port 20025]
if (process.versions.electron) {
  void shoot().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const args = process.argv.slice(2)
  const out = resolve(args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--port") ?? "file-reference-screenshots")
  const port = Number(args[args.indexOf("--port") + 1]) || 20025
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  await mkdir(join(out, "electron"), { recursive: true })
  const server = await createServer({ server: { host: "127.0.0.1", port, strictPort: true, watch: null } })
  await server.listen()
  await writeFile(join(out, "electron", "package.json"), JSON.stringify({ name: "mako-file-reference-screenshots", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_REFERENCE_SHOTS: out, MAKO_REFERENCE_URL: `http://127.0.0.1:${port}/scripts/file-references-check.html` }
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
  console.log(`File reference screenshots: ${out}`)
}

async function shoot() {
  const { app, BrowserWindow, nativeTheme } = await import("electron")
  const out = process.env.MAKO_REFERENCE_SHOTS
  app.setPath("userData", join(out, "electron", "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1000, height: 900, show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const pause = (ms) => new Promise((done) => setTimeout(done, ms))
  const until = async (code, what) => {
    const end = Date.now() + 20_000
    while (!(await evaluate(code))) {
      if (Date.now() > end) throw new Error(`Timed out: ${what}. Drawn: ${JSON.stringify(await evaluate(`[...document.querySelectorAll("[data-file-reference]")].map((el) => [el.textContent, el.dataset.fileReference])`))}; page: ${(await evaluate("document.body.innerText")).slice(0, 400)}`)
      await pause(50)
    }
  }
  const key = async (keyCode) => {
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: keyCode, code: keyCode, windowsVirtualKeyCode: { ArrowDown: 40, Enter: 13, Escape: 27 }[keyCode] })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: keyCode, code: keyCode })
  }
  const capture = async (name, selector) => {
    await evaluate("document.fonts.ready")
    await pause(300)
    const box = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.x) - 16), y: Math.max(0, Math.floor(r.y) - 16), width: Math.ceil(r.width) + 32, height: Math.ceil(r.height) + 32 } })()`)
    await writeFile(join(out, name), (await page.capturePage(box)).toPNG())
  }
  const links = () => evaluate(`[...document.querySelectorAll("[data-file-reference]")].map((el) => [el.textContent, el.dataset.fileReference, el.tagName, el.dataset.fileReason ?? ""])`)
  for (const theme of ["light", "dark"]) {
    nativeTheme.themeSource = theme
    await window.loadURL(`${process.env.MAKO_REFERENCE_URL}?theme=${theme}`)
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 2, mobile: false })
    await until(`!document.querySelector("[data-file-reference='asking']") && document.querySelectorAll("[data-file-reference]").length === 7`, "every spelling answered")
    assert.deepEqual(await links(), [
      ["tracker.ts:932", "file", "A", "touched"],
      ["electron/acp.ts", "file", "A", "renamed"],
      ["harnesses/index.ts", "choice", "A", ""],
      ["config.ts", "file", "A", "chosen"],
      ["README.md", "choice", "A", ""],
      ["src/app.ts", "none", "SPAN", ""],
      ["notes.md", "none", "SPAN", ""],
    ])
    assert.match(await evaluate(`document.querySelector("[data-file-reason='renamed']").dataset.fileTip`), /Renamed since from acp\.ts/)
    await capture(`answer-${theme}.png`, "[data-fixture-answer]")

    // A real tie: the question in the agent's words, ranked rows that say where and why, the keyboard.
    await evaluate(`document.querySelectorAll("[data-file-reference='choice']")[0].click()`)
    await until(`Boolean(document.querySelector("[data-file-chooser='harnesses/index.ts'] [role='listbox']"))`, "the chooser opened")
    const chooser = await evaluate(`document.querySelector("[data-file-chooser]").innerText`)
    assert.match(chooser, /Which harnesses\/index\.ts\?/)
    assert.match(chooser, /mako › packages\/sessions\/src\/harnesses/)
    assert.match(chooser, /Read by this thread · 2 min ago/)
    assert.match(chooser, /mako-backend › apps\/gateway\/src\/harnesses/)
    assert.match(chooser, /Not touched by this thread/)
    assert.equal(await evaluate(`document.querySelector("[role='option'][aria-selected='true']").dataset.fileOption`), "/Users/you/code/mako/packages/sessions/src/harnesses/index.ts", "the likeliest is selected")
    await capture(`chooser-${theme}.png`, "[data-file-chooser]")
    await key("ArrowDown")
    await until(`document.querySelector("[role='option'][aria-selected='true']")?.dataset.fileOption?.includes("mako-backend")`, "the arrow moved the selection")
    await key("Escape")
    await until(`!document.querySelector("[data-file-chooser]")`, "escape closed the chooser")

    // Eight candidates: a filter narrows them.
    await evaluate(`document.querySelectorAll("[data-file-reference='choice']")[1].click()`)
    await until(`Boolean(document.querySelector("[data-file-chooser='README.md'] input"))`, "the large chooser offers a filter")
    assert.equal(await evaluate(`document.querySelectorAll("[data-file-chooser='README.md'] [role='option']").length`), 8)
    await page.insertText("sessions")
    await until(`document.querySelectorAll("[data-file-chooser='README.md'] [role='option']").length === 1`, "the filter narrowed to one")
    await capture(`chooser-filtered-${theme}.png`, "[data-file-chooser]")
    await key("Escape")
    await until(`!document.querySelector("[data-file-chooser]")`, "escape closed the filtered chooser")

    // A file the person picked: a click opens it, Option-click (Alt on Linux) asks again with the rest.
    const picked = `document.querySelector("[data-file-reason='chosen']")`
    assert.match(await evaluate(`${picked}.title`), /You picked this/)
    assert.match(await evaluate(`${picked}.title`), /(Option|Alt)-click to pick another of 2/)
    await evaluate(`${picked}.click()`)
    await pause(200)
    assert.equal(await evaluate(`Boolean(document.querySelector("[data-file-chooser]"))`), false, "a plain click opens the pick, no chooser")
    await evaluate(`${picked}.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true }))`)
    await until(`Boolean(document.querySelector("[data-file-chooser='config.ts'] [role='listbox']"))`, "Option-click asked again")
    assert.equal(await evaluate(`document.querySelectorAll("[data-file-chooser='config.ts'] [role='option']").length`), 2)
    await capture(`pick-again-${theme}.png`, "[data-file-chooser]")
    await key("Escape")
    await until(`!document.querySelector("[data-file-chooser]")`, "escape closed the pick-again chooser")

    // Picking from a tie: that link is the pick from now on, and can be picked again.
    await evaluate(`document.querySelectorAll("[data-file-reference='choice']")[0].click()`)
    await until(`Boolean(document.querySelector("[data-file-chooser='harnesses/index.ts'] [role='listbox']"))`, "the tie's chooser opened again")
    await evaluate(`document.querySelector("[data-file-option*='mako-backend']").click()`)
    await until(`[...document.querySelectorAll("[data-file-reason='chosen']")].some((el) => el.textContent === "harnesses/index.ts")`, "the picked tie links as the pick")
  }
  app.exit(0)
}
