// Drives /scripts/transcript-scroll-browser.html in headless Chrome and reports
// every movement of the reading position the reader did not ask for.
// Usage: node scripts/transcript-scroll-probe.mjs <app url> [debug port] [turns]
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const app = new URL(process.argv[2] ?? process.env.APP_URL)
const port = Number(process.argv[3] ?? 20022)
const turns = Number(process.argv[4] ?? 90)
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const profile = mkdtempSync(join(tmpdir(), "mako-scroll-probe-"))
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--window-size=1100,900",
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
], { stdio: "ignore" })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function cdpTarget() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
      if (response.ok) return response.json()
    } catch {}
    await sleep(100)
  }
  throw new Error("Chrome did not open its debugging port")
}

const target = await cdpTarget()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})
let nextId = 0
const pending = new Map()
socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  }
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
async function evaluate(fn, arg) {
  const result = await send("Runtime.evaluate", {
    expression: `(${fn})(${JSON.stringify(arg ?? null)})`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
const frames = (count = 2) =>
  evaluate((count) => new Promise((resolve) => {
    let left = count
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
    requestAnimationFrame(tick)
  }), count)

await send("Page.enable")
await send("Runtime.enable")
await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false })

async function open(count = turns, paged = 0) {
  const url = new URL("/scripts/transcript-scroll-browser.html", app)
  url.searchParams.set("turns", String(count))
  if (paged) url.searchParams.set("paged", String(paged))
  await send("Page.navigate", { url: url.href })
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await sleep(100)
    const ready = await evaluate(() => Boolean(document.querySelector("[data-exchange]") && window.probe)).catch(() => false)
    if (ready) break
  }
  await sleep(800)
}

/** Marks the block at the middle of the scrollport and returns where things stand. */
function markAnchor() {
  const scroller = document.querySelector(".scroll-fade-scroller")
  const box = scroller.getBoundingClientRect()
  document.querySelector("[data-probe-anchor]")?.removeAttribute("data-probe-anchor")
  // A point in the gap between turns hits the column, whose top moves with any history added above.
  let element = null
  for (let y = box.height / 2; y < box.height - 20 && !element?.closest("[data-exchange]"); y += 13)
    element = document.elementFromPoint(box.left + 200, box.top + y)
  while (element && element.parentElement && !element.parentElement.matches("article, [data-exchange] > *")) {
    if (element.getBoundingClientRect().height > 8) break
    element = element.parentElement
  }
  element?.setAttribute("data-probe-anchor", "")
  return {
    top: element ? element.getBoundingClientRect().top - box.top : null,
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    exchange: element?.closest("[data-exchange]")?.getAttribute("data-exchange") ?? null,
  }
}

function readAnchor() {
  const scroller = document.querySelector(".scroll-fade-scroller")
  const box = scroller.getBoundingClientRect()
  const element = document.querySelector("[data-probe-anchor]")
  return {
    top: element && element.isConnected ? element.getBoundingClientRect().top - box.top : null,
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    edge: document.querySelector("[data-earlier]")?.getAttribute("data-earlier") ?? null,
    mounted: document.querySelectorAll("[data-exchange]").length,
  }
}

async function wheel(deltaY) {
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 500, y: 450, deltaX: 0, deltaY })
}

async function scrollUpThrough(label, step = -120, settle = 220) {
  const jumps = []
  let steps = 0
  for (; steps < 1500; steps += 1) {
    const before = await evaluate(markAnchor)
    await wheel(step)
    await sleep(settle)
    await frames()
    const after = await evaluate(readAnchor)
    if (before.top !== null && after.top !== null) {
      const scrolled = after.scrollTop - before.scrollTop
      // Scrolling up by `step` moves what the reader sees down by exactly that much.
      const jump = after.top - before.top + step
      const clamped = before.scrollTop + step <= 0
      if (!clamped && Math.abs(jump) > 3)
        jumps.push({ step: steps, exchange: before.exchange, jump: Math.round(jump), scrolled: Math.round(scrolled), scrollTop: Math.round(after.scrollTop), heightChange: Math.round(after.scrollHeight - before.scrollHeight), edge: after.edge, mounted: after.mounted })
    }
    if (after.scrollTop <= 0 && after.edge !== "loading" && after.edge !== "more") break
  }
  const total = jumps.reduce((sum, jump) => sum + Math.abs(jump.jump), 0)
  console.log(`\n${label}: ${steps} wheel steps of ${step}px, ${jumps.length} unasked movements, ${Math.round(total)}px in total`)
  for (const jump of jumps.slice(0, 25)) console.log("  ", JSON.stringify(jump))
  if (jumps.length > 25) console.log(`   … ${jumps.length - 25} more`)
  return jumps
}

/** A short session whose source serves earlier turns in pages, read to its beginning. */
async function sourcePages(paged, delta = Number(process.env.DELTA ?? -60)) {
  await open(turns, paged)
  const jumps = []
  let gesture = 0
  const requested = 20 * delta
  for (; gesture < 600; gesture += 1) {
    const before = await evaluate(markAnchor)
    for (let event = 0; event < 20; event += 1) {
      await wheel(delta)
      await sleep(16)
    }
    await sleep(450)
    const after = await evaluate(readAnchor)
    if (before.top !== null && after.top !== null && before.scrollTop + requested > 0) {
      const jump = after.top - before.top + requested
      if (Math.abs(jump) > 3) jumps.push({ gesture, jump: Math.round(jump), scrollTop: Math.round(after.scrollTop), edge: after.edge, mounted: after.mounted, height: after.scrollHeight - before.scrollHeight })
    }
    if (after.edge === "start" && after.scrollTop <= 0) break
  }
  const end = await evaluate(readAnchor)
  console.log(`\nSource paging from ${paged} turns (${turns} in all): reached ${end.edge === "start" ? "the beginning" : `edge "${end.edge}"`} after ${gesture} gestures with ${end.mounted} turns mounted; ${jumps.length} unasked movements`)
  for (const jump of jumps.slice(0, 20)) console.log("  ", JSON.stringify(jump))
}

/** Trackpad-like gestures: a stream of small wheel events, then a pause. */
async function gestures(count, events = 20, delta = -30) {
  await open()
  const jumps = []
  let gesture = 0
  for (; gesture < count; gesture += 1) {
    const before = await evaluate(markAnchor)
    for (let event = 0; event < events; event += 1) {
      await wheel(delta)
      await sleep(16)
    }
    await sleep(350)
    await frames()
    const after = await evaluate(readAnchor)
    if (before.top === null || after.top === null) continue
    const requested = events * delta
    if (before.scrollTop + requested <= 0) break
    const jump = after.top - before.top + requested
    if (Math.abs(jump) > 3) jumps.push({ gesture, exchange: before.exchange, jump: Math.round(jump), scrollTop: Math.round(after.scrollTop), heightChange: Math.round(after.scrollHeight - before.scrollHeight), edge: after.edge, mounted: after.mounted })
  }
  const total = jumps.reduce((sum, jump) => sum + Math.abs(jump.jump), 0)
  console.log(`\nTrackpad gestures up from the end (${turns} turns): ${gesture} gestures of ${events}×${delta}px, ${jumps.length} unasked movements, ${Math.round(total)}px in total`)
  for (const jump of jumps.slice(0, 30)) console.log("  ", JSON.stringify(jump))
}

async function turnFinishesWhileReading() {
  await open()
  for (let step = 0; step < 25; step += 1) {
    await wheel(-120)
    await sleep(60)
  }
  await sleep(1200)
  const before = await evaluate(markAnchor)
  await evaluate(() => window.probe.startTurn())
  for (let chunk = 0; chunk < 30; chunk += 1) {
    await evaluate((chunk) => window.probe.appendToTurn(`Streaming paragraph ${chunk}. ${"The answer keeps arriving while the reader is elsewhere. ".repeat(14)}\n\n`), chunk)
    await sleep(40)
  }
  const streamed = await evaluate(readAnchor)
  await evaluate(() => window.probe.finishTurn())
  await sleep(1200)
  const finished = await evaluate(readAnchor)
  console.log(`\nTurn streams and finishes while the reader is scrolled up:`)
  console.log(`   while streaming: anchor moved ${Math.round(streamed.top - before.top)}px`)
  console.log(`   after finishing: anchor moved ${Math.round(finished.top - before.top)}px (scrollTop ${Math.round(before.scrollTop)} → ${Math.round(finished.scrollTop)})`)
}

async function turnFinishesWhileReadingIt() {
  await open()
  await evaluate(() => window.probe.startTurn())
  for (let chunk = 0; chunk < 30; chunk += 1) {
    await evaluate((chunk) => window.probe.appendToTurn(`Streaming paragraph ${chunk}. ${"The answer keeps arriving at the end. ".repeat(20)}\n\n`), chunk)
    await sleep(40)
  }
  await sleep(400)
  for (let step = 0; step < 6; step += 1) {
    await wheel(-120)
    await sleep(80)
  }
  await sleep(800)
  const before = await evaluate(markAnchor)
  await evaluate(() => window.probe.finishTurn())
  await sleep(1200)
  const finished = await evaluate(readAnchor)
  console.log(`\nTurn finishes while the reader is reading its answer (work log above folds):`)
  console.log(`   anchor in ${before.exchange} moved ${Math.round(finished.top - before.top)}px (scrollTop ${Math.round(before.scrollTop)} → ${Math.round(finished.scrollTop)}, height ${before.scrollHeight} → ${finished.scrollHeight})`)
}

async function turnFinishesAtBottom() {
  await open()
  await evaluate(() => window.probe.startTurn())
  for (let chunk = 0; chunk < 30; chunk += 1) {
    await evaluate((chunk) => window.probe.appendToTurn(`Streaming paragraph ${chunk}. ${"The answer keeps arriving at the end. ".repeat(20)}\n\n`), chunk)
    await sleep(40)
  }
  await sleep(300)
  const streamed = await evaluate(() => { const s = document.querySelector(".scroll-fade-scroller"); return s.scrollHeight - s.scrollTop - s.clientHeight })
  await evaluate(() => window.probe.finishTurn())
  await sleep(1200)
  const finished = await evaluate(() => { const s = document.querySelector(".scroll-fade-scroller"); return s.scrollHeight - s.scrollTop - s.clientHeight })
  console.log(`\nTurn streams and finishes while following the end:`)
  console.log(`   distance from the end while streaming ${Math.round(streamed)}px, after finishing ${Math.round(finished)}px`)
}

/**
 * Where the reader is, by the position of the turn at the middle of the
 * scrollport in the list. A checkpoint renames every turn, so a marked
 * element would not survive it; the order does.
 */
function readerByPosition() {
  const scroller = document.querySelector(".scroll-fade-scroller")
  const box = scroller.getBoundingClientRect()
  const turns = [...document.querySelectorAll("[data-exchange]")]
  const middle = box.top + box.height / 2
  const index = turns.findIndex((turn) => turn.getBoundingClientRect().bottom > middle)
  const turn = turns[index]
  if (turn) turn.__reader = true
  return {
    fromEnd: index < 0 ? null : turns.length - index,
    question: turn?.textContent.match(/Question \d+:|Stream a long answer/)?.[0] ?? null,
    top: turn ? turn.getBoundingClientRect().top - box.top : null,
    distance: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    scrollTop: scroller.scrollTop,
  }
}

/** The reader's turn afterwards: the same element if it stayed mounted, else the one with its question, else the one as far from the end. */
function readerAfter({ fromEnd, question }) {
  const scroller = document.querySelector(".scroll-fade-scroller")
  const turns = [...document.querySelectorAll("[data-exchange]")]
  const kept = turns.find((turn) => turn.__reader)
  const turn = kept ?? (question && turns.find((turn) => turn.textContent.includes(question))) ?? turns[turns.length - fromEnd]
  return {
    kept: Boolean(kept),
    top: turn ? turn.getBoundingClientRect().top - scroller.getBoundingClientRect().top : null,
    distance: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    scrollTop: scroller.scrollTop,
  }
}

/** A turn finishes and the host's checkpoint hands it to native history: every turn returns under a new id. */
async function checkpointAfterTurn() {
  const stream = async () => {
    await evaluate(() => window.probe.startTurn())
    for (let chunk = 0; chunk < 30; chunk += 1) {
      await evaluate((chunk) => window.probe.appendToTurn(`Streaming paragraph ${chunk}. ${"The answer keeps arriving. ".repeat(20)}\n\n`), chunk)
      await sleep(40)
    }
    await sleep(300)
  }
  const settle = async (variant) => {
    await evaluate(() => window.probe.finishTurn())
    await sleep(600)
    await evaluate((variant) => window.probe.checkpoint(variant), variant)
    await sleep(1200)
    await frames()
  }
  const variants = (process.env.CHECKPOINT ?? "renamed,retold,reworded,uneven").split(",")
  console.log(`\nThe host checkpoints a finished turn (${turns} turns):`)
  for (const variant of variants) {
    await open()
    await stream()
    await settle(variant)
    const following = await evaluate(readerByPosition)
    console.log(`   ${variant}, following the end: ${Math.round(following.distance)}px from the end afterwards`)
    for (const [label, steps] of [["reading the answer that just finished", 6], ["reading an earlier turn", 80]]) {
      await open()
      await stream()
      for (let step = 0; step < steps; step += 1) {
        await wheel(-120)
        await sleep(50)
      }
      await sleep(900)
      const before = await evaluate(readerByPosition)
      await settle(variant)
      const after = await evaluate(readerAfter, before)
      if (process.env.TRACE_CHECKPOINT) for (const entry of await evaluate(() => (window.__log ?? []).slice(-12))) console.log("      ", JSON.stringify(entry))
      console.log(`   ${variant}, ${label} (${before.question}, ${before.fromEnd} from the end): moved ${Math.round(after.top - before.top)}px, ${after.kept ? "stayed mounted" : "remounted"} (scrollTop ${Math.round(before.scrollTop)} → ${Math.round(after.scrollTop)})`)
    }
  }
}

/** Where each turn's top sits after clicking its tick; it belongs at the scroll margin (24px). */
async function navigatorJumps(targets) {
  await open()
  const results = []
  for (const index of targets) {
    const id = `u${index}`
    const clicked = await evaluate(async ([label, index]) => {
      const list = document.querySelector('nav[aria-label="Previous prompts"] > div')
      if (list) list.scrollTop = Math.max(0, index * 14 - list.clientHeight / 2)
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const ticks = [...document.querySelectorAll('nav[aria-label="Previous prompts"] button[aria-label]')]
      const tick = ticks.find((button) => button.getAttribute("aria-label")?.startsWith(label))
      tick?.click()
      return Boolean(tick)
    }, [`Question ${index}:`, index])
    const samples = []
    for (let wait = 0; wait < 8; wait += 1) {
      await sleep(250)
      samples.push(await evaluate((id) => {
        const scroller = document.querySelector(".scroll-fade-scroller")
        const turn = document.querySelector(`[data-exchange="${id}"]`)
        return turn ? Math.round(turn.getBoundingClientRect().top - scroller.getBoundingClientRect().top) : null
      }, id))
    }
    results.push({ target: id, clicked, settledAt: samples.at(-1), path: samples.join(" → ") })
  }
  const misses = results.filter((result) => result.settledAt === null || Math.abs(result.settledAt - 24) > 4)
  console.log(`\nNavigator jumps: ${misses.length} of ${results.length} landed away from the turn's top`)
  for (const result of results) console.log("  ", JSON.stringify(result))
}

async function traceJump(index) {
  await open()
  await evaluate(async (index) => {
    const list = document.querySelector('nav[aria-label="Previous prompts"] > div')
    if (list) list.scrollTop = Math.max(0, index * 14 - list.clientHeight / 2)
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }, index)
  await evaluate((id) => {
    window.__log = []
    const scroller = document.querySelector(".scroll-fade-scroller")
    let last = scroller.scrollTop
    const sample = () => {
      if (Math.abs(scroller.scrollTop - last) > 0.5) {
        const turn = document.querySelector(`[data-exchange="${id}"]`)
        window.__log.push({ at: Math.round(performance.now()), top: Math.round(scroller.scrollTop), height: scroller.scrollHeight, target: turn ? Math.round(turn.getBoundingClientRect().top - scroller.getBoundingClientRect().top) : null, mounted: document.querySelectorAll("[data-exchange]").length })
        last = scroller.scrollTop
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    const ticks = [...document.querySelectorAll('nav[aria-label="Previous prompts"] button[aria-label]')]
    ticks.find((button) => button.getAttribute("aria-label")?.startsWith(`Question ${id.slice(1)}:`))?.click()
  }, `u${index}`)
  await sleep(2500)
  const log = await evaluate(() => window.__log)
  console.log(`\nTrace of a jump to u${index}:`)
  for (const entry of log) console.log("  ", JSON.stringify(entry))
}

/** The UI pilot page's own checks, which include prepending history around the reading anchor. */
async function pilot() {
  await send("Emulation.setFocusEmulationEnabled", { enabled: true })
  await send("Page.navigate", { url: new URL("/scripts/ui-pilot-browser.html", app).href })
  for (let wait = 0; wait < 100; wait += 1) {
    await sleep(200)
    if (await evaluate(() => document.querySelector("#root > button") !== null).catch(() => false)) break
  }
  await evaluate(() => document.querySelector("#root > button").click())
  let text = ""
  for (let wait = 0; wait < 120; wait += 1) {
    await sleep(500)
    text = await evaluate(() => document.querySelector("pre")?.textContent ?? "")
    if (/All UI regression checks passed|FAIL/.test(text)) break
  }
  console.log(`\nUI pilot checks:\n${text}`)
}

try {
  if (process.env.PILOT) await pilot()
  if (process.env.TRACE) await traceJump(Number(process.env.TRACE))
  const only = process.env.TRACE || process.env.PILOT ? [] : process.env.PROBE?.split(",")
  const want = (name) => !only || only.includes(name)
  if (want("wheel")) {
    await open()
    await scrollUpThrough(`Wheel up from the end (${turns} turns)`, -240, 140)
  }
  if (want("gesture")) await gestures(Number(process.env.GESTURES ?? 60))
  if (want("paged")) for (const paged of (process.env.PAGED ?? "12,45").split(",")) await sourcePages(Number(paged))
  if (want("finish")) await turnFinishesWhileReading()
  if (want("bottom")) await turnFinishesAtBottom()
  if (want("inturn")) await turnFinishesWhileReadingIt()
  if (want("checkpoint")) await checkpointAfterTurn()
  if (want("navigator")) await navigatorJumps(turns > 100 ? [250, 230, 200, 150, 90, 20, 180, 255, 259, 120] : [80, 72, 64, 50, 40, 25, 8, 70, 88, 89, 30])
} finally {
  socket.close()
  chrome.kill()
  await sleep(300)
  rmSync(profile, { recursive: true, force: true })
}
