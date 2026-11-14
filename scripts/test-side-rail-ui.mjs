import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * The right rail and the tab model on the mock bridge's Apex (`?mock&app=apex`), the web desk and the phone. The rail
 * is the left rail's twin: the same tone and row, a row a surface in a fixed order with its reading, needs-you in the
 * attention hue, arrows between rows, Agents offered only with someone to show. Changes is a list and a diff opens as
 * a tab; a Fin has no tab until it's opened, then one, and giving it up leaves none. In a laptop's browser the rail is
 * Changes and Files the same way, past the shell's gutter with no line, and the phone draws no chip per Fin.
 * Screenshots land in the printed directory. `--url <base>` uses a running Vite server instead of starting one.
 */

if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const given = process.argv.indexOf("--url")
  const root = testScratch("mako-side-rail-ui-")
  let server
  let base = given > 0 ? process.argv[given + 1] : undefined
  if (!base) {
    const { uiVite } = await import("./lib/ui-vite.mjs")
    server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await server.listen()
    base = server.resolvedUrls.local[0]
  }
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-side-rail-ui", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: base }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code, signal) => done(electronExit("The right rail UI check", code, signal)))
    })
  } finally {
    await server?.close()
  }
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL.replace(/\/$/, "")
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } })
  const page = window.webContents
  const guard = guardElectronCheck({ app, page, name: "The right rail UI check", ms: 240_000 })
  page.debugger.attach("1.3")
  /** The viewport drawn at, whatever the screen: a runner's 1024 px one clamps the window, and there the rail covers the chat. A page first: emulating a window that has drawn nothing crashes. */
  const viewport = async (width, height) => {
    await window.loadURL("about:blank")
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false })
  }
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
  const load = async (path) => {
    await window.loadURL(`${base}${path}`).catch((error) => {
      if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error
    })
  }
  const capture = async (name) => {
    await evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))")
    await writeFile(join(root, name), (await page.capturePage()).toPNG())
  }
  const seen = (selector) => until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, selector)
  const click = async (selector) => {
    await seen(selector)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`)
  }
  const press = async (selector) => {
    await seen(selector)
    await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 1 })); node.click(); return true })()`)
  }
  const rowIds = () => evaluate("[...document.querySelectorAll('[data-side-rail] [data-surface-id]')].map((row) => row.dataset.surfaceId)")
  const selectedRow = () => evaluate("document.querySelector('[data-side-rail] [aria-selected=true]')?.dataset.surfaceId")

  // The Apex, its twelve Fins, and the rail as a first boot opens it.
  await viewport(1440, 900)
  await load("/?mock&app=apex")
  await until("document.querySelectorAll('.thread-jump-scope [data-asking-fin]').length === 2", "the Apex in the rail")
  await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.querySelector('[data-fin-pips]')).click(); true")
  await until("Boolean(document.querySelector('[data-crew]'))", "the crew card")
  await until("Boolean(document.querySelector('[data-side-rail]'))", "the right rail")

  // The composer on screen marks words written into it as taken, so Setup's "Add to setup" counts only a real draft.
  await until("Boolean(document.querySelector('[data-composer] textarea'))", "the composer")
  assert.equal(await evaluate("window.dispatchEvent(new CustomEvent('mako:compose', { detail: { text: '' }, cancelable: true }))"), false, "the composer took the words")

  // A row a surface, in their order, with Agents' Fins there to show.
  assert.deepEqual(await rowIds(), ["changes", "files", "control", "agents", "setup"], "the surfaces, in their fixed order")
  assert.equal(await evaluate("document.querySelector('[data-side-rail]').getAttribute('aria-orientation')"), "vertical")
  assert.equal(await selectedRow(), "changes", "the rail opens on Changes")

  // The twin: the same tone as the left rail, the same row.
  const twin = await evaluate(`(() => {
    const left = document.querySelector('[data-rail-top-row="inbox"]')
    const right = document.querySelector('[data-surface-id="files"]')
    const style = (node) => { const each = getComputedStyle(node); return { height: node.getBoundingClientRect().height, font: each.fontSize, color: each.color, padding: each.paddingLeft } }
    const shell = (node) => { while (node && getComputedStyle(node).backgroundColor === 'rgba(0, 0, 0, 0)') node = node.parentElement; return getComputedStyle(node).backgroundColor }
    return { left: style(left), right: style(right), leftTone: shell(left), rightTone: shell(right), panel: getComputedStyle(document.querySelector('.companion-panel')).backgroundColor }
  })()`)
  assert.deepEqual(twin.right, twin.left, "a rail row is the left rail's row")
  assert.equal(twin.rightTone, twin.leftTone, "both rails sit on the shell")
  assert.equal(twin.panel, twin.leftTone, "the panel is the shell, not a surface")
  await capture("desk-changes.png")
  // The left rail's rows are the same component, and still do what they say.
  const inbox = `document.querySelector('[data-rail-top-row="inbox"]')`
  await click('[data-rail-top-row="inbox"]')
  await until(`${inbox}.dataset.open === 'true'`, "the Inbox from its row")
  await click('[data-rail-top-row="inbox"]')
  await until(`!${inbox}.dataset.open`, "the Inbox away")

  // Readings: lines changed on Changes, who needs the person on Agents, in the hue that means it.
  assert.match(await evaluate("document.querySelector('[data-surface-id=changes]').innerText"), /\+141\s+−246/)
  const agents = await evaluate(`(() => {
    const row = document.querySelector('[data-surface-id=agents]')
    const needs = [...row.querySelectorAll('span')].find((node) => node.textContent === '2 need you')
    const probe = document.createElement('span')
    probe.className = 'text-attention'
    document.body.append(probe)
    const attention = getComputedStyle(probe).color
    probe.remove()
    return { color: needs && getComputedStyle(needs).color, attention }
  })()`)
  assert.equal(agents.color, agents.attention, "needs you reads in the attention hue")

  // Changes is a list; a file's diff opens as a tab, which is what a tab is for.
  await until("Boolean(document.querySelector('[data-change-list]'))", "the list of changed files")
  assert.equal(await evaluate("Boolean(document.querySelector('[data-review-stream]'))"), false, "no stream of diffs in the rail")
  await evaluate("[...document.querySelectorAll('[data-change-row] button')].find((node) => /store\\.ts/.test(node.textContent)).click(); true")
  const diffTab = "[...document.querySelectorAll('[data-tab-id]')].some((tab) => /store\\.ts/.test(tab.textContent))"
  await until(diffTab, "the diff's tab")
  await capture("desk-diff-tab.png")
  await click("button[aria-label='Close src/state/store.ts']")
  await until(`!(${diffTab})`, "the diff's tab closed")

  // Arrows walk the rows and open what they land on.
  await evaluate("document.querySelector('[data-surface-id=changes]').focus(); true")
  const key = (name) => evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true })); true`)
  await key("ArrowDown")
  await until("document.querySelector('[data-side-rail] [aria-selected=true]')?.dataset.surfaceId === 'files'", "Files by the arrow")
  assert.equal(await evaluate("document.activeElement.dataset.surfaceId"), "files", "focus went with it")
  await key("End")
  await until("document.querySelector('[data-side-rail] [aria-selected=true]')?.dataset.surfaceId === 'setup'", "Setup by End")
  await until("Boolean(document.querySelector('[data-setup-panel]'))", "the Setup panel")
  await key("ArrowUp")
  await until("document.querySelector('[data-side-rail] [aria-selected=true]')?.dataset.surfaceId === 'agents'", "Agents by the arrow up")
  await until("Boolean(document.querySelector('[data-apex-fins]'))", "the Agents panel")
  await capture("desk-agents.png")
  await key("ArrowDown")
  await until("document.querySelector('[data-side-rail] [aria-selected=true]')?.dataset.surfaceId === 'setup'", "Setup again")
  await key("ArrowDown")
  await until("document.querySelector('[data-side-rail] [aria-selected=true]')?.dataset.surfaceId === 'changes'", "the arrows wrapping to Changes")

  // No tab for a Fin until it's opened, however many there are or spawn.
  const fins = () => evaluate("document.querySelectorAll('[data-child-tab]').length")
  assert.equal(await fins(), 0, "twelve Fins, no tab")
  assert.equal(await evaluate("Boolean(document.querySelector('[data-apex-count]'))"), false, "and no count in the strip")
  const roster = await evaluate("JSON.parse(JSON.stringify(window.apexScene.children()))")
  const spawned = { ...roster[0], nativeId: "spawned", title: "A new Fin", child: { ...roster[0].child, thread: "spawned-thread" } }
  await evaluate(`window.apexScene.setChildren(${JSON.stringify([...roster, spawned])}); true`)
  await until("document.querySelector('.thread-jump-scope [data-fin-pips]').getAttribute('aria-label').startsWith('13 Fins')", "the new Fin in the roster")
  assert.equal(await fins(), 0, "a Fin spawning opens no tab")
  await evaluate(`window.apexScene.setChildren(${JSON.stringify(roster)}); true`)
  const needing = roster.find((agent) => agent.title === "Sheet motion on iPad").child.thread
  await click(`[data-crew-row="${needing}"] button`)
  await until(`Boolean(document.querySelector('[data-child-tab="${needing}"][aria-selected="true"]'))`, "the opened Fin's tab")
  assert.equal(await fins(), 1, "the Fin opened has the one tab")
  await until("/need you|needs you/.test(document.querySelector('[data-surface-id=agents]')?.innerText ?? '')", "Agents keeping the Apex's Fins while one is open")
  await capture("desk-fin-tab.png")
  await click("button[aria-label='Close Sheet motion on iPad']")
  await until("!document.querySelector('[data-child-tab]') && !document.querySelector('[data-child-breadcrumb]')", "the Apex after closing its Fin's tab")

  // A window of 1100 keeps the rail beside the chat: both drawn, neither covering the other.
  await viewport(1100, 760)
  await load("/?mock&app=apex")
  await until("document.querySelectorAll('.thread-jump-scope [data-asking-fin]').length === 2", "the Apex at 1100")
  await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.querySelector('[data-fin-pips]')).click(); true")
  await until("Boolean(document.querySelector('[data-crew]')) && Boolean(document.querySelector('[data-side-rail]'))", "the crew card and the rail at 1100")
  const narrow = await evaluate(`(() => {
    const rail = document.querySelector('.companion-panel').getBoundingClientRect()
    const composer = document.querySelector('[data-composer]').getBoundingClientRect()
    return { rail: rail.width, chat: composer.width, beside: composer.right <= rail.left, covered: [...document.querySelectorAll('button')].some((node) => node.textContent.trim() === 'Workbench') }
  })()`)
  assert.ok(narrow.chat >= 400, `the chat stays on screen: ${JSON.stringify(narrow)}`)
  assert.equal(narrow.beside, true, `the chat stands left of the rail: ${JSON.stringify(narrow)}`)
  assert.equal(narrow.covered, false, "nothing to get back from")
  assert.ok(narrow.rail >= 340, `the rail keeps its least: ${narrow.rail}`)
  const overrun = await evaluate(`[...document.querySelectorAll('button[data-crew-row]')].filter((row) => [...row.querySelectorAll('[data-fin-moved], .truncate')].some((each) => each.getBoundingClientRect().right > row.children[1].getBoundingClientRect().right + 1)).map((row) => row.innerText)`)
  assert.deepEqual(overrun, [], "a crew line stops short of its time in the narrower chat")
  await capture("desk-1100.png")
  await viewport(1440, 900)
  await load("/?mock&app=apex")
  await until("document.querySelectorAll('.thread-jump-scope [data-asking-fin]').length === 2", "the Apex again")

  // A Thread with no Fins and nothing alongside has no Agents row.
  await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.innerText.includes('Refactor the composer')).click(); true")
  await until("!document.querySelector('[data-crew]')", "the plain Thread")
  await until("Boolean(document.querySelector('button[aria-label=\"Show the right sidebar\"], [data-side-rail]'))", "the title bar")
  if (!(await evaluate("Boolean(document.querySelector('[data-side-rail]'))"))) await click("button[aria-label='Show the right sidebar']")
  await until("Boolean(document.querySelector('[data-side-rail]'))", "the rail on the plain Thread")
  // Nor Setup: with no live conversation here, there's no place to read it from.
  assert.deepEqual(await rowIds(), ["changes", "files", "control"], "nobody to show, no Agents row")

  // A laptop's browser's Settings draws, Devices and each project's Setup in it, and Setup opens in the pane.
  await load("/scripts/web-desk.html?settings&theme=dark")
  await until("document.querySelectorAll('[data-setup-project]').length > 0", "Settings in the laptop browser, with Setup")
  assert.ok(await evaluate("document.querySelector('main').innerText.includes('Devices')"), "and Devices")
  await press("[data-setup-project]")
  await until("Boolean(document.querySelector('[data-setup-page], [data-setup-failed]'))", "a project's Setup in the pane")

  // A laptop's browser: Changes and Files, the same rows, the two taking turns, no line beside them.
  await load("/scripts/web-desk.html?thread=apex&theme=dark")
  await until("document.querySelectorAll('[data-thread-row]').length > 0", "the web desk")
  await click("button[aria-label='Show the right sidebar']:not(:disabled)")
  await until("Boolean(document.querySelector('[data-side-rail]'))", "the web's right rail")
  assert.deepEqual(await rowIds(), ["changes", "files", "agents", "setup"], "the desk's rows")
  assert.equal(await evaluate("document.querySelector('[data-surface-id=changes]').dataset.open"), "true", "the rail opens on Changes")
  assert.equal(await evaluate("Math.round(document.querySelector('.rv-layer').getBoundingClientRect().width)"), 420, "the desk's width")
  assert.equal(await evaluate("Boolean([...document.querySelectorAll('[data-surface-id=agents] span')].find((node) => node.textContent === '2 need you'))"), true, "and its reading")
  await press("[data-side-rail] [data-surface-id=agents]")
  await until("document.querySelector('[data-surface-id=agents]')?.dataset.open === 'true' && Boolean(document.querySelector('.rv-layer [data-apex-fins]'))", "the Apex's Fins in the rail")
  await capture("web-agents.png")
  await press("[data-side-rail] [data-surface-id=changes]")
  await until("document.querySelector('[data-surface-id=changes]')?.dataset.open === 'true'", "Changes from its row")
  assert.equal(await evaluate("document.querySelectorAll('.rv-layer').length"), 1, "the three take turns")
  await press("[data-side-rail] [data-surface-id=agents]")
  await until("Boolean(document.querySelector('.rv-layer [data-apex-fins]'))", "Agents again")
  await click("button[aria-label='Hide the right sidebar']")
  await until("!document.querySelector('[data-side-rail]')", "the rail away")
  // The composer's chip, which the browser's stage never drew an answer to, opens Agents here.
  await click("[data-agents-toggle]")
  await until("Boolean(document.querySelector('.rv-layer [data-apex-fins]'))", "Agents from the composer's chip")
  await press("[data-side-rail] [data-surface-id=changes]")
  await until("document.querySelector('[data-surface-id=changes]')?.dataset.open === 'true'", "Changes again")
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.rv-layer')).borderLeftWidth"), "0px", "no line in the chrome")
  await press("[data-side-rail] [data-surface-id=files]")
  await until("document.querySelector('[data-surface-id=files]')?.dataset.open === 'true'", "Files from its row")
  assert.equal(await evaluate("document.querySelectorAll('.rv-layer').length"), 1, "the two take turns")
  await press("[data-side-rail] [data-surface-id=setup]")
  await until("document.querySelector('[data-surface-id=setup]')?.dataset.open === 'true' && Boolean(document.querySelector('.rv-layer[data-setup-layer]'))", "Setup from its row")
  assert.equal(await evaluate("document.querySelectorAll('.rv-layer').length"), 1, "Setup takes its turn too")
  await press("[data-side-rail] [data-surface-id=files]")
  await until("document.querySelector('[data-surface-id=files]')?.dataset.open === 'true' && !document.querySelector('[data-setup-layer]')", "Files again, Setup gone")
  await capture("web-files.png")
  await click("button[aria-label='Hide the right sidebar']")
  await until("!document.querySelector('[data-side-rail]')", "the rail away")
  // A crew row opens its Fin there too, with its one tab; closing it is the Apex again.
  await click(`[data-crew-row="${needing}"] button`)
  await until(`Boolean(document.querySelector('[data-child-of] [data-child-tab="${needing}"][aria-selected="true"]'))`, "the Fin's tab in the browser")
  await click("button[aria-label='Close Sheet motion on iPad']")
  await until("!document.querySelector('[data-child-tab]') && Boolean(document.querySelector('[data-crew]'))", "the Apex in the browser again")
  // So does selecting the Apex's own Session, the one it was already on, as the desktop's tab does.
  const apexSelected = "!document.querySelector('[data-child-of]') && !document.querySelector('[data-child-tab]') && [...document.querySelectorAll('[data-session-tab]')].some((tab) => tab.getAttribute('aria-selected') === 'true')"
  await click(`[data-crew-row="${needing}"] button`)
  await until("Boolean(document.querySelector('[data-child-of] [data-child-tab]'))", "the Fin's tab again")
  await press("[data-session-tab]")
  await until(apexSelected, "the Apex's Session tab leaving the Fin")
  // And its row in the left rail, which opens the same Thread.
  await click(`[data-crew-row="${needing}"] button`)
  await until("Boolean(document.querySelector('[data-child-of] [data-child-tab]'))", "the Fin's tab once more")
  await evaluate("[...document.querySelectorAll('[data-thread-row]')].find((row) => row.textContent.includes('Mobile polish')).click(); true")
  await until(apexSelected, "the Apex's rail row leaving the Fin")

  // A Fin opened from Agents on a fresh page: back in Agents, the roster is still the Apex's, not the Fin's own.
  await load("/scripts/web-desk.html?thread=apex&theme=dark")
  await until("document.querySelectorAll('[data-thread-row]').length > 0", "the web desk again")
  await click("button[aria-label='Show the right sidebar']:not(:disabled)")
  await press("[data-side-rail] [data-surface-id=agents]")
  await seen(`.rv-layer [data-child-row="${needing}"]`)
  await click(`.rv-layer [data-child-row="${needing}"]`)
  await until(`Boolean(document.querySelector('[data-child-of] [data-child-tab="${needing}"]'))`, "the Fin from Agents")
  await click("button[aria-label='Hide the right sidebar']")
  await until("!document.querySelector('[data-side-rail]')", "the rail away with the Fin open")
  await click("button[aria-label='Show the right sidebar']:not(:disabled)")
  await press("[data-side-rail] [data-surface-id=agents]")
  await until("document.querySelector('.rv-layer [data-apex-fins]')?.dataset.apexFins === '12'", "the Apex's twelve Fins with one of them open")
  await click("button[aria-label='Close Sheet motion on iPad']")
  await until("!document.querySelector('[data-child-tab]')", "the Apex again")

  // Changes and Files opened with their code out of reach (offline before the service worker kept it): each says so,
  // with Retry, never an empty layer. Back online it reads again by itself, and where the browser won't fetch a module
  // it failed once (this Chromium keeps the failure; Safari can leave it pending) it offers Reload, which brings it.
  await page.debugger.sendCommand("Network.enable")
  const unreachable = async (pattern, what, open) => {
    await page.debugger.sendCommand("Network.setBlockedURLs", { urls: [pattern] })
    await load("/scripts/web-desk.html?thread=apex&theme=dark")
    await until("document.querySelectorAll('[data-thread-row]').length > 0", `the web desk, ${what}'s code out of reach`)
    await open()
    await until(`document.querySelector('.rv-layer [data-code-unavailable]')?.innerText.includes(${JSON.stringify(`${what} couldn't load`)})`, `${what} saying it couldn't load`)
    assert.ok(await evaluate("Boolean([...document.querySelectorAll('.rv-layer [data-code-unavailable] button')].find((button) => button.textContent === 'Retry'))"), `${what}'s Retry`)
    await capture(`web-${what.toLowerCase()}-unavailable.png`)
    await page.debugger.sendCommand("Network.setBlockedURLs", { urls: [] })
    await evaluate("window.dispatchEvent(new Event('online')); true")
    const drawn = "Boolean(document.querySelector('.rv-layer [data-side-rail]')) && !document.querySelector('[data-code-unavailable]')"
    await until(`(${drawn}) || Boolean(document.querySelector('[data-code-unavailable=stuck]'))`, `${what} back online, or offering Reload`)
    if (await evaluate("Boolean(document.querySelector('[data-code-unavailable=stuck]'))")) {
      assert.ok(await evaluate("Boolean([...document.querySelectorAll('[data-code-unavailable] button')].find((button) => button.textContent === 'Reload'))"), `${what}'s Reload`)
      await capture(`web-${what.toLowerCase()}-reload.png`)
      await evaluate("[...document.querySelectorAll('[data-code-unavailable] button')].find((button) => button.textContent === 'Reload').click(); true")
      await until("!document.querySelector('[data-code-unavailable]') && document.querySelectorAll('[data-thread-row]').length > 0", `the web desk reloaded for ${what}`)
      await open()
    }
    await until(drawn, `${what} drawn`)
  }
  await unreachable("*desk-review*", "Changes", () => click("button[aria-label='Show the right sidebar']:not(:disabled)"))
  await unreachable("*files-screen*", "Files", async () => {
    await click("button[aria-label='Show the right sidebar']:not(:disabled)")
    await press("[data-side-rail] [data-surface-id=files]")
  })
  await click("button[aria-label='Hide the right sidebar']")

  // The phone: the crew card holds the Fins, the bar counts them, and no chip repeats one.
  await viewport(390, 844)
  await load("/scripts/phone-apex.html?app=apex")
  await until("Boolean(document.querySelector('[data-thread] [data-fin-pips]'))", "the phone's list")
  await click("[data-thread]")
  await until("Boolean(document.querySelector('[data-crew]'))", "the crew card on the phone")
  assert.equal(await evaluate("document.querySelector('[data-apex-count]')?.dataset.apexCount"), "12")
  assert.equal(await evaluate("document.querySelectorAll('[data-child-chip], [data-child-chips]').length"), 0, "no chip a Fin")
  await capture("phone.png")
  // With the chips gone the card is the way in: a tap on a row opens that Fin, its back naming the Apex.
  await click(`[data-crew-row="${needing}"] button`)
  await until("Boolean(document.querySelector('[data-child-of]'))", "the Fin from the crew card")

  console.log("Right rail UI: the twin's rows and tone, readings, list-first Changes, arrows, a Fin's one tab, the web's rail, Changes and Files out of reach, and the phone passed")
  guard.done()
  app.exit(0)
}
