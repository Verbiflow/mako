import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"
import { atSize, withMotion } from "./lib/test-window.mjs"

/**
 * A turn's tool rows never draw over one another, in the Mac's conversation at a laptop's size and in the phone's
 * steps sheet at an iPhone's (`src/dev/tool-rows-check.tsx`): a Cursor turn's file edits stream as the host's batches
 * bring them, each opening as "Editing", its path arriving, and settling as "Edit" while the next opens; a row opens
 * mid-stream and grows. On every frame, every row's words stay inside its row, and each row starts at or below where
 * the one above it ends, its words included. Each case runs on a short transcript and a windowed one (over 200 turns),
 * dark and light. Then a turn of every tool of Mako's own server and the row facts (`?rows=words`) says what each call
 * did, in Mako's words, with a failed command's exit, a read's range and an edit's size, none naming the `mako` server.
 *
 * Screenshots go to the printed directory, or to the directory given as the first argument; `--port` serves the page
 * on that port (default: any free one).
 */
if (process.versions.electron) {
  const { app } = await import("electron")
  void checkRows().then(() => app.exit(0)).catch((error) => {
    console.error(error)
    app.exit(1)
  })
} else {
  const { uiVite } = await import("./lib/ui-vite.mjs")
  const args = process.argv.slice(2)
  const portAt = args.indexOf("--port")
  const port = portAt === -1 ? 0 : Number(args.splice(portAt, 2)[1])
  const root = testScratch("mako-tool-rows-ui-")
  const evidence = args[0] ? resolve(args[0]) : process.env.MAKO_TEST_EVIDENCE ? join(process.env.MAKO_TEST_EVIDENCE, "tool-rows") : root
  await mkdir(evidence, { recursive: true })
  const server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port, strictPort: port !== 0, hmr: false } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-tool-rows-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_ROWS_ROOT: root, MAKO_ROWS_EVIDENCE: evidence, MAKO_ROWS_URL: server.resolvedUrls.local[0] }
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
}

/**
 * Measures every drawn tool row each frame until `window.__rows.stop()`: where its box is, where its words are drawn,
 * and any frame where words leave their row or a row starts above the end of the one before it. Only what is painted
 * counts: a row sliding out from under a clipping ancestor (a list opening by its height) is drawn only inside it.
 */
const WATCH = `(() => {
  const faults = []
  let frames = 0, most = 0, running = true, largest = []
  const clip = (row) => {
    let top = -Infinity, bottom = Infinity
    for (let node = row.parentElement; node && node !== document.body; node = node.parentElement) {
      if (getComputedStyle(node).overflowY === 'visible') continue
      const box = node.getBoundingClientRect()
      top = Math.max(top, box.top)
      bottom = Math.min(bottom, box.bottom)
    }
    return { top, bottom }
  }
  const drawn = (row) => {
    const box = row.getBoundingClientRect()
    const shown = clip(row)
    let top = box.top, bottom = box.bottom
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const line of range.getClientRects()) {
        top = Math.min(top, line.top)
        bottom = Math.max(bottom, line.bottom)
      }
    }
    return { id: row.dataset.transcriptTool, words: row.querySelector('button')?.innerText.replace(/\\s+/g, ' ').trim(), box, top: Math.max(top, shown.top), bottom: Math.min(bottom, shown.bottom) }
  }
  const frame = () => {
    const rows = [...document.querySelectorAll('[data-transcript-tool]')].filter(row => row.getClientRects().length).map(drawn).filter(row => row.bottom > row.top).sort((a, b) => a.top - b.top)
    if (rows.length > most) {
      most = rows.length
      largest = rows.map(({ id, words, top, bottom }) => ({ id, words, top, bottom }))
    }
    rows.forEach((row, index) => {
      if (row.top < row.box.top - 0.5 || row.bottom > row.box.bottom + 0.5)
        faults.push(row.words + ': its words span ' + row.top.toFixed(1) + '–' + row.bottom.toFixed(1) + ' px, its row ' + row.box.top.toFixed(1) + '–' + row.box.bottom.toFixed(1))
      const above = rows[index - 1]
      if (above && row.top < above.bottom - 0.5)
        faults.push(row.words + ' starts at ' + row.top.toFixed(1) + ' px, over ' + above.words + ', which ends at ' + above.bottom.toFixed(1))
    })
    frames += 1
    if (running) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  window.__rows = { stop: () => { running = false; return { frames, most, largest, faults: [...new Set(faults)] } } }
  return true
})()`

async function checkRows() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_ROWS_ROOT
  const evidence = process.env.MAKO_ROWS_EVIDENCE
  app.setPath("userData", join(root, "profile"))
  withMotion(app)
  await app.whenReady()
  const watchdog = setTimeout(() => app.exit(1), 240_000)
  const window = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  atSize(window, 1280, 820)
  const page = window.webContents
  page.debugger.attach("1.3")
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const send = (method, params) => page.debugger.sendCommand(method, params)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const capture = async (name, measured) => {
    await writeFile(join(evidence, `${name}.png`), (await page.capturePage()).toPNG())
    const state = await evaluate(`({
      viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
      streaming: window.toolRows?.streaming,
      steps: [...document.querySelectorAll('[data-work-summary],[data-steps-line]')].map(control => ({ words: control.innerText, open: control.getAttribute('aria-expanded') })),
      rows: [...document.querySelectorAll('[data-transcript-tool]')].map(row => ({ id: row.dataset.transcriptTool, box: row.getBoundingClientRect().toJSON() }))
    })`)
    await writeFile(join(evidence, `${name}.json`), JSON.stringify({ measured, ...state }, null, 2))
  }
  const until = async (code, label = code) => {
    const deadline = Date.now() + 15_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out: ${label}`)
      }
      await wait(30)
    }
  }
  const SIZES = {
    desk: { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false },
    phone: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true },
  }

  // A page first: emulating a window that has drawn nothing yet crashes Electron.
  await window.loadURL("about:blank")
  try {
    for (const surface of ["desk", "phone"]) {
      await send("Emulation.setDeviceMetricsOverride", SIZES[surface])
      for (const turns of [12, 230]) {
        for (const theme of ["dark", "light"]) {
          const label = `${surface}, ${turns} turns, ${theme}`
          await window.loadURL(`${new URL("scripts/tool-rows.html", process.env.MAKO_ROWS_URL).href}?surface=${surface}&turns=${turns}&theme=${theme}`)
          await until(`Boolean(window.toolRows && document.querySelector('[data-transcript-viewport] [data-exchange]'))`, `${label}: the transcript`)
          await evaluate("document.fonts.ready.then(() => true)")
          const windowed = await evaluate("document.querySelector('[data-transcript-viewport]').hasAttribute('data-virtualized')")
          assert.equal(windowed, turns > 200, `${label}: the transcript ${windowed ? "is" : "isn't"} windowed`)
          // The turns before it open their steps, so settled rows stand above the streaming ones.
          if (surface === "desk") await evaluate(`[...document.querySelectorAll('[data-turn-fold="closed"] > button')].slice(-2).forEach(fold => fold.click()), true`)
          await evaluate(WATCH)
          await evaluate("window.toolRows.stream(8, 120)")
          // The turn's steps so far open, as the reader opens them while it runs: on the desk under the turn, on a
          // phone in the steps sheet. A running call alone has no work summary yet; a timed click could miss it.
          const summary = surface === "desk" ? '[data-work-summary]' : '[data-steps-line="live"]'
          await until(`Boolean(document.querySelector('${summary}'))`, `${label}: the steps control`)
          await evaluate(`document.querySelector('${summary}').click(), true`)
          await until(`document.querySelector('${summary}').getAttribute('aria-expanded') === 'true'`, `${label}: the steps opened`)
          // Open an actual settled call while later calls are still streaming, whichever pace this renderer keeps.
          const row = '[data-transcript-tool$=":live-2"] > div > button'
          await until(`document.querySelector('[data-transcript-tool$=":live-3"]') && document.querySelector('${row}')`, `${label}: the fourth call`)
          assert.equal(await evaluate("window.toolRows.streaming"), true, `${label}: the row opens mid-stream`)
          await evaluate(`document.querySelector('${row}').click(), true`)
          await until(`document.querySelector('${row}').getAttribute('aria-expanded') === 'true'`, `${label}: the settled row opened`)
          await until("!window.toolRows.streaming", `${label}: every stream phase arrived`)
          assert.equal(await evaluate(`document.querySelectorAll('[data-transcript-tool*=":live-"]').length`), 8, `${label}: every streamed call is mounted`)
          await evaluate(`[...document.querySelectorAll('[data-transcript-tool] > div > button[aria-expanded="true"]')].forEach(row => row.click()), true`)
          await evaluate(`Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))).then(() => true)`)
          await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`)
          const watched = await evaluate("window.__rows.stop()")
          if (turns < 200 || watched.most < 6 || watched.faults.length) await capture(`tool-rows-${surface}-${turns}-${theme}`, watched)
          await evaluate("window.toolRows.settle(), true")
          assert.ok(watched.most >= 6, `${label}: ${watched.most} rows were drawn at once, fewer than the stream's`)
          assert.deepEqual(watched.faults, [], `${label}: rows drew over one another`)
          console.log(`${label}: ${watched.frames} frames, up to ${watched.most} rows, none over another`)
        }
      }
    }
    // Every tool of Mako's own server and the row facts (`?rows=words`): each row says what happened, on one line.
    await send("Emulation.setDeviceMetricsOverride", SIZES.desk)
    for (const theme of ["dark", "light"]) {
      const label = `words, ${theme}`
      await window.loadURL(`${new URL("scripts/tool-rows.html", process.env.MAKO_ROWS_URL).href}?rows=words&theme=${theme}`)
      await until(`Boolean(document.querySelector('[data-transcript-viewport] [data-exchange]'))`, `${label}: the transcript`)
      await evaluate("document.fonts.ready.then(() => true)")
      await evaluate(`document.querySelectorAll('[data-work-summary][aria-expanded="false"]').forEach(summary => summary.click()), true`)
      await evaluate(WATCH)
      await wait(400)
      const said = await evaluate(`[...document.querySelectorAll('[data-transcript-tool]')].map(row => row.querySelector('button').innerText.replace(/\\s+/g, ' ').trim())`)
      for (const words of ["Started fin:own-words on Codex", "Answered fin:own-words: Squash it", "Messaged apex:Release notes", "Opened PR #374", "Start the app (api) failed", "Showed rows-after.png", "npm test failed · exit 2", "tool-row.tsx …/src/components/transcript :120–180", "+3 −2", "Edit 3 files +4 −2", "Starting fin:verify on"])
        assert.ok(said.some((row) => row.includes(words)), `${label}: no row says "${words}": ${JSON.stringify(said)}`)
      assert.ok(!said.some((row) => /\bmako$/.test(row)), `${label}: a Mako tool's row names its server`)
      assert.match(await evaluate(`[...document.querySelectorAll('[data-work-summary]')].map(summary => summary.innerText).join(' ')`), /\b1 failed\b/, `${label}: the lint a retry fixed still counts as failed`)
      await capture(`tool-words-desk-${theme}`)
      const watched = await evaluate("window.__rows.stop()")
      assert.deepEqual(watched.faults, [], `${label}: rows drew over one another`)
      console.log(`${label}: ${said.length} rows say what happened, none over another`)
    }
  } catch (error) {
    await capture("failure")
    throw error
  } finally {
    clearTimeout(watchdog)
  }
}
