import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"

/**
 * Settings › Account's devices against the production components and the
 * fixture desk: each device says when, from where and how it joined the
 * account, with its own kind's icon; a Mac signed out because its sign-in was
 * used from somewhere else says so. The browsers signed in to the account are
 * named and placed, and signed out one at a time or all, each asked first.
 * Screenshots of each, dark and light, stay in the printed directory.
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-account-devices-ui-"))
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-account-devices-check", main: fileURLToPath(import.meta.url) }))
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
    console.error("Account devices UI verification exceeded its 240-second limit")
    app.exit(1)
  }, 240_000)
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  let showToasts = false
  const settle = async () => {
    // The fixture desk's own toasts, such as its deliberately broken plugin, aren't what's shown here, but for the one a step looks at.
    if (!showToasts) await evaluate(`(() => { if (!document.getElementById('hide-toasts')) document.head.insertAdjacentHTML('beforeend', '<style id="hide-toasts">[data-sonner-toaster]{display:none!important}</style>'); return true })()`)
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
  const openAccount = async (query) => {
    await window.loadURL(`${base}?mock${query}`)
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({theme: 'dark'}))`)
    await until(`Boolean(document.querySelector('.composer-input'))`, "the desk")
    await evaluate(`window.dispatchEvent(new CustomEvent("mako:settings", { detail: "account" })), true`)
  }

  // 1. Signed in: every device says when, from where and how it joined.
  await openAccount("&cloud=signed-in&invited")
  await until(`document.querySelectorAll('[data-device-joined]').length >= 3`, "the devices")
  const lines = await evaluate(`[...document.querySelectorAll('[data-device-joined]')].map((line) => line.textContent)`)
  assert.ok(lines.some((line) => /^Joined .+ from San Francisco, United States, through the browser$/.test(line)), JSON.stringify(lines))
  assert.ok(lines.some((line) => /^Joined .+ from Frankfurt, Germany, with a code you approved$/.test(line)), JSON.stringify(lines))
  await evaluate(`(() => { const rows = [...document.querySelectorAll('[data-device-joined]')]; rows.at(-1).scrollIntoView({ block: 'center' }); rows.forEach((row) => row.closest('[class*="flex items-center gap-3"]')?.setAttribute('data-device-row', '')); return true })()`)
  await both("devices", ['[data-device-row]'])

  // 2. The browsers signed in to the account: named, where each signed in and was last used, signed out when asked twice.
  await until(`document.querySelectorAll('[data-browser-name]').length === 3`, "the browsers")
  const browsers = () => evaluate(`[...document.querySelectorAll('[data-browser-name]')].map((name) => name.closest('.flex.items-center.gap-3').innerText.replace(/\\n+/g, '\\n'))`)
  const rows = await browsers()
  assert.match(rows[0], /^Chrome on macOS\nUsed now from San Francisco, United States\nSigned in .+ from San Francisco, United States, with GitHub/, rows[0])
  assert.match(rows[2], /^Firefox on Windows\nLast used 3 ?h(?:r|ours?)? ago from Osaka, Japan\nSigned in .+ from Tokyo, Japan, with GitHub/, rows[2])
  await evaluate(`document.querySelector('[data-testid="account-browsers"]').scrollIntoView({ block: 'center' }), true`)
  await both("browsers", ['[data-testid="account-browsers"]'])
  const click = (scope, label) => evaluate(`(() => { const button = [...document.querySelectorAll('${scope} button')].find((each) => each.innerText.trim() === ${JSON.stringify(label)}); button.click(); return true })()`)
  await evaluate(`(() => { const row = [...document.querySelectorAll('[data-testid="account-browsers"] .flex.items-center.gap-3')].find((each) => each.innerText.startsWith('Firefox')); row.setAttribute('data-firefox', ''); return true })()`)
  await click("[data-firefox]", "Sign out")
  await until(`document.querySelector('[data-firefox]').innerText.includes('It will be signed out at once')`, "the confirmation")
  await both("browser-confirm", ['[data-testid="account-browsers"]'])
  await click("[data-firefox]", "Sign out")
  await until(`!document.querySelector('[data-firefox]') && document.querySelectorAll('[data-browser-name]').length === 2`, "one signed out")
  await click('[data-testid="account-browsers"]', "Sign out all")
  await until(`document.querySelectorAll('[data-testid="account-browsers"] .text-caution').length === 2`, "every row says it goes")
  await both("browsers-confirm-all", ['[data-testid="account-browsers"]'])
  await click('[data-testid="account-browsers"]', "Sign out 2 browsers")
  await until(`document.querySelector('[data-testid="account-browsers"]').innerText.includes('No browser is signed in to your account.')`, "none left")
  await both("browsers-none", ['[data-testid="account-browsers"]'])

  // 3. Signed out because the sign-in was used from somewhere else: said, with Sign in.
  await openAccount("&cloud=reused")
  await until(`document.body.innerText.includes('used from somewhere else')`, "the reused notice")
  assert.match(await evaluate(`document.querySelector('[role="dialog"] main').innerText`), /This Mac was signed out[\s\S]*used from somewhere else[\s\S]*Sign in/)
  await both("signed-out-reused", ['[role="dialog"] main'])
  // 4. A device joins while this Mac is open: said at once, with Remove.
  await window.loadURL(`${base}?mock&cloud=signed-in&invited&joined`)
  await until(`Boolean(document.querySelector('[data-sonner-toast]')) && document.body.innerText.includes('build-box joined your account')`, "the joined alert")
  const alert = await evaluate(`document.querySelector('[data-sonner-toast]').innerText`)
  assert.match(alert, /A terminal on Linux, from Frankfurt, Germany, with a code you approved\. If it isn't yours, remove it\./)
  assert.match(alert, /Remove/)
  showToasts = true
  await both("device-joined", ['[data-sonner-toast]'])
  console.log("Account devices UI: each device's joining said, the browsers named, placed and signed out one or all, a reused sign-in's sign-out said, a device that joins said at once")
  clearTimeout(watchdog)
  app.exit(0)
}
