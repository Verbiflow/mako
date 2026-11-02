import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// A lead's Threads on the desk and the phone, through production components on the mock bridge (`?mock&app=lead`):
// the rail lists no child and wears the lead's badge; a child's tab opens it in place with its brief and its
// breadcrumb, and Back returns; Stop in the lead's composer asks first; the Agents panel groups the children; the
// phone's list, chips, child and stop. Screenshots of each, dark and light, land in the evidence folder (or
// `MAKO_ORCH_UI_SHOTS`). Pass a dev server's URL to use it (`node scripts/test-orch-ui.mjs http://127.0.0.1:20026/`);
// with none it serves its own. `--bench` measures the strip, badge and panel under churn, and a rail of 50 leads.
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = await mkdtemp(join(tmpdir(), "mako-orch-ui-"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-orch-ui", main: fileURLToPath(import.meta.url) }))
  const given = process.argv.slice(2).find((arg) => /^https?:/.test(arg))
  let server
  if (!given) {
    const { createServer } = await import("vite")
    server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
    await server.listen()
  }
  const env = { ...process.env, MAKO_ORCH_UI_ROOT: root, MAKO_ORCH_UI_URL: given ?? server.resolvedUrls.local[0], MAKO_ORCH_UI_BENCH: process.argv.includes("--bench") ? "1" : "" }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server?.close()
  }
  console.log(`Orchestration UI evidence: ${root}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_ORCH_UI_ROOT
  const shots = process.env.MAKO_ORCH_UI_SHOTS ?? join(root, "shots")
  await mkdir(shots, { recursive: true })
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  await app.whenReady()
  const base = process.env.MAKO_ORCH_UI_URL
  if (process.env.MAKO_ORCH_UI_BENCH) {
    // Each measurement has a window of its own; between them none is open, which isn't the end.
    app.on("window-all-closed", () => undefined)
    const numbers = await bench(BrowserWindow, base, root)
    console.log(`BENCH ${JSON.stringify(numbers)}`)
    if (process.env.MAKO_ORCH_UI_BENCH_OUT) await writeFile(process.env.MAKO_ORCH_UI_BENCH_OUT, `${JSON.stringify(numbers, null, 2)}\n`)
    app.exit(0)
    return
  }
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } })
  const page = window.webContents
  const errors = []
  page.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const until = async (code, what = code) => {
    const deadline = Date.now() + 20_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${errors.length ? `; the page said: ${errors.join(" | ")}` : ""}`)
      await new Promise((done) => setTimeout(done, 40))
    }
  }
  // Fonts in, finite animations done (a card entering), and two frames painted.
  const settle = () =>
    evaluate(
      "document.fonts.ready.then(() => Promise.all(document.getAnimations().filter((each) => each.effect?.getTiming().iterations !== Infinity).map((each) => each.finished.catch(() => undefined)))).then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))).then(() => true)"
    )
  const capture = async (name) => {
    await settle()
    await writeFile(join(shots, `orch-build-ui-${name}.png`), (await page.capturePage()).toPNG())
  }
  const theme = (light) => evaluate(`document.documentElement.classList.toggle('light', ${light}); document.documentElement.style.colorScheme = '${light ? "light" : "dark"}'; true`)
  const both = async (name) => {
    await theme(false)
    await capture(`${name}-dark`)
    await theme(true)
    await capture(`${name}-light`)
    await theme(false)
  }
  const click = (selector) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true })()`)
  const press = (selector) =>
    evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 1 })); node.click(); return true })()`)

  await window.loadURL(`${base}?mock&app=lead`)
  await until("Boolean(document.querySelector('.thread-jump-scope [data-rollup]'))", "the lead's badge in the rail")

  // The rail lists the lead once and none of its Threads.
  const children = await evaluate("window.leadScene.children().map((agent) => agent.title)")
  assert.equal(children.length, 12)
  const rail = await evaluate("document.querySelector('.thread-jump-scope').innerText")
  for (const title of children) assert.ok(!rail.includes(title), `the rail lists no child: ${title}`)
  assert.equal(await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-rollup]')].length"), 1, "one lead row wears the badge")
  const label = await evaluate("document.querySelector('.thread-jump-scope [data-rollup]').getAttribute('aria-label')")
  assert.equal(label, "12 Threads: 2 need you, 5 working, 2 queued, 3 done")
  assert.equal(await evaluate("document.querySelector('.thread-jump-scope [data-rollup]').getAttribute('title')"), label)
  await both("rail")

  // Recent, Status and search list none of them either; the lead is there in each.
  for (const scope of ["Recent", "Status", "Projects"]) {
    await evaluate(`[...document.querySelectorAll('[aria-label="Thread view"] button')].find((button) => button.innerText === ${JSON.stringify(scope)}).click(); true`)
    await until(`[...document.querySelectorAll('[aria-label="Thread view"] button')].find((button) => button.innerText === ${JSON.stringify(scope)})?.getAttribute('aria-pressed') === 'true'`, `the rail's ${scope}`)
    await settle()
    const listed = await evaluate("document.querySelector('.thread-jump-scope').innerText")
    assert.match(listed, /Mobile lead/, `${scope} lists the lead`)
    for (const title of children) assert.ok(!listed.includes(title), `${scope} lists no child: ${title}`)
  }
  await click('[aria-label="Search threads"]')
  await until("Boolean(document.querySelector('[aria-label=\"Search every thread\"]'))", "the rail's search")
  for (const query of ["Sheet motion", "Mobile"]) {
    await evaluate(`(() => { const input = document.querySelector('[aria-label="Search every thread"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await settle()
    const found = await evaluate("document.querySelector('.thread-jump-scope').innerText")
    if (query === "Mobile") {
      assert.match(found, /Mobile lead/, "search finds the lead")
      assert.ok(!found.includes("Refactor the composer"), "search filters the rail")
    }
    else assert.ok(!found.includes("Sheet motion on iPad"), "search finds no child")
  }
  await click('[aria-label="Close search"]')

  // The lead opens from its row.
  await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.querySelector('[data-rollup]')).click(); true")
  // The strip: the lead's Sessions, a hairline, the count, then as many child tabs as fit and "+N".
  await until("Boolean(document.querySelector('[data-child-tabs] [data-child-tab]'))", "the lead's child tabs")
  const strip = await evaluate(`(() => {
    const tabs = [...document.querySelectorAll('[data-child-tab]')]
    const more = document.querySelector('[data-child-more]')
    return { tabs: tabs.map((tab) => tab.title), more: more ? Number(more.dataset.childMore) : 0, count: document.querySelector('[data-lead-count]')?.dataset.leadCount }
  })()`)
  console.log("STRIP", JSON.stringify(strip))
  // The composer's agents line counts the lead's Threads by the rollup: queued and asking ones aren't "running".
  assert.equal(await evaluate("document.querySelector('[data-agents-toggle]')?.innerText.trim()"), "5 working · 2 need you")
  await both("strip")

  // The count opens the Agents panel: the lead's Threads by group, above what its harness runs in the turn.
  await click("[data-lead-count]")
  await until("Boolean(document.querySelector('[data-lead-children]'))", "the panel's children section")
  const panel = await evaluate(`(() => {
    const section = document.querySelector('[data-lead-children]')
    return { heading: section.querySelector('div').innerText, groups: [...section.querySelectorAll('[data-child-group]')].map((group) => group.innerText.replace(/\\s+/g, ' ')), rows: section.querySelectorAll('[data-child-row]').length }
  })()`)
  console.log("PANEL", JSON.stringify(panel))
  assert.match(panel.heading, /Mobile lead's Threads/)
  assert.match(panel.heading, /12/)
  assert.match(panel.heading, /Stop all/)
  assert.deepEqual(panel.groups, ["Needs you 2", "Working 5", "Queued 2", "Done 3"])
  await both("panel")

  // A child's tab opens it in place: its breadcrumb, its brief from the lead first, the approval it waits on, its
  // composer saying the lead hears it, and its tab selected in the lead's strip.
  const opened = await evaluate(`(() => { const tab = [...document.querySelectorAll('[data-child-tab]')].find((node) => node.title.startsWith('Sheet motion')); return tab?.dataset.childTab })()`)
  assert.ok(opened, "the child waiting on approval has a tab")
  await press(`[data-child-tab="${opened}"]`)
  await until("Boolean(document.querySelector('[data-child-breadcrumb]'))", "the child's breadcrumb")
  await until("Boolean(document.querySelector('[data-agent-words=Brief]'))", "the brief's card")
  const child = await evaluate(`(() => ({
    crumb: document.querySelector('[data-child-breadcrumb]').innerText.replace(/\\s+/g, ' '),
    brief: document.querySelector('[data-agent-words=Brief]').innerText.replace(/\\s+/g, ' '),
    first: document.querySelector('[data-exchange]')?.querySelector('[data-agent-words]') !== null,
    note: document.querySelector('[data-child-note]')?.innerText,
    selected: document.querySelector('[data-child-tab="${opened}"]').getAttribute('aria-selected'),
    sessionSelected: [...document.querySelectorAll('[data-session-tab]')].some((tab) => tab.getAttribute('aria-selected') === 'true'),
    approval: document.body.innerText.includes('Allow once'),
    lit: document.querySelector('[data-child-row][aria-current=true]')?.innerText.split('\\n')[0],
  }))()`)
  console.log("CHILD", JSON.stringify(child))
  assert.match(child.crumb, /^Mobile lead \/ Sheet motion on iPad/)
  assert.match(child.crumb, /Stop$/)
  assert.match(child.brief, /^From Mobile lead · Brief/)
  assert.doesNotMatch(child.brief, /agents_report|You're child:/, "the brief's lines for the child alone stay out of the card")
  assert.equal(child.first, true, "the brief is the first card")
  assert.equal(child.note, "Mobile lead hears what you say here")
  assert.equal(child.selected, "true")
  assert.equal(child.sessionSelected, false, "no Session of the lead is selected while its child is shown")
  assert.equal(child.approval, true)
  assert.equal(child.lit, "Sheet motion on iPad", "the panel keeps the lead's Threads, the open one lit")
  await both("child")

  // Back returns to the lead; the lead's own tab does too.
  await click("[data-child-breadcrumb] button")
  await until("!document.querySelector('[data-child-breadcrumb]') && [...document.querySelectorAll('[data-session-tab]')].some((tab) => tab.getAttribute('aria-selected') === 'true')", "the lead after Back")
  await press(`[data-child-tab="${opened}"]`)
  await until("Boolean(document.querySelector('[data-child-breadcrumb]'))", "the child again")
  await press("[data-session-tab]")
  await until("!document.querySelector('[data-child-breadcrumb]')", "the lead after its tab")

  // Stop in the lead's composer asks first while any of its Threads works.
  const stop = "[data-composer] button[aria-label=Stop]"
  await until(`Boolean(document.querySelector(${JSON.stringify(stop)}))`, "the lead's Stop")
  await click(stop)
  await until("Boolean(document.querySelector('[data-stop-lead]'))", "the stop popover")
  const popover = await evaluate(`(() => {
    const card = document.querySelector('[data-stop-lead]')
    const box = card.getBoundingClientRect()
    return { width: box.width, height: box.height, text: card.innerText.replace(/\\s+/g, ' '), focused: document.activeElement?.innerText, scrim: getComputedStyle(document.body).overflow }
  })()`)
  console.log("STOP", JSON.stringify(popover))
  assert.ok(popover.width <= 320 && popover.height <= 120, `the popover is at most 320×120 (${popover.width}×${popover.height})`)
  assert.match(popover.text, /^5 of its Threads are working/)
  assert.match(popover.text, /Stop the lead only/)
  assert.match(popover.text, /Stop all \d+/)
  assert.equal(popover.focused, "Stop the lead only", "the safe choice is focused")
  await both("stop")
  await evaluate("[...document.querySelectorAll('[data-stop-lead] button')].find((button) => button.innerText === 'Stop the lead only').click(); true")
  await until("!document.querySelector('[data-stop-lead]')", "the popover closing on Stop the lead only")
  await evaluate("window.leadScene.setRunning(true); true")
  await until(`Boolean(document.querySelector(${JSON.stringify(stop)}))`, "the lead's Stop again")
  await click(stop)
  await until("Boolean(document.querySelector('[data-stop-lead]'))", "the popover reopening")
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true")
  await until("!document.querySelector('[data-stop-lead]')", "Escape closing the popover")
  assert.ok(await evaluate(`Boolean(document.querySelector(${JSON.stringify(stop)}))`), "Escape closed the popover without stopping the lead")
  await click(stop)
  await until("Boolean(document.querySelector('[data-stop-lead]'))", "the popover again")
  await evaluate("document.querySelector('main').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true")
  await until("!document.querySelector('[data-stop-lead]')", "an outside click closing the popover")

  // The phone: the list shows the lead as one row with the same badge; its screen's chips open a child, whose back
  // reads the lead's name; Stop asks first, full width.
  window.setContentSize(390, 844)
  await window.loadURL(`${base}scripts/phone-lead.html?app=lead`)
  await until("Boolean(document.querySelector('[data-thread] [data-rollup]'))", "the lead's badge in the phone's list")
  const list = await evaluate(`(() => ({ text: document.querySelector('[data-list]').innerText, rows: document.querySelectorAll('[data-thread]').length, label: document.querySelector('[data-thread] [data-rollup]').getAttribute('aria-label') }))()`)
  for (const title of children) assert.ok(!list.text.includes(title), `the phone's list lists no child (${title})`)
  assert.equal(list.rows, 4)
  assert.equal(list.label, "12 Threads: 2 need you, 5 working, 2 queued, 3 done")
  await both("phone-list")
  await click("[data-thread]")
  await until("Boolean(document.querySelector('[data-child-chips]'))", "the lead's chips")
  const chips = await evaluate("[...document.querySelectorAll('[data-child-chip]')].map((chip) => chip.innerText.replace(/\\s+/g, ' '))")
  console.log("CHIPS", JSON.stringify(chips))
  assert.equal(chips.length, 7, "chips for the children that need the person or are working")
  assert.match(chips[0], /Sheet motion|Push wording/)
  await until("Boolean(document.querySelector('[data-send-action=stop]'))", "the lead's transcript and dock on the phone")
  await both("phone-lead")
  // The count opens the Agents sheet on the lead's Threads; a row there opens that Thread, the sheet put away.
  assert.equal(await evaluate("document.querySelector('[data-child-chips] [data-lead-count]')?.dataset.leadCount"), "12")
  await click("[data-child-chips] [data-lead-count]")
  await until("Boolean(document.querySelector('[data-agents-sheet] [data-lead-children]'))", "the phone's Agents sheet on the lead's Threads")
  await both("phone-agents")
  await click(`[data-agents-sheet] [data-child-row="${opened}"]`)
  await until("Boolean(document.querySelector('[data-child-of]')) && !document.querySelector('[data-agents-sheet] [data-lead-children]')", "the child from the sheet")
  await click("[data-back-to-lead]")
  await until("Boolean(document.querySelector('[data-child-chips]')) && !document.querySelector('[data-child-of]')", "the lead again")
  await click(`[data-child-chip="${opened}"]`)
  await until("Boolean(document.querySelector('[data-child-of]'))", "the child on the phone")
  await until("Boolean(document.querySelector('[data-agent-words=Brief]'))", "the child's brief on the phone")
  const phoneChild = await evaluate(`(() => ({ back: document.querySelector('[data-back-to-lead]')?.innerText, brief: document.querySelector('[data-agent-words=Brief]').innerText.replace(/\\s+/g, ' '), note: document.querySelector('[data-child-note]')?.innerText }))()`)
  console.log("PHONE CHILD", JSON.stringify(phoneChild))
  assert.equal(phoneChild.back, "Mobile lead")
  assert.match(phoneChild.brief, /^From Mobile lead · Brief/)
  assert.equal(phoneChild.note, "Mobile lead hears what you say here")
  await both("phone-child")
  await click("[data-back-to-lead]")
  await until("Boolean(document.querySelector('[data-child-chips]')) && !document.querySelector('[data-child-of]')", "the lead after the phone's back")
  const phoneStop = "[data-send-action=stop]"
  await until(`Boolean(document.querySelector(${JSON.stringify(phoneStop)}))`, "the lead's Stop on the phone")
  await click(phoneStop)
  await until("Boolean(document.querySelector('[data-stop-lead]'))", "the stop popover on the phone")
  const phonePopover = await evaluate("(() => { const box = document.querySelector('[data-stop-lead]').getBoundingClientRect(); return { left: box.left, right: innerWidth - box.right, height: box.height } })()")
  console.log("PHONE STOP", JSON.stringify(phonePopover))
  assert.deepEqual([Math.round(phonePopover.left), Math.round(phonePopover.right)], [12, 12], "full width less its margins")
  assert.ok(phonePopover.height <= 120)
  await both("phone-stop")

  assert.deepEqual(errors.filter((message) => !/Download the React DevTools/.test(message)), [])
  console.log("Orchestration UI: passed")
  app.exit(0)
}

/**
 * Counts each commit's renders by area (the rail, the strip, the Agents panel) and by component, the way React
 * DevTools does: a fiber rendered in a commit if it did work (`PerformedWork`) and began anew (`actualStartTime`, which a
 * subtree React skipped keeps). Installed before React loads, in the counting window only: the walk costs frames.
 */
const COMMIT_COUNTER = `
const PERFORMED = 1
const AREAS = { rail: "AgentThreads", strip: "StageStrip", panel: "AgentsPanel" }
const began = new WeakMap()
let tally = { commits: 0, areas: {}, components: {}, renderMs: 0, longestCommitMs: 0 }
const nameOf = (type) => (typeof type === "function" ? type.displayName || type.name : type && typeof type === "object" ? type.displayName || nameOf(type.type) || nameOf(type.render) : undefined)
function walk(fiber, area, touched) {
  for (; fiber; fiber = fiber.sibling) {
    const name = nameOf(fiber.type)
    const root = name && Object.keys(AREAS).find((key) => AREAS[key] === name)
    const here = root || area
    // An area's root sums the time its subtree took in this commit, whenever React went through it.
    if (root && began.get(fiber) !== fiber.actualStartTime) touched[root + "Ms"] = (touched[root + "Ms"] ?? 0) + (fiber.actualDuration ?? 0)
    if (typeof fiber.type !== "string" && fiber.flags & PERFORMED && began.get(fiber) !== fiber.actualStartTime) {
      if (here) touched[here] = (touched[here] ?? 0) + 1
      if (name) tally.components[name] = (tally.components[name] ?? 0) + 1
    }
    began.set(fiber, fiber.actualStartTime)
    walk(fiber.child, here, touched)
  }
}
window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true,
  renderers: new Map(),
  inject: () => 1,
  onCommitFiberRoot(_, root) {
    tally.commits++
    tally.renderMs += root.current.actualDuration ?? 0
    tally.longestCommitMs = Math.max(tally.longestCommitMs, root.current.actualDuration ?? 0)
    const touched = {}
    walk(root.current, undefined, touched)
    for (const area of Object.keys(AREAS)) {
      if (!touched[area] && !touched[area + "Ms"]) continue
      const held = (tally.areas[area] ??= { commits: 0, renders: 0, ms: 0 })
      if (touched[area]) held.commits++
      held.renders += touched[area] ?? 0
      held.ms += touched[area + "Ms"] ?? 0
    }
  },
  onCommitFiberUnmount() {},
  onPostCommitFiberRoot() {},
  checkDCE() {},
}
window.__benchTally = () => JSON.parse(JSON.stringify(tally))
window.__benchReset = () => (tally = { commits: 0, areas: {}, components: {}, renderMs: 0, longestCommitMs: 0 })
`

/** Every frame's gap while it runs, and the longest animation frame Chromium saw. */
const FRAME_WATCH = `(() => {
  const watch = { gaps: [], longest: 0 }
  let last = performance.now()
  let on = true
  const frame = (now) => { watch.gaps.push(now - last); last = now; if (on) requestAnimationFrame(frame) }
  requestAnimationFrame(frame)
  const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) watch.longest = Math.max(watch.longest, entry.duration) })
  observer.observe({ type: "long-animation-frame" })
  window.__frames = () => { on = false; observer.disconnect(); return watch }
  return true
})()`

function frameNumbers({ gaps, longest }) {
  const sorted = gaps.toSorted((left, right) => left - right)
  const round = (value) => Math.round(value * 10) / 10
  return { frames: gaps.length, longestFrameMs: round(sorted.at(-1) ?? 0), p95FrameMs: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0), over33ms: gaps.filter((gap) => gap > 33.4).length, longestAnimationFrameMs: round(longest) }
}

/**
 * The numbers the brief asks for, on the mock: twenty children each changing once a second under the lead's strip,
 * the rail's badge and the Agents panel (commits a second by area, renders a second by component, the longest
 * frame); and a rail of fifty leads of twenty Threads each (its first render, and frames scrolling it).
 */
async function bench(BrowserWindow, base, root) {
  const preload = join(root, "commit-counter.cjs")
  await writeFile(preload, COMMIT_COUNTER)
  const open = async (query, counting) => {
    const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false, ...(counting && { preload, contextIsolation: false, sandbox: false }) } })
    // A cold dev server reloads the page once its dependencies are bundled, aborting this load; the wait below holds.
    await window.loadURL(`${base}?mock&app=lead${query}`).catch((error) => {
      if (!/ERR_ABORTED|ERR_FAILED/.test(String(error))) throw error
    })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const until = async (code, what) => {
      const deadline = Date.now() + 30_000
      while (!(await evaluate(code))) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
        await new Promise((done) => setTimeout(done, 25))
      }
    }
    return { window, evaluate, until }
  }
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  const SECONDS = 10

  // The lead open, its Agents panel showing, twenty children churning: one moves every 50 ms, so each once a second.
  const churned = async (counting) => {
    const { window, evaluate, until } = await open("", counting)
    await until("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].some((row) => row.innerText.includes('Mobile lead'))", "the lead's row")
    await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.innerText.includes('Mobile lead')).click(); true")
    await until("Boolean(document.querySelector('[data-composer]'))", "the lead's composer")
    await evaluate("[...document.querySelectorAll('button, [role=tab]')].find((node) => node.innerText.trim() === 'Agents')?.click(); true")
    await evaluate("window.__stopChurn = window.leadScene.churn(20, 50); true")
    await wait(2000)
    if (counting) await evaluate("window.__benchReset(); true")
    else await evaluate(FRAME_WATCH)
    await wait(SECONDS * 1000)
    const result = await evaluate(counting ? "window.__benchTally()" : "window.__frames()")
    await evaluate("window.__stopChurn(); true")
    window.destroy()
    return result
  }
  const say = (what) => console.error(`bench: ${what}`)
  say("churn, counting")
  const tally = await churned(true)
  const perSecond = (value) => Math.round((value / SECONDS) * 10) / 10
  const churn = {
    commitsPerSecond: perSecond(tally.commits),
    areas: Object.fromEntries(Object.entries(tally.areas).map(([area, { commits, renders, ms }]) => [area, { commitsPerSecond: perSecond(commits), rendersPerSecond: perSecond(renders), renderMsPerSecond: perSecond(ms) }])),
    // The children's own components, then the most rendered of any: where a regression shows first.
    componentRendersPerSecond: Object.fromEntries(["ChildTab", "ThreadRollup", "ChildRow", "AgentRow"].map((name) => [name, perSecond(tally.components[name] ?? 0)])),
    mostRenderedPerSecond: Object.fromEntries(Object.entries(tally.components).toSorted((left, right) => right[1] - left[1]).slice(0, 12).map(([name, count]) => [name, perSecond(count)])),
    reactRenderMsPerSecond: perSecond(tally.renderMs),
    longestCommitMs: Math.round(tally.longestCommitMs * 10) / 10,
    ...frameNumbers((say("churn, frames"), await churned(false))),
  }

  // Fifty leads of twenty: React's work drawing the rail the first time, then frames scrolling it top to bottom.
  const rail = async (counting) => {
    const { window, evaluate, until } = await open("&leads=50", counting)
    await until("document.querySelectorAll('.thread-jump-scope [data-flip-key]').length > 10", "the rail's rows")
    await wait(1500)
    const boot = counting ? await evaluate("window.__benchTally()") : undefined
    await evaluate("[...document.querySelectorAll('.thread-jump-scope button, .thread-jump-scope [role=tab]')].find((node) => node.innerText.trim() === 'Recent')?.click(); true")
    await wait(500)
    const rows = await evaluate("document.querySelectorAll('.thread-jump-scope [data-flip-key]').length")
    await evaluate(FRAME_WATCH)
    const scrolled = await evaluate(`new Promise((done) => {
      let node = document.querySelector('.thread-jump-scope [data-flip-key]')
      while (node && !(node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY))) node = node.parentElement
      if (!node) return done(0)
      const end = node.scrollHeight - node.clientHeight
      let at = -1
      const step = () => {
        node.scrollTop = Math.min(end, node.scrollTop + 24)
        if (node.scrollTop > at && node.scrollTop < end - 1) {
          at = node.scrollTop
          requestAnimationFrame(step)
        } else done(node.scrollTop)
      }
      requestAnimationFrame(step)
    })`)
    const frames = await evaluate("window.__frames()")
    window.destroy()
    return { boot, rows, scrolled, frames }
  }
  say("rail, counting")
  const counted = await rail(true)
  say("rail, frames")
  const watched = await rail(false)
  return {
    churn,
    rail: {
      bootCommits: counted.boot.commits,
      bootReactRenderMs: Math.round(counted.boot.renderMs),
      bootLongestCommitMs: Math.round(counted.boot.longestCommitMs * 10) / 10,
      bootRailRenders: counted.boot.areas.rail?.renders ?? 0,
      rows: watched.rows,
      scrolledPx: watched.scrolled,
      ...frameNumbers(watched.frames),
    },
  }
}
