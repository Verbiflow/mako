import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"

/**
 * A project's app setup against the production components and the fixture
 * desk: the Run control's right-click and its menu, the project's
 * right-click in the sidebar, and Settings › Apps (the list, a project set
 * up with files copied, linked and holding credentials, one committed
 * with the project, one not set up). Screenshots of each, dark and light, stay in
 * the printed directory.
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-app-setup-ui-"))
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-app-setup-check", main: fileURLToPath(import.meta.url) }))
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
  console.log(`UI evidence: ${root}`)
}

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 1240, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const watchdog = setTimeout(() => {
    console.error("App setup UI verification exceeded its 90-second limit")
    app.exit(1)
  }, 90_000)
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  const settle = async () => {
    // The fixture desk's own toasts, such as its deliberately broken plugin, aren't what's shown here.
    await evaluate(`(() => { if (!document.getElementById('hide-toasts')) document.head.insertAdjacentHTML('beforeend', '<style id="hide-toasts">[data-sonner-toaster]{display:none!important}</style>'); return true })()`)
    await evaluate("document.fonts.ready.then(() => true)")
    await evaluate(`Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))).then(() => true)`)
    await frames()
  }
  /** The whole window, and a crop around `around` when given. */
  const capture = async (name, around) => {
    await settle()
    await writeFile(join(root, `${name}.png`), (await page.capturePage()).toPNG())
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
    if (rect) await writeFile(join(root, `${name}-crop.png`), (await page.capturePage(rect)).toPNG())
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
  /** A Settings page from its top, and scrolled to its end. */
  const settingsPage = async (name) => {
    const scroll = (to) => evaluate(`(() => { const main = document.querySelector('[role="dialog"] main'); main.scrollTop = ${to === "end" ? "main.scrollHeight" : 0}; return true })()`)
    await both(name, ['[role="dialog"] main > div'])
    if (await evaluate(`(() => { const main = document.querySelector('[role="dialog"] main'); return main.scrollHeight > main.clientHeight + 4 })()`)) {
      await scroll("end")
      await both(`${name}-end`, ['[role="dialog"] main > div'])
      await scroll("top")
    }
  }
  const until = async (code, label = code) => {
    const deadline = Date.now() + 15_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure")
        throw new Error(`UI condition timed out: ${label}`)
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
    }
  }
  const point = (selector) =>
    evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing target ' + ${JSON.stringify(selector)}); const r = node.getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} })()`)
  const press = async (selector, button) => {
    const at = await point(selector)
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...at })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button, clickCount: 1, ...at })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button, clickCount: 1, ...at })
  }
  const click = (selector) => press(selector, "left")
  const rightClick = (selector) => press(selector, "right")
  const escape = async () => {
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
  }
  const menuItems = () => evaluate(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(item => item.textContent.trim())`)
  const settingsOpen = `document.querySelector('[role="dialog"] main h2')?.textContent === 'Apps'`

  await window.loadURL(`${base}?mock&app=stopped`)
  await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({railGrouping: 'project', railWidth: 264, theme: 'dark'}))`)
  await until(`document.querySelector('[data-app-control="stopped"]') !== null`, "the Run control rendered")
  await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 500 })

  // 1. The Run control: a click runs it; a right-click offers Run app and the project's setup.
  await rightClick('[data-app-control="stopped"]')
  await until(`document.querySelector('[role="menu"] [data-app-action="app-setup"]') !== null`, "the Run control's right-click menu")
  assert.deepEqual(await menuItems(), ["Run app", "App setup"])
  await both("run-right-click", ['[role="menu"]', '[data-app-control]'])
  await click('[role="menu"] [data-app-action="app-setup"]')
  await until(settingsOpen, "Settings opened on Apps")
  await until(`document.querySelector('[data-app-setup-action="change"]') !== null && document.body.textContent.includes('.env.local')`, "mako's app page")
  const page1 = await evaluate(`document.querySelector('[role="dialog"] main').innerText`)
  for (const text of ["Runs", "web", "npm run web", "Thread port", "Checks", "Quick check", "Before it starts", "npm install", "New Threads also get", "Copied", "config/dev.local.json", ".env.local", "Linked to the main folder", "fixtures/recordings", "Every Thread uses the main folder’s", ".env.local holds credentials", "agents are told never to open it", "Values", "MAKO_HOME", "Version 4, kept by your account for every branch, on this Mac and on cloud machines; 3 earlier versions kept", "Proved on this Mac and on a cloud machine", "Proved on this Mac · failed on a cloud machine at verify web"])
    assert.ok(page1.includes(text), `the project's page shows ${text}:\n${page1}`)
  assert.equal(await evaluate(`document.querySelector('[role="dialog"] main [role="switch"]')`), null, "nothing to allow: credentials are carried as the recipe says")
  assert.doesNotMatch(page1, /couldn’t reach your account/, "the account answered, so nothing says it may be behind")
  await settingsPage("apps-mako")
  await evaluate(`(() => {
    const versions = [...document.querySelectorAll('[role="dialog"] main section')].find(section => section.firstElementChild?.textContent.startsWith('Versions'))
    versions.dataset.check = 'versions'
    versions.scrollIntoView({ block: 'center' })
    ;[...document.querySelectorAll('[role="dialog"] main p')].find(p => p.textContent.includes('kept by your account')).parentElement.dataset.check = 'kept'
    return true
  })()`)
  await both("apps-mako-versions", ['[data-check="versions"]', '[data-check="kept"]'])
  await evaluate(`(() => { document.querySelector('[role="dialog"] main').scrollTop = 0; return true })()`)

  // 2. Every project, with what state each is in.
  await click('[role="dialog"] main button:first-child')
  await until(`document.querySelectorAll('[data-app-project]').length >= 3`, "the list of projects")
  const rows = await evaluate(`Object.fromEntries([...document.querySelectorAll('[data-app-project]')].map(row => [row.dataset.appProject, row.innerText.replace(/\\s+/g, ' ').trim()]))`)
  assert.match(rows.mako, /web · 2 checks/)
  assert.doesNotMatch(rows.mako, /Credentials/)
  assert.match(rows.api, /api, worker, temporal · 1 check/)
  assert.match(rows.site, /Not set up/)
  await settingsPage("apps-list")

  // 3. A recipe committed with the project, with a fixed port and one copy at a time.
  await click('[data-app-project="api"]')
  await until(`document.body.textContent.includes('One copy at a time')`, "api's page")
  const page2 = await evaluate(`document.querySelector('[role="dialog"] main').innerText`)
  for (const text of ["Port 7233, fixed", "Committed with the project", "server/.env", "postgres://localhost:5432/api_{thread}", "uv sync"])
    assert.ok(page2.includes(text), `api's page shows ${text}:\n${page2}`)
  await settingsPage("apps-api")

  // 4. Not set up: one button that starts it, naming the agent.
  await click('[role="dialog"] main button:first-child')
  await until(`document.querySelector('[data-app-project="site"]') !== null`)
  await click('[data-app-project="site"]')
  await until(`document.querySelector('[data-app-setup-action="set-up"]') !== null`, "site's page")
  assert.match(await evaluate(`document.querySelector('[role="dialog"] main').innerText`), /site isn’t set up to run yet/)
  await settingsPage("apps-site")
  await escape()
  await until(`!document.querySelector('[role="dialog"] main h2')`, "Settings closed")

  // 5. The project's right-click in the sidebar opens the same page.
  const header = `.thread-jump-scope [data-flip-key="folder:/Users/you/api"]`
  await until(`document.querySelector(${JSON.stringify(header)}) !== null`, "api's folder in the sidebar")
  await rightClick(header)
  await until(`document.querySelector('[role="menu"] [data-folder-action="app-setup"]') !== null`, "the project's right-click menu")
  const folderMenu = await menuItems()
  assert.ok(folderMenu.includes("App setup"), `the project's menu has App setup: ${folderMenu}`)
  assert.equal(folderMenu.indexOf("App setup") + 1, folderMenu.indexOf("Open in editor"), "it leads the folder's own group")
  await both("project-right-click", ['[role="menu"]', header])
  await click('[role="menu"] [data-folder-action="app-setup"]')
  await until(`${settingsOpen} && document.body.textContent.includes('One copy at a time')`, "the sidebar's App setup opened api's page")
  await escape()
  await until(`!document.querySelector('[role="dialog"] main h2')`)

  // 6. The account out of reach: the versions this Mac took are shown, saying they may not be the newest.
  await window.loadURL(`${base}?mock&app=stopped&recipe=behind`)
  await until(`document.querySelector('[data-app-control="stopped"]') !== null`)
  await rightClick('[data-app-control="stopped"]')
  await until(`document.querySelector('[role="menu"] [data-app-action="app-setup"]') !== null`)
  await click('[role="menu"] [data-app-action="app-setup"]')
  await until(`${settingsOpen} && document.body.textContent.includes('MAKO_HOME')`, "mako's app page, out of reach")
  assert.match(await evaluate(`document.querySelector('[role="dialog"] main').innerText`), /3 earlier versions kept\. Mako couldn’t reach your account just now, so this may not be its newest version\./)
  await settingsPage("apps-mako-behind")
  await escape()
  await until(`!document.querySelector('[role="dialog"] main h2')`)

  // 7. The running app's own menu ends with the same row.
  await window.loadURL(`${base}?mock&app=running`)
  await until(`document.querySelector('[data-app-control="running"]') !== null`)
  await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 500 })
  await click('[data-app-control="running"]')
  await until(`document.querySelector('[role="menu"] [data-app-action="app-setup"]') !== null`, "the running app's menu")
  const running = await menuItems()
  assert.equal(running.at(-1), "App setup")
  await both("running-menu", ['[role="menu"]', '[data-app-control]'])

  clearTimeout(watchdog)
  console.log("App setup UI checks clean: Run control right-click and menu, project right-click, Settings › Apps (list, set up with copied, linked and credentials files, versions kept by the account with each place's proof, out of reach, committed, not set up)")
  app.exit(0)
}
