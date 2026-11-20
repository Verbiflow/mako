import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * The calm rail against the production components and the fixture desk: quiet top rows with the Inbox's one count and
 * Setup hidden until asked for, project avatars (a GitHub owner's picture or a monogram) and the Projects header's
 * controls only under the pointer, a row that is its fin, title and time with Archive and ⋯ under the pointer, the
 * Thread menu's Mark as unread and Status kept in the Thread store, a Done Thread folding into "N done", ⌘ held
 * showing ⌘1–9 and ⌘2 opening the second row, ⌘/⇧-click picking rows with the selection bar's Archive and Esc,
 * dragging a project, Customize sidebar, "N to resolve" with its lines, Finish setting up, and an Apex's Fins folded
 * and open with ←/→. Screenshots stay in the printed directory; `--port` serves the page on that port.
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const portAt = process.argv.indexOf("--port")
  const port = portAt === -1 ? 0 : Number(process.argv[portAt + 1])
  const root = testScratch("mako-rail-calm-ui-")
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port, strictPort: port !== 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-rail-calm-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolveExit(electronExit("The calm rail UI check", code, signal)))
    })
  } finally {
    await server.close()
  }
}

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const guard = guardElectronCheck({ app, page, name: "The calm rail UI check", ms: 180_000 })
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  const pause = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))
  const capture = async (name) => {
    await evaluate("document.fonts.ready.then(() => true)")
    await frames()
    await writeFile(join(root, name), (await page.capturePage()).toPNG())
  }
  const until = async (code, label = code) => {
    guard.at(label)
    const deadline = Date.now() + 15_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure.png")
        throw new Error(`UI condition timed out: ${label}`)
      }
      await pause(30)
    }
  }
  const move = (x, y) => page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
  const point = async (selector) => evaluate(`(() => { const node = ${selector.startsWith("(") ? selector : `document.querySelector(${JSON.stringify(selector)})`}; if (!node) throw new Error('Missing target ' + ${JSON.stringify(selector)}); const r = node.getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} })()`)
  // Modifiers as CDP counts them: Alt 1, Ctrl 2, Meta 4, Shift 8.
  const click = async (selector, modifiers = 0, button = "left") => {
    const at = await point(selector)
    await move(at.x, at.y)
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button, clickCount: 1, modifiers, ...at })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button, clickCount: 1, modifiers, ...at })
    await frames()
  }
  const hover = async (selector) => {
    const at = await point(selector)
    await move(at.x, at.y)
    await frames()
  }
  const key = (type, key, code, modifiers = 0, keyCode = 0) => page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key, code, modifiers, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode })
  const press = async (keyName, code, keyCode, modifiers = 0) => {
    await key("rawKeyDown", keyName, code, modifiers, keyCode)
    await key("keyUp", keyName, code, modifiers, keyCode)
    await frames()
  }
  const row = (index) => `(document.querySelectorAll('.thread-jump-scope [data-thread-row]')[${index}])`
  const rowKeys = () => evaluate(`[...document.querySelectorAll('.thread-jump-scope [data-thread-row]')].filter((row) => row.offsetParent !== null).map((row) => row.dataset.flipKey)`)
  const load = async (query = "") => {
    await window.loadURL(`${base}?mock${query}`)
    await until(`document.querySelector('[data-rail-threads-heading]') !== null`, `the rail with ${query || "the default desk"}`)
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({railGrouping: 'project', railWidth: 264, theme: 'dark'}))`)
    await until(`document.querySelectorAll('.thread-jump-scope [data-flip-key^="folder:"]').length >= 2`, "projects drawn")
    await move(900, 500)
    await frames()
  }

  await load()

  // 1. Top rows: quiet, one count, Setup hidden until asked for; Pull requests and Automations say theirs in tips.
  const top = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-rail-top] [data-rail-top-row]')].map((row) => row.dataset.railTopRow)
    const pulls = document.querySelector('[data-rail-top-row="pulls"]')
    return { rows, pullsCount: pulls?.querySelector('[data-pulls-count]') !== null && pulls?.querySelector('[data-pulls-count]') !== undefined, height: pulls?.getBoundingClientRect().height }
  })()`)
  assert.deepEqual(top.rows, ["session.new", "view.command-palette", "inbox", "pulls", "automations"], "Setup is hidden at first")
  assert.equal(top.pullsCount, false, "Pull requests draws no count")
  assert.equal(Math.round(top.height), 28, "top rows are 28 px")
  console.log("PASS: quiet top rows, Setup hidden, no Pull requests count")

  // 2. Projects: an avatar each, the GitHub owner's where its origin is on GitHub; the header's controls under the pointer only.
  await until(`document.querySelector('[data-project-avatar="github"] img') !== null`, "the GitHub owner's avatar")
  const avatars = await evaluate(`[...document.querySelectorAll('.thread-jump-scope [data-project-avatar]')].map((avatar) => ({ kind: avatar.dataset.projectAvatar, text: avatar.textContent, size: avatar.getBoundingClientRect().width }))`)
  assert.ok(avatars.some((avatar) => avatar.kind === "monogram" && /^[A-Z0-9]$/.test(avatar.text)), `a project off GitHub wears its monogram: ${JSON.stringify(avatars)}`)
  assert.ok(avatars.every((avatar) => avatar.size === 16), "avatars are 16 px")
  const actionsAt = () => evaluate(`getComputedStyle(document.querySelector('[data-rail-header-actions]')).opacity`)
  await move(900, 500)
  await pause(250)
  assert.equal(await actionsAt(), "0", "the header's Filter, + and ⋯ rest out of sight")
  await hover("[data-rail-threads-heading]")
  await pause(250)
  assert.equal(await actionsAt(), "1", "and show with the pointer over the rail")
  const chips = await evaluate(`document.querySelectorAll('.thread-jump-scope [data-folder-activity], .thread-jump-scope [data-thread-purpose] [data-thread-purpose], .thread-jump-scope [data-app-mark]').length`)
  assert.equal(chips, 0, "no project chips, purpose chips or app marks on the rows")
  console.log("PASS: avatars, a GitHub owner's picture, header controls under the pointer only")

  // 3. A row: its fin, its title and its time; under the pointer, Archive and ⋯ in place of the time.
  const rest = await evaluate(`(() => { const row = ${row(1)}; const end = row.querySelector('[data-row-end]'); return { end: getComputedStyle(end).visibility, mark: row.querySelector('[data-live-mark]')?.getBoundingClientRect().width, height: row.getBoundingClientRect().height } })()`)
  assert.equal(rest.end, "visible")
  assert.equal(Math.round(rest.mark), 18, "the fin is 18 px")
  assert.equal(Math.round(rest.height), 28)
  await hover(row(1))
  await pause(200)
  const hovered = await evaluate(`(() => { const row = ${row(1)}; return { end: getComputedStyle(row.querySelector('[data-row-end]')).visibility, archive: getComputedStyle(row.querySelector('[data-row-archive]')).opacity, actions: row.querySelector('[aria-label^="Actions for"]') !== null } })()`)
  assert.deepEqual(hovered, { end: "hidden", archive: "1", actions: true }, "Archive and ⋯ take the trailing slot")
  await capture("calm-hover.png")
  console.log("PASS: a row's anatomy at rest and under the pointer")

  // 4. The Thread menu: Mark as unread and Status, kept in the Thread store.
  const statusRow = await evaluate(`${row(2)}.dataset.flipKey`)
  await click(`(${row(2)}.querySelector('[aria-label^="Actions for"]'))`)
  await until(`document.querySelector('[data-thread-action="status"]') !== null`, "the menu's Status")
  await hover('[data-thread-action="status"]')
  await until(`document.querySelector('[data-work-status-choice="in-review"]') !== null`, "the Status submenu")
  await capture("calm-status-menu.png")
  await click('[data-work-status-choice="in-review"]')
  await until(`document.querySelector('.thread-jump-scope [data-flip-key=${JSON.stringify(statusRow)}]')?.dataset.workStatus === 'in-review'`, "the row's status")
  assert.equal(await evaluate(`document.querySelector('.thread-jump-scope [data-flip-key=${JSON.stringify(statusRow)}] [data-row-end] [data-work-status="in-review"]') !== null`), true, "its glyph in the trailing slot")
  // The status menu has left before the next row's is opened: a click on its fading item is no click on the row.
  await until(`document.querySelector('[role="menu"]') === null`, "the menu closed")
  await move(900, 500)
  await click(`(${row(3)}.querySelector('[aria-label^="Actions for"]'))`)
  await until(`document.querySelector('[data-thread-action="unread"]') !== null`, "Mark as unread")
  const unreadItem = await evaluate(`[...document.querySelectorAll('[data-thread-action="unread"]')].map((item) => item.textContent).join(' | ')`)
  assert.match(unreadItem, /Mark as unread/, `the menu offers Mark as unread: ${unreadItem}`)
  await click('[data-thread-action="unread"]')
  await until(`${row(3)}.dataset.markedUnread === 'true'`, "the row marked unread")
  assert.equal(await evaluate(`${row(3)}.querySelector('[data-live-mark]').dataset.liveMark`), "unread", "it wears the unread sphere")
  console.log("PASS: Status and Mark as unread from the Thread menu")

  // 5. A Thread Done for three days folds into its project's "N done".
  const doneThread = await evaluate(`${row(2)}.dataset.threadId`)
  await evaluate(`import('/src/state/thread-marks.ts').then(({applyThreadMarks}) => applyThreadMarks([{ thread: ${JSON.stringify(doneThread)}, status: 'done', statusAt: Date.now() - 4 * 24 * 3600_000, by: 'person', unreadAt: null }]))`)
  await until(`document.querySelector('.thread-jump-scope [data-folder-done]') !== null && !document.querySelector('.thread-jump-scope [data-flip-key=${JSON.stringify(statusRow)}]')`, "the done Thread folded away")
  await until(`document.querySelector('[role="menu"]') === null`, "no menu open")
  await click('.thread-jump-scope [data-folder-done]')
  await until(`document.querySelector('.thread-jump-scope [data-folder-done]')?.getAttribute('aria-expanded') === 'true'`, "the done line open")
  await until(`document.querySelector('.thread-jump-scope [data-flip-key=${JSON.stringify(statusRow)}]')?.dataset.workStatus === 'done'`, "the done line opens them")
  await click('.thread-jump-scope [data-folder-done]')
  console.log("PASS: Done for three days folds into N done")

  // 6. ⌘ held 200 ms shows ⌘1–9 where the times were; ⌘2 opens the second row.
  // When the keys show is timed in the page, from the key going down: a slow runner's round trips can't blur 200 ms.
  await evaluate(`(() => {
    window.__hints = {}
    window.addEventListener("keydown", (event) => { if (event.key === "Meta") window.__hints.down = performance.now() }, { capture: true, once: true })
    const scope = document.querySelector('.thread-jump-scope')
    new MutationObserver((_, observer) => { if (scope.hasAttribute('data-jump-hints')) { window.__hints.shown = performance.now(); observer.disconnect() } }).observe(scope, { attributes: true, attributeFilter: ['data-jump-hints'] })
    return true
  })()`)
  await key("rawKeyDown", "Meta", "MetaLeft", 4, 91)
  await until(`document.querySelector('.thread-jump-scope[data-jump-hints]') !== null`, "the keys after 200 ms")
  const held = await evaluate("window.__hints.shown - window.__hints.down")
  assert.ok(held >= 195, `not before 200 ms: ${held} ms`)
  await until(`${row(0)}.querySelector('[data-jump-cap]')?.textContent === '⌘1' && getComputedStyle(${row(0)}.querySelector('[data-jump-cap]')).display === 'flex'`, "⌘1 on the first row")
  await capture("calm-cmd-held.png")
  await key("keyUp", "Meta", "MetaLeft", 0, 91)
  await until(`document.querySelector('.thread-jump-scope[data-jump-hints]') === null`, "the keys leave with ⌘")
  const second = (await rowKeys())[1]
  await press("2", "Digit2", 50, 4)
  await until(`document.querySelector('.thread-jump-scope [data-flip-key=${JSON.stringify(second)}]')?.dataset.active === 'true'`, "⌘2 opened the second row")
  console.log("PASS: ⌘ held shows ⌘1–9; ⌘2 opens the second row")

  // 7. ⌘-click and ⇧-click pick rows; the selection bar marks them read, archives them, and Esc lets go.
  const keys = await rowKeys()
  await click(row(0), 4)
  await click(row(2), 8)
  await until(`document.querySelector('[data-selection-bar="3"]') !== null`, "three picked")
  assert.equal(await evaluate(`document.querySelectorAll('.thread-jump-scope [data-picked]').length`), 3)
  await capture("calm-multi-select.png")
  await press("Escape", "Escape", 27)
  await until(`document.querySelector('[data-selection-bar]') === null`, "Esc lets go")
  // Two of the first project's rows, so every project keeps a row to drag by below.
  await click(row(2), 4)
  await click(row(3), 4)
  await until(`document.querySelector('[data-selection-bar="2"]') !== null`, "two picked")
  await click('[data-selection-action="archive"]')
  await until(`!document.querySelector('.thread-jump-scope [data-flip-key=${JSON.stringify(keys[2])}]') && !document.querySelector('.thread-jump-scope [data-flip-key=${JSON.stringify(keys[3])}]')`, "both archived")
  console.log("PASS: ⌘/⇧-click picking, Esc, Archive from the selection bar")

  // 8. A project dragged above the first keeps that order, which follows the account.
  const movable = () => evaluate(`[...document.querySelectorAll('.thread-jump-scope [data-project-movable]')].map((section) => section.dataset.projectSection)`)
  const before = await movable()
  assert.ok(before.length >= 2, "two projects to order")
  const from = await point(`(document.querySelector('.thread-jump-scope [data-project-section=${JSON.stringify(before[1])}] [data-folder-toggle]'))`)
  const to = await point(`(document.querySelector('.thread-jump-scope [data-project-section=${JSON.stringify(before[0])}] [data-folder-toggle]'))`)
  await move(from.x, from.y)
  await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...from })
  for (let step = 1; step <= 10; step += 1) await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, x: from.x, y: Math.round(from.y + ((to.y - 10 - from.y) * step) / 10) })
  await until(`document.querySelector('[data-drag-ghost]') !== null && document.querySelector('[data-drop-line]') !== null`, "the project lifted")
  await capture("calm-drag.png")
  await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: to.x, y: to.y - 10 })
  await until(`document.querySelector('[data-drag-ghost]') === null`, "dropped")
  const after = await movable()
  assert.equal(after[0], before[1], `dropped first: ${JSON.stringify(after)}`)
  assert.deepEqual(await evaluate(`import('/src/state/project-order.ts').then(({projectOrderStore}) => projectOrderStore.get().order.slice(0, 2))`), [before[1], before[0]], "the order is kept")
  assert.deepEqual(await evaluate(`window.mako.preferences().then((values) => values['rail.projectOrder']?.slice(0, 2))`), [before[1], before[0]], "and follows the account")
  console.log("PASS: dragging a project reorders it and keeps the order")

  // 9. Customize sidebar from the Projects header's ⋯: Setup shown on request; a right-click on the top rows opens the same.
  await hover("[data-rail-threads-heading]")
  await click("[data-rail-options]")
  await until(`document.querySelector('[data-customize="setup"]') !== null`, "Customize sidebar")
  await capture("calm-customize.png")
  await click('[data-customize="setup"]')
  await until(`document.querySelector('[data-rail-top-row="setup"]') !== null`, "Setup shown")
  await click('[data-customize="pulls"]')
  await until(`document.querySelector('[data-rail-top-row="pulls"]') === null`, "Pull requests hidden")
  await press("Escape", "Escape", 27)
  await click('[data-rail-top-row="inbox"]', 0, "right")
  await until(`document.querySelector('[data-customize="pulls"]') !== null`, "the same choices from the top rows")
  await click('[data-customize="pulls"]')
  await press("Escape", "Escape", 27)
  console.log("PASS: Customize sidebar")

  // 10. Finish setting up: real steps, folded and opened, put away.
  await until(`document.querySelector('[data-setup-checklist]') !== null`, "the checklist")
  const steps = await evaluate(`[...document.querySelectorAll('[data-setup-step]')].map((step) => step.dataset.setupStep + ':' + (step.dataset.done ?? 'no'))`)
  assert.equal(steps.length, 5, `five steps: ${JSON.stringify(steps)}`)
  assert.ok(steps.includes("project:true"), "a project is open")
  await click('[data-setup-checklist] [aria-expanded]')
  await until(`document.querySelector('[data-setup-checklist="folded"]') !== null`, "folded")
  await hover('[data-setup-checklist]')
  await click('[data-setup-put-away]')
  await until(`document.querySelector('[data-setup-checklist]') === null`, "put away")
  assert.equal(await evaluate(`import('/src/extend/commands.ts').then(({ runCommand }) => runCommand('view.finish-setup'))`), true, "the palette's Finish setting up")
  await until(`document.querySelector('[data-setup-checklist="open"]') !== null`, "brings it back open")
  console.log("PASS: Finish setting up")

  // 11. "N to resolve": the footer's one quiet button, its lines each with their fix.
  await load("&cloud=signed-in&invited&sync=failing")
  await until(`document.querySelector('[data-rail-issues]') !== null`, "N to resolve")
  assert.equal(await evaluate(`[...document.querySelectorAll('[data-sync-rail], [data-mcp-sign-ins]')].filter((line) => line.offsetParent !== null).length`), 0, "no line stands over the footer")
  await click("[data-rail-issues]")
  await until(`document.querySelector('[data-rail-issue-lines] [data-sync-rail]') !== null`, "the sync line in the popover")
  await capture("calm-issues.png")
  await press("Escape", "Escape", 27)
  console.log("PASS: N to resolve opens the footer's lines")

  // 12. An Apex: its avatar, folded to the Fins that need the person with their asks; open with →, every Fin in play.
  await load("&app=apex")
  await until(`document.querySelector('[data-apex-row] [data-apex-avatar]') !== null`, "the Apex's avatar")
  const folded = await evaluate(`({ fins: document.querySelectorAll('[data-fin-row]').length, asking: document.querySelectorAll('[data-asking-fin]').length, line: document.querySelector('[data-asking-line]')?.textContent, branch: document.querySelector('[data-fin-row] .rail-branch') !== null })`)
  assert.ok(folded.asking > 0 && folded.fins === folded.asking, `folded, only the Fins that need you: ${JSON.stringify(folded)}`)
  assert.ok(folded.line && folded.branch, "with their asks, hung on the Apex's line")
  await evaluate(`document.querySelector('[data-apex-row]').focus()`)
  await press("ArrowRight", "ArrowRight", 39)
  await until(`document.querySelector('[data-hung-fins-open]') !== null && document.querySelectorAll('[data-fin-row]').length > ${folded.fins}`, "open: every Fin in play")
  assert.equal(await evaluate(`document.querySelector('[data-apex-row]').dataset.apexOpen`), "true")
  await capture("calm-apex-open.png")
  await press("ArrowLeft", "ArrowLeft", 37)
  await until(`document.querySelectorAll('[data-fin-row]').length === ${folded.fins}`, "← folds it again")
  console.log("PASS: an Apex's Fins folded, opened with →, folded with ←")

  console.log(`Calm rail UI checks clean. Screenshots: ${root}`)
  app.exit(0)
}
