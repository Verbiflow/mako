import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * What stands over the composer lines up with it: every notice, its open list and what's left of it behind, the same
 * width and the same edges as the box you type in, on the desk, in a laptop's browser and on a phone, whatever the
 * window. Measured, so a pixel of drift fails. Screenshots land in the printed directory. `--url <base>` uses a running
 * Vite server instead of starting one.
 */

if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const given = process.argv.indexOf("--url")
  const root = testScratch("mako-composer-edges-ui-")
  let server
  let base = given > 0 ? process.argv[given + 1] : undefined
  if (!base) {
    const { uiVite } = await import("./lib/ui-vite.mjs")
    server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await server.listen()
    base = server.resolvedUrls.local[0]
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-composer-edges-ui", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: base }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code, signal) => done(electronExit("The composer edges UI check", code, signal)))
    })
  } finally {
    await server?.close()
  }
  console.log(`UI evidence: ${root}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL.replace(/\/$/, "")
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } })
  const page = window.webContents
  const guard = guardElectronCheck({ app, page, name: "The composer edges UI check", ms: 200_000 })
  page.debugger.attach("1.3")
  const evaluate = (code) => page.executeJavaScript(code)
  const until = async (code, label = code) => {
    guard.at(label)
    const deadline = Date.now() + 30_000
    while (!(await evaluate(code).catch(() => false))) {
      if (Date.now() > deadline) {
        await writeFile(join(root, "failure.png"), (await page.capturePage()).toPNG())
        throw new Error(`Timed out waiting for ${label}`)
      }
      await new Promise((done) => setTimeout(done, 50))
    }
  }
  const load = async (path, width, height, mobile = false) => {
    await window.loadURL("about:blank")
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile })
    await window.loadURL(`${base}${path}`).catch((error) => {
      if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error
    })
  }
  const capture = async (name) => {
    await evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))")
    await writeFile(join(root, name), (await page.capturePage()).toPNG())
  }
  /** Two notices, as the producers a window has: the stack, its lip behind, and its list when opened. */
  const notices = () =>
    evaluate(`import('/src/extend/notices.ts').then(({ registerNotice }) => {
      registerNotice('edges-a', () => ({ id: 'edges-a', tone: 'danger', title: 'A notice over the composer', description: 'Its edges are the box the words go in.' }), -20)
      registerNotice('edges-b', () => ({ id: 'edges-b', tone: 'info', title: 'And one behind it' }), -19)
      return true
    })`)
  const edges = (selector) =>
    evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return box && box.width > 0 ? { left: Math.round(box.left * 2) / 2, right: Math.round(box.right * 2) / 2 } : null })()`)
  const lined = async (where, box, selectors) => {
    const composer = await edges(box)
    assert.ok(composer, `the composer, ${where}`)
    for (const selector of selectors) {
      const row = await edges(selector)
      assert.ok(row, `${selector}, ${where}`)
      assert.deepEqual(row, composer, `${selector} lines up with the composer, ${where}`)
    }
  }
  const stack = ["[data-composer-notices] > div:last-of-type"]
  const list = "[data-notice-list]"

  for (const [name, path, width, height] of [
    ["the desk", "/?mock&app=apex", 1440, 900],
    ["a narrow desk", "/?mock&app=apex", 1100, 760],
    ["a laptop's browser", "/scripts/web-desk.html?thread=apex&theme=dark", 1280, 800],
  ]) {
    await load(path, width, height)
    await until("Boolean(document.querySelector('.composer-box'))", `the composer on ${name}`)
    await notices()
    await until("document.querySelector('[data-composer-notices]')?.dataset.composerNotices === '2'", `the notices on ${name}`)
    await lined(name, ".composer-box", stack)
    // The lip of the one behind stands inside the bar it peeks over, on both sides alike.
    const bar = await edges(stack[0])
    const lip = await edges("[data-notice-peek]")
    assert.equal(lip.left - bar.left, bar.right - lip.right, `the lip is centred on ${name}`)
    await evaluate("document.querySelector('[data-composer-notices]').dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); document.querySelector('[data-composer-notices]').focus?.(); true")
    await evaluate("document.querySelector('[data-composer-notices] button')?.focus(); true")
    await until(`document.querySelector('[data-composer-notices]')?.dataset.expanded === 'true'`, `the list open on ${name}`)
    await lined(`${name}, open`, ".composer-box", [list])
    await capture(`${name.replace(/[^a-z]+/g, "-")}.png`)
    // Each band that can stand there (the goal, a side question, a review, the queue, a plan) keeps to the same edges.
    const rows = await evaluate("document.querySelectorAll('[data-composer] [data-composer-row]').length")
    assert.ok(rows >= 3, `the composer's rows, ${name}: ${rows}`)
    for (let index = 0; index < rows; index += 1) assert.deepEqual(await evaluate(`(() => { const box = document.querySelectorAll('[data-composer] [data-composer-row]')[${index}].getBoundingClientRect(); return { left: box.left, right: box.right } })()`), await edges(".composer-box"), `row ${index} lines up, ${name}`)
  }

  // The phone's dock: what it draws over the box lines up with it too.
  await load("/scripts/phone-apex.html?app=apex&fins=limit", 390, 844, true)
  await until("Boolean(document.querySelector('[data-thread] [data-fin-pips]'))", "the phone's list")
  await evaluate("document.querySelector('[data-thread]').click(); true")
  await until("Boolean(document.querySelector('.composer-box, .web-dock textarea'))", "the phone's composer")
  await until("Boolean(document.querySelector('.web-composer-field'))", "the phone's field")
  const conversation = await evaluate("document.querySelector('[data-conversation]').dataset.conversation")
  await evaluate(`import('/src/web-client/outbox.ts').then(({ keepUnsent }) => { keepUnsent({ id: crypto.randomUUID(), conversation: ${JSON.stringify(conversation)}, text: 'Not sent yet', attachments: [] }); return true })`)
  await until("Boolean(document.querySelector('.web-unsent'))", "the phone's unsent message")
  await lined("on the phone", ".web-composer-field", [".web-unsent"])
  // What's seldom on screen, drawn into the dock as it would be: an ask's card, and the queue's and the tray's rows.
  await evaluate(`(() => {
    const dock = document.querySelector('.web-dock')
    const queue = dock.querySelector('[data-dock-queue]')
    queue.insertAdjacentHTML('beforeend', '<div data-probe=queue style="height:4px"></div>')
    dock.insertAdjacentHTML('afterbegin', '<div class="web-ask" data-probe=ask style="height:4px"></div><div class="rv-tray"><div data-probe=tray style="height:4px;width:100%"></div></div>')
    return true
  })()`)
  await lined("on the phone", ".web-composer-field", ["[data-probe=queue]", "[data-probe=ask]", "[data-probe=tray]"])
  await capture("phone.png")
  await load("/scripts/phone-apex.html?app=apex&fins=limit", 820, 1180, true)
  await until("Boolean(document.querySelector('[data-thread] [data-fin-pips]'))", "the iPad's list")
  await evaluate("document.querySelector('[data-thread]').click(); true")
  await until("Boolean(document.querySelector('.web-composer-field'))", "the iPad's field")
  await evaluate(`(() => {
    const dock = document.querySelector('.web-dock')
    dock.querySelector('[data-dock-queue]').insertAdjacentHTML('beforeend', '<div data-probe=queue style="height:4px"></div>')
    dock.insertAdjacentHTML('afterbegin', '<div class="web-ask" data-probe=ask style="height:4px"></div>')
    return true
  })()`)
  await lined("on an iPad", ".web-composer-field", ["[data-probe=queue]", "[data-probe=ask]"])

  guard.done()
  console.log("Composer edges: every notice lines up with the box, on the desk, in the browser, on the phone and on an iPad")
  app.exit(0)
}
