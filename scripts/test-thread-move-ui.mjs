import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"

/**
 * A Thread moving to the cloud, against the production components and the
 * fixture desk signed in with the cloud: a Thread in its own worktree offers
 * Move to the cloud from its Local chip; the strip above the composer walks
 * through sending ahead, handing over and resuming; once moved the chip says
 * Cloud, and offers Bring back to this Mac, whose strip walks through packing
 * and bringing it here until the chip says Local again. A busy Thread stays
 * here and says why. Screenshots of each, dark and
 * light, stay in the printed directory.
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-thread-move-ui-"))
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-thread-move-check", main: fileURLToPath(import.meta.url) }))
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
    console.error("Thread move UI verification exceeded its 240-second limit")
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
  /** The button inside `within` whose text includes `text`, clicked with trusted input. */
  const clickText = async (within, text) => {
    await evaluate(`(() => { document.querySelectorAll('[data-test-target]').forEach(node => node.removeAttribute('data-test-target')); const node = [...document.querySelectorAll(${JSON.stringify(`${within} button`)})].find(each => each.innerText.includes(${JSON.stringify(text)})); if (!node) throw new Error('Missing button ' + ${JSON.stringify(text)}); node.setAttribute('data-test-target', ''); return true })()`)
    await click("[data-test-target]")
  }
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

  // 1. A Thread on this Mac in its own worktree: its Local chip offers the move.
  await startThread("")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await both("local-chip", ['[data-run-place]', '[data-composer]'])
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-thread-move-offer]') !== null`, "the move offer")
  assert.equal(await evaluate(`document.querySelector('[data-thread-move-offer]').disabled`), false, "a quiet Thread in its own worktree can move")
  assert.match(await evaluate(`document.querySelector('[data-thread-move-offer]').innerText`), /Move to the cloud[\s\S]*same folder/)
  await both("move-offer", ['[data-thread-move-offer]', '[data-run-place]'])

  // 2. Moving: the strip above the composer says each step, and the chip says Moving.
  await click('[data-thread-move-offer]')
  await until(`document.querySelector('[data-thread-move="packing"]') !== null`, "sending ahead")
  assert.match(await evaluate(`document.querySelector('[data-run-place]').getAttribute('aria-label')`), /Moving/)
  await both("move-packing", ['[data-thread-move]', '[data-run-place]'])
  await until(`document.querySelector('[data-thread-move="handing-over"]') !== null`, "handing over")
  await both("move-handing-over", ['[data-thread-move]'])
  await until(`document.querySelector('[data-thread-move="resuming"]') !== null`, "resuming")
  await both("move-resuming", ['[data-thread-move]'])

  // 3. Moved: the strip goes, the chip says Cloud.
  await until(`document.querySelector('[data-run-place="cloud"]') !== null && !document.querySelector('[data-thread-move]')`, "moved")
  await both("moved", ['[data-run-place]', '[data-composer]'])

  // 3b. The way back: the Cloud chip offers it, two steps above the composer, and Local once it's here.
  await click('[data-run-place="cloud"]')
  await until(`document.querySelector('[data-thread-return-offer]') !== null`, "the return offer")
  assert.equal(await evaluate(`document.querySelector('[data-thread-return-offer]').disabled`), false, "a quiet cloud Thread can come back")
  assert.match(await evaluate(`document.querySelector('[data-thread-return-offer]').innerText`), /Bring back to this Mac[\s\S]*cloud machine ends/)
  await both("return-offer", ['[data-thread-return-offer]', '[data-run-place]'])
  await click('[data-thread-return-offer]')
  await until(`document.querySelector('[data-thread-return="packing"]') !== null`, "packing in the cloud")
  assert.match(await evaluate(`document.querySelector('[data-run-place]').getAttribute('aria-label')`), /Coming back/)
  await both("return-packing", ['[data-thread-return]', '[data-run-place]'])
  await until(`document.querySelector('[data-thread-return="bringing"]') !== null`, "bringing it here")
  await both("return-bringing", ['[data-thread-return]'])
  await until(`document.querySelector('[data-run-place="local"]') !== null && !document.querySelector('[data-thread-return]')`, "back")
  await both("back", ['[data-run-place]', '[data-composer]'])

  // 4. A busy Thread stays here: nothing moves, and the toast says why.
  await startThread("&move=busy")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-thread-move-offer]') !== null`, "the move offer")
  await click('[data-thread-move-offer]')
  await until(`document.querySelector('[data-run-place="local"]') !== null && !document.querySelector('[data-thread-move]')`, "kept here")

  // 5. A Thread at work is handed off: its chip offers it, the strip says its turn pauses, and it goes on in the cloud.
  await startThread("")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await click(".composer-input")
  await type("Keep working through the failing retries")
  await enter()
  await until(`document.querySelector('[data-run-place="local"]') !== null && document.querySelector('.composer-input') !== null`, "the turn running")
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-thread-move-offer][data-thread-handoff]') !== null`, "the handoff offer")
  assert.match(await evaluate(`document.querySelector('[data-thread-move-offer]').innerText`), /Hand off to the cloud[\s\S]*turn pauses[\s\S]*goes on there/)
  await both("handoff-offer", ['[data-thread-move-offer]', '[data-run-place]'])
  await click('[data-thread-move-offer]')
  await until(`document.querySelector('[data-thread-move="pausing"][data-thread-handoff]') !== null`, "pausing its turn")
  assert.match(await evaluate(`document.querySelector('[data-thread-move]').innerText`), /Handing off to the cloud/)
  await both("handoff-pausing", ['[data-thread-move]', '[data-run-place]'])
  await until(`document.querySelector('[data-thread-move="resuming"][data-thread-handoff]') !== null`, "continuing in the cloud")
  await both("handoff-resuming", ['[data-thread-move]'])
  await until(`document.querySelector('[data-run-place="cloud"]') !== null && !document.querySelector('[data-thread-move]')`, "handed off")

  // 5b. A Thread whose turn ended but left work running in the background is handed off too: that work stops, and it's told so there.
  await startThread("")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await click(".composer-input")
  await type("Start the dev server in the background")
  await enter()
  await until(`document.body.innerText.includes('Finished: Start the dev server')`, "the turn ended, its work in the background")
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-thread-move-offer][data-thread-handoff]') !== null`, "the handoff offer for background work")
  assert.match(await evaluate(`document.querySelector('[data-thread-move-offer]').innerText`), /Hand off to the cloud[\s\S]*left running in the background stops[\s\S]*told what stopped/)
  await both("handoff-background-offer", ['[data-thread-move-offer]', '[data-run-place]'])
  await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
  await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })

  // 6. The way back stays when Codex here is older than the cloud's: one choice updates it and brings the Thread back.
  await startThread("&return=outdated")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-thread-move-offer]') !== null`, "the move offer")
  await click('[data-thread-move-offer]')
  await until(`document.querySelector('[data-run-place="cloud"]') !== null && !document.querySelector('[data-thread-move]')`, "moved")
  await click('[data-run-place="cloud"]')
  await until(`document.querySelector('[data-thread-return-offer]') !== null`, "the return offer")
  await click('[data-thread-return-offer]')
  await until(`document.querySelector('[data-thread-return="outdated"]') !== null`, "the outdated notice")
  assert.match(await evaluate(`document.querySelector('[data-thread-return="outdated"]').innerText`), /stayed in the cloud[\s\S]*0\.163\.0[\s\S]*Update Codex and bring it back/)
  assert.ok(await evaluate(`document.querySelector('[data-run-place="cloud"]') !== null`), "the Thread stays in the cloud meanwhile")
  await both("return-outdated", ['[data-thread-return]', '[data-run-place]'])
  await clickText('[data-thread-return="outdated"]', "Update Codex and bring it back")
  await until(`document.querySelector('[data-thread-return="outdated"]')?.innerText.includes('Updating Codex')`, "updating")
  await both("return-updating", ['[data-thread-return]'])
  await until(`document.querySelector('[data-thread-return="packing"]') !== null`, "bringing it back after the update")
  await until(`document.querySelector('[data-run-place="local"]') !== null && !document.querySelector('[data-thread-return]')`, "back after the update")

  // 7. Settings: handing off as this Mac sleeps, and what quitting does while agents work.
  await evaluate(`window.dispatchEvent(new CustomEvent("mako:settings", { detail: "account" })), true`)
  await until(`document.querySelector('[data-handoff-settings]') !== null && document.querySelector('[data-handoff-settings] [role="switch"]')?.getAttribute('aria-checked') === 'true'`, "the handoff settings, on by default")
  await evaluate(`document.querySelector('[data-handoff-settings]').scrollIntoView({ block: 'center' }), true`)
  await both("handoff-settings", ['[data-handoff-settings]'])
  await click('[data-handoff-settings] [role="switch"]')
  await until(`document.querySelector('[data-handoff-settings] [role="switch"]').getAttribute('aria-checked') === 'false'`, "handing off on sleep turned off")
  await clickText('[data-handoff-settings]', "Hand off")
  await until(`document.querySelector('[data-handoff-settings] [aria-pressed="true"]')?.innerText.includes('Hand off')`, "quitting hands off")
  await both("handoff-settings-changed", ['[data-handoff-settings]'])
  console.log("Thread move UI: offered from a worktree Thread's Local chip, three steps above the composer, Cloud once moved; brought back from its Cloud chip in two steps, Local once back; a busy Thread kept here; a Thread at work handed off with its turn paused, and one with only background work; an outdated way back updated and brought back in one choice; and the handoff settings")
  clearTimeout(watchdog)
  app.exit(0)
}
