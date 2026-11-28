import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * Settings › Projects against the production components and the fixture desk: the project's right-click in the
 * sidebar, its page (folder, the branch new Threads start from, setup and run scripts, environment, cloud repository),
 * a base branch chosen, a run script edited into a new Thread's request, hiding and showing it again from the Hidden
 * list, "Project settings: <name>" in the palette, and Open settings file from Settings' footer and the palette (the
 * opener mocked). Screenshots of each, dark and light, go to the printed directory, or `MAKO_SHOTS` when set.
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = testScratch("mako-project-settings-ui-")
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-project-settings-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolveExit(code ?? 1))
    })
  } finally {
    await server.close()
  }
}

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL
  const shots = process.env.MAKO_SHOTS || join(root, "shots")
  await mkdir(shots, { recursive: true })
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 1000, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const watchdog = setTimeout(() => {
    console.error("Project settings UI verification exceeded its 300-second limit")
    app.exit(1)
  }, 300_000)
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  const settle = async () => {
    await evaluate(`(() => { if (!document.getElementById('hide-toasts')) document.head.insertAdjacentHTML('beforeend', '<style id="hide-toasts">[data-sonner-toaster]{display:none!important}</style>'); return true })()`)
    await evaluate("document.fonts.ready.then(() => true)")
    await evaluate(`Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))).then(() => true)`)
    await frames()
  }
  const capture = async (name, around) => {
    await settle()
    await writeFile(join(shots, `${name}.png`), (await page.capturePage()).toPNG())
    if (!around) return
    const rect = await evaluate(`(() => {
      const nodes = ${JSON.stringify(around)}.flatMap(selector => [...document.querySelectorAll(selector)])
      if (!nodes.length) return null
      const rects = nodes.map(node => node.getBoundingClientRect())
      const pad = 24
      const x = Math.max(0, Math.floor(Math.min(...rects.map(r => r.left)) - pad))
      const y = Math.max(0, Math.floor(Math.min(...rects.map(r => r.top)) - pad))
      return { x, y, width: Math.min(innerWidth - x, Math.ceil(Math.max(...rects.map(r => r.right)) + pad - x)), height: Math.min(innerHeight - y, Math.ceil(Math.max(...rects.map(r => r.bottom)) + pad - y)) }
    })()`)
    if (rect) await writeFile(join(shots, `${name}-crop.png`), (await page.capturePage(rect)).toPNG())
  }
  const theme = async (next) => {
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({theme: ${JSON.stringify(next)}}))`)
    await evaluate(`new Promise(resolve => { const check = () => document.documentElement.classList.contains('light') === ${next === "light"} ? resolve(true) : requestAnimationFrame(check); check() })`)
  }
  const both = async (name, around) => {
    await capture(name, around)
    await theme("light")
    await capture(`${name}-light`, around)
    await theme("dark")
  }
  const settingsPage = async (name) => {
    const scroll = (to) => evaluate(`(() => { const main = document.querySelector('[role="dialog"] main'); main.scrollTop = ${to === "end" ? "main.scrollHeight" : 0}; return true })()`)
    await both(name)
    if (await evaluate(`(() => { const main = document.querySelector('[role="dialog"] main'); return main.scrollHeight > main.clientHeight + 4 })()`)) {
      await scroll("end")
      await both(`${name}-end`)
      await scroll("top")
    }
  }
  const until = async (code, label = code) => {
    if (process.env.MAKO_UI_TRACE) console.log(`until ${label.slice(0, 80)}`)
    const deadline = Date.now() + 15_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure")
        console.error(await evaluate(`JSON.stringify({ main: document.querySelector('[role="dialog"] main')?.innerText.slice(-600) ?? '', attached: window.__attached, dialogs: window.__dialogs })`))
        throw new Error(`UI condition timed out: ${label}`)
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
    }
  }
  const point = (selector) =>
    evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing target ' + ${JSON.stringify(selector)}); node.scrollIntoView({ block: 'nearest' }); const r = node.getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} })()`)
  const press = async (selector, button) => {
    const at = await point(selector)
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...at })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button, clickCount: 1, ...at })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button, clickCount: 1, ...at })
  }
  const click = (selector) => press(selector, "left")
  const rightClick = (selector) => press(selector, "right")
  const key = async (name, code = name, keyCode = 0, modifiers = 0) => {
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: name, code, windowsVirtualKeyCode: keyCode, modifiers })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode: keyCode, modifiers })
  }
  const escape = () => key("Escape", "Escape", 27)
  const type = (text) => page.debugger.sendCommand("Input.insertText", { text })
  const menuItems = () => evaluate(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(item => item.textContent.trim())`)
  // The page's words, and each script field's command, which innerText leaves out.
  const mainText = () => evaluate(`document.querySelector('[role="dialog"] main').innerText + '\\n' + [...document.querySelectorAll('[data-project-script]')].map(field => field.value).join('\\n')`)
  const scripts = `[...document.querySelectorAll('[data-project-script]')].map(field => field.value).join(' ')`
  const onProjects = `document.querySelector('[role="dialog"] main h2')?.textContent === 'Projects'`
  const settingsClosed = `!document.querySelector('[role="dialog"] main h2')`

  await window.loadURL(`${base}?mock&app=stopped`)
  await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({railGrouping: 'project', railWidth: 264, theme: 'dark', hiddenProjects: []}))`)
  await until(`document.querySelector('[data-app-control="stopped"]') !== null`, "the desk rendered")
  // The opener and what it opens, recorded instead of reaching an editor.
  await evaluate(`(() => {
    window.__opened = []
    window.__attached = []
    window.__dialogs = []
    window.confirm = (message) => { window.__dialogs.push(String(message)); return true }
    window.alert = (message) => { window.__dialogs.push(String(message)) }
    window.mako.openInEditor = async (path, editor) => { window.__opened.push({ path, editor: editor ?? null }) }
    window.addEventListener('mako:attach', (event) => window.__attached.push({ text: event.detail.text?.() ?? '', files: event.detail.files.map(entry => entry.file.name) }))
    return true
  })()`)

  // 1. The project's right-click in the sidebar leads its own group with Project settings.
  const header = `.thread-jump-scope [data-flip-key="folder:/Users/you/api"]`
  await until(`document.querySelector(${JSON.stringify(header)}) !== null`, "api's folder in the sidebar")
  await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 500 })
  await rightClick(header)
  await until(`document.querySelector('[role="menu"] [data-folder-action="project-settings"]') !== null`, "the project's right-click menu")
  const folderMenu = await menuItems()
  assert.equal(folderMenu.indexOf("Project settings") + 1, folderMenu.indexOf("App setup"), `Project settings leads the folder's group: ${folderMenu}`)
  await both("01-rail-project-menu", ['[role="menu"]', header])
  await click('[role="menu"] [data-folder-action="project-settings"]')
  await until(`${onProjects} && document.querySelector('[data-project-page="api"] [data-project-cloud]') !== null && ${scripts}.includes('uv run uvicorn')`, "api's project page")

  // 2. Its page: the folder, where new Threads start, the scripts, the environment and the cloud repository.
  const apiPage = await mainText()
  for (const text of ["All projects", "api", "~/api", "Copy path", "Show in the sidebar", "Start from", "Automatic", "Scripts", "Setup", "Run · api", "uv run uvicorn app.main:app --port $PORT", "Environment", "DATABASE_URL", "Files new worktrees get", "Cloud", "acme/api"])
    assert.ok(apiPage.includes(text), `api's page shows ${text}:\n${apiPage}`)
  await settingsPage("02-project-api")

  // 3. A base branch: chosen from the repository's branches, saved, and shown as chosen.
  await click('[data-project-base] button')
  await until(`document.querySelector('[role="listbox"], [role="option"]') !== null`, "the branch list")
  await both("03-base-branch-picker", ['[data-project-base]', '[role="listbox"]'])
  await type("release/2026")
  await until(`[...document.querySelectorAll('[role="option"]')].some(option => option.textContent.includes('release/2026.10'))`, "the branch found")
  await key("Enter", "Enter", 13)
  await until(`document.querySelector('[data-project-base="release/2026.10"]') !== null`, "the base branch saved")
  assert.equal(await evaluate(`window.mako.projectSettings('/Users/you/api').then(view => view.baseBranch)`), "release/2026.10")
  await both("04-base-branch-chosen", ['[data-project-part="New Threads"]'])

  // 4. A run script edited: the change goes to a new Thread as its request, with the recipe attached.
  const runField = '[data-project-script="run-api"]'
  await click(runField)
  await evaluate(`(() => { const field = document.querySelector(${JSON.stringify(runField)}); field.setSelectionRange(field.value.length, field.value.length); return true })()`)
  await type(" --reload")
  await until(`document.querySelector('[data-project-action="propose-run-api"]') !== null`, "the edited script's action")
  await both("05-script-edited", ['[data-project-part="Scripts"]'])
  await click('[data-project-action="propose-run-api"]')
  await until(settingsClosed, "Settings closed for the new Thread")
  await until(`window.__attached.length === 1`, "the request attached to the new Thread")
  const attached = await evaluate(`window.__attached[0]`)
  assert.match(attached.text, /change the run · api command from `uv run uvicorn app\.main:app --port \$PORT` to `uv run uvicorn app\.main:app --port \$PORT --reload`/)
  assert.match(attached.text, /committed with the project as \.mako\/recipe\.json/)
  assert.equal(attached.files.length, 1, "the recipe goes with it")
  await both("06-script-request-thread")

  // 5. Hidden: the page's switch hides it; the list puts it under Hidden, and Show brings it back.
  await evaluate(`import('/src/state/project-settings.ts').then(({openProjectSettings}) => { openProjectSettings('/Users/you/api'); return true })`)
  await until(`${onProjects} && document.querySelector('[data-project-page="api"]') !== null`, "api's page again")
  await click('[data-project-page="api"] [role="switch"][aria-label="Show in the sidebar"]')
  await until(`document.querySelector('[data-project-page="api"]').textContent.includes('Hidden')`, "api marked hidden")
  assert.deepEqual(await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.get().hiddenProjects)`), ["/Users/you/api"])
  await both("07-project-hidden", ['[data-project-page="api"] h3', '[data-project-part="Folder"]'])
  await click('[role="dialog"] main button:first-child')
  await until(`document.querySelector('[data-projects="hidden"] [data-project-row="api"]') !== null`, "api under Hidden")
  assert.equal(await evaluate(`document.querySelector('[data-projects="active"] [data-project-row="api"]')`), null)
  assert.ok(await evaluate(`document.querySelector('[data-projects="active"] [data-project-row="mako"]') !== null`))
  await settingsPage("08-projects-list-hidden")
  await click('[data-project-show="api"]')
  await until(`document.querySelector('[data-projects="active"] [data-project-row="api"]') !== null && !document.querySelector('[data-projects="hidden"]')`, "api back in Active")
  await settingsPage("09-projects-list")

  // 6. Open settings file from Settings' footer: the preferences file, in the editor Settings › Editor chose.
  await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({externalEditor: 'zed'}))`)
  await both("10-settings-footer", ['[data-settings-file]'])
  await click('[data-settings-file]')
  await until(`window.__opened.length === 1`, "the settings file opened")
  assert.deepEqual(await evaluate(`window.__opened[0]`), { path: "/Users/you/.mako/preferences.json", editor: "zed" })
  await escape()
  await until(settingsClosed, "Settings closed")

  // 7. The palette: no project's settings until asked, then one for each project, and Open settings file.
  await evaluate(`window.dispatchEvent(new CustomEvent('mako:palette'))`)
  await until(`document.querySelector('[role="dialog"] input') !== null`, "the palette open")
  const browsing = await evaluate(`document.querySelector('[role="dialog"]').innerText`)
  assert.doesNotMatch(browsing, /Project settings:/, "an empty palette lists no project's settings")
  await type("project settings")
  await until(`document.querySelector('[role="dialog"]').innerText.includes('Project settings: mako')`, "the palette's project settings")
  const found = await evaluate(`document.querySelector('[role="dialog"]').innerText`)
  for (const name of ["mako", "api", "site"]) assert.match(found, new RegExp(`Project settings: ${name}`))
  await both("11-palette-project-settings", ['[role="dialog"]'])
  await evaluate(`(() => { const input = document.querySelector('[role="dialog"] input'); input.select(); return true })()`)
  await type("Project settings: mako")
  await until(`(document.querySelector('[data-command-palette] [data-palette-row][data-index="0"]')?.textContent ?? '').includes('Project settings: mako')`, "mako's settings first")
  await key("Enter", "Enter", 13)
  await until(`${onProjects} && document.querySelector('[data-project-page="mako"]') !== null && ${scripts}.includes('npm run web')`, "the palette opened mako's page")
  const makoPage = await mainText()
  for (const text of ["npm install", "npm run web", "MAKO_HOME", ".env.local", "fixtures/recordings", "acme/mako"])
    assert.ok(makoPage.includes(text), `mako's page shows ${text}:\n${makoPage}`)
  await settingsPage("12-project-mako")
  await escape()
  await until(settingsClosed)

  await evaluate(`window.dispatchEvent(new CustomEvent('mako:palette'))`)
  await until(`document.querySelector('[role="dialog"] input') !== null`)
  await type("open settings file")
  await until(`(document.querySelector('[data-command-palette] [data-palette-row][data-index="0"]')?.textContent ?? '').includes('Open settings file')`, "the palette's Open settings file")
  await both("13-palette-settings-file", ['[role="dialog"]'])
  await key("Enter", "Enter", 13)
  await until(`window.__opened.length === 2`, "the palette opened the settings file")

  // 8. A project not set up: its scripts offer the setup Thread.
  await evaluate(`import('/src/state/project-settings.ts').then(({openProjectSettings}) => { openProjectSettings('/Users/you/site'); return true })`)
  await until(`${onProjects} && document.querySelector('[data-project-page="site"] [data-project-action="set-up"]') !== null`, "site's page")
  assert.match(await mainText(), /The folder’s origin isn’t on GitHub/)
  await settingsPage("14-project-site-not-set-up")

  clearTimeout(watchdog)
  console.log(`Project settings UI checks clean: rail menu, project page, base branch, script edit to a new Thread, Hidden list and Show, palette commands, Open settings file. Screenshots in ${shots}`)
  app.exit(0)
}
