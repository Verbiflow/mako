import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Side questions in the window, against the mock bridge: `/btw` in the `/`
// menu, a question asked while a turn runs, its answer streaming in the
// side panel and staying out of the transcript, a follow-up, Stop, a failed
// answer and Ask again, Esc closing it, and `/btw` alone opening an empty
// panel. Writes screenshots and a recording of the whole run.
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const { default: electronPath } = await import("electron")
  const root = process.env.MAKO_SIDE_CHECK_OUT ?? await mkdtemp(join(tmpdir(), "mako-side-ui-"))
  await mkdir(root, { recursive: true })
  const threadUrl = process.env.MAKO_THREAD_URL
  const server = threadUrl ? undefined : await createServer({
    cacheDir: join(root, "cache"),
    server: { host: "127.0.0.1", port: 0, watch: null },
  })
  if (server) await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-side-ui-check", main: fileURLToPath(import.meta.url) }))
  const env = {
    ...process.env,
    MAKO_SIDE_CHECK_ROOT: root,
    MAKO_SIDE_CHECK_URL: `${threadUrl ?? server.resolvedUrls.local[0]}/`.replace(/\/\/$/, "/"),
  }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(electronPath, [root], { env, stdio: "inherit" })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    if (server) await server.close()
  }
  if (process.exitCode === 0) encode(root)
  console.log(`Side question UI evidence: ${root}`)
}

/** The screencast's frames, each held for as long as it was on screen, as one video. */
function encode(root) {
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(root, "frames", "list.txt"),
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-fps_mode", "vfr", "-c:v", "libx264", "-crf", "18", "-movflags", "+faststart", join(root, "side-questions.mp4")], { stdio: "inherit" })
  if (made.status !== 0) throw new Error("ffmpeg could not encode the recording")
  const gif = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(root, "side-questions.mp4"),
    "-vf", "fps=15,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", join(root, "side-questions.gif")], { stdio: "inherit" })
  if (gif.status !== 0) throw new Error("ffmpeg could not write the GIF")
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_SIDE_CHECK_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  const timer = setTimeout(() => app.exit(1), 150000)
  const page = window.webContents
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const frame = () => evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const shots = []
  const capture = async (name, selector, { settle = true } = {}) => {
    if (settle) {
      const end = Date.now() + 2000
      while (Date.now() < end && !(await evaluate("document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity)")))
        await pause(25)
    }
    await evaluate("document.fonts.ready")
    await frame()
    const bounds = selector
      ? await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)} })()`)
      : undefined
    await writeFile(join(root, name), (await page.capturePage(bounds)).toPNG())
    shots.push(name)
  }
  const until = async (code, what = code, ms = 15000) => {
    const end = Date.now() + ms
    while (!(await evaluate(code))) {
      if (Date.now() > end) {
        await capture("failure.png", undefined, { settle: false })
        throw new Error(`Timed out: ${what}`)
      }
      await pause(25)
    }
  }
  const press = async (key, code = key, keyCode = 13) => {
    for (const type of ["keyDown", "keyUp"])
      await page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode })
  }
  const clickAt = async (point) => {
    for (const type of ["mousePressed", "mouseReleased"])
      await page.debugger.sendCommand("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point })
  }
  const centre = (expression) => `(() => { const el = ${expression}; if (!el) return null; const r = el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`
  const click = async (selector) => {
    await frame()
    const point = await evaluate(centre(`document.querySelector(${JSON.stringify(selector)})`))
    assert.ok(point, `Missing ${selector}`)
    await clickAt(point)
  }
  const draft = () => evaluate("[...document.querySelectorAll('[data-composer] textarea')].find(t => !t.closest('[data-side-panel]')).value")
  /** Types as a person does, a character at a time, so the recording reads. */
  const typeInto = async (selector, text, perKey = 16) => {
    await click(selector)
    for (const glyph of text) {
      await page.debugger.sendCommand("Input.insertText", { text: glyph })
      await pause(perKey)
    }
  }
  const mainField = "[data-composer] textarea:not([data-side-panel] *)"
  const sideField = "[data-side-panel] textarea"
  const panel = "document.querySelector('[data-side-panel]')"
  const exchanges = `[...(${panel}?.querySelectorAll('[data-side-exchange]') ?? [])]`
  const toast = (text) => until(`[...document.querySelectorAll('[data-sonner-toast]')].some(t => t.textContent.includes(${JSON.stringify(text)}))`, `a toast saying ${text}`)
  const outsidePanel = (text) => evaluate(`(() => { const clone = document.body.cloneNode(true); clone.querySelector('[data-side-panel]')?.remove(); clone.querySelectorAll('[data-sonner-toast]').forEach(t => t.remove()); return clone.textContent.includes(${JSON.stringify(text)}) })()`)
  const turnRunning = () => evaluate("[...document.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === 'Stop')")

  await mkdir(join(root, "frames"), { recursive: true })
  const frames = []
  let recording = false
  page.debugger.on("message", (_event, method, params) => {
    if (method !== "Page.screencastFrame") return
    void page.debugger.sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {})
    if (!recording) return
    const name = `frame-${String(frames.length).padStart(5, "0")}.jpg`
    frames.push({ name, at: params.metadata.timestamp })
    void writeFile(join(root, "frames", name), Buffer.from(params.data, "base64"))
  })
  const startRecording = async () => {
    recording = true
    await page.debugger.sendCommand("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 })
  }
  const stopRecording = async () => {
    await pause(600)
    await page.debugger.sendCommand("Page.stopScreencast")
    recording = false
    assert.ok(frames.length > 30, `The recording caught ${frames.length} frames`)
    const lines = frames.flatMap((entry, index) => {
      const next = frames[index + 1]?.at ?? entry.at + 1
      return [`file '${join(root, "frames", entry.name)}'`, `duration ${Math.max(0.016, next - entry.at).toFixed(3)}`]
    })
    lines.push(`file '${join(root, "frames", frames.at(-1).name)}'`)
    await writeFile(join(root, "frames", "list.txt"), `${lines.join("\n")}\n`)
  }

  try {
    await window.loadURL(`${process.env.MAKO_SIDE_CHECK_URL}?mock`)
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false })
    await until("Boolean(document.querySelector('[data-composer] textarea'))", "the composer")

    await until("Boolean(document.querySelector('[data-sonner-toast]'))", "the fixture's plugin toast", 8000).catch(() => {})
    await evaluate("document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach(b => b.click())")
    await until("!document.querySelector('[data-sonner-toast]')", "the fixture's toasts dismissed")
    await evaluate("document.querySelector(\"button[aria-label='Hide the right sidebar']\").click()")
    await until("Boolean(document.querySelector(\"button[aria-label='Show the right sidebar']\"))", "the right sidebar hidden")
    await startRecording()
    await pause(600)

    // `/` offers Mako's side question first for what was typed, in place of the harness's own.
    await typeInto(mainField, "/bt", 90)
    await until("[...document.querySelectorAll('[role=option]')].some(o => o.textContent.startsWith('btw'))", "the btw row in the / menu")
    assert.match(await evaluate("[...document.querySelectorAll('[role=option]')].find(o => o.textContent.startsWith('btw')).textContent"), /Ask a side question without interrupting the turn/)
    assert.equal(await evaluate("[...document.querySelectorAll('[role=option]')].filter(o => /^(btw|side)/.test(o.textContent)).length"), 1, "the harness's own btw and side commands stay behind Mako's row")
    assert.match(await evaluate("document.querySelector('[role=option][aria-selected=true]')?.textContent ?? ''"), /^btw/, "the typed command is the one Enter picks")
    await pause(500)
    await capture("menu.png")
    await press("Enter")
    await until("[...document.querySelectorAll('[data-composer] textarea')].some(t => t.value === '/btw ')", "the picked command in the draft")
    await pause(300)

    // With no conversation yet it says what to do, and keeps the draft.
    await press("Enter")
    await toast("Start a conversation first, then ask a side question about it.")
    assert.equal(await draft(), "/btw ", "a side question with nowhere to go keeps the draft")
    for (let index = 0; index < 5; index += 1) await press("Backspace", "Backspace", 8)
    await evaluate("document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach(b => b.click())")
    await pause(400)

    // A conversation to ask beside.
    await typeInto(mainField, "Find out why the session rail re-renders on every token", 22)
    await press("Enter")
    await until("document.body.textContent.includes('The rail selected the entire store object')", "the first reply")
    await pause(900)

    // `/btw` alone opens an empty panel to ask in.
    await typeInto(mainField, "/btw", 90)
    await until("[...document.querySelectorAll('[role=option]')].some(o => o.textContent.startsWith('btw'))", "the btw row again")
    await press("Enter")
    await until("[...document.querySelectorAll('[data-composer] textarea')].some(t => t.value === '/btw ')", "the picked command again")
    await pause(300)
    await press("Enter")
    await until(`Boolean(${panel}) && document.activeElement === ${panel}.querySelector('textarea')`, "the empty side panel, focused")
    assert.equal(await draft(), "", "opening the panel clears the draft")
    assert.match(await evaluate(`${panel}.textContent`), /The answer stays here, out of the conversation\./)
    assert.equal(await evaluate(`${panel}.querySelector('textarea').placeholder`), "Ask about this conversation…")
    await pause(900)
    await capture("panel-empty.png", "[data-composer]")
    await press("Escape", "Escape", 27)
    await until(`!${panel}`, "the empty panel closed")
    await until("document.activeElement?.matches('[data-composer] textarea')", "focus back in the composer")
    await pause(500)

    // A turn that keeps running.
    await typeInto(mainField, "Run the rail tests", 34)
    await press("Enter")
    await until("document.body.textContent.includes('npm test -- rail')", "the turn running its tool")
    assert.ok(await turnRunning(), "the turn is running")
    await pause(900)

    // Asked from the composer while the turn runs.
    const first = "Why was the rail re-rendering on every token?"
    await typeInto(mainField, `/btw ${first}`, 34)
    await pause(300)
    await press("Enter")
    await until(`Boolean(${panel})`, "the side panel")
    assert.equal(await draft(), "", "an asked side question clears the draft")
    await until(`${panel}.textContent.includes('Thinking')`, "the thinking state")
    assert.match(await evaluate(`${panel}.textContent`), /Side questionClaude Code answers from this conversation\. Its turn keeps going\./)
    await capture("panel-thinking.png", "[data-composer]", { settle: false })
    await until(`(${exchanges}.at(-1)?.querySelector('.side-prose')?.textContent.length ?? 0) > 70`, "the answer streaming")
    await capture("panel-streaming.png", "[data-composer]", { settle: false })
    await until(`${exchanges}.at(-1)?.dataset.sideExchange === 'answered'`, "the answer finished")
    assert.match(await evaluate(`${panel}.textContent`), /entire store object/)
    assert.equal(await evaluate(`Boolean(${panel}.querySelector('strong') && ${panel}.querySelector('pre, [data-code-block], code'))`), true, "the answer renders as markdown, code included")
    assert.ok(await turnRunning(), "the turn kept running while the side question was answered")
    assert.equal(await outsidePanel(first), false, "the side question is not in the transcript")
    assert.equal(await outsidePanel("Each streamed token makes a new store object"), false, "the side answer is not in the transcript")
    assert.equal(await evaluate("document.activeElement?.closest('[data-side-panel]') !== null"), true, "focus moves to the side panel")
    await pause(1200)
    await capture("panel-answered.png", "[data-composer]")
    await capture("window-answered.png")

    // A follow-up from the panel's own field.
    await typeInto(sideField, "Which other components still do that?", 34)
    await pause(300)
    await press("Enter")
    await until(`${exchanges}.length === 2 && ${exchanges}.at(-1).dataset.sideExchange === 'answered'`, "the follow-up answered")
    assert.match(await evaluate(`${exchanges}.at(-1).textContent`), /status bar/)
    await pause(1200)
    await capture("panel-follow-up.png", "[data-composer]")

    // Stop keeps what came so far and lets the next question go.
    await typeInto(sideField, "Walk me through the fix again, in detail", 30)
    await press("Enter")
    await until(`(${exchanges}.at(-1)?.querySelector('.side-prose')?.textContent.length ?? 0) > 90`, "the third answer streaming")
    await pause(200)
    await click("[data-side-panel] button[aria-label='Stop the side answer']")
    await until(`${exchanges}.at(-1)?.dataset.sideExchange === 'stopped'`, "the answer stopped")
    assert.match(await evaluate(`${exchanges}.at(-1).textContent`), /Stopped\./)
    await pause(1000)
    await capture("panel-stopped.png", "[data-composer]")

    // A failed answer says why and offers to ask again.
    await typeInto(sideField, "Will this fail on older React versions?", 30)
    await press("Enter")
    await until(`${exchanges}.at(-1)?.dataset.sideExchange === 'failed'`, "the failed answer")
    assert.match(await evaluate(`${exchanges}.at(-1).textContent`), /provider closed the connection.*Ask again/)
    await pause(1200)
    assert.ok(await evaluate("[...document.querySelectorAll('[data-composer] textarea')].find(t => !t.closest('[data-side-panel]')).getBoundingClientRect().height >= 20"), "the composer keeps its own field beside a long side conversation")
    await capture("panel-failed.png", "[data-composer]")
    await capture("window-failed.png")

    // Esc closes it, discards the side conversation and gives the composer back its focus.
    await press("Escape", "Escape", 27)
    await until(`!${panel}`, "the side panel closed")
    await until("document.activeElement?.matches('[data-composer] textarea') && !document.activeElement.closest('[data-side-panel]')", "focus back in the composer")
    assert.equal(await outsidePanel(first), false, "closing leaves nothing of the side conversation behind")
    await pause(1500)
    await stopRecording()

    console.log(`Side question UI: the / menu, an empty panel, a question asked while a turn ran, streaming markdown kept out of the transcript, a follow-up, Stop, a failure with Ask again, and Esc. ${shots.length} screenshots, ${frames.length} recorded frames.`)
  } finally {
    clearTimeout(timer)
    app.exit(process.exitCode ?? 0)
  }
}
