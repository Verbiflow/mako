import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * Open project against the production components and the mock desk's home folder (`src/dev/mock-projects.ts`):
 * ⌘O and Enter on a recent project, a path typed and completed with Tab, a GitHub address cloned with its progress
 * (cancelled with Esc, moved to a toast, refused for sign-in, already cloned), a new empty project, the new Thread's
 * project chip moving the draft, a folder dropped on the rail, and the empty rail's first run.
 * Screenshots of every state, dark and light, go to `MAKO_UI_SHOTS` (else the printed scratch folder).
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = testScratch("mako-open-project-ui-")
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-open-project-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolveExit(electronExit("The open project UI check", code, signal)))
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
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const guard = guardElectronCheck({ app, page, name: "The open project UI check", ms: 150_000 })
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const send = (method, params) => page.debugger.sendCommand(method, params)
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  const capture = async (name) => {
    await evaluate("document.fonts.ready.then(() => true)")
    // Evidence shows rows where they land, not mid-glide.
    await evaluate(`Promise.all([...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].flatMap(node => node.getAnimations()).map(animation => animation.finished.catch(() => {}))).then(() => true)`)
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
  const KEYS = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38 }
  const press = async (key, { meta = false, shift = false, alt = false } = {}) => {
    const modifiers = (alt ? 1 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0)
    const named = KEYS[key]
    const params = named ? { key, code: key, windowsVirtualKeyCode: named, modifiers } : { key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers }
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...params })
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...params })
  }
  const type = (text) => send("Input.insertText", { text })
  const clearField = async () => {
    await evaluate(`(() => { const field = document.querySelector('[data-open-project-field]'); field.select(); return true })()`)
    await press("Backspace")
  }
  const centre = (selector) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing ' + ${JSON.stringify(selector)}); const r = node.getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} })()`)
  const click = async (selector) => {
    const point = await centre(selector)
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point })
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point })
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point })
  }
  const rows = () => evaluate(`[...document.querySelectorAll('[data-open-project-rows] [data-row-id]')].map(row => ({ id: row.dataset.rowId, text: row.innerText.replace(/\\s+/g, ' ').trim(), selected: row.hasAttribute('data-selected') }))`)
  const theme = (next) => evaluate(`import('/src/state/prefs.ts').then(({ prefsStore }) => { prefsStore.set({ theme: ${JSON.stringify(next)} }); return true })`)
  const openPalette = async () => {
    await press("o", { meta: true })
    await until(`document.querySelector('[data-open-project]') !== null`, "the palette opens on ⌘O")
  }
  const closed = `document.querySelector('[data-open-project]') === null`
  const composerFocused = `document.activeElement?.tagName === 'TEXTAREA'`

  await window.loadURL(`${base}?mock&plugins=none`)
  await until(`document.querySelector('[data-rail-threads-heading]') !== null`, "the rail draws")
  await evaluate(`import('/src/state/prefs.ts').then(({ prefsStore }) => prefsStore.set({ railGrouping: 'project', railWidth: 264, theme: 'dark' }))`)
  await until(`document.querySelectorAll('.thread-jump-scope [data-flip-key^="folder:"]').length >= 2`, "folders rendered")
  assert.equal(await evaluate(`document.querySelector('[data-rail-threads-heading]').textContent`), "Projects", "the rail's section is Projects")
  assert.equal(await evaluate(`document.querySelector('[data-rail-open-project]').getAttribute('title')`), "Open project… ⌘O")
  await capture("01-rail-projects-dark.png")
  console.log("PASS: the rail's section is Projects and its glyph says Open project… ⌘O")

  // 1. ⌘O with nothing typed: Recent, On this Mac, Start something new; Enter opens the first recent project.
  await openPalette()
  await until(`[...document.querySelectorAll('[data-open-project-rows] [data-row-id^="found:/"]')].length > 0`, "found checkouts arrive")
  const empty = await rows()
  assert.ok(empty[0].id.startsWith("recent:"), `the first row is a recent project, received ${JSON.stringify(empty[0])}`)
  assert.ok(empty[0].selected, "and it's selected")
  assert.ok(empty.some((row) => row.id === "found:/Users/you/code/harbor"), `a checkout Mako hasn't seen is offered, received ${JSON.stringify(empty)}`)
  assert.ok(!empty.some((row) => row.id === "found:/Users/you/api"), "a project already in Mako isn't offered twice")
  assert.ok(empty.filter((row) => row.id.startsWith("found:/")).length <= 5, "at most five found")
  assert.deepEqual(empty.filter((row) => row.id.startsWith("start:")).map((row) => row.text.replace(/\s*⌘.*$/, "")), ["Clone from GitHub…", "New empty project…", "Choose in Finder…"])
  assert.ok(empty.some((row) => row.id === "found:skipped"), "the guarded folders are one line with the action that adds them")
  assert.equal(await evaluate(`document.querySelector('[data-open-project-field]').placeholder`), "Open a project: type a path, paste a GitHub URL, or search")
  await capture("02-palette-empty-dark.png")
  const first = empty[0].id.slice("recent:".length)
  await press("Enter")
  await until(closed, "Enter closes the palette")
  await until(`import('/src/state/session.ts').then(({ store }) => store.get().meta?.cwd === ${JSON.stringify(first)})`, "a new Thread in the recent project")
  await until(composerFocused, "the composer has the caret")
  await capture("03-recent-opened-dark.png")
  console.log(`PASS: ⌘O, Enter opens a new Thread in ${first} with the composer focused`)

  // 2. A path: folders under it, Tab goes in, Enter opens; a missing path offers to be made.
  await openPalette()
  await type("~/co")
  await until(`document.querySelector('[data-row-id="dir:/Users/you/code"]') !== null`, "~/co lists ~/code")
  await capture("04-path-typed-dark.png")
  await press("Tab")
  await until(`document.querySelector('[data-open-project-field]').value === '~/code/'`, "Tab completes to ~/code/")
  await until(`document.querySelector('[data-row-id="open:/Users/you/code"]') !== null && document.querySelector('[data-row-id="dir:/Users/you/code/lantern"]') !== null`, "~/code/ lists its folders")
  const listed = await rows()
  assert.equal(listed[0].id, "open:/Users/you/code", "the folder itself comes first")
  assert.ok(listed.find((row) => row.id === "dir:/Users/you/code/harbor"), "its checkouts are listed")
  assert.ok(!listed.find((row) => row.id.includes("/.")), "dotfolders stay hidden")
  await capture("05-path-completed-dark.png")
  await press("Enter")
  await until(closed, "Enter on the path closes the palette")
  await until(`import('/src/state/session.ts').then(({ store }) => store.get().meta?.cwd === '/Users/you/code')`, "a non-Git folder opens as a project")
  console.log("PASS: ~/co, Tab to ~/code/, Enter opens it")
  await openPalette()
  await type("~/code/kelp")
  await until(`document.querySelector('[data-row-id="create:/Users/you/code/kelp"]') !== null`, "a missing path offers Create")
  assert.match((await rows()).at(-1).text, /^Create ~\/code\/kelp and open it/)
  await capture("06-path-create-dark.png")
  await press("Enter")
  await until(`import('/src/state/session.ts').then(({ store }) => store.get().meta?.cwd === '/Users/you/code/kelp')`, "the made folder opens")
  console.log("PASS: a missing path is made and opened")

  // 3. Words find a project by name.
  await openPalette()
  await type("lant")
  await until(`document.querySelector('[data-row-id="found:/Users/you/code/lantern"]') !== null`, "lant finds lantern")
  await capture("07-search-dark.png")
  await press("Escape")
  await until(closed, "Esc closes")

  // 4. A GitHub address: clone with progress into the folder recent projects share, then it opens.
  await openPalette()
  await type("https://github.com/acme/tidepool")
  await until(`document.querySelector('[data-row-id="repo:clone"]') !== null`, "the clone row")
  assert.match((await rows())[0].text, /^Clone acme\/tidepool into ~\/tidepool/)
  await capture("08-clone-row-dark.png")
  await press("Enter")
  await until(`document.querySelector('[data-open-project-rows] [data-row-id^="clone:"]')?.innerText.includes('Receiving objects')`, "the row shows Git's progress")
  await capture("09-clone-progress-dark.png")
  await until(closed, "the clone finishes and the palette closes", 20_000)
  await until(`import('/src/state/session.ts').then(({ store }) => store.get().meta?.cwd === '/Users/you/tidepool')`, "the clone opens")
  console.log("PASS: a pasted address clones with progress and opens")

  // Esc cancels a clone in the palette.
  await openPalette()
  await type("acme/reef")
  await until(`document.querySelector('[data-row-id="repo:clone"]') !== null`, "the reef clone row")
  await press("Enter")
  await until(`document.querySelector('[data-open-project-rows] [data-row-id^="clone:"]') !== null`, "cloning")
  await press("Escape")
  await until(`document.querySelector('[data-open-project-rows] [data-row-id^="clone:"]') === null && document.querySelector('[data-row-id="repo:clone"]') !== null`, "Esc cancels, the clone row is back")
  await until(`import('/src/state/open-project.ts').then(({ openProjectStore }) => Object.keys(openProjectStore.get().clones).length === 0)`, "nothing left running")
  console.log("PASS: Esc cancels a clone")

  // Closing the palette moves a clone to a toast; Open when ready opens it.
  await press("Enter")
  await until(`document.querySelector('[data-open-project-rows] [data-row-id^="clone:"]') !== null`, "cloning again")
  await evaluate(`import('/src/state/open-project.ts').then(({ closeProjectPalette }) => { closeProjectPalette(); return true })`)
  await until(`[...document.querySelectorAll('[data-sonner-toast]')].some(toast => toast.innerText.includes('Cloning acme/reef'))`, "the toast carries the clone")
  await capture("10-clone-toast-dark.png")
  await click("[data-sonner-toast] [data-button]")
  await until(`import('/src/state/session.ts').then(({ store }) => store.get().meta?.cwd === '/Users/you/reef')`, "Open when ready opens it", 20_000)
  console.log("PASS: a closed palette's clone moves to a toast and opens when ready")

  // A refused sign-in names the fix; an address already cloned opens.
  await openPalette()
  await type("acme/private-notes")
  await until(`document.querySelector('[data-row-id="repo:clone"]') !== null`, "the private clone row")
  await press("Enter")
  await until(`document.querySelector('[data-open-project-rows] [data-row-id^="clone:"]')?.innerText.includes('gh auth login')`, "the failure names gh auth login")
  assert.match((await rows())[0].text, /Try again/)
  await capture("11-clone-signin-dark.png")
  await press("Escape")
  await clearField()
  await type("github.com/acme/lantern")
  await until(`document.querySelector('[data-row-id="repo:open"]') !== null`, "already cloned")
  assert.match((await rows())[0].text, /^Open ~\/code\/lantern already cloned/)
  await capture("12-clone-already-dark.png")
  await press("Escape")
  console.log("PASS: sign-in failures name gh auth login; a repository already here opens")

  // 5. New empty project.
  await openPalette()
  await until(`[...document.querySelectorAll('[data-open-project-rows] [data-row-id^="found:/"]')].length > 0`, "the list settles")
  await click('[data-row-id="start:new"]')
  await until(`document.querySelector('[data-open-project-field]').placeholder === 'Name the new project'`, "the name field")
  await type("driftwood")
  await until(`document.querySelector('[data-row-id="create:make"]') !== null`, "the create row")
  await capture("13-new-project-dark.png")
  await press("Enter")
  await until(`import('/src/state/session.ts').then(({ store }) => store.get().meta?.cwd === '/Users/you/driftwood')`, "the new project opens")
  console.log("PASS: New empty project makes and opens the folder")

  // 6. The chip: the new Thread's project is a control; switching moves the draft.
  await evaluate(`import('/src/state/session.ts').then(({ actions }) => actions.newConversationIn('/Users/you/mako'))`)
  await until(`document.querySelector('[data-project-chip]')?.innerText.includes('mako')`, "the chip names mako")
  await until(composerFocused, "the composer is focused")
  await type("Draft that moves with the project")
  await capture("14-chip-dark.png")
  await press("o", { meta: true, shift: true })
  await until(`document.querySelector('[data-project-menu]') !== null`, "⌘⇧O opens the project menu")
  await evaluate(`Promise.all(document.querySelector('[data-project-menu]').getAnimations().map(animation => animation.finished.catch(() => {}))).then(() => true)`)
  await capture("15-chip-menu-dark.png")
  await type("site")
  await until(`document.querySelector('[data-project-menu] [data-project-menu-item]')?.dataset.projectMenuItem === '/Users/you/site'`, "site first")
  await press("Enter")
  await until(`import('/src/state/session.ts').then(({ store }) => store.get().meta?.cwd === '/Users/you/site')`, "the draft's Thread moves to site")
  await until(`document.querySelector('main textarea')?.value === 'Draft that moves with the project'`, "the words came along")
  assert.equal(await evaluate(`import('/src/state/drafts.ts').then(({ draftText, projectDraftKey }) => draftText(projectDraftKey('/Users/you/mako')))`), "", "mako keeps none of it")
  await capture("16-chip-moved-dark.png")
  console.log("PASS: ⌘⇧O switches project and the unsent draft moves with it")

  // 7. A folder dropped on the rail opens as a project.
  const dropped = join(root, "dropped-project")
  await mkdir(dropped, { recursive: true })
  await evaluate(`window.mako.pathForFile = () => ${JSON.stringify(dropped)}; true`)
  const railPoint = await centre("[data-rail-drop] .scroll-fade-scroller")
  const drag = { items: [], files: [dropped], dragOperationsMask: 1 }
  await send("Input.dispatchDragEvent", { type: "dragEnter", ...railPoint, data: drag })
  await send("Input.dispatchDragEvent", { type: "dragOver", ...railPoint, data: drag })
  await until(`document.querySelector('[data-folder-drop]') !== null`, "the drop overlay")
  assert.equal(await evaluate(`document.querySelector('[data-folder-drop]').innerText.trim()`), "Drop to open as a project")
  await capture("17-drop-overlay-dark.png")
  await send("Input.dispatchDragEvent", { type: "drop", ...railPoint, data: drag })
  await until(`import('/src/state/session.ts').then(({ store }) => store.get().meta?.cwd === ${JSON.stringify(dropped)})`, "the dropped folder opens")
  assert.equal(await evaluate(`document.querySelector('[data-folder-drop]')`), null, "the overlay leaves")
  console.log("PASS: a folder dropped on the rail opens as a project")

  // 8. Light theme.
  await theme("light")
  await openPalette()
  await until(`[...document.querySelectorAll('[data-open-project-rows] [data-row-id^="found:/"]')].length > 0`, "found rows in light")
  await capture("18-palette-empty-light.png")
  await clearField()
  await type("~/code/")
  await until(`document.querySelector('[data-row-id="dir:/Users/you/code/lantern"]') !== null`, "path rows in light")
  await capture("19-path-light.png")
  await press("Escape")
  await evaluate(`import('/src/state/session.ts').then(({ actions }) => actions.newConversationIn('/Users/you/api'))`)
  await until(`document.querySelector('[data-project-chip]')?.innerText.includes('api')`, "the chip in light")
  await capture("20-chip-light.png")
  await theme("dark")

  // 9. macOS keeping the scan out of Documents is one line with the action that fixes it.
  await window.loadURL(`${base}?mock&plugins=none&found=refused`)
  await until(`document.querySelector('[data-rail-threads-heading]') !== null`, "the rail draws again")
  await openPalette()
  await until(`document.querySelector('[data-row-id="found:refused"]') !== null`, "the refusal line")
  assert.match((await rows()).find((row) => row.id === "found:refused").text, /macOS keeps Mako out of Documents/)
  await capture("21-palette-refused-dark.png")
  console.log("PASS: macOS's refusal is one line with Open settings")

  // 10. The empty rail's first run, dark and light.
  await window.loadURL(`${base}?mock&plugins=none&app=first-run`)
  await until(`document.querySelector('[data-first-project]') !== null`, "the first-run state")
  await until(`document.querySelectorAll('[data-first-project-found]').length === 3`, "three found checkouts")
  const firstRun = await evaluate(`document.querySelector('[data-first-project]').innerText`)
  assert.match(firstRun, /Open a project to start/)
  assert.match(firstRun, /Pick a folder you already work in\. Mako finds the ones on this Mac\./)
  assert.match(firstRun, /Open project…/)
  assert.match(firstRun, /Clone from GitHub…/)
  await capture("22-first-run-dark.png")
  await theme("light")
  await frames()
  await capture("23-first-run-light.png")
  await click("[data-first-project-found]")
  await until(`import('/src/state/session.ts').then(({ store }) => store.get().meta?.cwd?.startsWith('/Users/you/'))`, "Open on a found checkout opens it")
  console.log("PASS: the empty rail offers found checkouts, Open project… and Clone from GitHub…")

  console.log(`Screenshots: ${shots}`)
  guard.done()
  app.exit(0)
}
