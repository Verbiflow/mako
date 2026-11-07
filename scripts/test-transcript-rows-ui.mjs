import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

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
  const root = testScratch("mako-transcript-rows-")
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

/** Installed once the rows are up, and again after they're opened anew, so its observer runs after the virtualizer's, in the frame's last moment before paint. */
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
  // Observers run in the order they were made, and a panel opened again makes the virtualizer's anew.
  let last
  window.__lastObserver = () => {
    last?.disconnect()
    last = new ResizeObserver(look)
    last.observe(kick)
  }
  window.__lastObserver()
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
  window.__tall = () => {
    n += 1
    const id = crypto.randomUUID(), m = n
    const text = '[mako · from your Fins, not the person]\\n1 finished:\\n  • "fin-' + m + '" done: the work is in.'
    const request = { id, createdAt: Date.now(), text, attachments: [], status: 'dispatching', digest: { sentAt: Date.now(), notices: [] } }
    send({ requestChanges: [request], updates: [{ kind: 'user', id: 'wake-' + m, text, requestId: id }, { kind: 'text', id: 'answer-' + m, text: 'A long answer with a good deal in it, line after line. '.repeat(600) }] })
    send({ requestChanges: [{ ...request, status: 'completed' }] })
    return 'wake-' + m
  }
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

/** Each frame, once painted: the turns in view, how much of the view they fill, and for a reader up, the line they read. */
const CROSSING = (up) => `(() => {
  const node = document.querySelector('[data-transcript-viewport]')
  const view = node.getBoundingClientRect()
  const first = [...node.querySelectorAll('[data-exchange]')].find((turn) => turn.getBoundingClientRect().bottom > view.top + 40)
  const anchor = ${up} ? first.dataset.exchange : null
  const start = first.getBoundingClientRect().top
  const seen = window.__crossing = { frames: 0, after: 0, crossed: false, empty: [], moved: [] }
  const read = () => {
    seen.frames += 1
    if (node.hasAttribute('data-virtualized')) { seen.crossed = true; seen.after += 1 }
    const turns = [...node.querySelectorAll('[data-exchange]')].map((turn) => turn.getBoundingClientRect())
    const shown = turns.reduce((all, box) => all + Math.max(0, Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top)), 0)
    if (shown < view.height * (anchor ? 0.5 : 0.05)) seen.empty.push({ frame: seen.frames, turns: turns.length, shown: Math.round(shown), scrollTop: Math.round(node.scrollTop) })
    if (anchor) {
      const turn = node.querySelector('[data-exchange="' + anchor + '"]')
      const by = turn ? turn.getBoundingClientRect().top - start : null
      if (by === null || Math.abs(by) > 3) seen.moved.push({ frame: seen.frames, by: by === null ? 'gone' : Math.round(by) })
    }
  }
  const after = new MessageChannel()
  after.port1.onmessage = read
  const tick = () => { after.port2.postMessage(0); requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  return true
})()`

const FORMS = [
  { form: "desk", path: "/?mock&app=apex&turns=260&idle=1", width: 1440, height: 900, mobile: false,
    open: "(() => { const row = [...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.querySelector('[data-fin-pips]')); row?.click(); return Boolean(row) })()" },
  { form: "laptop browser", path: "/scripts/web-desk.html?app=apex&thread=apex&turns=260&idle=1", width: 1280, height: 800, mobile: false },
  { form: "phone", path: "/scripts/phone-apex.html?app=apex&turns=260&idle=1", width: 390, height: 844, mobile: true,
    open: "(() => { const row = document.querySelector('[data-thread]'); row?.click(); return Boolean(row) })()" },
]

async function check() {
  const { app, BrowserWindow, contentTracing, nativeImage } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const evidence = process.env.MAKO_SEND_SHOTS ?? root
  const base = process.env.MAKO_UI_TEST_URL.replace(/\/$/, "")
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } })
  const page = window.webContents
  const guard = guardElectronCheck({ app, page, name: "The transcript rows check", ms: 480_000 })
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

    if (!mobile) {
      // Rows come and go in the same frames here: none may read as one the observer missed.
      guard.at(`${form}: a fast climb, observer working`)
      const at = await evaluate("(() => { const box = document.querySelector('[data-transcript-viewport]').getBoundingClientRect(); return { x: box.left + 200, y: box.top + 80 } })()")
      for (let step = 0; step < 90; step += 1) {
        await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: step < 60 ? -700 : 700 })
        await wait(16)
      }
      await wait(300)
      await faults("a fast climb with the observer working")
      assert.deepEqual(corrected, [], `${form}: nothing to correct as rows come and go`)
      await evaluate(`import('/src/components/transcript/transcript-end.ts').then(({ TRANSCRIPT_END_EVENT }) => { document.querySelector('[data-transcript-viewport]').dispatchEvent(new Event(TRANSCRIPT_END_EVENT, { bubbles: true })); return true })`)
      await wait(400)
    }
    if (form === "desk") {
      // Opened again, its rows are measured fresh and the first of them move the window: those that leave it aren't missed.
      guard.at(`${form}: another Thread and back, observer working`)
      for (let round = 0; round < 3; round += 1) {
        await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.innerText.includes('Refactor the composer')).click(); true")
        await wait(500)
        await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.querySelector('[data-fin-pips]')).click(); true")
        await until(`document.querySelectorAll(${JSON.stringify(ROW)}).length > 2`, `${form}: its rows again`)
        await wait(500)
      }
      // Sizes kept from before stand as measured, so nothing moves its rows when they're replaced: a turn, a wheel, a new width.
      guard.at(`${form}: opened again, then a turn and a wheel`)
      await evaluate("window.__lastObserver(); window.__overlaps.length = 0; true")
      await turns(2)
      await wait(600)
      await shot(`${form} opened again, hands off`)
      await faults("opened again, then a turn, hands off")
      const at = await evaluate("(() => { const box = document.querySelector('[data-transcript-viewport]').getBoundingClientRect(); return { x: box.left + 200, y: box.top + 80 } })()")
      for (let step = 0; step < 12; step += 1) {
        await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: -60 })
        await wait(30)
      }
      await wait(600)
      await faults("opened again, then a wheel")
      guard.at(`${form}: opened again, then a new width`)
      await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: width - 40, height, deviceScaleFactor: 2, mobile })
      await wait(600)
      await turns(1)
      await wait(300)
      await shot(`${form} opened again at a new width`)
      await faults("opened again, then a new width")
      await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile })
      await wait(400)
      assert.deepEqual(corrected, [], `${form}: nothing to correct on opening it again`)
      await evaluate(`import('/src/components/transcript/transcript-end.ts').then(({ TRANSCRIPT_END_EVENT }) => { document.querySelector('[data-transcript-viewport]').dispatchEvent(new Event(TRANSCRIPT_END_EVENT, { bubbles: true })); return true })`)
      await wait(400)
      await evaluate("window.__overlaps.length = 0; true")
    }

    if (form === "desk") {
      // A row coming in restyles itself, never the page around it: a rule that makes it do so costs every row a frame at
      // speed. Elements counted, not milliseconds, so no runner's load decides it.
      guard.at(`${form}: what a row coming in restyles`)
      const at = await evaluate("(() => { const box = document.querySelector('[data-transcript-viewport]').getBoundingClientRect(); return { x: box.left + 200, y: box.top + 80 } })()")
      await contentTracing.startRecording({ included_categories: ["devtools.timeline"], excluded_categories: ["*"] })
      for (let step = 0; step < 60; step += 1) {
        await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: step < 40 ? -300 : 300 })
        await wait(20)
      }
      const trace = JSON.parse(await readFile(await contentTracing.stopRecording(join(root, "style.trace.json")), "utf8"))
      const elements = await evaluate("document.getElementsByTagName('*').length")
      const restyled = trace.traceEvents.filter((event) => event.name === "UpdateLayoutTree").map((event) => event.args?.elementCount ?? 0)
      console.log(`${form}: restyles while rows came in: ${restyled.length}, the most ${Math.max(0, ...restyled)} of the page's ${elements} elements`)
      assert.ok(restyled.length > 10, `${form}: the trace saw the rows come in`)
      assert.ok(Math.max(...restyled) < elements / 2, `${form}: a row coming in restyles ${Math.max(...restyled)} of ${elements} elements`)
      await evaluate(`import('/src/components/transcript/transcript-end.ts').then(({ TRANSCRIPT_END_EVENT }) => { document.querySelector('[data-transcript-viewport]').dispatchEvent(new Event(TRANSCRIPT_END_EVENT, { bubbles: true })); return true })`)
      await wait(400)
      await evaluate("window.__overlaps.length = 0; true")
    }

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
  // The crossing into a window, at every width, under a reader who's up and one at the end, with turns streaming: each
  // frame paints turns where the frame before had them. Read after the frame's paint, so nothing that lands a frame late
  // passes for having been there.
  for (const { form, path, width, height, mobile, open } of [
    { form: "desk", path: "/?mock&app=apex&turns=12&idle=1", width: 1440, height: 900, mobile: false, open: FORMS[0].open },
    { form: "a narrow window", path: "/scripts/web-desk.html?app=apex&thread=apex&turns=12&idle=1", width: 1100, height: 800, mobile: false },
    { form: "phone", path: "/scripts/phone-apex.html?app=apex&turns=12&idle=1", width: 390, height: 844, mobile: true, open: FORMS[2].open },
  ]) {
    for (const reader of ["up", "at the end", "scrolling"]) {
      guard.at(`${form}: crossing into a window, reader ${reader}`)
      await window.loadURL("about:blank")
      await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile })
      await window.loadURL(`${base}${path}`).catch((error) => {
        if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error
      })
      if (open) await until(open, `${form}: its list`)
      await until("document.querySelectorAll('[data-transcript-viewport] [data-exchange]').length > 2", `${form}: the Apex's turns`)
      await evaluate(TURNS)
      await wait(600)
      assert.equal(await evaluate("document.querySelector('[data-transcript-viewport]').hasAttribute('data-virtualized')"), false, `${form}: starts short of a window, or nothing crosses`)
      const at = await evaluate("(() => { const box = document.querySelector('[data-transcript-viewport]').getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + 80 } })()")
      const wheelBy = (deltaY) => page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY })
      if (reader !== "at the end") {
        await wheelBy(-500)
        await wait(400)
        const away = await evaluate("(() => { const node = document.querySelector('[data-transcript-viewport]'); return node.scrollHeight - node.scrollTop - node.clientHeight })()")
        assert.ok(away > 96, `${form}: the reader left the end (${away})`)
      }
      await evaluate(CROSSING(reader === "up"))
      let moving = reader === "scrolling"
      const wheeling = (async () => {
        for (let step = 0; moving; step += 1) {
          await wheelBy(step % 12 < 6 ? -80 : 80)
          await wait(30)
        }
      })()
      for (let turn = 0; turn < 40 && !(await evaluate("window.__crossing.crossed")); turn += 1) await evaluate("window.__turn()")
      await wait(500)
      moving = false
      await wheeling
      const crossing = await evaluate("window.__crossing")
      console.log(`${form}, reader ${reader}: crossed after ${crossing.frames} frames, ${crossing.after} frames after it, empty ${crossing.empty.length}, moved ${crossing.moved.length}${crossing.empty[0] ? ` first ${JSON.stringify(crossing.empty[0])}` : ""}${crossing.moved[0] ? ` first ${JSON.stringify(crossing.moved[0])}` : ""}`)
      if (crossing.empty.length || crossing.moved.length) await shot(`${form} crossing, reader ${reader}`)
      assert.ok(crossing.crossed, `${form}: the turns crossed into a window`)
      assert.deepEqual(crossing.empty.slice(0, 3), [], `${form}, reader ${reader}: turns painted in every frame across the crossing`)
      assert.deepEqual(crossing.moved.slice(0, 3), [], `${form}, reader ${reader}: what's read stays where it was across the crossing`)
    }
  }
  // What the crossing paints, frame by frame, as the screen shows it: a frame can be wrong with every box right by the time
  // anything can read one. A reader who's still sees no frame that isn't the one before, wherever they rest.
  for (const up of [500, 1500]) {
    guard.at(`a narrow window: the crossing in pixels, ${up} px up`)
    await window.loadURL("about:blank")
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false })
    await window.loadURL(`${base}/scripts/web-desk.html?app=apex&thread=apex&turns=12&idle=1`).catch((error) => {
      if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error
    })
    await until("document.querySelectorAll('[data-transcript-viewport] [data-exchange]').length > 2", "the Apex's turns")
    await evaluate(TURNS)
    await wait(600)
    const box = await evaluate("(() => { const b = document.querySelector('[data-transcript-viewport]').getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height } })()")
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x + box.width / 2, y: box.y + 80, deltaX: 0, deltaY: -up })
    await wait(500)
    const frames = []
    const painted = (_event, method, params) => {
      if (method !== "Page.screencastFrame") return
      frames.push({ at: params.metadata.timestamp * 1000, data: params.data })
      void page.debugger.sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined)
    }
    page.debugger.on("message", painted)
    await evaluate("(() => { const node = document.querySelector('[data-transcript-viewport]'); const look = () => { if (node.hasAttribute('data-virtualized')) window.__crossedAt = performance.timeOrigin + performance.now(); else requestAnimationFrame(look) }; requestAnimationFrame(look); return true })()")
    // The screencast sends a frame only when something on screen changes, and a crossing done right changes nothing: a
    // speck outside the transcript changes every frame, so each one is sent and both sides of the crossing are seen.
    await evaluate("(() => { const speck = document.createElement('div'); speck.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;z-index:9999;pointer-events:none'; document.body.append(speck); let on = false; const tick = () => { on = !on; speck.style.background = on ? '#fff' : '#000'; requestAnimationFrame(tick) }; requestAnimationFrame(tick); return true })()")
    await page.debugger.sendCommand("Page.startScreencast", { format: "png", everyNthFrame: 1 })
    await wait(200)
    for (let turn = 0; turn < 40 && !(await evaluate("Boolean(window.__crossedAt)")); turn += 1) await evaluate("window.__turn()")
    await wait(1_800)
    await page.debugger.sendCommand("Page.stopScreencast")
    page.debugger.removeListener("message", painted)
    const crossedAt = await evaluate("window.__crossedAt")
    assert.ok(crossedAt, "the turns crossed into a window")
    // The transcript, short of its edges: its scrollbar and the pill that says there's more come and go on their own.
    const crop = { x: Math.round(box.x), y: Math.round(box.y) + 20, width: Math.round(box.width) - 60, height: Math.round(box.height) - 90 }
    // What settled is read well after it, when anything a slow machine draws late (code's colours) has come: closer, a
    // late repaint would pass for a change that stays.
    const around = frames.filter((frame) => frame.at > crossedAt - 400 && frame.at < crossedAt + 1_500)
    // A runner paints at its own rate: what matters is frames on both sides of it, not how many.
    const before = around.filter((frame) => frame.at < crossedAt).length, after = around.length - before
    assert.ok(before >= 2 && after >= 2, `the screencast saw both sides of the crossing: ${before} frames before it, ${after} after`)
    // Wrong for a frame is unlike both what was there and what settled: code without its colours, a turn over another. A
    // reader's text settling a fraction of a pixel over is unlike one of them only, and stays.
    const pixels = around.map((frame) => nativeImage.createFromBuffer(Buffer.from(frame.data, "base64")).crop(crop).toBitmap())
    const unlike = (one, other) => {
      let changed = 0
      for (let at = 0; at < one.length; at += 4)
        if (Math.abs(one[at] - other[at]) + Math.abs(one[at + 1] - other[at + 1]) + Math.abs(one[at + 2] - other[at + 2]) > 48) changed += 1
      return 100 * changed / (one.length / 4)
    }
    const was = pixels[0], settled = pixels.at(-1)
    const stayed = unlike(was, settled)
    const flash = around.map((frame, index) => ({ frame, by: Math.min(unlike(pixels[index], was), unlike(pixels[index], settled)), at: Math.round(frame.at - crossedAt) })).reduce((most, each) => each.by > most.by ? each : most)
    console.log(`a narrow window, ${up} px up: ${around.length} painted frames around the crossing, ${before} before it; the most any frame was unlike both sides ${flash.by.toFixed(2)}% ${flash.at} ms from it; what stayed changed ${stayed.toFixed(2)}%`)
    if (flash.by > 1 || stayed > 10) {
      await mkdir(evidence, { recursive: true })
      for (const [name, frame] of [["before", around[0]], ["flash", flash.frame], ["settled", around.at(-1)]])
        await writeFile(join(evidence, `crossing ${up} px up ${name}.png`), Buffer.from(frame.data, "base64"))
    }
    assert.ok(flash.by <= 1, `a narrow window, ${up} px up: the crossing paints a frame ${flash.by.toFixed(2)}% unlike both what was there and what settled, ${flash.at} ms from it`)
    assert.ok(stayed <= 10, `a narrow window, ${up} px up: the crossing leaves the screen ${stayed.toFixed(2)}% changed`)
  }

  // A finger, or a fling, in a tall turn as the crossing comes: what's read goes with the gesture, and never leaps. Turns
  // here run past 5,000 px on a phone, and only a tall one shows a reader sent to its top.
  for (const { form, width, gesture } of [
    { form: "phone, a finger", width: 390, gesture: { speed: 900, preventFling: true } },
    { form: "phone, a fling", width: 390, gesture: { speed: 3000, preventFling: false } },
    { form: "an iPad's width, a finger", width: 1100, gesture: { speed: 900, preventFling: true } },
  ]) {
    guard.at(`${form} across the crossing`)
    await window.loadURL("about:blank")
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 2, mobile: true })
    await window.loadURL(`${base}/scripts/transcript-scroll-browser.html?turns=20`).catch((error) => {
      if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error
    })
    await until("document.querySelectorAll('[data-transcript-viewport] [data-exchange]').length > 2", `${form}: the fixture`)
    await wait(900)
    assert.equal(await evaluate("document.querySelector('[data-transcript-viewport]').hasAttribute('data-virtualized')"), false, `${form}: starts short of a window`)
    const at = await evaluate("(() => { const box = document.querySelector('[data-transcript-viewport]').getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + 80 } })()")
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: -500 })
    await wait(500)
    await evaluate(`(() => { const node = document.querySelector('[data-transcript-viewport]'); const view = node.getBoundingClientRect(); const seen = window.__gesture = { steps: [], crossed: false, tallest: 0 }
      const under = () => [...node.querySelectorAll('[data-exchange]')].find((turn) => { const box = turn.getBoundingClientRect(); return box.top <= view.top + view.height / 2 && box.bottom > view.top + view.height / 2 })
      let id, before
      const read = () => { const was = node.hasAttribute('data-virtualized'); if (was && !seen.crossed) { seen.crossed = true; seen.at = seen.steps.length }
        const turn = (id && node.querySelector('[data-exchange="' + id + '"]')) || under(); if (!turn) return
        const box = turn.getBoundingClientRect(); seen.tallest = Math.max(seen.tallest, box.height)
        if (turn.dataset.exchange === id) seen.steps.push(Math.round(box.top - before)); id = turn.dataset.exchange; before = box.top }
      const after = new MessageChannel(); after.port1.onmessage = read
      const tick = () => { after.port2.postMessage(0); requestAnimationFrame(tick) }; requestAnimationFrame(tick); return true })()`)
    let moving = true
    const mover = (async () => {
      for (let step = 0; moving; step += 1) {
        await page.debugger.sendCommand("Input.synthesizeScrollGesture", { x: at.x, y: at.y + 200, yDistance: step % 2 ? -260 : 300, gestureSourceType: "touch", ...gesture }).catch(() => undefined)
        await wait(90)
      }
    })()
    for (let turn = 0; turn < 60 && !(await evaluate("document.querySelector('[data-transcript-viewport]').hasAttribute('data-virtualized')")); turn += 1)
      await evaluate("(async () => { window.probe.startTurn(); for (let piece = 0; piece < 6; piece += 1) { window.probe.appendToTurn('The answer keeps arriving, a few words a frame. '); await new Promise(requestAnimationFrame) } return true })()")
    await wait(600)
    moving = false
    await mover
    const seen = await evaluate("window.__gesture")
    const leaps = seen.steps.map((by, frame) => ({ by, frame })).filter(({ by }) => Math.abs(by) > 400)
    console.log(`${form}: crossed ${seen.crossed}, ${seen.steps.length} frames, in a turn ${Math.round(seen.tallest)} px tall, the biggest step ${Math.max(...seen.steps.map(Math.abs))} px, leaps ${JSON.stringify(leaps.slice(0, 3))}`)
    assert.ok(seen.crossed, `${form}: the turns crossed into a window`)
    assert.deepEqual(leaps.slice(0, 3), [], `${form}: what's read goes with the gesture across the crossing`)
  }

  console.log("Transcript rows: held apart in every frame on the desk, in a laptop's browser and on a phone, with and without the observer")
  app.exit(0)
}
