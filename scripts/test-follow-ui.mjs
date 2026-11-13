import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * The newest turn stays in view while reports pour into a long Apex, on the desk, in a laptop's browser and on a phone,
 * and only the reader's own scrolling of the transcript lets go of it. Trusted input through the real pipeline: bursts,
 * a queued digest, a steer, a shrinking column, a reconnect and the crew card growing all keep the end; a wheel over
 * the crew card's own list doesn't release it, nor does a tap or a click; a reader back at the end follows again;
 * a browser with no `scrollend` keeps its input from going stale. A reader who's truly up stays exactly where they are
 * through the burst, with what's mounted bounded, and a button they clicked doesn't hold the conversation's memory.
 * Screenshots land in the printed directory.
 */

if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = testScratch("mako-follow-ui-")
  const { uiVite } = await import("./lib/ui-vite.mjs")
  const server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-follow-ui", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code, signal) => done(electronExit("The follow UI check", code, signal)))
    })
  } finally {
    await server.close()
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
  const guard = guardElectronCheck({ app, page, name: "The follow UI check", ms: 420_000 })
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
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  const load = async (path, width, height, mobile = false) => {
    await window.loadURL("about:blank")
    await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile })
    await window.loadURL(`${base}${path}`).catch((error) => {
      if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error
    })
  }
  const VIEW = "document.querySelector('[data-transcript-viewport]')"
  const install = () => evaluate(`Promise.all([import('/src/state/live-recovery.ts'), import('/src/state/acp-state.ts')]).then(([recovery, acp]) => {
    let n = 0
    const live = () => acp.activeLiveAcp(acp.acpStore.get())
    window.__report = (extra = {}) => {
      const at = live(); n += 1
      const id = crypto.randomUUID()
      const text = '[mako · from your Fins, not the person]\\n1 finished:\\n  • "fin-' + n + '" done: Report ' + n + ' is in.'
      const request = { id, createdAt: Date.now(), text, attachments: [], status: 'dispatching', digest: { sentAt: Date.now(), notices: [] } }
      recovery.applyLiveBatch({ id: at.key, epoch: at.epoch, revision: (at.revision ?? 0) + 1, updates: [
        { kind: 'user', id: 'wake-' + n, text, requestId: id },
        { kind: 'text', id: 'reply-' + n, text: 'Noted report ' + n + '. ' + 'It changes nothing else in the plan, so the rest stands as it was. '.repeat(1 + n % 4) },
      ], requestChanges: [request], ...extra })
      const after = live()
      recovery.applyLiveBatch({ id: at.key, epoch: at.epoch, revision: (after.revision ?? 0) + 1, updates: [], requestChanges: [{ ...request, status: 'completed' }] })
    }
    window.__burst = (count, every) => new Promise((done) => {
      let left = count
      const timer = setInterval(() => { window.__report(); if (--left <= 0) { clearInterval(timer); done(true) } }, every)
    })
    return true
  })`)
  const reading = () => evaluate(`(() => { const node = ${VIEW}; return { away: Math.round(node.scrollHeight - node.scrollTop - node.clientHeight), rows: node.querySelectorAll('[data-exchange]').length, height: node.scrollHeight } })()`)
  // The way back a reader has: follow is on again, not just the offset.
  const toEnd = async () => {
    await evaluate(`import('/src/components/transcript/transcript-end.ts').then(({ TRANSCRIPT_END_EVENT }) => { ${VIEW}.dispatchEvent(new Event(TRANSCRIPT_END_EVENT, { bubbles: true })); return true })`)
    await wait(220)
    await evaluate(`(() => { const probe = ${VIEW}; return probe.scrollTop })()`)
  }
  const follows = async () => {
    await evaluate("window.__report(); true")
    await wait(250)
    return (await reading()).away <= 96
  }
  const trial = async (name, before, during, { burst = true } = {}) => {
    await toEnd()
    const pinnedBefore = await follows()
    await before?.()
    const start = await reading()
    await Promise.all([burst ? evaluate("window.__burst(24, 30)") : wait(300), during?.()])
    await wait(350)
    const end = await reading()
    console.log(`TRIAL ${name.padEnd(50)} ${pinnedBefore ? "" : "(NOT FOLLOWING FIRST) "}away ${String(start.away).padStart(6)} → ${String(end.away).padStart(6)}  ${end.away > 96 ? "LOST" : "kept"}`)
    return end.away <= 96
  }
  const batch = (body) => evaluate(`Promise.all([import('/src/state/live-recovery.ts'), import('/src/state/acp-state.ts')]).then(([recovery, acp]) => { const at = acp.activeLiveAcp(acp.acpStore.get()); recovery.applyLiveBatch({ id: at.key, epoch: at.epoch, revision: (at.revision ?? 0) + 1, ...${body} }); return true })`)
  const wheel = async (x, y, deltaY) => {
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY })
    await wait(60)
  }
  const replay = async (at, events) => {
    for (const [gap, deltaY] of events) {
      if (gap) await new Promise((done) => setTimeout(done, gap))
      await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY })
    }
  }
  const centre = (selector) => evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return box ? { x: box.left + box.width / 2, y: box.top + Math.min(box.height / 2, 200) } : null })()`)

  for (const [form, path, width, height, mobile] of [
    ["desk", "/?mock&app=apex&turns=260", 1440, 900, false],
    ["laptop browser", "/scripts/web-desk.html?thread=apex&theme=dark", 1280, 800, false],
    ["phone", "/scripts/phone-apex.html?app=apex", 390, 844, true],
  ]) {
    console.log(`=== ${form}`)
    const open = async () => {
      await load(path, width, height, mobile)
      if (form === "desk") {
        await until("document.querySelectorAll('.thread-jump-scope [data-asking-fin]').length === 2", "the rail")
        await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.querySelector('[data-fin-pips]')).click(); true")
      }
      if (form === "phone") {
        await until("Boolean(document.querySelector('[data-thread]'))", "the list")
        await evaluate("document.querySelector('[data-thread]').click(); true")
      }
      await until(`Boolean(${VIEW}) && Boolean(document.querySelector('[data-crew]'))`, "the Apex")
      await install()
      await wait(500)
      await toEnd()
    }
    await open()
    const keeps = async (name, ...args) => assert.ok(await trial(name, ...args), `${form}: ${name} keeps the end`)
    await keeps("a burst, hands off")
    await keeps("a queued digest behind the turn", () => batch("{ updates: [], requestChanges: [{ id: crypto.randomUUID(), createdAt: Date.now(), text: '[mako · from your Fins, not the person]\\nqueued', attachments: [], status: 'queued' }] }"))
    await keeps("a steer landing in the turn", undefined, () => batch("{ updates: [{ kind: 'user', text: 'A steer', steeringFor: at.requests?.at(-1)?.id, requestId: crypto.randomUUID() }] }"))
    await keeps("a reply retracted, the column shrinking", undefined, () => batch("{ updates: [{ kind: 'retract', ids: ['reply-2', 'reply-3'] }] }"))
    await keeps("a reconnect reading the snapshot again", undefined, () => evaluate(`Promise.all([import('/src/state/live-recovery.ts'), import('/src/state/acp-state.ts')]).then(async ([recovery, acp]) => { await new Promise((done) => setTimeout(done, 200)); const now = acp.activeLiveAcp(acp.acpStore.get()); recovery.applyLiveSnapshot({ session: now.session, revision: (now.revision ?? 0) + 1, epoch: 'reconnected', createdAt: Date.now(), threadPath: now.threadPath, threadId: now.threadId, sessionId: now.sessionId, base: null, permissions: [], requests: now.requests, blocks: now.blocks, control: now.control, nativeAgents: now.nativeAgents }); return true })`))
    await keeps("the crew card growing", undefined, () => evaluate("(() => { const fins = window.apexScene?.children?.(); if (fins) window.apexScene.setChildren(fins.map((fin) => ({ ...fin }))); return true })()"))
    const stale = async (name, input) => {
      // Input that moved nothing must leave nothing behind: the layout shifting a moment later isn't the reader.
      await open()
      await evaluate("window.addEventListener('scrollend', (event) => event.stopImmediatePropagation(), true); true")
      await keeps(name, async () => { await input(); await wait(350) }, () => evaluate(`(() => { const node = ${VIEW}; node.scrollTop = node.scrollHeight - node.clientHeight - 300; return true })()`))
    }
    if (form !== "phone") {
      await open()
      await keeps("a wheel down at the end", async () => { const at = await centre("[data-transcript-viewport]"); await wheel(at.x, at.y, 40) })
      await keeps("a wheel up over the crew card's own list", async () => {
        const at = await centre("[data-crew-scroller]")
        if (!at) return
        await wheel(at.x, at.y, 200)
        await wheel(at.x, at.y, -60)
      })
      await open()
      await keeps("read up, then wheeled back to the end", async () => {
        const at = await centre("[data-transcript-viewport]")
        await wheel(at.x, at.y, -900)
        await wait(250)
        assert.ok((await reading()).away > 96, `${form}: the wheel left the end`)
        for (let step = 0; step < 10; step += 1) await wheel(at.x, at.y, 300)
        await wait(250)
      })
      // Up, then exactly as far back, and the hand stops: inside one wheel window its net is nothing, which fingers at
      // rest also come to, and main left the end it came back to unfollowed. Clear of the crew card, so no wheel goes
      // to its list.
      await open()
      await keeps("read up, then wheeled exactly back to the end", async () => {
        const at = await evaluate(`(() => { const box = ${VIEW}.getBoundingClientRect(); return { x: box.left + 200, y: box.top + 60 } })()`)
        await wheel(at.x, at.y, -900)
        // Soon enough that the way back lands inside the wheel's window with the move up: on the runner, 250 ms here
        // put the third wheel past it one run in six, and main's net then followed again.
        await wait(100)
        assert.ok((await reading()).away > 96, `${form}: the wheel left the end`)
        for (let step = 0; step < 3; step += 1) await wheel(at.x, at.y, 300)
        assert.ok((await reading()).away <= 1, `${form}: the wheel came back to the end`)
        await wait(250)
      })
      // What a hand does: a trackpad at rest lets go of nothing, and a move on purpose lets go at once.
      const { traces } = JSON.parse(await readFile(resolve("scripts/fixtures/wheel-traces.json"), "utf8"))
      for (const [name, trace] of Object.entries(traces)) {
        await open()
        // Over the transcript itself, clear of the crew card's list, which would take the wheel.
        const point = await evaluate(`(() => { const box = ${VIEW}.getBoundingClientRect(); return { x: box.left + 200, y: box.top + 60 } })()`)
        if (trace.expect === "keeps") {
          await keeps(name, () => replay(point, trace.events))
        } else {
          await replay(point, trace.events)
          await wait(200)
          const left = await reading()
          await evaluate("window.__burst(10, 20)")
          await wait(300)
          const after = await reading()
          console.log(`TRIAL ${name.padEnd(50)} away ${left.away} → ${after.away}  ${after.away > left.away + 40 ? "released" : "HELD"}`)
          assert.ok(after.away > left.away + 40, `${form}: ${name} lets go of the end: ${left.away} → ${after.away}`)
        }
      }
      await stale("no scrollend: a wheel, then the layout shifting", async () => { const at = await centre("[data-transcript-viewport]"); await wheel(at.x, at.y, 40) })
      await stale("no scrollend: a click, then the layout shifting", async () => {
        const at = await centre("[data-transcript-viewport]")
        for (const type of ["mousePressed", "mouseReleased"]) await page.debugger.sendCommand("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 })
      })
    } else {
      await stale("a tap, then the layout shifting", async () => {
        const at = await centre("[data-transcript-viewport]")
        for (const type of ["touchStart", "touchEnd"]) await page.debugger.sendCommand("Input.dispatchTouchEvent", { type, touchPoints: type === "touchStart" ? [{ x: at.x, y: at.y }] : [] })
      })
    }

    // A reader who's truly up: where they are holds through the burst, and nothing piles up behind them.
    await open()
    await evaluate(`(() => { const node = ${VIEW}; node.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true })); return true })()`)
    if (form !== "phone") {
      const at = await centre("[data-transcript-viewport]")
      await wheel(at.x, at.y, -1200)
    } else {
      const at = await centre("[data-transcript-viewport]")
      await page.debugger.sendCommand("Input.synthesizeScrollGesture", { x: at.x, y: at.y, yDistance: 900, gestureSourceType: "touch" })
    }
    await wait(300)
    const up = await evaluate(`(() => { const node = ${VIEW}; const first = [...node.querySelectorAll('[data-exchange]')].find((row) => row.getBoundingClientRect().bottom > node.getBoundingClientRect().top); return { id: first.dataset.exchange, top: first.getBoundingClientRect().top } })()`)
    await evaluate("window.__burst(60, 12)")
    await wait(400)
    const held = await evaluate(`(() => { const row = document.querySelector('[data-exchange="' + ${JSON.stringify(up.id)} + '"]'); return row ? row.getBoundingClientRect().top : null })()`)
    assert.ok(held !== null && Math.abs(held - up.top) <= 1, `${form}: a reader who's up stays put: ${up.top} → ${held}`)
    const mounted = (await reading()).rows
    console.log(`MOUNTED ${form}: ${mounted} turns with the reader up`)
  }

  // What's mounted on the desk stays a window however many turns arrive, for a reader up or at the end.
  await load("/?mock&app=apex&turns=260", 1440, 900)
  await until("document.querySelectorAll('.thread-jump-scope [data-asking-fin]').length === 2", "the long Apex's rail")
  await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.querySelector('[data-fin-pips]')).click(); true")
  await until(`Boolean(${VIEW}) && Boolean(document.querySelector('[data-crew]'))`, "the long Apex")
  await install()
  await wait(400)
  await wheel(700, 400, -2400)
  await wait(300)
  await evaluate("window.__burst(120, 6)")
  await wait(500)
  const windowed = (await reading()).rows
  assert.ok(windowed <= 40, `a reader up in a long Apex keeps a window mounted, not its history: ${windowed}`)
  // A button clicked in a turn leaves focus there: that turn is kept, and the rest can still go.
  await evaluate(`(() => { const button = [...${VIEW}.querySelectorAll('[data-exchange] button')].find((node) => node.getBoundingClientRect().height > 0); button.focus(); return true })()`)
  await wait(300)
  const reader = await evaluate(`Promise.all([import('/src/state/transcript-reading.ts'), import('/src/state/acp-state.ts')]).then(([reading, acp]) => { const held = reading.transcriptReaders.protected(reading.liveReadingSource(acp.activeLiveAcp(acp.acpStore.get()).key)); return { bounded: held !== undefined, size: held?.size ?? 0, focused: held?.has(document.activeElement.closest('[data-exchange]').dataset.exchange) ?? false } })`)
  assert.ok(reader.bounded, "focus resting in a turn doesn't hold every turn in memory")
  assert.equal(reader.focused, true, "and the turn it rests in is kept")
  console.log("MEMORY", JSON.stringify({ windowed, ...reader }))
  // A button held through a wheel, past when its input would settle, in a browser with no `scrollend`: its release ends
  // the input, or the pane counts as moving for good and every turn stays in memory.
  await evaluate("window.addEventListener('scrollend', (event) => event.stopImmediatePropagation(), true); true")
  await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: 700, y: 400, button: "left", clickCount: 1 })
  await wheel(700, 400, -600)
  await wait(600)
  await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: 700, y: 400, button: "left", clickCount: 1 })
  await evaluate("getSelection().removeAllRanges(); true")
  await wait(500)
  const released = await evaluate(`Promise.all([import('/src/state/transcript-reading.ts'), import('/src/state/acp-state.ts')]).then(([reading, acp]) => reading.transcriptReaders.protected(reading.liveReadingSource(acp.activeLiveAcp(acp.acpStore.get()).key))?.size ?? null)`)
  console.log("RELEASED", JSON.stringify({ size: released }))
  assert.ok(released !== null && released <= 40, `a button held through a wheel lets go of memory as it's released: ${released}`)

  // Crossing into a window under a reader who's up: they stay where they are, and what's mounted falls.
  await load("/?mock&app=apex&turns=12", 1440, 900)
  await until("document.querySelectorAll('.thread-jump-scope [data-asking-fin]').length === 2", "the Apex just short of a window's rail")
  await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.querySelector('[data-fin-pips]')).click(); true")
  await until(`Boolean(${VIEW}) && Boolean(document.querySelector('[data-crew]'))`, "the Apex just short of a window")
  await install()
  await wait(400)
  await wheel(700, 400, -1800)
  await wait(300)
  const crossing = await evaluate(`(() => { const node = ${VIEW}; const first = [...node.querySelectorAll('[data-exchange]')].find((row) => row.getBoundingClientRect().bottom > node.getBoundingClientRect().top + 40); return { id: first.dataset.exchange, top: first.getBoundingClientRect().top } })()`)
  assert.equal(await evaluate(`${VIEW}.hasAttribute('data-virtualized')`), false, "the Apex starts short of a window, or nothing crosses")
  await evaluate("window.__burst(60, 10)")
  await wait(700)
  const crossed = await evaluate(`(() => { const row = document.querySelector('[data-exchange="' + ${JSON.stringify(crossing.id)} + '"]'); return { top: row ? row.getBoundingClientRect().top : null, windowed: ${VIEW}.hasAttribute('data-virtualized'), rows: ${VIEW}.querySelectorAll('[data-exchange]').length } })()`)
  console.log("CROSSING", JSON.stringify({ before: crossing.top, ...crossed }))
  assert.equal(crossed.windowed, true, "past 120 items the transcript is windowed")
  assert.ok(crossed.top !== null && Math.abs(crossed.top - crossing.top) <= 2, `crossing into a window moves nothing under the reader: ${crossing.top} → ${crossed.top}`)
  assert.ok(crossed.rows <= 40, `and what's mounted falls: ${crossed.rows}`)


  guard.done()
  console.log("Follow UI: the end kept through every burst, let go only by the reader, and memory bounded behind one who's up")
  app.exit(0)
}
