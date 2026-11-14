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
  const guard = guardElectronCheck({ app, page, name: "The lazy pieces UI check", ms: 600_000 })
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
  // A page that stops answering (a render that never ends) fails the check with what it last drew, never hangs it.
  const evaluate = (code) => Promise.race([page.executeJavaScript(code), new Promise((_, fail) => setTimeout(() => fail(new Error(`The page stopped answering: ${code.slice(0, 80)}`)), 10_000))])
  /**
   * A function run in the page with `args` passed as its arguments (`Runtime.callFunctionOn`), never spliced into
   * script text: a selector or words reach the page as values.
   */
  const run = async (fn, ...args) => {
    const { result: global } = await send("Runtime.evaluate", { expression: "globalThis" })
    const answer = await send("Runtime.callFunctionOn", { objectId: global.objectId, functionDeclaration: fn.toString(), arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true })
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text)
    return answer.result.value
  }
  /** Until `check`, a check here (which may `run` one in the page with values), holds. */
  const untilCheck = async (check, label) => {
    guard.at(label)
    const deadline = Date.now() + 30_000
    while (!(await check().catch(() => false))) {
      if (Date.now() > deadline) {
        await keepEvidence(label)
        throw new Error(`Timed out waiting for ${label}`)
      }
      await new Promise((done) => setTimeout(done, 50))
    }
  }
  /** Until a page script of fixed text holds. */
  const until = (code, label = code) => untilCheck(() => evaluate(code), label)
  const load = async (path) => {
    guard.at(`loading ${path}`)
    // A page whose own first code is held never finishes loading: that fails the check, never hangs it.
    const loading = window.loadURL(`${base}${path}`).catch((error) => {
      if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error
    })
    await Promise.race([loading, new Promise((_, fail) => setTimeout(() => fail(new Error(`${path} didn't finish loading`)), 30_000))])
  }
  const capture = async (name) => {
    await evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))")
    const png = (await page.capturePage()).toPNG()
    await writeFile(join(root, name), png)
    // A run's screenshots kept beyond its scratch folder, which goes when it passes.
    if (process.env.MAKO_UI_SHOTS) await writeFile(join(process.env.MAKO_UI_SHOTS, name), png)
  }
  const seen = (selector) => untilCheck(() => run((target) => Boolean(document.querySelector(target)), selector), selector)
  const click = async (selector) => {
    await seen(selector)
    await run((target) => document.querySelector(target).click(), selector)
  }
  const press = async (selector) => {
    await seen(selector)
    await run((target) => {
      const node = document.querySelector(target)
      node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1 }))
      node.click()
    }, selector)
  }
  /** The button in `scope` that says `text`, whether there is one. */
  const hasButton = (scope, text) => run((within, words) => [...document.querySelectorAll(`${within} button`)].some((button) => button.textContent.trim() === words), scope, text)
  const clickText = (scope, text) => run((within, words) => [...document.querySelectorAll(`${within} button`)].find((button) => button.textContent.trim() === words)?.click() ?? false, scope, text)
  /** Whether the element `selector` names says `words`. */
  const says = (selector, words) => run((target, text) => Boolean(document.querySelector(target)?.innerText.includes(text)), selector, words)
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
    if (await hasButton(scope, "Retry")) await clickText(scope, "Retry")
    else await evaluate("window.dispatchEvent(new Event('online')); true")
    await untilCheck(async () => (await evaluate(drawn)) || (await evaluate("Boolean(document.querySelector('[data-code-unavailable=stuck]'))")), `${what} back, or offering Reload`)
    if (await evaluate("Boolean(document.querySelector('[data-code-unavailable=stuck]'))")) {
      // Nothing is asked of the page until the reload has loaded: a script sent mid-navigation can go unanswered.
      const reloaded = new Promise((done) => page.once("did-finish-load", done))
      await clickText(scope, "Reload")
      await reloaded
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
  await until("document.querySelector('[data-composer-pending][aria-busy=true] [data-code-loading]')?.innerText.includes('Loading the composer')", "the composer loading")
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
    await untilCheck(() => says(".rv-layer [data-code-loading]", `Loading ${what}`), `${what} loading`)
    await capture(`${what.toLowerCase()}-loading.png`)
    await release(pattern, "continue")
    await until("Boolean(document.querySelector('.rv-layer [data-side-rail]')) && !document.querySelector('.rv-layer [data-code-loading]')", `${what} drawn`)
  }
  await letGo()

  // Code still on its way past its patience (a slow or stalled download) isn't a failure: the piece keeps its loading
  // look, says "Still loading…" with Reload, and draws when the code lands. Only a read that fails says it couldn't.
  const FILES = "src/web-client/files-screen.tsx"
  const filesOpen = async (label) => {
    await load(desk)
    await until("document.querySelectorAll('[data-thread-row]').length > 0", label)
    await click("button[aria-label='Show the right sidebar']:not(:disabled)")
    await press("[data-side-rail] [data-surface-id=files]")
    await held(FILES)
  }
  await hold(FILES)
  await filesOpen("the web desk, Files' code slow")
  await untilCheck(() => says(".rv-layer [data-code-slow]", "Still loading Files"), "Files past its patience, still loading")
  assert.ok(await hasButton(".rv-layer [data-code-loading-layer]", "Reload"), "Files' Reload while it's slow")
  assert.equal(await evaluate("Boolean(document.querySelector('.rv-layer [data-code-unavailable]'))"), false, "slow is not a failure")
  assert.equal(paused.get(FILES).length > 0, true, "its code still held, neither arrived nor failed")
  await capture("files-slow.png")
  await release(FILES, "continue")
  await until("Boolean(document.querySelector('.rv-layer [data-side-rail]')) && !document.querySelector('.rv-layer [data-code-loading]')", "Files drawn once its late code landed")
  await letGo()
  // Past its patience a read follows the network: offline it's a failure, and given up, so going back online starts a
  // new read, which says it's still loading past its own patience. Handed back the stalled read, Retry would end on
  // "This page won't fetch it again". The browser shares one in-flight fetch per module, so the new read joins the
  // held request rather than asking again: the page's count of reads started (`noteReadStarted`) tells it apart.
  const readsStarted = () => evaluate("Number(globalThis.__makoCodeReads ?? 0)")
  /** How many listeners the window holds for `type`, as DevTools counts them. */
  const windowListeners = async (type) => {
    const { result } = await send("Runtime.evaluate", { expression: "window" })
    const { listeners } = await send("DOMDebugger.getEventListeners", { objectId: result.objectId })
    return listeners.filter((listener) => listener.type === type).length
  }
  const network = async (online) => {
    await send("Network.enable")
    await send("Network.emulateNetworkConditions", { offline: !online, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  }
  await hold(FILES)
  await filesOpen("the web desk, Files' code slow, then the network gone")
  await untilCheck(() => says(".rv-layer [data-code-slow]", "Still loading Files"), "Files slow")
  const watchingOffline = await windowListeners("offline")
  await network(false)
  await untilCheck(() => says(".rv-layer [data-code-unavailable]", "Files couldn't load"), "Files slow, then offline: it couldn't load")
  // Given up, the read stops watching the network: a module Safari leaves pending for good keeps no listeners.
  assert.equal(await windowListeners("offline"), watchingOffline - 1, "the given-up read's offline listener is gone")
  const filesReads = await readsStarted()
  await network(true)
  await untilCheck(async () => (await readsStarted()) > filesReads, "back online, a new read of Files' code started")
  await untilCheck(() => says(".rv-layer [data-code-slow]", "Still loading Files"), "back online, Files loading again in a new read")
  assert.equal(await evaluate("Boolean(document.querySelector('.rv-layer [data-code-unavailable]'))"), false, "back online and loading, not a failure")
  await release(FILES, "continue")
  await until("Boolean(document.querySelector('.rv-layer [data-side-rail]')) && !document.querySelector('.rv-layer [data-code-loading]')", "Files drawn from its new load")
  await letGo()
  // Changes (`lazyCode`): offline when its patience runs out is a failure, and back online its code is asked for anew.
  const CHANGES = "src/web-client/desk-review.tsx"
  await hold(CHANGES)
  await load(desk)
  await until("document.querySelectorAll('[data-thread-row]').length > 0", "the web desk, Changes' code held")
  await click("button[aria-label='Show the right sidebar']:not(:disabled)")
  await held(CHANGES)
  await network(false)
  await untilCheck(() => says(".rv-layer [data-code-unavailable]", "Changes couldn't load"), "Changes offline past its patience: it couldn't load")
  const changesReads = await readsStarted()
  await network(true)
  await untilCheck(async () => (await readsStarted()) > changesReads, "back online, a new read of Changes' code started")
  await untilCheck(() => says(".rv-layer [data-code-slow]", "Still loading Changes"), "back online, Changes loading again in a new read")
  assert.equal(await evaluate("Boolean(document.querySelector('.rv-layer [data-code-unavailable]'))"), false, "back online and loading, not a failure")
  await release(CHANGES, "continue")
  await until("Boolean(document.querySelector('.rv-layer [data-side-rail]')) && !document.querySelector('.rv-layer [data-code-unavailable]') && !document.querySelector('.rv-layer [data-code-loading]')", "Changes drawn from its new load")
  await letGo()
  await hold(FILES)
  await filesOpen("the web desk, Files' code failing")
  await release(FILES, "fail")
  await untilCheck(() => says(".rv-layer [data-code-unavailable]", "Files couldn't load"), "Files' failed read saying it couldn't load")
  await letGo()

  // Show original's dialog: a line while it opens, a line with Retry if it can't, never the window's error screen.
  const DIALOG = "src/components/transcript/show-original-dialog.tsx"
  const streams = "/?mock&app=streams"
  const field = "[data-composer] textarea"
  const answered = async () => {
    await seen(field)
    await run((target) => document.querySelector(target).focus(), field)
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
  assert.ok((await hasButton("[data-original-unavailable]", "Retry")) && (await hasButton("[data-original-unavailable]", "Reload")), "Show original's Retry and Reload")
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
  // Its viewer's code slow: past its patience "Still opening the original…" with Retry and Reload, not a failure, and
  // the dialog once the code lands.
  await hold(DIALOG)
  await load(streams)
  await answered()
  await click("[data-show-original]")
  await held(DIALOG)
  await untilCheck(() => says("[data-original-slow]", "Still opening the original"), "Show original past its patience, still opening")
  assert.ok((await hasButton("[data-original-slow]", "Retry")) && (await hasButton("[data-original-slow]", "Reload")), "Show original's Retry and Reload while it's slow")
  assert.equal(await evaluate("Boolean(document.querySelector('[data-original-unavailable]'))"), false, "slow is not a failure")
  await notBroken("Show original, slow")
  await release(DIALOG, "continue")
  await seen("[data-original-dialog]")
  await letGo()

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

  // The web app's own screens (`?webapp` mounts `WebApp` on the desk fixture's client), as a phone draws them under a finger.
  const phoneInput = async (on) => {
    await send("Emulation.setEmulatedMedia", { features: on ? [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }, { name: "any-pointer", value: "coarse" }, { name: "any-hover", value: "none" }] : [] })
    await send("Emulation.setTouchEmulationEnabled", on ? { enabled: true, maxTouchPoints: 5 } : { enabled: false })
  }
  const appPage = "/scripts/web-desk.html?webapp&theme=dark"
  const listed = "document.querySelectorAll('[data-thread]').length > 0"
  await viewport(390, 844)
  await phoneInput(true)
  // A Thread tapped before its screen's code arrived: its bar and title at once, over the transcript's loader.
  const THREAD = "src/web-client/thread.tsx"
  await letGo()
  await hold(THREAD)
  await load(appPage)
  await until(listed, "the phone's list")
  const title = await evaluate("document.querySelector('[data-thread] [data-thread-title], [data-thread]')?.innerText.split('\\n')[0]")
  await click("[data-thread]")
  await until("Boolean(document.querySelector('[data-thread-loading] h1')) && Boolean(document.querySelector('[data-thread-loading] [aria-busy]'))", "the Thread's shell")
  assert.ok((await evaluate("document.querySelector('[data-thread-loading] h1').textContent")).length > 0, `the shell names the Thread (${title})`)
  await capture("thread-shell.png")
  await held(THREAD)
  await release(THREAD, "continue")
  await until("Boolean(document.querySelector('[data-thread-screen]')) && !document.querySelector('[data-thread-loading]')", "the Thread's own screen")
  await letGo()
  await hold(THREAD)
  await load(appPage)
  await until(listed, "the phone's list again")
  await click("[data-thread]")
  await held(THREAD)
  await release(THREAD, "fail")
  await until("document.querySelector('[data-thread-loading] [data-code-unavailable]')?.innerText.includes(\"This Thread couldn't load\")", "the Thread saying it couldn't load")
  assert.ok(await evaluate("Boolean([...document.querySelectorAll('[data-thread-loading] button')].find((button) => button.textContent.trim() === 'Reload'))"), "the Thread's Reload")
  await capture("thread-unavailable.png")
  await notBroken("the Thread")
  // New: its sheet at once, saying it's loading, then its form in the same sheet; a line with Retry if it can't.
  const START = "src/web-client/new-thread.tsx"
  await letGo()
  await hold(START)
  await load(appPage)
  await until(listed, "the list, New's code held")
  await click("button.web-fab[aria-label='New thread']")
  await until("document.querySelector('.web-start-sheet [data-code-loading]')?.innerText.includes('Loading New')", "New's sheet loading")
  await capture("new-loading.png")
  await held(START)
  await release(START, "continue")
  await until("Boolean(document.querySelector('.web-start-sheet')) && !document.querySelector('.web-start-sheet [data-code-loading]') && document.querySelector('.web-start-sheet').innerText.trim().length > 0", "New's form in its sheet")
  // Settings, read with React.lazy: a loading line, and on a failure a line with Reload, never the window's error screen.
  const SETTINGS = "src/web-client/settings.tsx"
  await letGo()
  await hold(SETTINGS)
  await load(appPage)
  await until(listed, "the list, Settings' code held")
  await click("button[aria-label='Settings']")
  await until("document.querySelector('[data-code-loading]')?.innerText.includes('Loading Settings')", "Settings loading")
  await held(SETTINGS)
  await release(SETTINGS, "fail")
  await until("document.querySelector('[data-screen-unavailable] [data-lazy-failed]')?.innerText.includes(\"Settings couldn't load\")", "Settings saying it couldn't load")
  await capture("settings-unavailable.png")
  await notBroken("Settings")
  // Past their patience, still on their way: a Thread's code says "Still loading this Thread…" over its shell, and
  // Settings (read with React.lazy, timing its own wait) "Still loading Settings…", each with Reload, then draws.
  await letGo()
  await hold(THREAD)
  await load(appPage)
  await until(listed, "the phone's list, a Thread's code slow")
  await click("[data-thread]")
  await held(THREAD)
  await untilCheck(() => says("[data-thread-loading] [data-code-slow]", "Still loading this Thread"), "the Thread past its patience, still loading")
  assert.ok(await hasButton("[data-thread-loading]", "Reload"), "the Thread's Reload while it's slow")
  await capture("thread-slow.png")
  await release(THREAD, "continue")
  await until("Boolean(document.querySelector('[data-thread-screen]')) && !document.querySelector('[data-thread-loading]')", "the Thread's screen once its late code landed")
  await letGo()
  await hold(SETTINGS)
  await load(appPage)
  await until(listed, "the list, Settings' code slow")
  await click("button[aria-label='Settings']")
  await held(SETTINGS)
  await untilCheck(() => says("[data-code-slow]", "Still loading Settings"), "Settings past its patience, still loading")
  assert.ok(await hasButton("[data-code-loading-screen]", "Reload"), "Settings' Reload while it's slow")
  assert.equal(await evaluate("Boolean(document.querySelector('[data-screen-unavailable]'))"), false, "slow is not a failure")
  await release(SETTINGS, "continue")
  await until("!document.querySelector('[data-code-loading-screen]') && !document.querySelector('[data-screen-unavailable]')", "Settings drawn once its late code landed")
  await letGo()
  await phoneInput(false)

  // A laptop's browser: the desk is a chunk of its own, and the page says it's loading until it arrives.
  await viewport(1440, 900)
  const DESK = "src/web-client/desk.tsx"
  await hold(DESK)
  await load(appPage)
  await until("document.querySelector('[data-code-loading]')?.innerText.includes('Loading Mako')", "the desk loading")
  await held(DESK)
  await release(DESK, "fail")
  await until("document.querySelector('[data-screen-unavailable] [data-code-unavailable]')?.innerText.includes(\"Mako couldn't load\")", "the desk saying it couldn't load")
  await capture("desk-unavailable.png")
  await notBroken("the desk")
  await letGo()
  await load(appPage)
  await until("document.querySelectorAll('[data-thread-row]').length > 0", "the desk")

  // A preview read with React.lazy (here Files' reader, `FileView`) still on its way past its patience: its own loading
  // look with "Still loading the file…" and Reload, not a failure; drawn once its code lands.
  const VIEW = "src/components/viewer/file-view.tsx"
  await letGo()
  await viewport(1440, 900)
  await hold(VIEW)
  await load(desk)
  await until("document.querySelectorAll('[data-thread-row]').length > 0", "the web desk, the file viewer's code held")
  await click("button[aria-label='Show the right sidebar']:not(:disabled)")
  await press("[data-side-rail] [data-surface-id=files]")
  await untilCheck(() => hasButton(".rv-layer", "package.json"), "Files listing package.json")
  await clickText(".rv-layer", "package.json")
  await held(VIEW)
  await untilCheck(() => says("[data-lazy-slow]", "Still loading the file"), "the file's preview past its patience, still loading")
  assert.ok(await hasButton("[data-lazy-slow]", "Reload"), "the preview's Reload while it's slow")
  assert.equal(await evaluate("Boolean(document.querySelector('[data-lazy-failed]'))"), false, "slow is not a failure")
  await capture("preview-slow.png")
  await release(VIEW, "continue")
  await until("!document.querySelector('[data-lazy-slow]')", "the file's preview drawn once its late code landed")
  await notBroken("the file's preview")
  await letGo()

  console.log(`Lazy pieces UI: the composer, Files, Changes, Show original, the Agents sheet, a Thread, New, Settings, the desk and a preview each load, fail, run past their patience and come back without a blank or the error screen (${root})`)
  guard.done()
  app.exit(0)
}
