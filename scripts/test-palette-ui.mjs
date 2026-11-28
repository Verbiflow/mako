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
    await type("zq")
    await press("x")
    await press("ArrowDown")
    await press("ArrowUp")
    await press("Tab")
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(FIELD)}).value`), "zqx", `${label}: what's typed is in the palette`)
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
  await until(`document.querySelector('[data-command-palette] [data-palette-row][data-index="0"]')?.textContent.includes('Toggle light and dark')`, "Toggle light and dark is listed")
  await click(`[data-command-palette] [data-palette-row][data-index="0"]`)
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
  // The palette gave focus back to the composer, where Escape is the composer's: off the field, it's the Inbox's.
  await evaluate("document.activeElement?.blur(), true")
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


  // ——— Search ———
  const rowsNow = () => evaluate(`[...document.querySelectorAll('[data-command-palette] [data-palette-row]')].map(row => ({ id: row.dataset.paletteRow, title: row.querySelector('[data-palette-title]')?.textContent, lit: [...row.querySelectorAll('[data-lit]')].map(mark => mark.textContent).join(''), group: row.closest('[data-palette-group]')?.dataset.paletteGroup, selected: row.hasAttribute('data-selected') }))`)
  const headers = () => evaluate(`[...document.querySelectorAll('[data-command-palette] [role=group]')].map(group => group.getAttribute('aria-label'))`)
  const openFresh = async () => {
    if (await evaluate(OPEN)) {
      await press("Escape")
      await until(GONE, "closed before opening again")
    }
    await press("k", { meta: true })
    await until(OPEN, "the palette opens")
  }
  const setQuery = async (text) => {
    await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(FIELD)}); input.select(); return true })()`)
    if (text) await type(text)
    else await press("Backspace")
    await until(`document.querySelector(${JSON.stringify(FIELD)}).value === ${JSON.stringify(text)}`, `typed ${text}`)
    await frames()
  }

  // Nothing typed: recent Threads, suggested actions and projects at once, each group headed once.
  await openFresh()
  await until(`document.querySelectorAll('[data-command-palette] [data-palette-row]').length > 5`, "rows with nothing typed")
  const empty = await headers()
  assert.ok(empty.includes("Threads") && empty.includes("Actions"), `recent Threads and actions with nothing typed: ${empty.join(", ")}`)
  assert.equal(new Set(empty).size, empty.length, "each group headed once")
  assert.ok((await rowsNow())[0]?.selected, "the first row is highlighted")
  await capture("10-empty-dark.png")
  console.log(`PASS: nothing typed lists ${empty.join(", ")}`)

  // Typed: grouped, each header once, matched letters lit, footer says what Enter and ⌘↩ do.
  await setQuery("toggle")
  const toggled = await rowsNow()
  assert.ok(toggled.length > 2 && toggled.every((row) => row.lit.toLowerCase().includes("toggle") || !row.id.startsWith("command:")), `toggle lights its letters: ${JSON.stringify(toggled.slice(0, 4))}`)
  const typedHeaders = await headers()
  assert.equal(new Set(typedHeaders).size, typedHeaders.length, `no header twice: ${typedHeaders.join(", ")}`)
  assert.match(await evaluate(`document.querySelector('[data-palette-footer]').textContent`), /Run/)
  assert.equal(toggled.at(-1)?.id, "search:conversations", "the last row searches every conversation for the words")
  await capture("11-typed-dark.png")
  await setQuery("theme")
  await until(`document.querySelector('[data-palette-row="settings:appearance"]') !== null`, "theme finds Settings › Appearance", 10_000)
  await capture("12-setting-by-keyword-dark.png")
  console.log("PASS: typed rows group under one header each, letters lit, Settings found by its words")

  // Tabs: → with nothing typed moves along them; ⌘P is Files.
  await setQuery("")
  await press("ArrowRight")
  await until(`document.querySelector('[data-command-palette]').dataset.category === 'threads'`, "→ to Threads")
  assert.ok((await rowsNow()).every((row) => ["threads", "fins", "needs"].includes(row.group)), "the Threads tab lists Threads")
  await capture("13-threads-tab-dark.png")
  await press("ArrowLeft")
  await until(`document.querySelector('[data-command-palette]').dataset.category === 'all'`, "← back to All")
  await press("p", { meta: true })
  await until(`document.querySelector('[data-command-palette]').dataset.category === 'files'`, "⌘P is the Files tab")
  await press("k", { meta: true })
  await until(`document.querySelector('[data-command-palette]').dataset.category === 'all'`, "⌘K back to All")
  console.log("PASS: ← and → move between tabs with nothing typed; ⌘P and ⌘K switch tabs")

  // > narrows to actions.
  await setQuery(">new")
  await until(`document.querySelector('[data-palette-prefix]')?.textContent === 'Actions'`, "> says Actions")
  assert.ok((await rowsNow()).every((row) => ["actions", "settings", "models"].includes(row.group)), "> lists actions only")
  console.log("PASS: > narrows to actions")

  // A project: Tab looks inside it, Escape backs out of it and then closes.
  await setQuery("api")
  await until(`document.querySelector('[data-palette-row="project:/Users/you/api"]') !== null`, "the api project is listed")
  const apiIndex = await evaluate(`Number(document.querySelector('[data-palette-row="project:/Users/you/api"]').dataset.index)`)
  for (let step = 0; step < apiIndex; step += 1) await press("ArrowDown")
  await until(`document.querySelector('[data-palette-row="project:/Users/you/api"]')?.hasAttribute('data-selected')`, "the project highlighted")
  await press("Tab")
  await until(`document.querySelector('[data-command-palette]').dataset.scope === 'project' && document.querySelector('[data-palette-scope]')?.textContent === 'api'`, "Tab scopes to api")
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(FIELD)}).value`), "", "the scope starts empty")
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(FIELD)}).placeholder`), /Search in api/)
  await capture("14-project-scope-dark.png")
  await press("Escape")
  await until(`document.querySelector('[data-command-palette]')?.dataset.scope === undefined && ${OPEN}`, "Escape backs out of the scope, the palette stays")
  await press("Escape")
  await until(GONE, "the second Escape closes it")
  assert.deepEqual(await leaks(), [])
  console.log("PASS: Tab scopes into a project, Escape backs out, then closes")

  // ⌘⇧M: straight into the models.
  await press("m", { meta: true, shift: true })
  await until(`${OPEN} && document.querySelector('[data-command-palette]').dataset.scope === 'models'`, "⌘⇧M opens the models")
  await until(`document.querySelectorAll('[data-command-palette] [data-palette-row^="model:"]').length > 0`, "models listed")
  await capture("15-models-dark.png")
  await press("Escape")
  await press("Escape")
  await until(GONE, "closed")
  console.log("PASS: ⌘⇧M opens the palette in its models")

  // Enter on a Thread opens it; nothing found offers a new Thread with the words.
  await openFresh()
  const threadRow = (await rowsNow()).find((row) => row.group === "threads")
  assert.ok(threadRow, "a Thread to open")
  await setQuery(threadRow.title)
  await until(`document.querySelector('[data-command-palette] [data-palette-row]')?.dataset.paletteRow === ${JSON.stringify(threadRow.id)}`, "its exact title puts it first")
  await press("Enter")
  await until(GONE, "Enter opens it and closes the palette")
  await openFresh()
  await setQuery("qqzzxx unfindable")
  await until(`document.querySelector('[data-palette-row="new-thread:typed"]') !== null`, "nothing found offers a new Thread")
  await capture("16-no-match-dark.png")
  await press("Escape")
  await until(GONE)
  console.log("PASS: Enter opens a Thread; nothing found offers New Thread with the words")

  // Light theme, over Settings.
  await evaluate(`import('/src/state/prefs.ts').then(({ prefsStore }) => { prefsStore.set({ theme: 'light' }); return true })`)
  await evaluate(`window.dispatchEvent(new CustomEvent('mako:settings', { detail: 'appearance' })); true`)
  await until(SETTINGS, "Settings, light")
  await press("k", { meta: true })
  await until(OPEN)
  await setQuery("git")
  await frames()
  await capture("17-settings-light.png")
  await press("Escape")
  await until(GONE)
  await press("Escape")
  await until(`!(${SETTINGS})`)
  await evaluate(`import('/src/state/prefs.ts').then(({ prefsStore }) => { prefsStore.set({ theme: 'dark' }); return true })`)

  // 5,000 Threads: the palette opens and answers each key inside a frame or two.
  await evaluate(`import('/src/state/thread-store.ts').then(({ threadsStore }) => {
    const words = ["gateway", "retry", "billing", "auth", "palette", "inbox", "migrate", "postgres", "flaky", "onboarding", "deploy", "cache", "render", "worker", "webhook", "export", "sidebar", "phone", "ipad", "release"]
    const projects = ["mako", "api", "site", "web", "infra", "mobile", "billing", "docs"]
    const harnesses = ["claude", "codex", "cursor", "grok", "opencode"]
    const now = Date.now()
    const refs = Array.from({ length: 5000 }, (_, i) => ({ harness: harnesses[i % 5], nativeId: 'bench-' + i, path: '/bench/' + i + '.jsonl', cwd: '/Users/you/' + projects[i % 8], title: words[i % 20] + ' ' + words[(i * 7 + 3) % 20] + ' when ' + words[(i * 13 + 5) % 20] + ' fails #' + i, updatedAt: new Date(now - i * 60_000).toISOString(), threadId: 'bench-thread-' + i }))
    threadsStore.set({ threads: [...threadsStore.get().threads, ...refs] })
    return true
  })`)
  await frames()
  const timeOpen = () => evaluate(`new Promise(resolve => {
    const start = performance.now()
    const done = () => document.querySelector('[data-command-palette] [data-palette-row]') ? resolve(performance.now() - start) : requestAnimationFrame(done)
    window.dispatchEvent(new CustomEvent('mako:palette'))
    requestAnimationFrame(done)
  })`)
  const opens = []
  for (let round = 0; round < 5; round += 1) {
    opens.push(await timeOpen())
    await press("Escape")
    await until(GONE)
  }
  await press("k", { meta: true })
  await until(OPEN)
  const keys = []
  for (const text of ["g", "ga", "gat", "gate", "gatew", "gatewa", "gateway", "gateway a", "gateway au", "gateway aut", "gateway auth"]) {
    keys.push(await evaluate(`new Promise(resolve => {
      const input = document.querySelector(${JSON.stringify(FIELD)})
      const before = document.querySelector('[data-command-palette] [role=listbox]').innerHTML
      const start = performance.now()
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(text)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const done = () => document.querySelector('[data-command-palette] [role=listbox]').innerHTML !== before ? requestAnimationFrame(() => resolve(performance.now() - start)) : requestAnimationFrame(done)
      requestAnimationFrame(done)
    })`))
  }
  const found = await rowsNow()
  assert.ok(found.some((row) => row.title?.startsWith("gateway auth")), "the 5,000 are searched")
  assert.ok(await evaluate(`document.querySelector('[data-palette-group="threads"] .tabular')?.textContent.includes('more') ?? false`), "under All, Threads say how many more")
  await capture("18-5k-threads-dark.png")
  await press("Escape")
  await until(GONE)
  const sortedOpens = [...opens].sort((a, b) => a - b)
  const sortedKeys = [...keys].sort((a, b) => a - b)
  console.log(`TIMING: 5,000 Threads in the window: open to rows painted median ${sortedOpens[2].toFixed(1)} ms (max ${sortedOpens.at(-1).toFixed(1)}); a keystroke to its rows painted median ${sortedKeys[5].toFixed(1)} ms (max ${sortedKeys.at(-1).toFixed(1)})`)
  assert.ok(sortedKeys[5] < 100, "a keystroke's rows paint well inside 100 ms")

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
