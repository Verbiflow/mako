import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Opening a Thread on a phone, by trusted touch at an iPhone's size on the phone's live Session
 * (`src/dev/phone-open-check.tsx`), dark and light, in a transcript of 40 turns and in a windowed one of 260:
 *
 * - From the tap, its newest turn is painted at the end: at once from what the page holds, and as soon as its owner
 *   answers when the page let it go (as a reload does).
 * - Once painted, no turn on screen moves for 1.5 s: not the thread's entrance, nor the windowed rows' measurements.
 * - The probe's Thread-open reading says a held open was painted from what was kept, before its owner answered.
 *
 * Screenshots go to the printed directory, or to the directory given as the first argument; `--port` serves the page
 * on that port (default: any free one).
 */
if (process.versions.electron) {
  const { app } = await import("electron")
  void checkOpen().then(() => app.exit(0)).catch((error) => {
    console.error(error)
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const args = process.argv.slice(2)
  const portAt = args.indexOf("--port")
  const port = portAt === -1 ? 0 : Number(args.splice(portAt, 2)[1])
  const root = await mkdtemp(join(tmpdir(), "mako-phone-open-ui-"))
  const evidence = args[0] ? resolve(args[0]) : root
  await mkdir(evidence, { recursive: true })
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port, strictPort: port !== 0, hmr: false } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-phone-open-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_OPEN_ROOT: root, MAKO_OPEN_EVIDENCE: evidence, MAKO_OPEN_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`Phone open UI evidence: ${evidence}`)
}

/** The owner's answer to a read, in ms (`?answer=`): what the page waits for when it holds nothing. */
const ANSWER_MS = 300
/** The newest answer's last words, which only its turn holds. */
const NEWEST = "That is the whole of the retry fix."

/**
 * From the next tap, every frame: when the newest turn's last words are on screen with the transcript at its end
 * (`newestMs`), then for 1.5 s how far any turn on screen moved from where it was first painted (`moved`).
 */
const RECORD = `(() => {
  const log = window.__open = { moved: 0, tapped: false }
  const tap = () => {
    removeEventListener('click', tap, true)
    log.tapped = true
    const began = performance.now()
    let seen
    const rows = new Map()
    const frame = () => {
      const now = performance.now()
      const scroller = document.querySelector('[data-transcript-viewport]')
      if (scroller) {
        const top = scroller.getBoundingClientRect().top
        const fromEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
        if (seen === undefined && fromEnd <= 2 && scroller.textContent.includes(${JSON.stringify(NEWEST)})) {
          seen = now
          log.newestMs = Math.round(now - began)
        }
        if (seen !== undefined) {
          for (const row of scroller.querySelectorAll('[data-exchange]')) {
            const box = row.getBoundingClientRect()
            if (box.bottom <= top || box.top >= top + scroller.clientHeight) continue
            if (!rows.has(row)) rows.set(row, box.top - top)
            const moved = Math.abs(box.top - top - rows.get(row))
            if (moved > log.moved) Object.assign(log, { moved, movedAt: Math.round(now - seen) })
          }
          if (now - seen > 1500) return (log.done = true)
        }
      }
      if (now - began < 8000) requestAnimationFrame(frame)
      else log.done = true
    }
    requestAnimationFrame(frame)
  }
  addEventListener('click', tap, true)
  return true
})()`

async function checkOpen() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_OPEN_ROOT
  const evidence = process.env.MAKO_OPEN_EVIDENCE
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const watchdog = setTimeout(() => app.exit(1), 180_000)
  const window = new BrowserWindow({ width: 393, height: 852, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  page.on("console-message", (details) => {
    if (details.level === "error" && !/flushSync was called from inside a lifecycle method/.test(details.message)) console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const send = (method, params) => page.debugger.sendCommand(method, params)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const capture = async (name) => writeFile(join(evidence, name), (await page.capturePage()).toPNG())
  const until = async (code, label = code, ms = 10_000) => {
    const deadline = Date.now() + ms
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure.png")
        throw new Error(`Timed out: ${label}`)
      }
      await wait(30)
    }
  }
  const tap = async (selector) => {
    const point = await evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 } })()`)
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] })
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  }
  /** Opens the Thread by a tap and records it; then back to where it can be opened again. */
  const open = async (label) => {
    await until("Boolean(document.querySelector('[data-open-thread]'))", "the Thread's row")
    await evaluate(RECORD)
    await tap("[data-open-thread]")
    await until("window.__open.done === true", `${label}: the open recorded`)
    const opened = await evaluate("window.__open")
    assert.ok(opened.tapped, `${label}: the tap opened the Thread`)
    return opened
  }
  const close = () => evaluate("window.openCheck.close(), true")

  await window.loadURL("about:blank")
  await send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 3, mobile: true })
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
  try {
    for (const theme of ["dark", "light"])
      for (const turns of [40, 260]) {
        const where = `${turns} turns, ${theme}`
        await window.loadURL(`${new URL("scripts/phone-open.html", process.env.MAKO_OPEN_URL).href}?theme=${theme}&turns=${turns}&answer=${ANSWER_MS}`)
        await until("Boolean(document.querySelector('[data-open-thread]'))", "the fixture")
        await evaluate("document.fonts.ready.then(() => true)")
        const said = []
        for (const [label, held] of [["first", false], ["again", true], ["after letting it go", false], ["once more", true]]) {
          if (label === "after letting it go") await evaluate("window.openCheck.forget(), true")
          const opened = await open(`${where}, ${label}`)
          assert.notEqual(opened.newestMs, undefined, `${where}, ${label}: the newest turn was never painted at the end`)
          const budget = held ? 400 : ANSWER_MS + 700
          assert.ok(opened.newestMs <= budget, `${where}, ${label}: the newest turn was painted ${opened.newestMs} ms after the tap (at most ${budget})`)
          assert.ok(opened.moved < 0.5, `${where}, ${label}: once painted, a turn on screen moved ${opened.moved.toFixed(1)} px, ${opened.movedAt} ms after`)
          said.push(`${label} ${opened.newestMs} ms${held ? " (held)" : ""}`)
          if (label === "again" && turns === 40) await capture(`opened-iphone-${theme}.png`)
          if (label === "again" && turns === 260) await capture(`opened-windowed-iphone-${theme}.png`)
          await close()
        }
        const readings = await evaluate("window.openCheck.readings()")
        const kept = readings.filter((reading) => reading.from === "kept")
        assert.ok(kept.length >= 1 && kept.every((reading) => reading.newestMs < ANSWER_MS), `${where}: the probe read a held open as painted from what was kept before its owner answered: ${JSON.stringify(readings)}`)
        console.log(`Opening, ${where}: newest painted ${said.join(", ")}; nothing moved after`)
      }
  } finally {
    clearTimeout(watchdog)
  }
}
