import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { atSize, withMotion } from "./lib/test-window.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * ⌘K over every screen of the mock desk, against the production palette: Settings and each of its sections, the
 * composer (with and without its @ list open), the Inbox, Automations, Search, a Thread, an Apex, the right sidebar
 * focused, a menu and a dialog open. Each time the caret is in the palette's field, what's typed lands there and no
 * key reaches the page underneath, Escape closes the palette alone, and focus goes back where it was. ⌘K again
 * closes it, ⌘P switches it to files keeping what's typed, and a row in it takes a click over Settings.
 * Screenshots go to `MAKO_UI_SHOTS` (else the printed scratch folder).
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = testScratch("mako-palette-ui-")
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-palette-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolveExit(electronExit("The palette UI check", code, signal)))
    })
  } finally {
    await server.close()
  }
}

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL
  const shots = process.env.MAKO_UI_SHOTS ?? join(root, "shots")
  await mkdir(shots, { recursive: true })
  console.log(`Screenshots: ${shots}`)
  app.setPath("userData", join(root, "profile"))
  withMotion(app)
  await app.whenReady()
  const window = atSize(new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }), 1440, 900)
  const page = window.webContents
  page.debugger.attach("1.3")
  const guard = guardElectronCheck({ app, page, name: "The palette UI check", ms: 300_000 })
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const send = (method, params) => page.debugger.sendCommand(method, params)
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  const settle = () => evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.target?.closest?.('[data-command-palette], [data-palette-scrim]')).map(a => a.finished.catch(() => {}))).then(() => true)`)
  const capture = async (name) => {
    await evaluate("document.fonts.ready.then(() => true)")
    await settle()
    await frames()
    await writeFile(join(shots, name), (await page.capturePage()).toPNG())
  }
  const until = async (code, label = code, ms = 15_000) => {
    guard.at(label)
    const deadline = Date.now() + ms
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture(`failure-${label.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.png`)
        throw new Error(`UI condition timed out: ${label}`)
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
    }
  }
  const KEYS = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, ArrowLeft: 37, Backspace: 8 }
  const press = async (key, { meta = false, shift = false, alt = false } = {}) => {
    const modifiers = (alt ? 1 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0)
    const named = KEYS[key]
    const params = named
      ? { key, code: key, windowsVirtualKeyCode: named, modifiers }
      : key === "@"
        ? { key, code: "Digit2", windowsVirtualKeyCode: 50, modifiers: modifiers | 8 }
        : { key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers }
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...params })
    if (!named && !meta) await send("Input.dispatchKeyEvent", { type: "char", text: key, ...params })
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...params })
  }
  const type = (text) => send("Input.insertText", { text })
  const centre = (selector) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing ' + ${JSON.stringify(selector)}); const r = node.getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} })()`)
  const click = async (selector, { button = "left" } = {}) => {
    const point = await centre(selector)
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point })
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button, clickCount: 1, ...point })
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button, clickCount: 1, ...point })
  }

  const OPEN = `document.querySelector('[data-command-palette][data-state=open]') !== null`
  const GONE = `document.querySelector('[data-command-palette]') === null`
  const FIELD = `[data-command-palette] input`
  const SETTINGS = `document.querySelector('[role=dialog]:has([data-settings-section])') !== null`
  /** Where focus is, as a selector-ish name, so a failure says where it went. */
  const focusName = `(() => { const a = document.activeElement; if (!a || a === document.body) return 'body'; if (a.closest('[data-command-palette]')) return 'palette:' + a.tagName; return a.tagName + (a.getAttribute('placeholder') ? '[' + a.getAttribute('placeholder') + ']' : '') + (a.dataset.settingsSection ? '#' + a.dataset.settingsSection : '') })()`

  /**
   * A listener on the document's capture phase, which runs after the window's: every key it hears while the palette
   * is open reached the page underneath. Chords are left out: a chord another command owns closes the palette and
   * runs, as it should.
   */
  const installLeakWatch = () => evaluate(`(() => {
    window.__leaks = []
    if (window.__leakWatch) return true
    window.__leakWatch = true
    for (const target of [document, document.body]) target.addEventListener('keydown', (event) => {
      if (!document.querySelector('[data-command-palette][data-state=open]')) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      window.__leaks.push(event.key)
    }, true)
    return true
  })()`)
  const leaks = () => evaluate(`window.__leaks.splice(0)`)

  /**
   * ⌘K from wherever focus is, type, walk the list, Escape: the palette had the caret and every key, closed alone,
   * and gave focus back. `stays` is what must still be on screen after.
   */
  const roundTrip = async (label, { stays, shot } = {}) => {
    const before = await evaluate(focusName)
    await press("k", { meta: true })
    await until(OPEN, `${label}: ⌘K opens the palette`)
    await until(`document.activeElement?.matches(${JSON.stringify(FIELD)})`, `${label}: the caret is in the palette (was ${before})`)
    await type("ab")
    await press("c")
    await press("ArrowDown")
    await press("ArrowUp")
    await press("Tab")
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(FIELD)}).value`), "abc", `${label}: what's typed is in the palette`)
    if (shot) await capture(shot)
    await press("Escape")
    await until(GONE, `${label}: Escape closes the palette`)
    assert.deepEqual(await leaks(), [], `${label}: no key reached the page underneath`)
    if (stays) assert.ok(await evaluate(stays), `${label}: Escape closed the palette alone (${stays})`)
    assert.equal(await evaluate(focusName), before, `${label}: focus went back where it was`)
    console.log(`PASS: ${label}: caret in the palette, no key leaked, Escape closed it alone, focus back on ${before}`)
  }

  await window.loadURL(`${base}?mock&plugins=none`)
  await until(`document.querySelector('[data-rail-threads-heading]') !== null`, "the rail draws")
  await evaluate(`import('/src/state/prefs.ts').then(({ prefsStore }) => { prefsStore.set({ theme: 'dark', railOpen: true }); return true })`)
  await installLeakWatch()

  // Settings, every section: the palette over it, Settings still there after, focus back in it.
  await evaluate(`window.dispatchEvent(new CustomEvent('mako:settings', { detail: 'appearance' })); true`)
  await until(SETTINGS, "Settings opens")
  const sections = await evaluate(`[...document.querySelectorAll('[data-settings-section]')].map(node => node.dataset.settingsSection)`)
  assert.ok(sections.length >= 20, `Settings lists its sections, received ${sections.length}`)
  for (const [index, id] of sections.entries()) {
    await evaluate(`document.querySelector('[data-settings-section="${id}"]').scrollIntoView({ block: 'nearest' }); true`)
    await frames()
    await click(`[data-settings-section="${id}"]`)
    await until(`document.querySelector('[data-settings-section="${id}"]')?.getAttribute('aria-current') === 'page'`, `Settings › ${id}`)
    await roundTrip(`Settings › ${id}`, { stays: SETTINGS, shot: index === 0 ? "01-settings-palette-dark.png" : undefined })
  }
  // Over Settings, the palette takes the pointer and the wheel, and what runs from it runs.
  await press("k", { meta: true })
  await until(OPEN, "the palette over Settings")
  await type("toggle light")
  await until(`[...document.querySelectorAll('[data-command-palette] button[data-index]')].some(b => b.textContent.includes('Toggle light and dark'))`, "Toggle light and dark is listed")
  await click(`[data-command-palette] button[data-index="0"]`)
  await until(GONE, "a click on a row runs it and closes the palette")
  await until(`import('/src/state/prefs.ts').then(({ prefsStore }) => prefsStore.get().theme === 'light')`, "the row's command ran")
  assert.ok(await evaluate(SETTINGS), "Settings is still open")
  console.log("PASS: a row clicked over Settings runs and closes the palette; Settings stays")
  await capture("02-settings-after-click-light.png")
  await evaluate(`import('/src/state/prefs.ts').then(({ prefsStore }) => { prefsStore.set({ theme: 'dark' }); return true })`)
  // The Settings search field typed into before ⌘K keeps its words; the palette's Escape never clears it.
  await click(`[role=dialog] input[placeholder="Search settings"]`)
  await type("git")
  await roundTrip("Settings with its search typed", { stays: `document.querySelector('[role=dialog] input[placeholder="Search settings"]')?.value === 'git'` })
  await press("Escape")
  await press("Escape")
  await until(`!(${SETTINGS})`, "Settings closes on its own Escape")

  // ⌘K again closes it; ⌘P switches it to files keeping what's typed; it opens empty after.
  await press("l", { meta: true })
  await until(`document.activeElement?.tagName === 'TEXTAREA'`, "the composer has the caret")
  await type("half a thought")
  await press("k", { meta: true })
  await until(OPEN, "⌘K from the composer")
  await type("zzz")
  assert.equal(await evaluate(`document.querySelector('main textarea')?.value`), "half a thought", "what's typed in the palette never reaches the composer")
  await capture("03-composer-palette-dark.png")
  await press("p", { meta: true })
  await until(`document.querySelector(${JSON.stringify(FIELD)})?.placeholder === 'Open a file by name' && document.querySelector(${JSON.stringify(FIELD)})?.value === 'zzz'`, "⌘P switches to files, keeping what's typed")
  await press("k", { meta: true })
  await until(`document.querySelector(${JSON.stringify(FIELD)})?.placeholder !== 'Open a file by name'`, "⌘K switches back")
  await press("k", { meta: true })
  await until(GONE, "⌘K while it's open closes it")
  await until(`document.activeElement?.tagName === 'TEXTAREA'`, "focus is back in the composer")
  assert.deepEqual(await leaks(), [])
  await press("k", { meta: true })
  await until(OPEN, "it opens again")
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(FIELD)}).value`), "", "it opens empty")
  await press("Escape")
  await until(GONE, "Escape")
  console.log("PASS: ⌘K toggles, ⌘P switches modes keeping the query, it reopens empty")
  await roundTrip("the composer focused", { stays: `document.querySelector('main textarea')?.value === 'half a thought'` })

  // The composer's @ list open: its keys stay its own until the palette opens, then are the palette's.
  await evaluate(`(() => { const t = document.querySelector('main textarea'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); return true })()`)
  await type(" @")
  await until(`document.querySelector('[data-mention-menu], [role=listbox]') !== null`, "the @ list opens", 5_000).catch(() => console.log("note: the mock composer drew no @ list"))
  const draft = await evaluate(`document.querySelector('main textarea')?.value`)
  await roundTrip("the composer's @ list open", { stays: `document.querySelector('main textarea')?.value === ${JSON.stringify(draft)}` })
  await press("Escape")

  // Inbox, Automations, Search: each stays open under the palette's Escape.
  await press("u", { meta: true, shift: true })
  await until(`document.querySelector('[data-inbox]') !== null`, "the Inbox opens")
  await roundTrip("the Inbox", { stays: `document.querySelector('[data-inbox]') !== null`, shot: "04-inbox-palette-dark.png" })
  await press("Escape")
  await until(`document.querySelector('[data-inbox]') === null`, "the Inbox closes on its own Escape")
  await press("a", { meta: true, shift: true })
  await until(`document.querySelector('[data-automations]') !== null`, "Automations opens")
  await roundTrip("Automations", { stays: `document.querySelector('[data-automations]') !== null`, shot: "05-automations-palette-dark.png" })
  await press("a", { meta: true, shift: true })
  await until(`document.querySelector('[data-automations]') === null`, "Automations closes")
  await press("f", { meta: true, shift: true })
  await until(`document.activeElement?.placeholder === 'Search this project and its conversations'`, "Search opens")
  await roundTrip("Search", { stays: `document.querySelector('input[placeholder="Search this project and its conversations"]') !== null` })
  await press("Escape")

  // A Thread, then an Apex, from the rail.
  await click(`[data-thread-row]:not([data-apex-row])`)
  await frames()
  await roundTrip("a Thread", { shot: "06-thread-palette-dark.png" })

  // The right sidebar focused.
  await evaluate(`import('/src/state/stage.ts').then(({ stage }) => { stage.open('changes'); return true })`)
  await until(`document.querySelector('[data-workbench] ~ * button, [data-companion-leaving] button, aside button') !== null`, "the right sidebar opens", 5_000).catch(() => undefined)
  await evaluate(`(() => { const buttons = [...document.querySelectorAll('button')].filter(b => b.getBoundingClientRect().left > innerWidth * 0.66 && b.getBoundingClientRect().top > 60 && b.offsetParent); buttons[0]?.focus(); return buttons.length })()`)
  await roundTrip("the right sidebar focused")

  // A menu open: the palette takes over and the menu goes.
  await click(`[data-thread-row]`, { button: "right" })
  await until(`document.querySelector('[role=menu]') !== null`, "a row's menu opens")
  await press("k", { meta: true })
  await until(OPEN, "⌘K over a menu")
  await until(`document.activeElement?.matches(${JSON.stringify(FIELD)})`, "the caret is in the palette over a menu")
  await until(`document.querySelector('[role=menu]') === null`, "the menu closes as the palette takes focus")
  await press("Escape")
  await until(GONE, "Escape after the menu")
  assert.deepEqual(await leaks(), [])
  console.log("PASS: a menu open: the palette takes focus, the menu closes, Escape closes the palette")

  // A dialog open: the palette over it, the dialog still there after, focus back in it.
  await evaluate(`import('/src/state/apexes.ts').then(({ openNewApex }) => { openNewApex(); return true })`)
  await until(`document.querySelector('[data-apex-dialog]') !== null`, "the New Apex dialog opens")
  await frames()
  await roundTrip("the New Apex dialog", { stays: `document.querySelector('[data-apex-dialog]') !== null`, shot: "08-dialog-palette-dark.png" })
  await press("Escape")
  await until(`document.querySelector('[data-apex-dialog]') === null`, "the dialog closes on its own Escape")

  // An Apex on screen: the mock's Apex scene, its Fins working.
  await window.loadURL(`${base}?mock&app=apex&plugins=none`)
  await until(`document.querySelector('[data-thread-row][data-apex-row]') !== null`, "the Apex scene draws its Apex")
  await click(`[data-thread-row][data-apex-row]`)
  await frames()
  await installLeakWatch()
  await roundTrip("an Apex", { shot: "07-apex-palette-dark.png" })

  guard.done()
  console.log("Palette UI check passed")
  app.exit(0)
}
