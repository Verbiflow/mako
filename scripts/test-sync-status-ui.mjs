import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"

/**
 * Settings › Account's Sync against the production components and the mock
 * bridge: what of the last 30 days is in the cloud, by tier (working now,
 * today, this week, earlier this month), as it catches up, once it's all
 * there, while it waits for power, and when a push failed, in the cloud's
 * words with a copy of the correlation IDs. A Mac without the cloud shows no
 * Sync. Screenshots of each, dark and light, stay in the printed directory.
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-sync-status-ui-"))
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-sync-status-check", main: fileURLToPath(import.meta.url) }))
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
    console.error("Sync status UI verification exceeded its 240-second limit")
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

  const section = '[data-testid="sync-section"]'
  const text = async () => (await evaluate(`document.querySelector('${section}').innerText`)).replace(/\n+/g, "\n")
  const show = () => evaluate(`document.querySelector('${section}').scrollIntoView({ block: 'center' }), true`)

  // 1. Catching up: the Thread at work and today's are in; this week's and the rest go, the older sessions read first.
  await openAccount("&cloud=signed-in&invited")
  await until(`Boolean(document.querySelector('${section} [data-sync-tier="month"]'))`, "the tiers")
  await show()
  let said = await text()
  assert.match(said, /Your last 30 days, in the cloud/)
  assert.match(said, /Catching up/)
  assert.match(said, /Working now\n2 Threads · 3 Sessions\n\s*All 2 Threads/)
  assert.match(said, /Today\n9 Threads · 14 Sessions\n\s*All 9 Threads/)
  assert.match(said, /This week\n31 Threads · 58 Sessions\n\s*\d+ of 31 Threads/)
  assert.match(said, /readable on your other devices · \d+ ready to continue anywhere/)
  assert.match(said, /still being read on this Mac/)
  assert.match(said, /Reading this Mac's older sessions into its records: [\d,]+ of 5,012\./)
  await both("sync-catching-up", [section])

  // 2. All of it in the cloud.
  await openAccount("&cloud=signed-in&invited&sync=synced")
  await until(`document.querySelector('${section} [data-sync-state="synced"]') !== null`, "in sync")
  await show()
  said = await text()
  assert.match(said, /In sync/)
  assert.match(said, /Earlier this month\n74 Threads · 129 Sessions\n\s*All 74 Threads/)
  assert.match(said, /Last sent just now\./)
  assert.doesNotMatch(said, /Reading this Mac's older sessions/, "a finished backfill isn't said")
  await both("sync-in-sync", [section])

  // 3. On a low battery: catching up waits, the Thread at work still goes.
  await openAccount("&cloud=signed-in&invited&sync=paused")
  await until(`document.querySelector('${section} [data-sync-state="paused"]') !== null`, "paused")
  await show()
  said = await text()
  assert.match(said, /Waiting for power/)
  assert.match(said, /Catching up waits while this Mac is on a low battery or in Low Power Mode; the Thread you're working in still goes up\./)
  assert.match(said, /2 Sessions changed since their last copy, going up in turn\./)
  await both("sync-waiting-for-power", [section])

  // 4. A push failed: said in the cloud's words, with its correlation ID one copy away.
  await openAccount("&cloud=signed-in&invited&sync=failing")
  await until(`document.querySelector('[data-sync-failures]') !== null`, "the failures")
  await show()
  const failure = await evaluate(`document.querySelector('[data-sync-failures]').innerText`)
  assert.match(failure, /2 Sessions didn't go up, the last 2m ago\. Mako tries again on its own\./)
  assert.match(failure, /correlation 6f1c2d3e-8b9a-4c7d-a1e2-f3b4c5d6e7f8/)
  assert.match(failure, /Copy details/)
  await both("sync-failing", [section, "[data-sync-failures]"])

  // 5. No cloud on the account: no Sync at all.
  await openAccount("&cloud=signed-in")
  await until(`document.body.innerText.includes("Invite-only for now")`, "the account")
  assert.equal(await evaluate(`document.querySelector('${section}')`), null)
  console.log("Sync status UI: catching up by tier with the backfill said, all in sync, waiting for power, a failure in the cloud's words with its correlation ID, and nothing without the cloud")
  clearTimeout(watchdog)
  app.exit(0)
}
