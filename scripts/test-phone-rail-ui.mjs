import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * The phone's and the tablet's list in the desk's rail's anatomy (`src/dev/phone-rail-check.tsx`), by trusted touch at
 * an iPhone's size and an iPad's, dark and light:
 *
 * - Threads group by project under the project's tile and name, the chats last; a phone's rows are 52px, a tablet's 44px.
 * - An Apex's Fins hang under it on the 1px line: folded, only those that need the person, each with its ask; its tile
 *   unfolds every Fin in play and the finished as one line, and folds them again.
 * - A Thread's Status is its glyph at the row's end; a Done one's title fades, and Done past three days folds into its
 *   project's "N done" line, which opens them in place.
 * - A Thread marked unread on another device lists as unread, and opening it asks its owner to read it, once.
 * - Finish setting up heads the phone's list with the steps a phone can know, gone once they're done or put away
 *   (kept across a reload).
 * - Held, a row's menu offers Mark as unread and Status, each sent to the owner as `mako:thread-mark`.
 *
 * Screenshots go to the directory given as the first argument (default: a scratch directory); `--port` serves the page
 * on that port (default: any free one).
 */
if (process.versions.electron) {
  const { app } = await import("electron")
  void checkRail().then(() => app.exit(0)).catch((error) => {
    console.error(error)
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const args = process.argv.slice(2)
  const portAt = args.indexOf("--port")
  const port = portAt === -1 ? 0 : Number(args.splice(portAt, 2)[1])
  const root = testScratch("mako-phone-rail-ui-")
  const evidence = args[0] ? resolve(args[0]) : root
  await mkdir(evidence, { recursive: true })
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port, strictPort: port !== 0, hmr: false } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-phone-rail-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_RAIL_ROOT: root, MAKO_RAIL_EVIDENCE: evidence, MAKO_RAIL_URL: server.resolvedUrls.local[0] }
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
}

/** The mock Apex scene's Thread (`mock-apex-thread.ts`) and its project. */
const APEX_THREAD = "1ead1ead-0000-4000-8000-000000001ead"
const MAKO = "/Users/you/mako"
/** The fixture's Threads (`phone-rail-check.tsx`). */
const thread = (index) => `0000000b-0000-4000-8000-0000000002${String(index).padStart(2, "0")}`
/** A browser with nothing to add to the Home Screen by hand (no Safari), whose own offer hasn't come. */
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36"
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

async function checkRail() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_RAIL_ROOT
  const evidence = process.env.MAKO_RAIL_EVIDENCE
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const watchdog = setTimeout(() => app.exit(1), 240_000)
  const window = new BrowserWindow({ width: 393, height: 852, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  page.on("console-message", (details) => {
    if (details.level === "error" && !/flushSync was called from inside a lifecycle method/.test(details.message)) console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const send = (method, params) => page.debugger.sendCommand(method, params)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  // A hidden window's transitions crawl: each one that ends is taken to its end before a picture, as on screen.
  const capture = async (name) => {
    await page.executeJavaScript("document.getAnimations().forEach((animation) => { if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish() }), true")
    await writeFile(join(evidence, name), (await page.capturePage()).toPNG())
  }
  const until = async (code, label = code, ms = 10_000) => {
    const deadline = Date.now() + ms
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure.png")
        throw new Error(`Timed out: ${label}`)
      }
      await wait(30)
    }
  }
  const q = (selector) => JSON.stringify(selector)
  const pointOf = async (selector) => {
    await evaluate(`document.querySelector(${q(selector)}).scrollIntoView({ block: "center", behavior: "instant" }), true`)
    await wait(250)
    return evaluate(`(() => { const box = document.querySelector(${q(selector)}).getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 } })()`)
  }
  /** A finger down and up on it: a row opens on the lift (`row-gestures.ts`). */
  const tap = async (selector) => {
    const point = await pointOf(selector)
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] })
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  }
  /** Held past half a second: the row's menu. */
  const hold = async (selector) => {
    const point = await pointOf(selector)
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] })
    await wait(750)
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  }
  /** A control's own press (a fold, a menu's choice), as the tap's click lands on it. */
  const press = (selector) => evaluate(`document.querySelector(${q(selector)}).click(), true`)
  const load = async (search, { width, height, scale, agent }) => {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: true })
    await send("Emulation.setUserAgentOverride", { userAgent: agent ?? "" })
    await window.loadURL(`${new URL("scripts/phone-rail.html", process.env.MAKO_RAIL_URL).href}?app=apex&${search}`)
    await until("Boolean(document.querySelector('[data-project-group]'))", `the list (${search})`)
    await evaluate("document.fonts.ready.then(() => true)")
  }
  const calls = () => evaluate("window.phoneRail.calls().filter((call) => call.channel === 'mako:thread-mark').map((call) => ({ thread: call.args[1], change: call.args[2], operation: call.args[0] }))")
  const row = (index) => `[data-thread="${index === "apex" ? APEX_THREAD : thread(index)}"]`

  await window.loadURL("about:blank")
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
  const PHONE = { width: 393, height: 852, scale: 3, agent: IPHONE }
  const IPAD = { width: 1180, height: 820, scale: 2 }
  try {
    // Finish setting up, all done: a browser with no Home Screen to add to, its notifications on. No card.
    await load("push=on", { ...PHONE, agent: ANDROID })
    await evaluate("localStorage.clear(), true")
    await load("push=on", { ...PHONE, agent: ANDROID })
    await wait(200)
    assert.equal(await evaluate("document.querySelector('[data-setup-card]')"), null, "every step done: no Finish setting up")

    for (const theme of ["dark", "light"]) {
      await evaluate("localStorage.clear(), true")
      await load(`theme=${theme}`, PHONE)
      const where = `phone, ${theme}`

      // Groups: the project with one waiting on the person first, each under its tile, the chats last.
      const groups = await evaluate(`[...document.querySelectorAll('[data-project-group]')].map((group) => ({ key: group.dataset.projectGroup, name: group.querySelector('[data-project-name]').textContent, tile: group.querySelector('[data-project-row] [data-project-avatar]')?.textContent ?? null, tileBox: (() => { const box = group.querySelector('[data-project-avatar]')?.getBoundingClientRect(); return box ? [box.width, box.height] : null })(), hue: [...(group.querySelector('[data-project-avatar]')?.classList ?? [])].find((name) => name.startsWith('rail-hue-')) ?? null }))`)
      assert.deepEqual(groups.map((group) => [group.key, group.name, group.tile]), [[MAKO, "mako", "M"], ["/Users/you/api", "api", "A"], ["/Users/you/site", "site", "S"], ["chats", "Chats", null]], `${where}: the projects in order, each with its tile: ${JSON.stringify(groups)}`)
      for (const group of groups.slice(0, 3)) {
        assert.deepEqual(group.tileBox, [20, 20], `${where}: ${group.name}'s tile is 20px square`)
        assert.ok(group.hue, `${where}: ${group.name}'s tile wears a hue`)
      }
      const heights = await evaluate("[...new Set([...document.querySelectorAll('.web-row')].map((node) => Math.round(node.getBoundingClientRect().height)))]")
      assert.deepEqual(heights, [52], `${where}: a phone's rows are 52px: ${heights}`)
      const corners = await evaluate("[...document.querySelectorAll('.web-row, .web-fin-row, .web-project-row, [data-project-avatar], [data-setup-card]')].map((node) => getComputedStyle(node).borderRadius).filter((radius) => radius !== '0px')")
      assert.deepEqual(corners, [], `${where}: every corner square`)

      // The Apex: its tile, its line, and folded only the Fins that need the person, each with its ask.
      await until(`Boolean(document.querySelector('[data-hung-fins="${APEX_THREAD}"] [data-fin-row]'))`, `${where}: the Apex's Fins`)
      const folded = await evaluate(`(() => { const fins = [...document.querySelectorAll('[data-hung-fins="${APEX_THREAD}"] [data-fin-row]')]; return { apex: document.querySelector('${row("apex")}').dataset.apexOpen, tile: Boolean(document.querySelector('${row("apex")} [data-apex-avatar]')), stem: Boolean(document.querySelector('${row("apex")} .web-apex-stem')), fins: fins.length, asking: fins.filter((fin) => fin.dataset.askingFin).length, lines: fins.map((fin) => fin.querySelector('[data-asking-line]')?.textContent ?? ''), branches: fins.map((fin) => fin.querySelector('.rail-branch')?.hasAttribute('data-last') ?? null), counts: document.querySelector('${row("apex")}').dataset.finCounts } })()`)
      assert.equal(folded.apex, "false", `${where}: the Apex starts folded`)
      assert.ok(folded.tile && folded.stem, `${where}: the Apex wears its tile, its line running down from it`)
      assert.ok(folded.fins >= 1 && folded.asking === folded.fins, `${where}: folded, only the Fins that need you hang under it: ${JSON.stringify(folded)}`)
      assert.ok(folded.lines.every((line) => line.length > 0), `${where}: each asking Fin says its ask beside its name: ${folded.lines}`)
      assert.deepEqual(folded.branches, folded.branches.map((_, index) => index === folded.branches.length - 1), `${where}: each Fin hangs on the line, the last on its elbow`)
      assert.match(folded.counts, /Fin/, `${where}: the Apex's row carries its Fins' counts`)
      await press(`${row("apex")} [data-row-fold]`)
      await until(`document.querySelector('${row("apex")}').dataset.apexOpen === 'true'`, `${where}: the Apex unfolds`)
      const open = await evaluate(`({ fins: document.querySelectorAll('[data-hung-fins="${APEX_THREAD}"] [data-fin-row]').length, finished: Number(document.querySelector('[data-hung-fins="${APEX_THREAD}"] [data-fins-finished]')?.dataset.finsFinished ?? 0) })`)
      assert.ok(open.fins > folded.fins, `${where}: unfolded, every Fin in play hangs under it (${open.fins} of ${folded.fins} folded)`)
      assert.ok(open.finished > 0, `${where}: and the finished as one line`)
      await evaluate(`document.querySelector('${row("apex")}').scrollIntoView({ block: 'start' }), document.querySelector('.web-scroll').scrollBy(0, -60), true`)
      await wait(300)
      await capture(`22-phone-apex-${theme}.png`)
      await press(`${row("apex")} [data-row-fold]`)
      await until(`document.querySelector('${row("apex")}').dataset.apexOpen === 'false'`, `${where}: the Apex folds again`)
      await evaluate("document.querySelector('.web-scroll').scrollTo(0, 0), true")

      // Status: each its glyph at the row's end; a Done one faded; Done past three days folded into "2 done".
      const marks = await evaluate(`[1, 7, 8, 4, 10].map((index) => { const node = document.querySelector('[data-thread="0000000b-0000-4000-8000-0000000002' + String(index).padStart(2, '0') + '"]'); return { status: node?.dataset.workStatus, glyph: node?.querySelector('[data-row-end] [data-work-status]')?.dataset.workStatus, title: node?.querySelector('[data-row-title]').className } })`)
      assert.deepEqual(marks.map((mark) => [mark.status, mark.glyph]), [["in-progress", "in-progress"], ["in-review", "in-review"], ["backlog", "backlog"], ["done", "done"], ["done", "done"]], `${where}: each Status its glyph: ${JSON.stringify(marks)}`)
      assert.ok(marks.slice(3).every((mark) => mark.title.includes("text-foreground/45")), `${where}: a Done Thread's title fades`)
      assert.ok(!marks[0].title.includes("/45"), `${where}: one in progress doesn't`)
      assert.equal(await evaluate(`document.querySelector('[data-project-group="${MAKO}"] [data-done-fold]')?.dataset.doneFold`), "2", `${where}: Done past three days folds into "2 done"`)
      assert.equal(await evaluate(`document.querySelectorAll('${row(5)}, ${row(6)}').length`), 0, `${where}: folded, they aren't listed`)
      await press(`[data-project-group="${MAKO}"] [data-done-fold]`)
      await until(`document.querySelectorAll('[data-done-rows] ${row(5)}, [data-done-rows] ${row(6)}').length === 2`, `${where}: "2 done" opens them`)
      await press(`[data-project-group="${MAKO}"] [data-done-fold]`)
      await until(`!document.querySelector('${row(5)}')`, `${where}: and folds them again`)

      // Marked unread on another device: unread here, its title in full tone.
      const unread = await evaluate(`(() => { const node = document.querySelector('${row(2)}'); return { unread: node.dataset.unread, marked: node.dataset.markedUnread, title: node.querySelector('[data-row-title]').className, plain: document.querySelector('${row(7)}').dataset.unread } })()`)
      assert.equal(unread.unread, "true", `${where}: a Thread marked unread elsewhere lists as unread`)
      assert.equal(unread.marked, "true")
      assert.ok(/\btext-foreground\b(?!\/)/.test(unread.title) && !unread.title.includes("/72"), `${where}: its title in full tone: ${unread.title}`)
      assert.equal(unread.plain, undefined, `${where}: one not marked doesn't`)

      // Finish setting up: Mac and a Thread done, the Home Screen and notifications to do.
      const card = await evaluate(`({ count: document.querySelector('[data-setup-card]')?.dataset.setupCard, steps: [...document.querySelectorAll('[data-setup-step]')].map((step) => [step.dataset.setupStep, step.hasAttribute('data-done')]), first: document.querySelector('.web-scroll [data-setup-card]')?.getBoundingClientRect().top < document.querySelector('[data-project-group]').getBoundingClientRect().top })`)
      assert.equal(card.count, "2/4", `${where}: Finish setting up says 2 of 4: ${JSON.stringify(card)}`)
      assert.deepEqual(card.steps, [["mac", true], ["thread", true], ["home", false], ["notify", false]], `${where}: the steps a phone can know`)
      assert.ok(card.first, `${where}: at the top of the list`)
      await capture(`21-phone-${theme}.png`)

      // Held: Mark as unread and Status, each sent to the owner.
      const before = (await calls()).length
      await hold(`${row(1)} [data-row-title]`)
      await until("Boolean(document.querySelector('[data-row-action=\"status\"]'))", `${where}: the held row's menu`)
      const menu = await evaluate("[...document.querySelectorAll('.web-sheet .web-choice')].map((node) => node.innerText.replace(/\\s+/g, ' ').trim())")
      assert.equal(menu[0], "Mark as unread", `${where}: the menu leads with Mark as unread: ${menu}`)
      assert.match(menu[1], /^Status In progress/, `${where}: then Status, saying the current one: ${menu}`)
      await press('[data-row-action="status"]')
      await until("document.querySelectorAll('[data-work-status-choice]').length === 5", `${where}: the Status choices`)
      const choices = await evaluate("[...document.querySelectorAll('[data-work-status-choice]')].map((node) => [node.dataset.workStatusChoice, node.innerText.trim(), Boolean(node.querySelector('svg[data-work-status]')), node.getAttribute('aria-pressed')])")
      assert.deepEqual(choices.map(([id, words]) => [id, words]), [["backlog", "Backlog"], ["in-progress", "In progress"], ["in-review", "In review"], ["done", "Done"], ["none", "No status"]], `${where}: Backlog to Done, then No status`)
      assert.ok(choices.slice(0, 4).every(([, , glyph]) => glyph), `${where}: each Status with its glyph`)
      assert.equal(choices[1][3], "true", `${where}: the current one checked`)
      await wait(350)
      await capture(`23-phone-menu-status-${theme}.png`)
      await press('[data-work-status-choice="in-review"]')
      await until(`document.querySelector('${row(1)}').dataset.workStatus === 'in-review'`, `${where}: the row shows the Status chosen at once`)
      await until("!document.querySelector('.web-sheet-layer[data-open]')", `${where}: the menu closes`, 3000).catch(() => undefined)
      await wait(400)
      await hold(`${row(7)} [data-row-title]`)
      await until("Boolean(document.querySelector('[data-row-action=\"unread\"]'))", `${where}: the second held row's menu`)
      await press('[data-row-action="unread"]')
      await until(`document.querySelector('${row(7)}').dataset.unread === 'true'`, `${where}: marked unread, it lists as unread`)
      const sent = (await calls()).slice(before)
      assert.deepEqual(sent.map((call) => [call.thread, call.change]), [[thread(1), { status: "in-review" }], [thread(7), { unread: true }]], `${where}: each sent to its owner as mako:thread-mark: ${JSON.stringify(sent)}`)
      assert.ok(sent.every((call) => /^[0-9a-f-]{36}$/.test(call.operation)), `${where}: each with its own operation ID`)
      await wait(400)

      // Opening one marked unread asks its owner to read it, once.
      const opening = (await calls()).length
      await tap(`${row(2)} [data-row-title]`)
      await until("Boolean(document.querySelector('[aria-label=\"Back to threads\"]'))", `${where}: the Thread opened`)
      await until(`window.phoneRail.calls().some((call) => call.channel === 'mako:thread-mark' && call.args[1] === '${thread(2)}')`, `${where}: its owner asked to read it`)
      await tap('[aria-label="Back to threads"]')
      await until(`Boolean(document.querySelector('${row(2)}'))`, `${where}: back to the list`)
      assert.equal(await evaluate(`document.querySelector('${row(2)}').dataset.unread`), undefined, `${where}: read, it no longer lists as unread`)
      await tap(`${row(2)} [data-row-title]`)
      await until("Boolean(document.querySelector('[aria-label=\"Back to threads\"]'))", `${where}: the Thread opened again`)
      await wait(300)
      const reads = (await calls()).slice(opening)
      assert.deepEqual(reads.map((call) => [call.thread, call.change]), [[thread(2), { unread: false }]], `${where}: asked once: ${JSON.stringify(reads)}`)
      await tap('[aria-label="Back to threads"]')
      await until(`Boolean(document.querySelector('${row(2)}'))`, `${where}: back to the list again`)

      // Put away, Finish setting up stays away, across a reload.
      await press("[data-setup-dismiss]")
      await until("!document.querySelector('[data-setup-card]')", `${where}: put away`)
      assert.deepEqual(JSON.parse(await evaluate("localStorage.getItem('mako:web:setup-card:account-rail-check')")), { dismissed: true }, `${where}: kept on this device`)
      await load(`theme=${theme}`, PHONE)
      await wait(300)
      assert.equal(await evaluate("document.querySelector('[data-setup-card]')"), null, `${where}: still away after a reload`)
      console.log(`Phone, ${theme}: projects ${groups.map((group) => group.name).join(", ")}; the Apex ${folded.fins} Fins folded, ${open.fins} + ${open.finished} finished open; 2 done folded; Status and Mark as unread sent; read once on open; setup card 2 of 4, put away`)

      // The tablet: the rail beside the open Apex, rows 44px, the open one lit.
      await load(`theme=${theme}&form=ipad`, IPAD)
      await until(`document.querySelector('[data-list="rail"] ${row("apex")}')?.getAttribute('aria-current') === 'page'`, `iPad, ${theme}: the open Apex lit`)
      const rail = await evaluate("({ heights: [...new Set([...document.querySelectorAll('[data-list=\"rail\"] .web-row')].map((node) => Math.round(node.getBoundingClientRect().height)))], card: Boolean(document.querySelector('[data-setup-card]')), groups: document.querySelectorAll('[data-list=\"rail\"] [data-project-group]').length })")
      assert.deepEqual(rail.heights, [44], `iPad, ${theme}: rows are 44px: ${rail.heights}`)
      assert.equal(rail.groups, 4, `iPad, ${theme}: the same projects`)
      assert.equal(rail.card, false, `iPad, ${theme}: Finish setting up is the phone's`)
      await press(`${row("apex")} [data-row-fold]`)
      await until(`document.querySelector('${row("apex")}').dataset.apexOpen === 'true'`, `iPad, ${theme}: the Apex unfolds`)
      await wait(600)
      await capture(`20-ipad-${theme}.png`)
      await press(`${row("apex")} [data-row-fold]`)
      console.log(`iPad, ${theme}: rows 44px, the open Apex lit, 4 groups, no setup card`)
    }
  } finally {
    clearTimeout(watchdog)
  }
}
