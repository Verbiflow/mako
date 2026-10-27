import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"

/**
 * A project's carried files in Mako Cloud, against the production components and the fixture desk signed in with
 * the cloud: Settings › Apps says whether the files the recipe carries are copied, copies them on the person's word,
 * shows each with where it stands and removes one or all; a Thread's first move asks once whether they go too, and
 * either answer moves it. Screenshots of each, dark and light, stay in the printed directory.
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-carried-files-ui-"))
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-carried-files-check", main: fileURLToPath(import.meta.url) }))
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
    console.error("Carried files UI verification exceeded its 240-second limit")
    app.exit(1)
  }, 240_000)
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  const settle = async () => {
    // The fixture desk's own toasts, such as its deliberately broken plugin, aren't what's shown here.
    await evaluate(`(() => { if (!document.getElementById('hide-toasts')) document.head.insertAdjacentHTML('beforeend', '<style id="hide-toasts">[data-sonner-toaster]{display:none!important}</style>'); return true })()`)
    await evaluate("document.fonts.ready.then(() => true)")
    await evaluate(`Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))).then(() => true)`)
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
  const until = async (code, label = code) => {
    const deadline = Date.now() + 30_000
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
  const type = (text) => page.debugger.sendCommand("Input.insertText", { text })
  const enter = async () => {
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  }
  /** A new Thread on its own branch, signed in with the cloud: its first message makes its worktree and starts it there. */
  const startThread = async (query) => {
    await window.loadURL(`${base}?mock&cloud=signed-in&invited&making=fast${query}`)
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({railGrouping: 'project', railWidth: 264, theme: 'dark', newThreadsInWorktree: true}))`)
    await until(`Boolean(document.querySelector('.composer-input')) && !document.querySelector('.composer-input').readOnly`, "the composer")
    await click(".composer-input")
    await type("Retry the billing webhooks with backoff")
    await enter()
    await until(`document.querySelector('[data-run-place="local"]') !== null`, "the open Thread's Local chip")
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 300 })
  }
  const settingsOpen = `document.querySelector('[role="dialog"] main h2')?.textContent === 'Apps'`
  const inCloud = `[...document.querySelectorAll('[role="dialog"] main section')].find(section => section.firstElementChild?.textContent.startsWith('In Mako Cloud'))`
  /** Settings › Apps on the mock's own project, scrolled to its part about the cloud. */
  const appsPage = async (query) => {
    await window.loadURL(`${base}?mock&app=stopped&cloud=signed-in&invited${query}`)
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({railGrouping: 'project', railWidth: 264, theme: 'dark'}))`)
    await until(`Boolean(document.querySelector('.composer-input'))`, "the desk")
    await evaluate(`import('/src/state/app-setup.ts').then(({openAppSetup}) => { openAppSetup('/Users/you/mako'); return true })`)
    await until(settingsOpen, "Settings opened on Apps")
    await until(`Boolean(${inCloud})`, "the project's part about the cloud")
    await evaluate(`(() => { const section = ${inCloud}; section.dataset.check = 'cloud'; section.scrollIntoView({ block: 'center' }); return true })()`)
  }
  const cloudText = () => evaluate(`(${inCloud})?.innerText.replace(/\\s+/g, ' ') ?? ''`)

  // 1. Not asked yet: nothing has left the Mac, and the part says plainly what would go and what copying means.
  await appsPage("&carried=unasked")
  await until(`(${inCloud}).innerText.includes('Not copied yet')`, "not copied yet")
  let text = await cloudText()
  for (const expected of ["Git leaves out .env.local and config/dev.local.json", "encrypted copy in your account", "Agents never see the values", "Copy to Mako Cloud", "fixtures/recordings (linked to the main folder, not copied)"])
    assert.ok(text.includes(expected), `the part says ${expected}: ${text}`)
  await both("settings-not-copied", ['[data-check="cloud"]'])

  // 2. Copied on the person's word: each file in the cloud, removable alone, and all at once.
  await click('[data-carried-files-action="copy"]')
  await until(`document.querySelectorAll('[data-carried-file]').length === 2`, "both files in the cloud")
  text = await cloudText()
  assert.match(text, /\.env\.local In the cloud · just now Remove/)
  assert.ok(text.includes("Remove all"), text)
  await both("settings-copied", ['[data-check="cloud"]'])
  await click('[data-carried-file=".env.local"] [data-carried-file-action="remove"]')
  await until(`document.querySelector('[data-carried-file=".env.local"]')?.innerText.includes('Kept on this Mac')`, "kept on this Mac")
  await both("settings-one-kept", ['[data-check="cloud"]'])

  // 3. Changed here since it went up: said, and the next move sends it.
  await appsPage("&carried=changed")
  await until(`document.querySelector('[data-carried-file=".env.local"]')?.innerText.includes('Changed here')`, "changed here")
  await both("settings-changed", ['[data-check="cloud"]'])

  // 4. A Thread's first move asks once, with the files named; either answer moves it.
  await startThread("&carried=unasked")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-thread-move-offer]') !== null`, "the move offer")
  await click('[data-thread-move-offer]')
  await until(`document.querySelector('[data-carried-files-question]') !== null`, "the question")
  const asked = await evaluate(`document.querySelector('[data-carried-files-question]').innerText.replace(/\\s+/g, ' ')`)
  for (const expected of ["Copy these files to the cloud too?", "Git leaves out .env.local and config/dev.local.json", "Agents never see the values", "Asked once", "Move without them", "Copy and move"])
    assert.ok(asked.includes(expected), `the question says ${expected}: ${asked}`)
  await both("move-question", ['[data-carried-files-question]', '[data-run-place]'])
  await click('[data-carried-files-answer="yes"]')
  await until(`document.querySelector('[data-run-place="cloud"]') !== null`, "moved")
  // Asked once: the project's next move doesn't ask again.
  await startThread("&carried=declined")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-thread-move-offer]') !== null`, "the move offer")
  await click('[data-thread-move-offer]')
  await until(`document.querySelector('[data-run-place="cloud"]') !== null`, "moved without asking")
  assert.equal(await evaluate(`document.querySelector('[data-carried-files-question]')`), null)

  clearTimeout(watchdog)
  app.exit(0)
}
