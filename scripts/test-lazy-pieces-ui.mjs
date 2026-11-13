import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * Every piece the window reads as code of its own when it's needed says where it stands: while its code is on its way
 * something stands in its place, and if the code can't arrive it says so with a way to try again; nothing is left blank,
 * and nothing takes the window down to its error screen. Each piece's module is held (`Fetch.requestPaused`) to see it
 * loading, then failed as a network would fail it: the web desk's composer, Files and Changes, the phone's Agents sheet,
 * and Show original's dialog. (The thinking orb isn't one: it draws whenever a Thread works, so it loads with the
 * Thread.) Screenshots land in the printed directory. `--url <base>` uses a running Vite server instead of starting one.
 */

if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const given = process.argv.indexOf("--url")
  const root = testScratch("mako-lazy-pieces-ui-")
  let server
  let base = given > 0 ? process.argv[given + 1] : undefined
  if (!base) {
    const { createServer } = await import("vite")
    server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await server.listen()
    base = server.resolvedUrls.local[0]
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-lazy-pieces-ui", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: base }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code, signal) => done(electronExit("The lazy pieces UI check", code, signal)))
    })
  } finally {
    await server?.close()
  }
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL.replace(/\/$/, "")
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } })
  const page = window.webContents
  const guard = guardElectronCheck({ app, page, name: "The lazy pieces UI check", ms: 300_000 })
  page.debugger.attach("1.3")
  const consoleLines = []
  page.on("console-message", (event) => consoleLines.push(String(event.message ?? "").slice(0, 300)))
  // What a failed check saw, beside the run and in CI's evidence (`MAKO_TEST_EVIDENCE`, which the job uploads).
  const keepEvidence = async (label) => {
    const kept = [root, ...(process.env.MAKO_TEST_EVIDENCE ? [join(process.env.MAKO_TEST_EVIDENCE, "lazy-pieces")] : [])]
    const png = await page.capturePage().then((image) => image.toPNG(), () => undefined)
    const dom = await page.executeJavaScript("document.body.innerHTML.slice(0, 20000)").catch(() => "")
    const said = `${label}\n\nasks:\n${asks.join("\n")}\n\nconsole:\n${consoleLines.slice(-60).join("\n")}\n`
    for (const folder of kept) {
      await mkdir(folder, { recursive: true }).catch(() => undefined)
      if (png) await writeFile(join(folder, "failure.png"), png)
      await writeFile(join(folder, "failure.txt"), said)
      await writeFile(join(folder, "failure.html"), dom)
    }
  }
  const send = (method, params) => page.debugger.sendCommand(method, params)
  const viewport = async (width, height) => {
    await window.loadURL("about:blank")
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false })
    // MAKO_LAZY_SLOW: a CI runner's pace and settings here (a slow CPU, reduced motion), to see what it sees.
    if (process.env.MAKO_LAZY_SLOW) {
      await send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.MAKO_LAZY_SLOW) || 4 })
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] })
    }
  }
  const evaluate = (code) => page.executeJavaScript(code)
  const until = async (code, label = code) => {
    guard.at(label)
    const deadline = Date.now() + 30_000
    while (!(await evaluate(code).catch(() => false))) {
      if (Date.now() > deadline) {
        await keepEvidence(label)
        throw new Error(`Timed out waiting for ${label}`)
      }
      await new Promise((done) => setTimeout(done, 50))
    }
  }
  const load = async (path) => {
    await window.loadURL(`${base}${path}`).catch((error) => {
      if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error
    })
  }
  const capture = async (name) => {
    await evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))")
    const png = (await page.capturePage()).toPNG()
    await writeFile(join(root, name), png)
    // A run's screenshots kept beyond its scratch folder, which goes when it passes.
    if (process.env.MAKO_UI_SHOTS) await writeFile(join(process.env.MAKO_UI_SHOTS, name), png)
  }
  const seen = (selector) => until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, selector)
  const click = async (selector) => {
    await seen(selector)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`)
  }
  const press = async (selector) => {
    await seen(selector)
    await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 1 })); node.click(); return true })()`)
  }
  const clickText = (scope, text) => evaluate(`[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((button) => button.textContent.trim() === ${JSON.stringify(text)})?.click() ?? false`)
  const notBroken = async (what) => assert.equal(await evaluate("document.body.innerText.includes('Something in the interface broke')"), false, `${what}: the window never shows its error screen`)

  // A module held, then let go or failed as a network fails it: `hold` before the page that reads it loads.
  // Each held pattern is in one state: `hold` (asks wait in `paused`), `fail` (every ask fails, as with the network
  // down) or `continue` (every ask goes through). A state applies to every later ask too: a browser may ask for the
  // same module again, and an ask left waiting after its first was failed leaves the import pending for good.
  const paused = new Map()
  const states = new Map()
  /** Every ask for a held pattern, in order, with what was done with it: said when a check fails. */
  const asks = []
  const settle = (requestId, state) =>
    send(state === "fail" ? "Fetch.failRequest" : "Fetch.continueRequest", state === "fail" ? { requestId, errorReason: "InternetDisconnected" } : { requestId }).catch(() => undefined)
  page.debugger.on("message", (_event, method, params) => {
    if (method !== "Fetch.requestPaused") return
    const pattern = [...states.keys()].find((each) => params.request.url.includes(each))
    const state = pattern ? states.get(pattern) : "continue"
    if (pattern) asks.push(`${state}: ${params.request.url}`)
    if (state === "hold") paused.get(pattern).push(params.requestId)
    else void settle(params.requestId, state)
  })
  const hold = async (...patterns) => {
    for (const pattern of patterns) {
      paused.set(pattern, [])
      states.set(pattern, "hold")
    }
    await send("Fetch.enable", { patterns: [...states.keys()].map((pattern) => ({ urlPattern: `*${pattern}*`, requestStage: "Request" })) })
  }
  const held = async (pattern) => {
    guard.at(`${pattern} asked for`)
    const deadline = Date.now() + 30_000
    while (!paused.get(pattern)?.length) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${pattern} to be asked for`)
      await new Promise((done) => setTimeout(done, 50))
    }
  }
  /** Settles what waits for `pattern` and every later ask for it the same way, until `letGo`. */
  const release = async (pattern, how) => {
    states.set(pattern, how)
    for (const requestId of paused.get(pattern) ?? []) await settle(requestId, how)
    paused.set(pattern, [])
  }
  const letGo = async () => {
    for (const pattern of paused.keys()) await release(pattern, "continue")
    paused.clear()
    states.clear()
    await send("Fetch.disable").catch(() => undefined)
  }
  /** Back online after a failure: the piece draws by itself, or (a module this page won't fetch again) offers Reload, which brings it. */
  const recovers = async (what, drawn, scope, reopen) => {
    await letGo()
    if (await evaluate(`Boolean([...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((button) => button.textContent.trim() === 'Retry'))`)) await clickText(scope, "Retry")
    else await evaluate("window.dispatchEvent(new Event('online')); true")
    await until(`(${drawn}) || Boolean(document.querySelector('[data-code-unavailable=stuck]'))`, `${what} back, or offering Reload`)
    if (await evaluate("Boolean(document.querySelector('[data-code-unavailable=stuck]'))")) {
      await clickText(scope, "Reload")
      await reopen()
    }
    await until(drawn, `${what} drawn`)
    await notBroken(what)
  }

  // The web desk's composer: its room held while its code arrives, a line with Retry and Reload if it can't.
  await viewport(1440, 900)
  const COMPOSER = "src/components/composer/composer.tsx"
  const desk = "/scripts/web-desk.html?thread=apex&theme=dark"
  const composerDrawn = "Boolean(document.querySelector('[data-composer]')) && !document.querySelector('[data-composer-pending]')"
  await hold(COMPOSER)
  await load(desk)
  await held(COMPOSER)
  await seen("[data-composer-pending][aria-busy=true]")
  const pending = await evaluate("document.querySelector('[data-composer-pending]').getBoundingClientRect().height")
  await capture("composer-loading.png")
  await release(COMPOSER, "continue")
  await until(composerDrawn, "the desk's composer")
  const composer = await evaluate("document.querySelector('[data-composer]').getBoundingClientRect().height")
  console.log(`composer: ${pending} px held, ${composer} px drawn`)
  assert.ok(Math.abs(pending - composer) <= 8, `the composer's room (${pending} px) is its height (${composer} px), so the transcript doesn't move`)
  await letGo()
  await hold(COMPOSER)
  await load(desk)
  await held(COMPOSER)
  await release(COMPOSER, "fail")
  await until("document.querySelector('[data-composer-pending] [data-code-unavailable]')?.innerText.includes(\"The composer couldn't load\")", "the composer saying it couldn't load")
  assert.ok(await evaluate("['Retry', 'Reload'].every((word) => [...document.querySelectorAll('[data-composer-pending] button')].some((button) => button.textContent.trim() === word))"), "the composer's Retry and Reload")
  await capture("composer-unavailable.png")
  await notBroken("the composer")
  await recovers("the composer", composerDrawn, "[data-composer-pending]", async () => {
    await until("document.querySelectorAll('[data-thread-row]').length > 0", "the desk reloaded")
  })

  // Files and Changes: a loading line while their code arrives, never a blank layer.
  for (const [what, pattern, open] of [
    ["Changes", "src/web-client/desk-review.tsx", () => click("button[aria-label='Show the right sidebar']:not(:disabled)")],
    ["Files", "src/web-client/files-screen.tsx", async () => {
      await click("button[aria-label='Show the right sidebar']:not(:disabled)")
      await press("[data-side-rail] [data-surface-id=files]")
    }],
  ]) {
    await letGo()
    await hold(pattern)
    await load(desk)
    await until("document.querySelectorAll('[data-thread-row]').length > 0", `the web desk, ${what}'s code held`)
    await open()
    await until(`document.querySelector('.rv-layer [data-code-loading]')?.innerText.includes(${JSON.stringify(`Loading ${what}`)})`, `${what} loading`)
    await capture(`${what.toLowerCase()}-loading.png`)
    await release(pattern, "continue")
    await until("Boolean(document.querySelector('.rv-layer [data-side-rail]')) && !document.querySelector('[data-code-loading]')", `${what} drawn`)
  }
  await letGo()

  // Show original's dialog: a line while it opens, a line with Retry if it can't, never the window's error screen.
  const DIALOG = "src/components/transcript/show-original-dialog.tsx"
  const streams = "/?mock&app=streams"
  const field = "[data-composer] textarea"
  const answered = async () => {
    await seen(field)
    await evaluate(`document.querySelector(${JSON.stringify(field)}).focus()`)
    await send("Input.insertText", { text: "Find out why the session rail re-renders on every token" })
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
    await until("document.body.textContent.includes('The rail selected the entire store object')", "the streams scene's answer")
  }
  await load(streams)
  await seen(field)
  await evaluate(`localStorage.setItem("mako.prefs.v1", JSON.stringify({ ...JSON.parse(localStorage.getItem("mako.prefs.v1") ?? "{}"), showOriginals: true })); true`)
  await hold(DIALOG)
  await load(streams)
  await answered()
  await click("[data-show-original]")
  await held(DIALOG)
  await seen("[data-original-loading]")
  await release(DIALOG, "fail")
  await until("Boolean(document.querySelector('[data-original-unavailable]'))", "Show original saying it couldn't open")
  assert.match(await evaluate("document.querySelector('[data-original-unavailable]').innerText"), /Couldn't open the original/)
  await capture("original-unavailable.png")
  await notBroken("Show original")
  await letGo()
  await clickText("[data-original-unavailable]", "Retry")
  // This Chromium keeps a dynamic import it failed once, so a retry may meet the same failure: either way the window stands.
  await until("Boolean(document.querySelector('[data-original-dialog]')) || Boolean(document.querySelector('[data-original-unavailable]'))", "Show original tried again")
  await notBroken("Show original, tried again")
  await load(streams)
  await answered()
  await click("[data-show-original]")
  await seen("[data-original-dialog]")

  // The phone's Agents sheet: a loading line while its roster's code arrives, a line with Retry and Reload if it can't.
  await viewport(390, 844)
  const PANEL = "src/components/inspector/agents-panel.tsx"
  const phone = "/scripts/phone-apex.html?app=apex"
  const openSheet = async () => {
    await until("Boolean(document.querySelector('[data-thread] [data-fin-pips]'))", "the phone's list")
    await click("[data-thread]")
    await click("[data-apex-count]")
  }
  const rosterDrawn = "Boolean(document.querySelector('[data-agents-sheet] [data-apex-fins]'))"
  await hold(PANEL)
  await load(phone)
  await openSheet()
  await held(PANEL)
  await until("document.querySelector('[data-agents-sheet] [data-code-loading]')?.innerText.includes('Loading the agents')", "the Agents sheet loading")
  await capture("agents-loading.png")
  await release(PANEL, "fail")
  await until("document.querySelector('[data-agents-sheet] [data-code-unavailable]')?.innerText.includes(\"The agents couldn't load\")", "the Agents sheet saying it couldn't load")
  await capture("agents-unavailable.png")
  await notBroken("the Agents sheet")
  await recovers("the Agents sheet", rosterDrawn, "[data-agents-sheet]", openSheet)

  console.log(`Lazy pieces UI: the composer, Files, Changes, Show original and the Agents sheet each load, fail and come back without a blank or the error screen (${root})`)
  guard.done()
  app.exit(0)
}
