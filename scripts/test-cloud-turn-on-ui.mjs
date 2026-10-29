import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"

/**
 * Mako Cloud in Settings › Account and the sidebar, against the production components and the mock bridge: an
 * account waiting for its invite (Check now hears it), the surface from the moment the cloud came on, getting ready,
 * ready with what's going said in plain words, a machine warming for the first Thread, one thing at a time that needs
 * the person (an agent signed out here, a private project, the files Git leaves out), what Mako retries by itself only
 * in Details, on with how it went, the sidebar's line, Start making its machine ahead when pressed (never on a hover,
 * and asking again shortly after the host's "later"), and Start opening the first Thread in the cloud. Each state is
 * photographed dark and light, and the surface as it changes, a frame each 400 ms.
 *
 *   node scripts/test-cloud-turn-on-ui.mjs [--shots <dir>]
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-turn-on-ui-"))
  const shotsAt = process.argv.indexOf("--shots")
  const shots = shotsAt > 0 ? resolve(process.argv[shotsAt + 1]) : root
  await mkdir(shots, { recursive: true })
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-turn-on-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_SHOTS: shots, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
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
  console.log(`UI evidence: ${shots}`)
}

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const shots = process.env.MAKO_UI_TEST_SHOTS
  const base = process.env.MAKO_UI_TEST_URL
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 1000, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  const watchdog = setTimeout(() => {
    console.error("Turn-on UI verification exceeded its 300-second limit")
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
  const rectOf = (around, pad = 20) =>
    evaluate(`(() => {
      const nodes = ${JSON.stringify(around)}.flatMap(selector => [...document.querySelectorAll(selector)])
      if (!nodes.length) return null
      const rects = nodes.map(node => node.getBoundingClientRect())
      const pad = ${pad}
      const x = Math.max(0, Math.floor(Math.min(...rects.map(r => r.left)) - pad))
      const y = Math.max(0, Math.floor(Math.min(...rects.map(r => r.top)) - pad))
      return { x, y, width: Math.min(innerWidth - x, Math.ceil(Math.max(...rects.map(r => r.right)) + pad - x)), height: Math.min(innerHeight - y, Math.ceil(Math.max(...rects.map(r => r.bottom)) + pad - y)) }
    })()`)
  const capture = async (name, around, wait = true) => {
    if (wait) await settle()
    const rect = around ? await rectOf(around) : null
    await writeFile(join(shots, `${name}.png`), (rect ? await page.capturePage(rect) : await page.capturePage()).toPNG())
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
        await capture("turn-on-failure")
        throw new Error(`UI condition timed out: ${label}`)
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
    }
  }
  const open = async (query, settings = true) => {
    await window.loadURL(`${base}?mock&cloud=signed-in${query}`)
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({theme: 'dark'}))`)
    await until(`Boolean(document.querySelector('.composer-input'))`, "the desk")
    if (settings) {
      await evaluate(`window.dispatchEvent(new CustomEvent("mako:settings", { detail: "account" })), true`)
      await until(`Boolean(document.querySelector('[data-turn-on]'))`, "the turn-on card")
      await evaluate(`document.querySelector('[data-turn-on]').scrollIntoView({ block: 'center' }), true`)
    }
  }
  const card = '[data-turn-on]'
  const text = async (selector = card) => (await evaluate(`document.querySelector('${selector}')?.innerText ?? ''`)).replace(/\n+/g, "\n")

  const details = async () => {
    await evaluate(`document.querySelector('[data-turn-on-details-toggle]').click(), true`)
    await until(`Boolean(document.querySelector('[data-turn-on-details]'))`, "the details")
  }
  const noJargon = async () => {
    const said = await text()
    for (const word of [/\bbase\b/i, /copy of/i, /ready to start fast/i, /sign(?:ing)? in again on this Mac; the cloud follows/i, /needs signing in/i]) assert.doesNotMatch(said, word, `no jargon: ${word}`)
    assert.equal(await evaluate(`document.querySelector('[data-turn-on-marks]')`), null, "no row of status dots")
  }

  // 1. Signed in, no cloud yet: the invite, with Check now, which hears the grant and starts it.
  await open("&grant")
  let said = await text()
  assert.match(said, /^Mako Cloud\nInvite-only for now\. Once you're invited, it turns on by itself\.\nCheck for invite/)
  assert.equal(await evaluate(`document.querySelector('[data-turn-on-mark]').dataset.turnOnMark`), "waiting")
  assert.equal(await evaluate(`document.querySelector('[data-turn-on-rail]')`), null, "the sidebar says nothing to an account without the cloud")
  await both("turn-on-01-invite", [card])
  await evaluate(`document.querySelector('[data-turn-on-fix="check-plan"]').click(), true`)
  await until(`document.querySelector('[data-turn-on]')?.dataset.turnOn === 'turning-on'`, "the grant heard")

  // 2. From the moment the cloud came on: a frame each 400 ms for 13 s.
  await open("&invited&turnon=live")
  const clip = await rectOf([card], 16)
  const sequence = join(shots, "turn-on-frames")
  await mkdir(sequence, { recursive: true })
  for (let frame = 0; frame < 33; frame++) {
    await frames()
    await writeFile(join(sequence, `frame-${String(frame).padStart(3, "0")}.png`), (await page.capturePage(clip)).toPNG())
    await new Promise((resolveWait) => setTimeout(resolveWait, 400))
  }
  await until(`document.querySelector('[data-turn-on]')?.dataset.turnOn === 'ready'`, "ready while the rest goes")
  assert.match(await text(), /Mako Cloud is ready/)

  // 3. Each state, dark and light.
  await open("&invited&turnon=starting")
  said = await text()
  assert.match(said, /^Getting your cloud ready\nBringing your agents over from this Mac…/)
  assert.equal(await evaluate(`document.querySelector('[data-turn-on-fix="start-thread"]')`), null, "Start waits until a Thread can run")
  assert.equal(await evaluate(`document.querySelector('[data-turn-on-mark] .spinner')?.style.getPropertyValue('--visible-animation-state')`), "running", "the mark's spinner turns while it's seen")
  await noJargon()
  await both("turn-on-02-starting", [card])

  await open("&invited&turnon=ready")
  said = await text()
  assert.match(said, /^Mako Cloud is ready\nSetting up your projects and syncing your last 30 days\. Today's are already in\.\nStart a cloud Thread\nDetails$/)
  await noJargon()
  await both("turn-on-03-ready", [card])

  await open("&invited&turnon=warming")
  assert.match(await text(), /Warming up a machine for mako…/)
  await both("turn-on-04-warming", [card])

  await open("&invited&turnon=stuck")
  said = await text()
  assert.match(said, /Claude Code is signed out on this Mac\nCloud Threads use the same sign-in as this Mac, so signing in here is all it takes\.\nSign in/)
  assert.doesNotMatch(said, /didn't go up|couldn't be made|retry/i, "what Mako retries by itself isn't on the surface")
  assert.equal(await evaluate(`document.querySelectorAll('[data-turn-on-needs]').length`), 1, "one thing at a time")
  await noJargon()
  await both("turn-on-05-stuck", [card])
  await details()
  said = await text('[data-turn-on-details]')
  assert.match(said, /2 Sessions retrying/)
  assert.match(said, /Try again/)
  await evaluate(`document.querySelector('[data-turn-on-fix="retry-bases"]').click(), true`)
  await until(`!document.querySelector('[data-turn-on-fix="retry-bases"]')`, "asked again")

  await open("&invited&turnon=none")
  assert.match(await text(), /None of your recent projects is on GitHub\nCloud Threads start from a GitHub repository\. Open one here, choose Cloud beside the composer, and send\./)
  await both("turn-on-06-no-project", [card])

  await open("&invited&turnon=on")
  said = await text()
  assert.match(said, /^Mako Cloud is on\nYour agents, projects and last 30 days are in the cloud\.\nDetails$/)
  assert.equal(await evaluate(`document.querySelector('[data-turn-on-mark]').dataset.turnOnMark`), "on")
  await both("turn-on-07-on", [card])
  await details()
  said = await text('[data-turn-on-details]')
  assert.match(said, /Agents\nClaude Code, Codex and Grok, from this Mac\n2s/)
  assert.match(said, /Last 30 days\n117 of 117 Threads\n41s/)
  assert.match(said, /First cloud Thread\nRunning\n1m 23s/)
  await both("turn-on-08-on-how-it-went", [card])

  await open("&invited&turnon=private")
  said = await text()
  assert.match(said, /mako is a private repository\nCloud Threads work with public GitHub repositories for now, so mako stays on this Mac\. Your first cloud Thread starts in api instead\./)
  assert.equal(await evaluate(`document.querySelector('[data-turn-on-needs="private"] button')`), null, "nothing to press that would pretend to fix it")
  await both("turn-on-13-private", [card])

  await open("&invited&turnon=ready&carried=unasked")
  await until(`Boolean(document.querySelector('[data-turn-on-needs="carried"]'))`, "the carried files question")
  assert.match(await text(), /Bring \.env\.local and config\/dev\.local\.json to the cloud\?/)
  await both("turn-on-14-carried", [card])
  await evaluate(`document.querySelector('[data-carried-files-answer="yes"]').click(), true`)
  await until(`!document.querySelector('[data-turn-on-needs="carried"]')`, "answered once")

  // 4. The sidebar's line, while it gets ready, once ready, and when something needs the person; it opens Settings.
  const rail = '[data-turn-on-rail]'
  for (const [scenario, name] of [["starting", "turn-on-09-rail-turning-on"], ["ready", "turn-on-10-rail-ready"], ["stuck", "turn-on-11-rail-stuck"]]) {
    await open(`&invited&turnon=${scenario}`, false)
    await until(`Boolean(document.querySelector('${rail}'))`, `the sidebar line (${scenario})`)
    await both(name, [rail])
  }
  assert.match(await text(rail), /Mako Cloud is ready\nClaude Code is signed out/)
  await open("&invited&turnon=on", false)
  await settle()
  assert.equal(await evaluate(`document.querySelector('${rail}')`), null, "gone once it's on")
  await open("&invited&turnon=ready", false)
  await until(`Boolean(document.querySelector('${rail}'))`, "the sidebar line")
  assert.match(await text(rail), /Mako Cloud is ready\nStart your first cloud Thread/)
  await capture("turn-on-12-window-ready")
  await evaluate(`document.querySelector('${rail}').click(), true`)
  await until(`Boolean(document.querySelector('[data-turn-on]'))`, "Settings › Account from the sidebar")

  // 5. A pointer passing over Start makes no machine; pressing it does. The host's "later" (a few made ahead went
  // unused) lets the next ask come shortly, as it does for the composer, rather than holding it off half a minute.
  await evaluate(`(() => { window.__prepares = []; window.mako.cloudPrepare = async (...args) => (window.__prepares.push(args), "later"); return true })()`)
  const start = `document.querySelector('[data-turn-on-fix="start-thread"]')`
  await evaluate(`(() => { const start = ${start}; for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) start.dispatchEvent(new PointerEvent(type, { bubbles: !type.endsWith("enter"), pointerType: "mouse" })); return true })()`)
  await new Promise((resolveWait) => setTimeout(resolveWait, 300))
  assert.equal(await evaluate("window.__prepares.length"), 0, "hovering Start makes no machine")
  await evaluate(`${start}.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 })), true`)
  await until("window.__prepares.length === 1", "pressing Start makes its machine ahead")
  const later = `import('/src/state/prewarm.ts').then(({ prepareCloudNow }) => (prepareCloudNow("/Users/me/later", window.__laterAt), true))`
  await evaluate(`window.__prepares.length = 0, window.__laterAt = Date.now() + 120_000, true`)
  await evaluate(later)
  await until("window.__prepares.length === 1", "the first ask")
  await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  await evaluate(`window.__laterAt += 2_500, true`)
  await evaluate(later)
  await until("window.__prepares.length === 2", "asked again shortly after \"later\"")

  // 6. Start opens the first Thread with Cloud chosen, Settings closed.
  await evaluate(`document.querySelector('[data-turn-on-fix="start-thread"]').click(), true`)
  await until(`!document.querySelector('[data-turn-on]')`, "Settings closed")
  assert.equal(await evaluate(`import('/src/state/run-place.ts').then(({ runPlaceStore }) => runPlaceStore.get().cloud)`), true, "Cloud chosen for the new Thread")

  console.log("Turn-on UI: the invite and Check now, the line playing, getting ready, ready with what's going in plain words, a machine warming, one thing at a time that needs the person (an agent signed out, a private project, the files Git leaves out), what Mako retries only in Details, on with how it went, the sidebar line, Start making its machine on a press (never a hover), and Start opening the first cloud Thread")
  clearTimeout(watchdog)
  app.exit(0)
}
