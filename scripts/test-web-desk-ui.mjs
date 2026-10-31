import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The web app in a laptop's browser (`src/dev/web-desk-check.tsx`: `Desk` through its production pieces, on the mock
 * bridge), at a laptop's size with a mouse:
 *
 * - The rail is the desktop's own (`AgentThreads`): the account's Threads under their projects, indented from a
 *   hairline, a Thread's four Sessions one row wearing their count, Projects, Recent and Status; each project with what
 *   its checkout has checked out, a row with the agent it ran in before, and a Thread waiting on background work with
 *   the hourglass before it's opened, all as the Mac's list says them.
 * - The page never grows past the window, however many tabs a Thread has or how wide its transcript's lines are: the
 *   transcript's column, the composer and the strip's end stay on screen.
 * - The strip's tabs are the desktop's; a tab opens its Session, a rail row its Thread, each at its address.
 * - A Session another device starts shows in the rail as it's listed.
 * - ⌘B hides the rail and brings it back.
 *
 * Screenshots go to the printed directory, or to the directory given as the first argument; `--port` serves the page
 * on that port (default: any free one).
 */
if (process.versions.electron) {
  const { app } = await import("electron")
  void checkDesk().then(() => app.exit(0)).catch((error) => {
    console.error(error)
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const args = process.argv.slice(2)
  const portAt = args.indexOf("--port")
  const port = portAt === -1 ? 0 : Number(args.splice(portAt, 2)[1])
  const root = await mkdtemp(join(tmpdir(), "mako-web-desk-ui-"))
  const evidence = args[0] ? resolve(args[0]) : root
  await mkdir(evidence, { recursive: true })
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port, strictPort: port !== 0, hmr: false } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-web-desk-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_DESK_ROOT: root, MAKO_DESK_EVIDENCE: evidence, MAKO_DESK_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`Web desk UI evidence: ${evidence}`)
}

async function checkDesk() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_DESK_ROOT
  const evidence = process.env.MAKO_DESK_EVIDENCE
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const watchdog = setTimeout(() => app.exit(1), 180_000)
  const window = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = (count = 2) => evaluate(`new Promise(resolve => { let left = ${count}; const step = () => --left > 0 ? requestAnimationFrame(step) : resolve(true); requestAnimationFrame(step) })`)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (code, label = code) => {
    const deadline = Date.now() + 15_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure.png")
        throw new Error(`Timed out: ${label}`)
      }
      await wait(30)
    }
  }
  const capture = async (name) => {
    await frames(3)
    await writeFile(join(evidence, name), (await page.capturePage()).toPNG())
  }
  const centre = (selector) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing ' + ${JSON.stringify(selector)}); const r = node.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
  const click = async (selector) => {
    const { x, y } = await centre(selector)
    for (const type of ["mousePressed", "mouseReleased"]) await page.debugger.sendCommand("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 })
    await frames(2)
  }
  const chord = async (key, code, modifiers) => {
    for (const type of ["rawKeyDown", "keyUp"]) await page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key, code, modifiers, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) })
    await frames(2)
  }
  /** Whether every element `selector` names lies inside the window, side to side. */
  const onScreen = (selector) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].every(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 0.5 })`)
  const desk = async (theme, query = "thread=busy") => {
    await window.loadURL(`${new URL("scripts/web-desk.html", process.env.MAKO_DESK_URL).href}?${query}&theme=${theme}`)
    await until("document.querySelectorAll('[data-thread-row]').length > 0", "the rail's rows")
    await evaluate("document.fonts.ready.then(() => true)")
  }

  try {
    // 0. Before anything is opened, the rail says what the Mac's rail shows: each project's checkout, the agent a row
    //    ran in before, and the Thread waiting on background work.
    await desk("dark", "list")
    const heads = await evaluate("[...document.querySelectorAll('[data-flip-key^=\"folder:\"]')].map(node => node.textContent.replace(/\\s+/g, ' ').trim())")
    assert.ok(heads.some((head) => head.startsWith("api") && head.includes("billing-webhook-retries")), `the api project's branch: ${JSON.stringify(heads)}`)
    assert.ok(heads.some((head) => head.startsWith("site") && head.includes("Rebasing pricing-table")), `the site project mid-rebase: ${JSON.stringify(heads)}`)
    const busy = "[...document.querySelectorAll('[data-thread-row]')].find(node => node.textContent.includes('Thread Environments'))"
    assert.equal(await evaluate(`${busy}.getAttribute('aria-label').includes('background task')`), true, "the busy Thread waits on its background work, before it's opened")
    assert.equal(await evaluate("[...document.querySelectorAll('[data-thread-row]')].find(node => node.textContent.includes('Ship the billing webhooks')).querySelectorAll('.mark-stack > *').length"), 2, "a row wears the agent it ran in before, beside its own")
    await capture("list-1280-dark.png")
    console.log("Rail: checkouts, earlier agents and background work from the Mac's list")

    await desk("dark")
    assert.equal(await evaluate("matchMedia('(pointer: fine) and (hover: hover)').matches"), true, "the page reads as under a mouse")
    await until("Boolean(document.querySelector('[data-background-work]'))", "the busy Session's background work")

    // 1. The desktop's rail: projects, each Thread one row hanging from its project's hairline; four Sessions, one row.
    const folders = await evaluate("[...document.querySelectorAll('[data-flip-key^=\"folder:\"]')].map(node => node.textContent.trim())")
    assert.ok(folders.some((name) => name.startsWith("mako")) && folders.some((name) => name.startsWith("api")), `the rail's projects: ${JSON.stringify(folders)}`)
    assert.ok((await evaluate("document.querySelectorAll('[data-thread-row][data-thread-indent]').length")) >= 4, "Threads are indented under their project")
    assert.equal(await evaluate("document.querySelectorAll('[aria-label=\"4 sessions\"]').length"), 1, "the busy Thread is one row for its four Sessions")
    assert.equal(await evaluate("Boolean(document.querySelector('[data-thread-row][data-active]'))"), true, "the open Thread's row is lit")
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[aria-label=\"Thread view\"] button')].map(node => node.textContent)"), ["Projects", "Recent", "Status"], "the rail's views")
    console.log(`Rail: ${folders.length} projects, the desktop's rows`)

    // 2. Nothing runs off the window: the page, the transcript's column, the background work, the composer's send.
    assert.ok(await onScreen(".web-desk"), "the desk fits the window")
    assert.ok(await onScreen("[data-background-work]"), "the background work's line fits")
    assert.ok(await onScreen("main textarea"), "the composer fits")
    assert.ok(await onScreen("[role=tablist] ~ *"), "the strip's end fits")
    assert.equal(await evaluate("document.querySelectorAll('.session-tab').length"), 4, "the strip's tabs are the desktop's, one per Session")
    await capture("busy-1280-dark.png")
    console.log("Fit: page, transcript, composer and strip inside 1280 px")

    // 3. A tab opens its Session; a rail row its Thread.
    await click("[data-session-tab]:nth-of-type(1)")
    const third = await evaluate("document.querySelectorAll('[data-session-tab]')[2].getAttribute('data-session-tab')")
    await click(`[data-session-tab="${third}"]`)
    await until(`document.querySelector('[data-session-tab="${third}"]').getAttribute('aria-selected') === 'true'`, "the third tab selected")
    await until("document.querySelector('main textarea')?.placeholder.includes('Codex')", "the Codex Session's composer")
    const thread = await evaluate("document.querySelector('[data-thread-screen]').getAttribute('data-thread-screen')")
    const other = await evaluate("[...document.querySelectorAll('[data-thread-row]')].find(node => node.textContent.includes('Ship the billing webhooks')).getAttribute('data-conversation-id')")
    await click(`[data-conversation-id="${other}"]`)
    await until(`document.querySelector('[data-thread-screen]')?.getAttribute('data-thread-screen') !== ${JSON.stringify(thread)}`, "the other Thread open")
    await until(`document.querySelector('[data-conversation-id="${other}"]')?.hasAttribute('data-active')`, "its row lit")
    console.log("Open: a tab, then a rail row")

    // 4. A Session another device starts is in the rail as soon as it's listed, at work.
    await evaluate("window.webDeskCheck.list('Rotate the signing keys', '/Users/you/api')")
    await until("[...document.querySelectorAll('[data-thread-row]')].some(node => node.textContent.includes('Rotate the signing keys'))", "the listed Session's row")
    console.log("Listing: a new Session's row")

    // 5. ⌘B: the rail goes, the title strip's segment with it, and comes back.
    await chord("b", "KeyB", 4)
    await until("!document.querySelector('nav[aria-label=\"Threads\"]')", "the rail hidden")
    await chord("b", "KeyB", 4)
    await until("Boolean(document.querySelector('nav[aria-label=\"Threads\"]'))", "the rail back")
    console.log("Keys: ⌘B")

    await desk("light")
    await until("Boolean(document.querySelector('[data-background-work]'))", "the busy Session, light")
    await capture("busy-1280-light.png")
  } finally {
    clearTimeout(watchdog)
  }
}
