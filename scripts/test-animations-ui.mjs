import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"
import { atSize, withMotion } from "./lib/test-window.mjs"

// Every mark of work in progress moves for as long as its work runs, in
// production components on the isolated live workflow fixture: the sweep
// over each call running at once and over agents started together, a
// spinner, and the rail's worker-painted orb. Each is read as the browser
// runs it (its animation's name, play state and clock, or the orb's pixels)
// while it is on screen, after its window is hidden and shown again, after
// it is scrolled out of view and back, and under reduced motion, where it
// stands still. A running call carries no orb and nothing draws a heartbeat.
// Pass a dev web desk's URL to use its Vite server; with none it serves its own.
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app, BrowserWindow } = await import("electron")
    const window = BrowserWindow.getAllWindows()[0]
    try {
      if (window) {
        const out = join(process.env.MAKO_TEST_EVIDENCE ?? process.env.MAKO_ANIMATIONS_UI_ROOT, "animations")
        await mkdir(out, { recursive: true })
        await writeFile(join(out, "failure.png"), (await window.webContents.capturePage()).toPNG())
        await writeFile(join(out, "failure.json"), JSON.stringify(await window.webContents.executeJavaScript(`({
          samples: window.animationSamples,
          visibility: document.visibilityState,
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          viewport: [innerWidth, innerHeight],
          marks: [...document.querySelectorAll('.shimmer-text, [data-spinner], .live-mark-body')].map((element) => ({
            text: element.textContent.trim().slice(0, 60),
            name: getComputedStyle(element).animationName,
            state: getComputedStyle(element).animationPlayState,
            gate: getComputedStyle(element).getPropertyValue('--visible-animation-state'),
            clock: element.getAnimations()[0]?.currentTime,
            pending: element.getAnimations()[0]?.pending,
          })),
        })`), null, 2))
        console.error(`Animation evidence: ${out}`)
      }
    } catch (evidenceError) {
      console.error("Could not capture animation evidence:", evidenceError)
    }
    app.exit(1)
  })
} else {
  const root = testScratch("mako-animations-ui-")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-animations-ui", main: fileURLToPath(import.meta.url) }))
  const given = process.argv[2]
  let server
  if (!given) {
    const { uiVite } = await import("./lib/ui-vite.mjs")
    server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await server.listen()
  }
  const env = { ...process.env, MAKO_ANIMATIONS_UI_ROOT: root, MAKO_ANIMATIONS_UI_URL: given ?? server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server?.close()
  }
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_ANIMATIONS_UI_ROOT
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  withMotion(app)
  await app.whenReady()
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } })
  atSize(window, 1440, 900)
  const page = window.webContents
  const evaluate = (code) => page.executeJavaScript(code)
  const pause = (ms) => new Promise((done) => setTimeout(done, ms))
  const until = async (code, label = code) => {
    const deadline = Date.now() + 20_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
      await pause(40)
    }
  }
  page.debugger.attach("1.3")
  const reduceMotion = (reduce) => page.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }] })

  await window.loadURL(new URL("scripts/live-workflow.html", process.env.MAKO_ANIMATIONS_UI_URL).href)
  await until("Boolean(document.querySelector('[data-fixture=turn-parallel]'))", "the fixture")

  /**
   * The marks `selector` finds, each as the browser runs it: its first
   * animation's name and play state, and how far its clock moved over 400 ms.
   * A paused animation's ready promise resolves before its intersection gate
   * has opened. Wait for the requested state on every mark before sampling;
   * reduced-motion samples pass null because their animations may be absent.
   */
  const read = async (selector, state = "running") => {
    if (state) await until(`(() => {
      const elements = [...document.querySelectorAll(${JSON.stringify(selector)})]
      return elements.length > 0 && elements.every((element) => {
        const style = getComputedStyle(element)
        const animation = element.getAnimations()[0]
        return style.animationPlayState === ${JSON.stringify(state)} && !animation?.pending
      })
    })()`, `${selector} ready to be ${state}`)
    return evaluate(`(async () => {
    const elements = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const clock = (element) => element.getAnimations()[0]?.currentTime ?? null
    // Styles first, so a gate set just now applies; a pause or play takes hold on the next frame (\`ready\`).
    for (const element of elements) getComputedStyle(element).animationPlayState
    await Promise.all(elements.map((element) => element.getAnimations()[0]?.ready))
    const snapshot = (element) => {
      const animation = element.getAnimations()[0]
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return { clock: clock(element), timeline: document.timeline.currentTime, state: style.animationPlayState, gate: style.getPropertyValue("--visible-animation-state"), pending: animation?.pending, start: animation?.startTime, connected: element.isConnected, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
    }
    const initial = elements.map(snapshot)
    const before = elements.map(clock)
    await new Promise((done) => setTimeout(done, 400))
    const marks = elements.map((element, index) => {
      const style = getComputedStyle(element)
      const animation = element.getAnimations()[0]
      const after = clock(element)
      return { initial: initial[index], final: snapshot(element), text: element.textContent.trim().slice(0, 60), name: style.animationName, state: style.animationPlayState, running: animation?.playState, moved: before[index] === null || after === null ? 0 : after - before[index] }
    })
    ;(window.animationSamples ??= []).push({ selector: ${JSON.stringify(selector)}, expected: ${JSON.stringify(state)}, marks })
    return marks
  })()`)
  }
  const moving = (marks, what, name) => {
    assert.ok(marks.length > 0, `${what}: on screen`)
    for (const mark of marks) {
      assert.equal(mark.name, name, `${what} "${mark.text}" runs ${name}`)
      assert.equal(mark.state, "running", `${what} "${mark.text}" plays`)
      assert.equal(mark.running, "running", `${what} "${mark.text}" is running`)
      assert.ok(mark.moved > 200, `${what} "${mark.text}" moved ${mark.moved} ms in 400 ms`)
    }
  }
  const resting = (marks, what) => {
    for (const mark of marks) {
      assert.equal(mark.state, "paused", `${what} "${mark.text}" rests`)
      assert.equal(mark.moved, 0, `${what} "${mark.text}" stands still while it rests`)
    }
  }
  /** Distinct pictures of the element `selector` finds, over `count` frames 150 ms apart. */
  const pictures = async (selector, count = 6) => {
    const rect = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) } })()`)
    const seen = new Set()
    for (let index = 0; index < count; index++) {
      seen.add((await page.capturePage(rect)).toBitmap().toString("base64"))
      await pause(150)
    }
    return seen.size
  }
  /** The page told its window was hidden, then shown, as a covered or minimized window is. */
  const visibility = (state) => evaluate(`Object.defineProperty(document, "visibilityState", { configurable: true, get: () => ${JSON.stringify(state)} }); document.dispatchEvent(new Event("visibilitychange")); true`)

  // Three calls running at once: each sweeps, and none carries an orb.
  await evaluate("document.querySelector('[data-fixture=turn-parallel]').click(), true")
  const rows = "[data-live-step] .shimmer-text"
  await until(`document.querySelectorAll(${JSON.stringify(rows)}).length >= 3`, "three running rows")
  moving(await read(rows), "a running call", "shimmer-sweep")
  assert.equal(await evaluate("document.querySelectorAll('[data-live-step] .activity-orb, [data-live-step] canvas').length"), 0, "a running call's only signal is its sweep: no orb")
  assert.equal(await evaluate("document.querySelectorAll('.lucide-activity, .activity-meter').length"), 0, "nothing draws a heartbeat")

  // A spinner and the rail's working fin, which runs on the shared clock: at the timeline's own point of its loop.
  const spinner = "[data-fixture=spinner] [data-spinner]"
  const fin = "[data-fixture=status-marks] [data-live-mark=working] .live-mark-body"
  const inPhase = `(() => { const animation = document.querySelector(${JSON.stringify(fin)}).getAnimations()[0]; const period = animation.effect.getComputedTiming().duration; return Math.abs((animation.currentTime % period) - (document.timeline.currentTime % period)) < 20 })()`
  moving(await read(spinner), "a spinner", "spinner-turn")
  moving(await read(fin), "the working fin", "live-mark-bob")
  assert.ok((await pictures(fin)) > 1, "the working fin moves")
  assert.equal(await evaluate(inPhase), true, "the fin runs on the shared clock")

  // Covered or minimized, they rest; shown again, every one moves again.
  await visibility("hidden")
  resting(await read(rows, "paused"), "a running call, hidden")
  resting(await read(spinner, "paused"), "a spinner, hidden")
  resting(await read(fin, "paused"), "the working fin, hidden")
  await visibility("visible")
  moving(await read(rows), "a running call, shown again", "shimmer-sweep")
  moving(await read(spinner), "a spinner, shown again", "spinner-turn")
  moving(await read(fin), "the working fin, shown again", "live-mark-bob")
  assert.equal(await evaluate(inPhase), true, "shown again, the fin is back on the shared clock rather than where it rested")

  // Scrolled out of view the rows rest; scrolled back they sweep again.
  const scroller = "document.querySelector('[data-live-step]').closest('.scroll-fade-scroller')"
  await evaluate(`(() => { const spacer = document.createElement("div"); spacer.id = "animations-spacer"; spacer.style.height = "4000px"; ${scroller}.firstElementChild.append(spacer); ${scroller}.scrollTop = ${scroller}.scrollHeight; return true })()`)
  await until(`getComputedStyle(document.querySelector(${JSON.stringify(rows)})).animationPlayState === "paused"`, "the rows resting out of view")
  resting(await read(rows, "paused"), "a running call, scrolled away")
  await evaluate(`(() => { document.getElementById("animations-spacer").remove(); document.querySelector('[data-live-step]').scrollIntoView({ block: "center" }); return true })()`)
  await until(`getComputedStyle(document.querySelector(${JSON.stringify(rows)})).animationPlayState === "running"`, "the rows moving again in view")
  moving(await read(rows), "a running call, scrolled back", "shimmer-sweep")

  // Agents started together sweep as one row.
  await evaluate("document.querySelector('[data-fixture=turn-agents]').click(), true")
  await until("Boolean(document.querySelector('[data-agent-group] .shimmer-text'))", "the agent group")
  moving(await read("[data-agent-group] .shimmer-text"), "agents running", "shimmer-sweep")
  assert.equal(await evaluate("document.querySelectorAll('[data-live-step] .activity-orb, [data-live-step] canvas').length"), 0, "agents running carry no orb")

  // Reduced motion: the words stand still in their own colours, the spinner and the fin stand still.
  await reduceMotion(true)
  await pause(200)
  for (const mark of await read("[data-agent-group] .shimmer-text", null)) assert.equal(mark.name, "none", "reduced motion: the words stand still")
  for (const mark of await read(spinner, null)) assert.ok(mark.running !== "running" || mark.moved === 0, "reduced motion: the spinner stands still")
  assert.equal(await pictures(fin), 1, "reduced motion: the fin stands still")
  await reduceMotion(false)

  console.log("Every mark of work in progress moves while it is seen, rests while it is not, and moves again when seen.")
  app.exit(0)
}
