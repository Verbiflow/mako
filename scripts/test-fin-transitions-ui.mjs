import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * An opened Fin through everything that can happen to it, on the desk, in a laptop's browser and on a phone. From each
 * way in (the crew card, the left rail, Agents, the phone's list by way of its Apex) a Fin opens with one tab or screen; hiding and showing
 * the rail, closing it, going to another Thread and reloading each leave no Fin behind and no other Thread's roster on
 * show. What the rail reads and what Agents draws always agree, which is the invariant every step checks.
 * Screenshots land in the printed directory. `--url <base>` uses a running Vite server instead of starting one.
 */

if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const given = process.argv.indexOf("--url")
  const root = testScratch("mako-fin-transitions-ui-")
  let server
  let base = given > 0 ? process.argv[given + 1] : undefined
  if (!base) {
    const { uiVite } = await import("./lib/ui-vite.mjs")
    server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await server.listen()
    base = server.resolvedUrls.local[0]
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-fin-transitions-ui", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: base }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code, signal) => done(electronExit("The Fin transitions UI check", code, signal)))
    })
  } finally {
    await server?.close()
  }
}

const FIN = "Sheet motion on iPad"
const CLOSE = `button[aria-label='Close ${FIN}']`
const SHOW = "button[aria-label='Show the right sidebar']:not(:disabled)"
const HIDE = "button[aria-label='Hide the right sidebar']"

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL.replace(/\/$/, "")
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } })
  const page = window.webContents
  const guard = guardElectronCheck({ app, page, name: "The Fin transitions UI check", ms: 420_000 })
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const until = async (code, label = code) => {
    guard.at(label)
    const deadline = Date.now() + 30_000
    while (!(await evaluate(code).catch(() => false))) {
      if (Date.now() > deadline) {
        await writeFile(join(root, "failure.png"), (await page.capturePage()).toPNG())
        throw new Error(`Timed out waiting for ${label}`)
      }
      await new Promise((done) => setTimeout(done, 50))
    }
  }
  const seen = (selector) => until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, selector)
  const gone = (selector) => until(`!document.querySelector(${JSON.stringify(selector)})`, `no ${selector}`)
  const click = async (selector) => {
    await seen(selector)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`)
  }
  const load = async (path) => {
    await window.loadURL(`${base}${path}`).catch((error) => {
      if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error
    })
  }
  const viewport = async (width, height, mobile = false) => {
    await window.loadURL("about:blank")
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile })
  }
  const row = (words) => `[...document.querySelectorAll('.thread-jump-scope [data-flip-key], [data-thread-row]')].find((node) => node.innerText.includes(${JSON.stringify(words)}))`
  const openThread = async (words) => {
    await until(`Boolean(${row(words)})`, `the row of ${words}`)
    await evaluate(`${row(words)}.click(); true`)
  }
  const reading = () => evaluate("document.querySelector('[data-surface-id=agents]')?.innerText.replace(/\\s+/g, ' ').trim() ?? null")
  const rail = async () => {
    if (!(await evaluate("Boolean(document.querySelector('[data-side-rail]'))"))) await click(SHOW)
    await seen("[data-side-rail]")
  }
  /** The rail's Agents row and what it draws name the Apex's twelve Fins. */
  const apexRoster = async (where) => {
    await rail()
    await click("[data-side-rail] [data-surface-id=agents]")
    await until("document.querySelector('[data-apex-fins]')?.dataset.apexFins === '12'", `the Apex's twelve in Agents, ${where}`)
    assert.match((await reading()) ?? "", /2 need you/, `the Agents row reads the same roster, ${where}`)
  }
  const oneTab = (fin) => until(`document.querySelectorAll('[data-child-tab]').length === 1 && document.querySelector('[data-child-tab="${fin}"]')?.getAttribute('aria-selected') === 'true'`, "the Fin's one tab")
  const apexBack = () =>
    until("!document.querySelector('[data-child-tab]') && !document.querySelector('[data-child-breadcrumb]') && !document.querySelector('[data-child-of]') && Boolean(document.querySelector('[data-crew]'))", "the Apex, with no Fin left")

  // The desk.
  await viewport(1440, 900)
  const deskApex = async () => {
    await load("/?mock&app=apex")
    await until("document.querySelectorAll('.thread-jump-scope [data-asking-fin]').length === 2", "the desk's Apex row")
    await openThread("12 Fins")
    await seen("[data-crew]")
    await rail()
  }
  await deskApex()
  const fin = await evaluate(`window.apexScene.children().find((agent) => agent.title === ${JSON.stringify(FIN)}).child.thread`)
  const crew = `[data-crew-row="${fin}"] button`
  const deskEntries = {
    "the crew card": () => click(crew),
    "the left rail": () => click(`[data-asking-fin="${fin}"]`),
    "Agents": async () => {
      await rail()
      await click("[data-side-rail] [data-surface-id=agents]")
      await click(`[data-child-row="${fin}"]`)
    },
  }
  for (const [entry, open] of Object.entries(deskEntries)) {
    await deskApex()
    await open()
    await oneTab(fin)
    await seen("[data-child-breadcrumb]")
    await click(HIDE)
    await gone("[data-side-rail]")
    await click(SHOW)
    await apexRoster(`on the desk with its Fin open from ${entry}`)
    await click(CLOSE)
    await apexBack()
    await apexRoster(`on the desk after closing the Fin from ${entry}`)
    // Straight to another Thread with the Fin open: nothing of the Apex comes along.
    await open()
    await oneTab(fin)
    await openThread("Refactor the composer")
    await gone("[data-child-tab]")
    await gone("[data-crew]")
    await rail()
    // Agents was open, so its row stays, with no reading and none of the Apex's Fins; and no row stays lit for the Fin.
    assert.ok(["Agents", null].includes(await reading()), `no reading from the Apex: ${await reading()}`)
    await gone("[data-apex-fins]")
    await gone("[data-asking-fin][data-active]")
    await openThread("12 Fins")
    await apexBack()
    await apexRoster(`on the desk back from another Thread, from ${entry}`)
    // A reload keeps no Fin.
    await open()
    await oneTab(fin)
    await deskApex()
    await apexBack()
    console.log(`Desk: the Fin from ${entry}`)
  }

  // A laptop's browser.
  const webApex = async () => {
    await load("/scripts/web-desk.html?thread=apex&theme=dark")
    await until("document.querySelectorAll('[data-thread-row]').length > 0", "the web desk")
    await seen("[data-crew]")
  }
  const otherThread = "Thread Environments"
  const webEntries = {
    "the crew card": () => click(crew),
    "the left rail": () => click(`[data-asking-fin="${fin}"]`),
    "Agents": async () => {
      await rail()
      await click("[data-side-rail] [data-surface-id=agents]")
      await click(`.rv-layer [data-child-row="${fin}"]`)
    },
  }
  /** Agents in another Thread: its own roster, drawn and read alike, none of the Apex's. */
  const otherRoster = async (where) => {
    await click("[data-agents-toggle]")
    await seen(".rv-layer [data-side-rail] [data-surface-id=agents][data-open]")
    await until("Boolean(document.querySelector('.rv-layer [data-native-work]'))", `the other Thread's roster, ${where}`)
    assert.equal(await evaluate("Boolean(document.querySelector('.rv-layer [data-apex-fins]'))"), false, `no Apex's Fins, ${where}`)
    assert.equal(await evaluate(`document.querySelector('.rv-layer').innerText.includes(${JSON.stringify(FIN)})`), false, `no Fin of the Apex, ${where}`)
    assert.match((await reading()) ?? "", /running/, `the row reads this Thread, ${where}`)
    await click(HIDE)
    await gone("[data-side-rail]")
  }
  for (const [entry, open] of Object.entries(webEntries)) {
    await webApex()
    await open()
    await until(`Boolean(document.querySelector('[data-child-of] [data-child-tab="${fin}"][aria-selected="true"]'))`, `the Fin from ${entry}`)
    await until("!document.querySelector('[data-crew]')", "the Fin's own transcript")
    await rail()
    await click(HIDE)
    await gone("[data-side-rail]")
    await click(SHOW)
    await apexRoster(`in the browser with its Fin open from ${entry}`)
    await click(HIDE)
    await gone("[data-side-rail]")
    await click(CLOSE)
    await apexBack()
    // Closed, then another Thread: pr-review's path, and the row and the panel agree on it.
    await openThread(otherThread)
    await gone("[data-crew]")
    await otherRoster(`after closing the Fin from ${entry}`)
    await openThread("12 Fins")
    await apexBack()
    await apexRoster(`in the browser back on the Apex, from ${entry}`)
    await click(HIDE)
    await gone("[data-side-rail]")
    // Straight to another Thread with the Fin open.
    await open()
    await until("Boolean(document.querySelector('[data-child-of] [data-child-tab]'))", "the Fin again")
    await openThread(otherThread)
    await gone("[data-child-tab]")
    await gone("[data-child-of]")
    await otherRoster(`straight from an open Fin, from ${entry}`)
    // A reload keeps no Fin and no roster.
    await openThread("12 Fins")
    await apexBack()
    await open()
    await until("Boolean(document.querySelector('[data-child-of] [data-child-tab]'))", "the Fin before a reload")
    await webApex()
    await apexBack()
    await apexRoster(`in the browser after a reload, from ${entry}`)
    console.log(`Laptop browser: the Fin from ${entry}`)
  }
  // Agents follows the Session on screen inside a Thread: the row and the panel agree on each tab.
  await load("/scripts/web-desk.html?thread=busy&theme=dark")
  await until("document.querySelectorAll('[data-session-tab]').length > 2", "the busy Thread's Sessions")
  await click("[data-agents-toggle]")
  await seen(".rv-layer [data-side-rail]")
  const counted = () => evaluate("(() => { const words = document.querySelector('[data-surface-id=agents]')?.innerText ?? ''; const panel = document.querySelector('.rv-layer')?.innerText ?? ''; const running = words.match(/(\\d+) running/)?.[1]; return { running, drawn: running ? panel.includes(`${running} running`) : true } })()")
  await until("Boolean(document.querySelector('.rv-layer [data-native-work]'))", "the first Session's roster")
  assert.equal((await counted()).drawn, true, `the first Session's row and panel agree: ${JSON.stringify(await counted())}`)
  const third = await evaluate("document.querySelectorAll('[data-session-tab]')[2].getAttribute('data-session-tab')")
  await evaluate(`document.querySelector('[data-session-tab="${third}"]').click(); true`)
  await until(`document.querySelector('[data-session-tab="${third}"]').getAttribute('aria-selected') === 'true'`, "the third Session")
  await seen(".rv-layer [data-side-rail]")
  assert.equal((await counted()).drawn, true, `the third Session's row and panel agree: ${JSON.stringify(await counted())}`)
  console.log("Laptop browser: Agents follows the Session on screen")

  // The phone.
  await viewport(390, 844, true)
  const phoneList = async () => {
    await load("/scripts/phone-apex.html?app=apex")
    await until("Boolean(document.querySelector('[data-thread] [data-fin-pips]'))", "the phone's list")
  }
  const phoneApex = async () => {
    await phoneList()
    await click("[data-thread]")
    await seen("[data-crew]")
  }
  const phoneFin = () => until("Boolean(document.querySelector('[data-child-of]')) && !document.querySelector('[data-apex-count]')", "the Fin on the phone")
  const phoneBack = async () => {
    await click("[data-back-to-apex]")
    await until("!document.querySelector('[data-child-of]') && Boolean(document.querySelector('[data-crew]')) && document.querySelector('[data-apex-count]')?.dataset.apexCount === '12'", "the Apex on the phone")
  }
  const phoneRoster = async (where) => {
    await click("[data-apex-count]")
    await until("document.querySelector('[data-agents-sheet] [data-apex-fins]')?.dataset.apexFins === '12'", `the phone's twelve, ${where}`)
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    await gone("[data-agents-sheet] [data-apex-fins]")
  }
  const phoneEntries = {
    "the crew card": async () => {
      await phoneApex()
      await click(`${crew}`)
    },
    "the Agents sheet": async () => {
      await phoneApex()
      await click("[data-apex-count]")
      await click(`[data-agents-sheet] [data-child-row="${fin}"]`)
    },
    "the list": async () => {
      await phoneList()
      await until("Boolean(document.querySelector('[data-fin-row]'))", "the Fin's row in the phone's list")
      // This row opens the Apex, where its card answers it; the Fin is a press away from there.
      await evaluate(`[...document.querySelectorAll('[data-fin-row]')].find((node) => node.innerText.includes(${JSON.stringify(FIN)})).click(); true`)
      await seen("[data-crew]")
      await click(crew)
    },
  }
  for (const [entry, open] of Object.entries(phoneEntries)) {
    await open()
    await phoneFin()
    await phoneBack()
    await phoneRoster(`after going back, from ${entry}`)
    // Another Thread with the Fin open: the list, then another row, no Fin and no count.
    await click(crew)
    await phoneFin()
    await phoneList()
    await until("Boolean(document.querySelector('[data-thread]'))", "the list after a reload")
    await evaluate("[...document.querySelectorAll('[data-thread]')].find((node) => !node.querySelector('[data-fin-pips]')).click(); true")
    await until("Boolean(document.querySelector('[data-thread-screen]')) && !document.querySelector('[data-child-of]') && !document.querySelector('[data-apex-count]')", "another Thread on the phone")
    console.log(`Phone: the Fin from ${entry}`)
  }

  guard.done()
  console.log("Fin transitions UI: each way in, closing, another Thread, a reload and the rail, on the desk, the browser and the phone, passed")
  app.exit(0)
}
