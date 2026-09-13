import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"

/**
 * The rail against the production components and the fixture catalogue:
 * position never carries status, a folder moves only when you work there,
 * the pointer holds the order, rows that move glide, the status board
 * regroups by state in a fixed order, and Archived lives behind the filter.
 * Screenshots of every view, dark and light, stay in the printed directory.
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-rail-ui-"))
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-rail-check", main: fileURLToPath(import.meta.url) }))
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
  const window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const watchdog = setTimeout(() => {
    console.error("Rail UI verification exceeded its 90-second limit")
    app.exit(1)
  }, 90_000)
  page.on("console-message", (details) => {
    if (details.level === "error" || details.level === "warning") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  const capture = async (name) => {
    await evaluate("document.fonts.ready.then(() => true)")
    // Evidence shows rows where they land, not mid-glide.
    await evaluate(`Promise.all([...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].flatMap(node => node.getAnimations()).map(animation => animation.finished.catch(() => {}))).then(() => true)`)
    await frames()
    await writeFile(join(root, name), (await page.capturePage()).toPNG())
    const rail = await evaluate(`(() => { const r = document.querySelector('.thread-jump-scope').getBoundingClientRect(); return {x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height)} })()`)
    await writeFile(join(root, name.replace(".png", "-rail.png")), (await page.capturePage(rail)).toPNG())
  }
  const until = async (code, label = code) => {
    const deadline = Date.now() + 15_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure.png")
        throw new Error(`UI condition timed out: ${label}`)
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
    }
  }
  const move = (x, y) => page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
  const click = async (selector) => {
    const point = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing click target ' + ${JSON.stringify(selector)}); const r = node.getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} })()`)
    await move(point.x, point.y)
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point })
  }
  const folderOrder = () => evaluate(`[...document.querySelectorAll('.thread-jump-scope [data-flip-key^="folder:"]')].map(node => node.dataset.flipKey)`)
  const rowsIn = (folderKey) => evaluate(`[...document.querySelector('.thread-jump-scope [data-flip-key=${JSON.stringify(folderKey)}]').closest('section').querySelectorAll('[data-thread-row]')].map(node => node.dataset.flipKey)`)
  const flipping = (key) => evaluate(`document.querySelector('.thread-jump-scope [data-flip-key=${JSON.stringify(key)}]')?.getAnimations().some(animation => animation.id === 'rail-flip') ?? false`)

  await window.loadURL(`${base}?mock`)
  await until(`document.querySelector('[aria-label="Thread view"]') !== null`)
  await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({railGrouping: 'project', railWidth: 264, theme: 'dark'}))`)
  await until(`document.querySelectorAll('.thread-jump-scope [data-flip-key^="folder:"]').length >= 2`, "folders rendered")
  await move(900, 500)
  await frames()

  // The header fits at the default width: the view switcher never runs under the glyphs.
  const header = await evaluate(`(() => { const view = document.querySelector('[aria-label="Thread view"]').getBoundingClientRect(); const search = document.querySelector('[aria-label="Search threads"]').getBoundingClientRect(); return {viewRight: view.right, searchLeft: search.left, pills: [...document.querySelectorAll('[aria-label="Thread view"] button')].map(b => b.textContent)} })()`)
  assert.deepEqual(header.pills, ["Projects", "Recent", "Status"])
  assert.ok(header.viewRight <= header.searchLeft, `The view switcher must fit beside the glyphs, received ${JSON.stringify(header)}`)
  await capture("rail-projects.png")

  const before = await folderOrder()
  assert.ok(before.length >= 2)
  const lastFolder = before[before.length - 1]
  const [victim] = await rowsIn(lastFolder)
  const victimRef = await evaluate(`import('/src/state/threads.ts').then(({threadsStore}) => threadsStore.get().threads.find(ref => ref.path === ${JSON.stringify(victim)}))`)
  assert.ok(victimRef, "the last folder has a native row")

  // 1. Status changes the mark and the chip, never the place.
  await evaluate(`import('/src/state/threads.ts').then(({setThreadRunning}) => setThreadRunning(${JSON.stringify(victim)}, true))`)
  await until(`document.querySelector('.thread-jump-scope [data-flip-key=${JSON.stringify(lastFolder)}] [data-folder-activity="working"]')?.textContent === '1 running'`, "folder chip shows the run")
  assert.deepEqual(await folderOrder(), before, "a thread starting work must not lift its folder")
  await evaluate(`import('/src/state/threads.ts').then(({applyThreadRun}) => applyThreadRun({path: ${JSON.stringify(victim)}, harness: ${JSON.stringify(victimRef.harness)}, status: 'done'}))`)
  await until(`document.querySelector('.thread-jump-scope [data-flip-key=${JSON.stringify(lastFolder)}] [data-folder-activity="complete"]')?.textContent === '1 to review'`, "folder chip shows the unread reply")
  assert.deepEqual(await folderOrder(), before, "a finished turn must not lift its folder")
  console.log("PASS: working and finished-unread change the chip, not the folder's place")

  // 1b. The unread answer is one fresh mark on its row; a failure is an
  // outcome you acknowledge by opening the thread, and its folder's chip
  // stops reporting it the moment you do.
  const victimRow = `.thread-jump-scope [data-thread-row][data-flip-key=${JSON.stringify(victim)}]`
  await until(`document.querySelector(${JSON.stringify(`${victimRow} .review-dot`)}) !== null`, "the finished row wears the unread mark")
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${victimRow} .review-dot`)}).hasAttribute('data-new')`), true, "an answer that just finished arrives; it is not painted still")
  const dotStyle = await evaluate(`(() => { const s = getComputedStyle(document.querySelector(${JSON.stringify(`${victimRow} .review-dot`)})); return {width: s.width, gradient: s.backgroundImage.startsWith('radial-gradient'), blur: s.boxShadow} })()`)
  assert.equal(dotStyle.width, "7px", `the mark is a 7px sphere, received ${JSON.stringify(dotStyle)}`)
  assert.equal(dotStyle.gradient, true, "the mark is shaded, not flat")
  assert.match(dotStyle.blur, /\b0px 0px 0px 1px\b/, `the mark's ring is spread only, received ${dotStyle.blur}`)
  await capture("rail-unread.png")
  const failFolder = before[0]
  const failing = (await rowsIn(failFolder))[1]
  assert.ok(failing, "the first folder has a second row to fail")
  const failFolderChip = (state) => `document.querySelector('.thread-jump-scope [data-flip-key=${JSON.stringify(failFolder)}] [data-folder-activity="${state}"]')`
  await evaluate(`import('/src/state/threads.ts').then(({applyThreadRun}) => { applyThreadRun({path: ${JSON.stringify(failing)}, harness: ${JSON.stringify(victimRef.harness)}, status: 'running'}); applyThreadRun({path: ${JSON.stringify(failing)}, harness: ${JSON.stringify(victimRef.harness)}, status: 'failed', error: 'The provider exited'}) })`)
  const failingRow = `.thread-jump-scope [data-thread-row][data-flip-key=${JSON.stringify(failing)}]`
  await until(`document.querySelector(${JSON.stringify(`${failingRow} .activity-mark[data-state="failed"]`)}) !== null`, "the failed row wears the failure")
  await until(`${failFolderChip("failed")}?.textContent === '1 failed'`, "the folder chip reports the unseen failure")
  assert.deepEqual(await folderOrder(), before, "a failure must not lift its folder")
  await capture("rail-failed.png")
  await click(failingRow)
  await until(`document.querySelector(${JSON.stringify(`${failingRow} .activity-mark[data-state="failed"]`)}) === null`, "opening the failed thread stands its mark down")
  await until(`${failFolderChip("failed")} === null`, "the folder chip stops reporting a failure you have seen")
  await evaluate(`import('/src/state/threads.ts').then(({threads}) => threads.closeViewer())`)
  await move(900, 500)
  await frames()
  console.log("PASS: the unread mark is fresh once; a failure is acknowledged by opening it")

  // 2. An agent's reply landing in a file does not lift its folder either; the row glides within it.
  const firstFolder = before[0]
  const firstRows = await rowsIn(firstFolder)
  assert.ok(firstRows.length >= 2, "the first folder shows several rows")
  const climber = firstRows[firstRows.length - 1]
  await evaluate(`import('/src/state/threads.ts').then(({threadsStore, applyThreadRef}) => { const ref = threadsStore.get().threads.find(ref => ref.path === ${JSON.stringify(climber)}); applyThreadRef({...ref, updatedAt: new Date(Date.now() + 60_000).toISOString(), bytes: (ref.bytes ?? 0) + 1}) })`)
  await frames()
  assert.equal((await rowsIn(firstFolder))[0], climber, "an idle thread follows its file within the folder")
  assert.equal(await flipping(climber), true, "the row that moved glides to its new place")
  assert.deepEqual(await folderOrder(), before, "a reply in a file must not reorder folders")
  await evaluate(`import('/src/state/threads.ts').then(({threadsStore, applyThreadRef}) => { const ref = threadsStore.get().threads.find(ref => ref.path === ${JSON.stringify(victim)}); applyThreadRef({...ref, updatedAt: new Date(Date.now() + 120_000).toISOString(), bytes: (ref.bytes ?? 0) + 1}) })`)
  await frames()
  assert.deepEqual(await folderOrder(), before, "the newest file in the last folder does not lift it")
  console.log("PASS: files changing never move folders; rows glide")

  // 3. The pointer holds the order; leaving releases it.
  const rowPoint = await evaluate(`(() => { const r = document.querySelector('.thread-jump-scope [data-thread-row]').getBoundingClientRect(); return {x: Math.round(r.x + 30), y: Math.round(r.y + r.height / 2)} })()`)
  await move(rowPoint.x, rowPoint.y)
  await frames()
  const heldRows = await rowsIn(firstFolder)
  const riser = heldRows[heldRows.length - 1]
  await evaluate(`import('/src/state/threads.ts').then(({threadsStore, applyThreadRef}) => { const ref = threadsStore.get().threads.find(ref => ref.path === ${JSON.stringify(riser)}); applyThreadRef({...ref, updatedAt: new Date(Date.now() + 180_000).toISOString(), bytes: (ref.bytes ?? 0) + 1}) })`)
  await frames()
  assert.deepEqual(await rowsIn(firstFolder), heldRows, "nothing changes place while the pointer is in the rail")
  await move(900, 500)
  await until(`[...document.querySelector('.thread-jump-scope [data-flip-key=${JSON.stringify(firstFolder)}]').closest('section').querySelectorAll('[data-thread-row]')][0]?.dataset.flipKey === ${JSON.stringify(riser)}`, "the held order releases when the pointer leaves")
  console.log("PASS: the pointer holds the order and leaving releases it")

  // 3b. A row's full text is the rail's own tip, never a native title:
  // it arrives after a short wait, hands over to the next row at once,
  // stands down over the row's controls, and leaves with the pointer.
  const tipRows = ".thread-jump-scope [data-thread-row][data-tip]"
  const tip = () => evaluate(`document.querySelector('[data-rail-tip]')?.textContent ?? null`)
  const tipText = (index) => evaluate(`document.querySelectorAll(${JSON.stringify(tipRows)})[${index}]?.dataset.tip.replaceAll('\\n', '') ?? null`)
  const tipRowPoint = (index) => evaluate(`(() => { const r = document.querySelectorAll(${JSON.stringify(tipRows)})[${index}].getBoundingClientRect(); return {x: Math.round(r.x + 30), y: Math.round(r.y + r.height / 2)} })()`)
  assert.equal(await evaluate(`document.querySelectorAll('.thread-jump-scope [data-thread-row][title]').length`), 0, "no row carries a native title")
  assert.ok((await evaluate(`document.querySelectorAll(${JSON.stringify(tipRows)}).length`)) >= 2, "rows carry their full text as data-tip")
  await new Promise((resolveWait) => setTimeout(resolveWait, 400))
  const firstTipRow = await tipRowPoint(0)
  await move(firstTipRow.x, firstTipRow.y)
  await frames()
  assert.equal(await tip(), null, "no tip before the wait")
  await until(`document.querySelector('[data-rail-tip]') !== null`, "the tip appears after the wait")
  assert.equal(await tip(), await tipText(0), "the tip carries the row's full text")
  const tipBox = await evaluate(`(() => { const r = document.querySelector('[data-rail-tip]').getBoundingClientRect(); const row = document.querySelector(${JSON.stringify(tipRows)}).getBoundingClientRect(); return {below: r.top >= row.bottom, left: Math.abs(r.left - row.left) < 1, inside: r.right <= window.innerWidth && r.bottom <= window.innerHeight} })()`)
  assert.deepEqual(tipBox, { below: true, left: true, inside: true }, `the tip sits under the row's left edge, received ${JSON.stringify(tipBox)}`)
  await capture("rail-tip.png")
  assert.equal(await tip(), await tipText(0), "the tip stays while the pointer rests on the row")
  const secondTipRow = await tipRowPoint(1)
  await move(secondTipRow.x, secondTipRow.y)
  await frames()
  assert.equal(await tip(), await tipText(1), "the next row's tip shows without a second wait")
  const pinPoint = await evaluate(`(() => { const r = document.querySelectorAll(${JSON.stringify(tipRows)})[1].querySelector('[data-tip-quiet] button').getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} })()`)
  await move(pinPoint.x, pinPoint.y)
  await frames()
  assert.equal(await tip(), null, "the tip stands down over the row's controls")
  await move(secondTipRow.x, secondTipRow.y)
  await frames()
  assert.equal(await tip(), await tipText(1), "and returns when the pointer does")
  await move(900, 500)
  await frames()
  assert.equal(await tip(), null, "the tip leaves with the pointer")
  console.log("PASS: the rail's tip replaces the native title")

  // 4. Only working there lifts a folder.
  await evaluate(`import('/src/state/prefs.ts').then(({noteFolderUse}) => noteFolderUse(${JSON.stringify(victimRef.cwd)}))`)
  await until(`document.querySelector('.thread-jump-scope [data-flip-key^="folder:"]')?.dataset.flipKey === ${JSON.stringify(lastFolder)}`, "your own prompt lifts the folder")
  assert.equal(await flipping(lastFolder), true, "the lifted folder glides up")
  await capture("rail-projects-lifted.png")
  console.log("PASS: a prompt sent in a folder lifts it, with a glide")

  // 5. Recent is the same rows in one list, held the same way.
  await click('[aria-label="Thread view"] button:nth-child(2)')
  await until(`document.querySelector('[aria-label="Thread view"] button[aria-pressed="true"]')?.textContent === 'Recent'`)
  await until(`document.querySelectorAll('.thread-jump-scope [data-thread-row]').length > 0 && document.querySelectorAll('.thread-jump-scope [data-flip-key^="folder:"]').length === 0`)
  await capture("rail-recent.png")

  // 6. The status board: fixed sections, and the one place a thread regroups by state.
  await click('[aria-label="Thread view"] button:nth-child(3)')
  await until(`document.querySelector('[data-board-section]') !== null`, "board sections rendered")
  const sections = await evaluate(`[...document.querySelectorAll('[data-board-section]')].map(node => node.dataset.boardSection)`)
  const order = ["needs-input", "failed", "review", "working", "done"]
  assert.deepEqual(sections, order.filter((key) => sections.includes(key)), "sections keep their fixed order")
  assert.ok(sections.includes("review") && sections.includes("done"), `the unread reply and the idle threads have sections, received ${sections}`)
  assert.equal(await evaluate(`document.querySelector('[data-board-section="review"]').closest('section').querySelector('[data-thread-row]')?.dataset.flipKey`), victim, "the unread thread sits under Ready to review")
  await capture("rail-status.png")
  await evaluate(`import('/src/state/threads.ts').then(({setThreadAttention}) => setThreadAttention(${JSON.stringify(victim)}, {kind: 'needs-permission', since: Date.now(), detail: 'Run npm test?'}))`)
  await until(`document.querySelector('[data-board-section]')?.dataset.boardSection === 'needs-input'`, "Needs input leads the board")
  assert.equal(await evaluate(`document.querySelector('[data-board-section="needs-input"]').closest('section').querySelector('[data-thread-row]')?.dataset.flipKey`), victim)
  assert.equal(await evaluate(`document.body.textContent.includes('Nothing needs you right now')`), false)
  await capture("rail-status-needs-input.png")
  await evaluate(`import('/src/state/threads.ts').then(({setThreadAttention}) => setThreadAttention(${JSON.stringify(victim)}, null))`)
  await until(`document.querySelector('[data-board-section="needs-input"]') === null`)
  assert.equal(await evaluate(`document.body.textContent.includes('Nothing needs you right now')`), true, "a calm board says so")
  await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({theme: 'light'}))`)
  await until(`document.documentElement.classList.contains('light')`)
  await capture("rail-status-light.png")
  await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({theme: 'dark'}))`)
  await until(`!document.documentElement.classList.contains('light')`)
  console.log("PASS: the status board regroups by state in a fixed order")

  // 6. Archived lives behind the filter glyph and names itself while showing.
  await click('[aria-label="Filter and sort"]')
  await until(`[...document.querySelectorAll('[data-slot="popover-content"] button')].some(button => button.textContent.includes('Archived threads'))`)
  await capture("rail-filter.png")
  const archivedButton = await evaluate(`(() => { const buttons = [...document.querySelectorAll('[data-slot="popover-content"] button')]; const index = buttons.findIndex(button => button.textContent.includes('Archived threads')); buttons[index].setAttribute('data-rail-test', 'archived'); return index })()`)
  assert.ok(archivedButton >= 0)
  await click('[data-rail-test="archived"]')
  await until(`[...document.querySelectorAll('[aria-label="Thread view"] button')].map(b => b.textContent).join() === 'Archived'`, "the pressed pill names Archived")
  await click('[aria-label="Thread view"] button')
  await until(`[...document.querySelectorAll('[aria-label="Thread view"] button')].map(b => b.textContent).join() === 'Projects,Recent,Status'`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="Thread view"] button[aria-pressed="true"]').textContent`), "Projects")
  console.log("PASS: Archived is reached from the filter and returns to Projects")

  // 7. Reduced motion: rows still move, nothing glides.
  await page.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] })
  await until(`window.matchMedia('(prefers-reduced-motion: reduce)').matches`)
  const quietRows = await rowsIn(firstFolder)
  const quietRiser = quietRows[quietRows.length - 1]
  await evaluate(`import('/src/state/threads.ts').then(({threadsStore, applyThreadRef}) => { const ref = threadsStore.get().threads.find(ref => ref.path === ${JSON.stringify(quietRiser)}); applyThreadRef({...ref, updatedAt: new Date(Date.now() + 240_000).toISOString(), bytes: (ref.bytes ?? 0) + 1}) })`)
  await frames()
  assert.equal((await rowsIn(firstFolder))[0], quietRiser)
  assert.equal(await flipping(quietRiser), false, "reduced motion moves rows without a glide")
  console.log("PASS: reduced motion is honoured")

  clearTimeout(watchdog)
  console.log("Rail UI checks clean: stable folders, pointer hold, glides, status board, archived filter, reduced motion")
  app.exit(0)
}
