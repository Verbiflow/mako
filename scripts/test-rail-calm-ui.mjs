import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"
import { HANDLE_ALPHABET, HANDLE_LENGTH, threadCode } from "@mako/host/contracts/thread-handles"

/**
 * The calm rail against the production components and the fixture desk: quiet top rows with the Inbox's one count and
 * Setup hidden until asked for, project avatars (a GitHub owner's picture or a monogram) and the Projects header's
 * controls only under the pointer, a row that is its fin, title and time with Archive and ⋯ under the pointer, the
 * Thread menu's Mark as unread and Status kept in the Thread store, a Done Thread folding into "N done", ⌘ held
 * showing ⌘1–9 and ⌘2 opening the second row, ⌘/⇧-click picking rows with the selection bar's Archive and Esc,
 * dragging a project (the others still ordering as worked in), a project with no row waiting behind "N more folders",
 * Customize sidebar, "N to resolve" with its lines, Finish setting up, an Apex's Fins folded
 * and open with ←/→, and a Thread's handle: in its row's tip, its menu's Copy handle, a Session tab's tooltip, and typed
 * after `@`. Screenshots stay in the printed directory; `--port` serves the page on that port.
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

  // 2. Projects: an avatar each, the GitHub owner's only where no other project here is that owner's (the fixture's
  // mako and api are one owner's, its site another's); the header's controls under the pointer only.
  await until(`document.querySelector('[data-project-avatar="github"] img') !== null`, "the GitHub owner's avatar")
  const avatars = await evaluate(`[...document.querySelectorAll('.thread-jump-scope [data-folder-toggle]')].map((toggle) => { const avatar = toggle.querySelector('[data-project-avatar]'); return { name: toggle.querySelector('.rail-fade')?.textContent.trim(), kind: avatar?.dataset.projectAvatar, text: avatar?.textContent, size: avatar?.getBoundingClientRect().width } }).filter((each) => each.kind)`)
  const avatarOf = (name) => avatars.find((avatar) => avatar.name === name)
  assert.equal(avatarOf("site")?.kind, "github", `a project alone under its owner wears the owner's picture: ${JSON.stringify(avatars)}`)
  assert.deepEqual([avatarOf("mako"), avatarOf("api")].map((avatar) => [avatar?.kind, avatar?.text]), [["monogram", "M"], ["monogram", "A"]], `two projects of one owner are told apart by their own letters: ${JSON.stringify(avatars)}`)
  assert.ok(avatars.every((avatar) => avatar.size === 16), "avatars are 16 px")
  // A square is a project's alone, and its Threads sit a step in from it: the list's two shapes and two columns are its two kinds of row.
  const columns = await evaluate(`(() => { const left = (node) => Math.round(node.getBoundingClientRect().left); const projects = [...document.querySelectorAll('.thread-jump-scope [data-folder-toggle] [data-project-avatar]')].map(left); const threads = [...document.querySelectorAll('.thread-jump-scope [data-thread-row][data-thread-indent]')].map((row) => left(row.firstElementChild)); return { projects: [...new Set(projects)], threads: [...new Set(threads)], squares: document.querySelectorAll('.thread-jump-scope [data-thread-row] .rail-avatar, .thread-jump-scope [data-fin-row] .rail-avatar').length } })()`)
  assert.equal(columns.projects.length, 1, `projects share one column: ${JSON.stringify(columns)}`)
  assert.ok(columns.threads.length >= 1 && columns.threads.every((x) => x >= columns.projects[0] + 10), `a Thread's mark starts right of its project's: ${JSON.stringify(columns)}`)
  assert.equal(columns.squares, 0, "no Thread or Fin wears a square")
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

  // 4b. A Thread's handle: never drawn on its row, last but for its worktree in the row's tip, and copied from its menu.
  await until(`document.querySelector('[role="menu"]') === null`, "the menu closed")
  const handled = await evaluate(`(() => { const row = ${row(1)}; return { thread: row.dataset.threadId, handle: row.dataset.threadHandle, tip: row.dataset.tip.split('\\n'), drawn: row.textContent } })()`)
  assert.match(handled.handle ?? "", new RegExp(`^[a-z0-9]+(?:-[a-z0-9]+)*-[${HANDLE_ALPHABET}]{${HANDLE_LENGTH}}$`), `a word, a hyphen and four characters: ${handled.handle}`)
  assert.equal(handled.handle.slice(-HANDLE_LENGTH), threadCode(handled.thread).slice(0, HANDLE_LENGTH), "the start of its Thread's code, as the host works it out")
  assert.ok(handled.tip.includes(handled.handle), `its tip says it on a line of its own: ${JSON.stringify(handled.tip)}`)
  assert.ok(!handled.drawn.includes(handled.handle), "the row itself draws no handle")
  await move(900, 500)
  await pause(350)
  await hover(row(1))
  await until(`document.querySelector('[data-rail-tip]')?.textContent.includes(${JSON.stringify(handled.handle)})`, "the handle in the row's tip")
  await capture("calm-handle-tip.png")
  // What the menu copies is kept from the person's own clipboard.
  await evaluate(`(() => { window.__copied = []; navigator.clipboard.writeText = async (text) => { window.__copied.push(text) }; return true })()`)
  await click(`(${row(1)}.querySelector('[aria-label^="Actions for"]'))`)
  await until(`document.querySelector('[data-thread-action="copy-handle"]') !== null`, "the menu's Copy handle")
  assert.equal(await evaluate(`document.querySelector('[data-thread-action="copy-handle"]').textContent`), `Copy handle${handled.handle}`, "it names what it copies")
  await capture("calm-copy-handle.png")
  await click('[data-thread-action="copy-handle"]')
  await until(`window.__copied.length === 1`, "the handle copied")
  assert.deepEqual(await evaluate("window.__copied"), [handled.handle])
  await until(`[...document.querySelectorAll('[data-sonner-toast]')].some((toast) => toast.textContent.includes('Handle copied'))`, "the toast that says so")
  console.log("PASS: a Thread's handle in its row's tip and Copy handle in its menu")

  // 4c. Typed after `@` in the composer, a handle finds its Thread, and picking it writes the token any mention of it does.
  const title = await evaluate(`${row(1)}.querySelector('[data-row-title]').textContent`)
  await click("main textarea")
  await page.debugger.sendCommand("Input.insertText", { text: `@${handled.handle}` })
  await until(`document.querySelector('[data-mention-menu="@"] [role=option]') !== null`, "the @ menu")
  const offered = await evaluate(`(() => { const first = document.querySelector('[data-mention-menu="@"] [role=option]'); return { title: first.querySelector('span').textContent, hint: first.title } })()`)
  assert.equal(offered.title, title, `the Thread its handle names leads: ${JSON.stringify(offered)}`)
  assert.ok(offered.hint.endsWith(handled.handle), `and its row says the handle that was typed: ${offered.hint}`)
  await press("Enter", "Enter", 13)
  await until(`document.querySelector('[data-mention-menu]') === null`, "the pick")
  // The composer shows a mention's token as its Thread's title (`draftView`): the handle typed is gone, the mention stands.
  const draft = await evaluate(`document.querySelector('main textarea').value`)
  assert.ok(draft.startsWith(`@${title.slice(0, 12)}`) && !draft.includes(handled.handle), `the draft holds the Thread's mention, not the handle: ${draft}`)
  await press("a", "KeyA", 65, 4)
  await press("Backspace", "Backspace", 8)
  console.log("PASS: a typed handle picks its Thread's mention")

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
  assert.ok(before.length >= 3, "three projects to order")
  const toggle = (key) => `(document.querySelector('.thread-jump-scope [data-project-section=${JSON.stringify(key)}] [data-folder-toggle]'))`
  // Lifts the project `key` and drops it just above `above`.
  const drag = async (key, above, shot) => {
    const from = await point(toggle(key))
    const to = await point(toggle(above))
    await move(from.x, from.y)
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...from })
    for (let step = 1; step <= 10; step += 1) await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, x: from.x, y: Math.round(from.y + ((to.y - 10 - from.y) * step) / 10) })
    await until(`document.querySelector('[data-drag-ghost]') !== null && document.querySelector('[data-drop-line]') !== null`, "the project lifted")
    if (shot) await capture(shot)
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: to.x, y: to.y - 10 })
    await until(`document.querySelector('[data-drag-ghost]') === null`, "dropped")
  }
  const storedOrder = () => evaluate(`import('/src/state/project-order.ts').then(({projectOrderStore}) => [...projectOrderStore.get().order])`)
  const accountOrder = () => evaluate(`window.mako.preferences().then((values) => values['rail.projectOrder'])`)
  await drag(before[1], before[0], "calm-drag.png")
  const after = await movable()
  assert.deepEqual(after, [before[1], before[0], ...before.slice(2)], `dropped first, the rest as they were: ${JSON.stringify(after)}`)
  assert.deepEqual(await storedOrder(), [before[1], ":"], "the order is kept: the project dragged holds the first place, and no other project was placed")
  assert.deepEqual(await accountOrder(), [before[1], ":"], "and follows the account")
  // The projects nobody dragged go on ordering as they are worked in: the last one, worked in now, passes the one above
  // it, and the project dragged keeps its place. The pointer leaves the rail first, which holds every place while inside.
  await move(900, 500)
  await evaluate(`import('/src/state/rail-ranks.ts').then(({railRanksStore}) => railRanksStore.set({ folders: { ...railRanksStore.get().folders, [${JSON.stringify(before[2])}]: new Date(Date.now() + 60_000).toISOString() } }))`)
  await until(`JSON.stringify([...document.querySelectorAll('.thread-jump-scope [data-project-movable]')].map((section) => section.dataset.projectSection)) === ${JSON.stringify(JSON.stringify([before[1], before[2], before[0], ...before.slice(3)]))}`, "a project worked in passes one never dragged, under the one dragged")
  assert.deepEqual(await storedOrder(), [before[1], ":"], "which moves nothing the person placed")
  console.log("PASS: dragging a project reorders it and keeps the order")

  // A project with no row left to draw waits behind "N more folders" instead of taking a row for its header alone;
  // dragged from there to a place, it's the person's to keep listed.
  const quiet = before[2]
  const moreFolders = () => evaluate(`[...document.querySelectorAll('.thread-jump-scope button')].map((button) => button.textContent.trim()).find((text) => /more folders$|^Fewer folders$/.test(text)) ?? null`)
  // The line under the projects, brought clear of what stands over the list's end before it's clicked.
  const clickLine = async (text) => {
    const line = `([...document.querySelectorAll('.thread-jump-scope button')].find((button) => button.textContent.trim() === ${JSON.stringify(text)}))`
    await evaluate(`${line}.scrollIntoView({ block: 'center' })`)
    await frames()
    await click(line)
  }
  assert.equal(await moreFolders(), null, "every project has a row, so none waits")
  const quietThreads = await evaluate(`[...document.querySelectorAll('.thread-jump-scope [data-project-section=${JSON.stringify(quiet)}] [data-thread-row]')].map((row) => row.dataset.threadId)`)
  assert.ok(quietThreads.length > 0 && quietThreads.every(Boolean), `the project's Threads: ${JSON.stringify(quietThreads)}`)
  await evaluate(`import('/src/state/thread-marks.ts').then(({applyThreadMarks}) => applyThreadMarks(${JSON.stringify(quietThreads)}.map((thread) => ({ thread, status: 'done', statusAt: Date.now() - 4 * 24 * 3600_000, by: 'person', unreadAt: null }))))`)
  await until(`!document.querySelector('.thread-jump-scope [data-project-section=${JSON.stringify(quiet)}]')`, "the project whose Threads are all folded as Done left the list")
  assert.equal(await moreFolders(), "1 more folders")
  assert.deepEqual(await movable(), [before[1], before[0], ...before.slice(3)], "and the others closed up")
  await clickLine("1 more folders")
  await until(`document.querySelector('.thread-jump-scope [data-project-section=${JSON.stringify(quiet)}]') !== null`, "it's behind the line")
  assert.deepEqual(await movable(), [before[1], before[0], ...before.slice(3), quiet], "after the projects with something to list")
  await drag(quiet, before[1])
  assert.deepEqual(await storedOrder(), [quiet, before[1], ":"], "dragged first: it and the project placed before it hold their places")
  await move(900, 500)
  await clickLine("Fewer folders")
  await until(`![...document.querySelectorAll('.thread-jump-scope button')].some((button) => button.textContent.trim() === 'Fewer folders')`, "the line folded")
  assert.deepEqual(await movable(), [quiet, before[1], before[0], ...before.slice(3)], "and it stays listed where the person put it, with no row to show")
  assert.equal(await moreFolders(), null)
  console.log("PASS: a project with no row waits behind N more folders, and stays where it's dragged to")

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

  // 12. An Apex: a Thread's fin, folded to the Fins that need the person with their asks; open with →, every Fin in play.
  await load("&app=apex")
  await until(`document.querySelector('[data-apex-row] [data-apex-mark]') !== null`, "the Apex's fin")
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

  // 15. The open Thread's Session tab: its tooltip ends on the Thread's handle, which the tab never draws.
  const tabs = await evaluate(`[...document.querySelectorAll('[data-session-tab]')].map((tab) => ({ handle: tab.dataset.threadHandle, last: tab.title.split('\\n').at(-1), drawn: tab.textContent }))`)
  assert.match(tabs[0]?.handle ?? "", new RegExp(`^[a-z0-9]+(?:-[a-z0-9]+)*-[${HANDLE_ALPHABET}]{${HANDLE_LENGTH}}$`), `a Session's tab knows its Thread's handle: ${JSON.stringify(tabs)}`)
  assert.ok(tabs.every((tab) => tab.handle === tabs[0].handle && tab.last === tab.handle && !tab.drawn.includes(tab.handle)), `every tab says the one handle, last in its tooltip alone: ${JSON.stringify(tabs)}`)
  console.log("PASS: a Session tab's tooltip ends on its Thread's handle")

  console.log(`Calm rail UI checks clean. Screenshots: ${root}`)
  app.exit(0)
}
