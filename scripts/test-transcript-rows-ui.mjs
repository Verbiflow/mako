import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"

/**
 * A long Apex's rows stand apart in every frame it paints, whether or not the virtualizer's resize observer hears
 * them: on the desk, in a laptop's browser and on a phone, Fin reports start turns that grow by a tool and an answer,
 * first with the observer working (nothing is corrected, nothing is logged), then with the rows taken from it, as a
 * person's Apex was seen: every row left at its size when it mounted, a report over the answer above it and the crew
 * card over the last line. A row that grows with no change to the document comes right within the check's second, and
 * a reader who wheeled up keeps their rows apart too. Every correction is logged with what it found.
 *
 * Each frame reads every mounted row and what follows them, where the frame paints: a row over its neighbour by more
 * than a pixel is a fault naming the frame, the two rows and by how much. Screenshots land in the printed directory.
 */

if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = await mkdtemp(join(tmpdir(), "mako-transcript-rows-"))
  const { createServer } = await import("vite")
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-transcript-rows", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code, signal) => done(electronExit("The transcript rows check", code, signal)))
    })
  } finally {
    await server.close()
  }
  console.log(`UI evidence: ${root}`)
}

const ROW = "[data-virtual-transcript] > [data-index]"

/** Before the page's own code: every row's observation is kept, so the rows can be taken from the observer later. */
const OBSERVER = `(() => {
  const observed = []
  const observe = ResizeObserver.prototype.observe
  ResizeObserver.prototype.observe = function (target, options) {
    if (target.matches?.(${JSON.stringify(ROW)})) {
      if (window.__rowsDeaf) return
      observed.push([this, target])
    }
    return observe.call(this, target, options)
  }
  window.__deafen = () => {
    window.__rowsDeaf = true
    for (const [observer, target] of observed.splice(0)) observer.unobserve(target)
  }
})()`

/** Installed once the rows are up, so its observer runs after the virtualizer's, in the frame's last moment before paint. */
const WATCH = `(() => {
  const faults = window.__overlaps = []
  let frames = 0
  const look = () => {
    const node = document.querySelector('[data-transcript-viewport]')
    if (!node) return
    frames += 1
    const view = node.getBoundingClientRect()
    const boxes = [...node.querySelectorAll(${JSON.stringify(ROW)})].map((row) => ({ id: 'row ' + row.dataset.index, box: row.getBoundingClientRect() }))
      .filter(({ box }) => box.height > 0 && box.bottom > view.top && box.top < view.bottom)
    const after = node.querySelector('[data-virtual-transcript]')?.nextElementSibling
    if (after && boxes.length) {
      const box = after.getBoundingClientRect()
      if (box.height > 0 && box.top < view.bottom) boxes.push({ id: 'what follows the rows', box })
    }
    boxes.sort((left, right) => left.box.top - right.box.top)
    for (let index = 1; index < boxes.length; index += 1) {
      const by = boxes[index - 1].box.bottom - boxes[index].box.top
      if (by > 1) faults.push({ frame: frames, above: boxes[index - 1].id, below: boxes[index].id, by: Math.round(by) })
    }
    window.__frames = frames
  }
  const kick = document.createElement('div')
  kick.style.cssText = 'position:fixed;left:0;top:0;height:1px;width:1px;pointer-events:none;opacity:0'
  document.body.append(kick)
  new ResizeObserver(look).observe(kick)
  const tick = () => {
    kick.style.width = kick.style.width === '1px' ? '2px' : '1px'
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return true
})()`

/** A Fin's report starting a turn of the Apex, through the batches a live one gets: its card, a tool, then an answer in pieces. */
const TURNS = `Promise.all([import('/src/state/live-recovery.ts'), import('/src/state/acp-state.ts')]).then(([recovery, acp]) => {
  let n = 0
  const send = (batch) => {
    const at = acp.activeLiveAcp(acp.acpStore.get())
    recovery.applyLiveBatch({ id: at.key, epoch: at.epoch, revision: (at.revision ?? 0) + 1, updates: [], requestChanges: [], ...batch })
  }
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  window.__turn = async () => {
    n += 1
    const id = crypto.randomUUID(), m = n
    const words = '[mako · from your Fins, not the person]\\n1 finished:\\n  • "fin-' + m + '" done: the work is in.'
    const card = { report: 'report-' + m, fin: crypto.randomUUID(), name: 'fin-' + m, harness: 'codex', status: 'done', line: 'The work is in, every check green. '.repeat(6) }
    const text = words + '\\n\\n<mako-reports>\\n' + JSON.stringify({ version: 1, reports: [card] }) + '\\n</mako-reports>'
    const request = { id, createdAt: Date.now(), text, attachments: [], status: 'dispatching', digest: { sentAt: Date.now(), notices: [] } }
    send({ requestChanges: [request] })
    await sleep(40)
    send({ updates: [{ kind: 'user', id: 'wake-' + m, text, requestId: id }] })
    await sleep(60)
    send({ updates: [{ kind: 'tool', id: 'tool-' + m, title: 'mcp__mako__agents_send', name: 'mcp__mako__agents_send', status: 'running', input: '{"to":"land-2","text":"Next."}', at: Date.now() }] })
    await sleep(60)
    send({ updates: [{ kind: 'tool-update', id: 'tool-' + m, status: 'completed', output: '{}', endedAt: Date.now() }] })
    await sleep(60)
    for (let piece = 0; piece < 5; piece += 1) {
      send({ updates: [{ kind: 'text', id: 'answer-' + m, text: 'It changes nothing else in the plan, so the rest stands as it was, and the queue goes on. '.repeat(3) }] })
      await sleep(50)
    }
    send({ requestChanges: [{ ...request, status: 'completed' }] })
    await sleep(120)
    return true
  }
  return true
})`

const FORMS = [
  { form: "desk", path: "/?mock&app=apex&turns=260&idle=1", width: 1440, height: 900, mobile: false,
    open: "(() => { const row = [...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.querySelector('[data-fin-pips]')); row?.click(); return Boolean(row) })()" },
  { form: "laptop browser", path: "/scripts/web-desk.html?app=apex&thread=apex&turns=260&idle=1", width: 1280, height: 800, mobile: false },
  { form: "phone", path: "/scripts/phone-apex.html?app=apex&turns=260&idle=1", width: 390, height: 844, mobile: true,
    open: "(() => { const row = document.querySelector('[data-thread]'); row?.click(); return Boolean(row) })()" },
]

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL.replace(/\/$/, "")
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } })
  const page = window.webContents
  const guard = guardElectronCheck({ app, page, name: "The transcript rows check", ms: 300_000 })
  page.debugger.attach("1.3")
  const corrected = []
  page.on("console-message", (event) => {
    if (event.message.startsWith("Transcript row corrected")) corrected.push(event.message)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  const until = async (code, label = code) => {
    guard.at(label)
    const deadline = Date.now() + 120_000
    while (!(await evaluate(code).catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
      await wait(50)
    }
  }
  const shot = async (name) => writeFile(join(root, `${name}.png`), (await page.capturePage()).toPNG())
  // A page first: a window that has drawn nothing answers no debugger command, and crashes on emulation.
  await window.loadURL("about:blank")
  await page.debugger.sendCommand("Page.enable")
  await page.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: OBSERVER })

  for (const { form, path, width, height, mobile, open } of FORMS) {
    console.log(`=== ${form}`)
    await window.loadURL("about:blank")
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile })
    await window.loadURL(`${base}${path}`).catch((error) => {
      if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error
    })
    if (open) await until(open, `${form}: its list`)
    await until(`document.querySelectorAll(${JSON.stringify(ROW)}).length > 2 && Boolean(document.querySelector('[data-crew]'))`, `${form}: the Apex's rows`)
    await evaluate(TURNS)
    await wait(600)
    await evaluate(WATCH)
    const faults = async (name) => {
      const seen = await evaluate("({ frames: window.__frames, overlaps: window.__overlaps.splice(0) })")
      console.log(`${form}: ${name}: ${seen.frames} frames in all, ${seen.overlaps.length} overlapping, the most ${Math.max(0, ...seen.overlaps.map((fault) => fault.by))} px`)
      if (seen.overlaps.length) await shot(`${form} ${name}`)
      assert.deepEqual(seen.overlaps.slice(0, 3), [], `${form}: ${name}: no row over another in any frame`)
    }
    const turns = async (count) => {
      for (let turn = 0; turn < count; turn += 1) await evaluate("window.__turn()")
    }

    guard.at(`${form}: turns, observer working`)
    corrected.length = 0
    await turns(3)
    await faults("turns with the observer working")
    assert.deepEqual(corrected, [], `${form}: nothing to correct while the observer hears the rows`)

    guard.at(`${form}: turns, rows taken from the observer`)
    await evaluate("window.__deafen(); true")
    await turns(4)
    await wait(200)
    await shot(`${form} rows taken from the observer`)
    await faults("turns with the rows taken from the observer")
    assert.ok(corrected.length > 0, `${form}: a correction is logged`)
    const said = JSON.parse(corrected.at(-1).slice(corrected.at(-1).indexOf("{")))
    for (const field of ["row", "stale", "real", "heard", "registered", "turns", "scrolling", "following", "visibility"])
      assert.ok(field in said, `${form}: the log says ${field}: ${corrected.at(-1)}`)
    assert.equal(said.heard, false, `${form}: the log says the observer didn't report the row`)

    guard.at(`${form}: a row growing with no change to the document`)
    await evaluate(`(() => { const rows = [...document.querySelectorAll(${JSON.stringify(ROW)})]; rows.at(-1).style.paddingBlockEnd = '180px'; return true })()`)
    await wait(1_400)
    const settled = await evaluate(`(() => { const rows = [...document.querySelectorAll(${JSON.stringify(ROW)})].sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top); const last = rows.at(-1).getBoundingClientRect(); const after = document.querySelector('[data-virtual-transcript]').nextElementSibling?.getBoundingClientRect(); return after ? after.top - last.bottom : 0 })()`)
    assert.ok(settled >= -1, `${form}: a row grown by nothing the document says comes right within the check's second (${settled})`)
    await evaluate("window.__overlaps.length = 0; true")

    if (!mobile) {
      guard.at(`${form}: turns under a reader who wheeled up`)
      const at = await evaluate("(() => { const box = document.querySelector('[data-transcript-viewport]').getBoundingClientRect(); return { x: box.left + 200, y: box.top + 80 } })()")
      await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: -240 })
      await wait(300)
      await turns(3)
      await wait(200)
      await faults("turns under a reader who wheeled up")
    }
    console.log(`${form}: corrections logged: ${corrected.length}; the last: ${corrected.at(-1)}`)
  }
  console.log("Transcript rows: held apart in every frame on the desk, in a laptop's browser and on a phone, with and without the observer")
  app.exit(0)
}
