import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"
import { atSize, withMotion } from "./lib/test-window.mjs"

// An Apex's Fins on the desk and the phone, through production components on the mock bridge (`?mock&app=apex`):
// the rail lists only the Fins that need the person, under the Apex's row and its pips; a Fin's tab opens it in place with its brief and its
// breadcrumb, and Back returns; Stop in the Apex's composer asks first; the Agents panel groups the Fins; a message
// the person wrote to a Fin straight stands as its own routing line, and Reply or `@` writes the next one to a Fin
// with no turn of the Apex's; the phone's list, chips, Fin, Reply and stop. Screenshots of each, dark and light, land
// in the evidence folder (or `MAKO_ORCH_UI_SHOTS`). Pass a dev server's URL to use it
// (`node scripts/test-orch-ui.mjs http://127.0.0.1:20026/`); with none it serves its own. `--bench` measures the
// strip, badge and panel under churn, a rail of 50 Apexes, and a Fin's ask from its batch to its card.
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = testScratch("mako-orch-ui-")
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
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_ORCH_UI_ROOT
  const shots = process.env.MAKO_ORCH_UI_SHOTS ?? join(root, "shots")
  await mkdir(shots, { recursive: true })
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  withMotion(app)
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
  atSize(window, 1440, 900)
  const page = window.webContents
  page.debugger.attach("1.3")
  const type = (text) => page.debugger.sendCommand("Input.insertText", { text })
  const key = async (name, code, windowsVirtualKeyCode) => {
    for (const each of ["keyDown", "keyUp"]) await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: each, key: name, code, windowsVirtualKeyCode })
  }
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
  // Fonts in, finite animations done (a card entering), and two frames painted. Only what's rendered: a transition in
  // a turn scrolled out (`content-visibility: auto`) stops where it was and never finishes, and paints nothing.
  const settle = () =>
    evaluate(
      "document.fonts.ready.then(() => new Promise((done) => { const look = () => document.getAnimations().some((each) => each.playState === \"running\" && each.effect?.getTiming().iterations !== Infinity && each.effect.target?.checkVisibility({ contentVisibilityAuto: true }) !== false) ? requestAnimationFrame(look) : done(); requestAnimationFrame(look) })).then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))).then(() => true)"
    )
  const capture = async (name, prefix = "orch-build-ui-") => {
    await settle()
    await writeFile(join(shots, `${prefix}${name}.png`), (await page.capturePage()).toPNG())
  }
  const theme = (light) => evaluate(`document.documentElement.classList.toggle('light', ${light}); document.documentElement.style.colorScheme = '${light ? "light" : "dark"}'; true`)
  const both = async (name, prefix) => {
    await theme(false)
    await capture(`${name}-dark`, prefix)
    await theme(true)
    await capture(`${name}-light`, prefix)
    await theme(false)
  }
  const click = (selector) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true })()`)
  const press = (selector) =>
    evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 1 })); node.click(); return true })()`)

  await window.loadURL(`${base}?mock&app=apex`)
  await until("document.querySelectorAll('.thread-jump-scope [data-asking-fin]').length === 2", "the Apex's pips and asking Fins in the rail")

  // The rail lists the Apex once, and of its Fins only those that need the person, under it.
  const children = await evaluate("window.apexScene.children().map((agent) => agent.title)")
  assert.equal(children.length, 12)
  const nested = await evaluate(`(() => { const rail = document.querySelector('.thread-jump-scope').cloneNode(true); const asking = [...rail.querySelectorAll('[data-asking-fin]')].map((node) => node.querySelector('[data-asking-title]').textContent); rail.querySelectorAll('[data-asking-fin]').forEach((node) => node.remove()); return { text: rail.innerText, asking } })()`)
  assert.deepEqual(nested.asking.sort(), ["Quiet-hours push wording", "Sheet motion on iPad"], "the Fins that need the person hang under the Apex")
  for (const title of children) assert.ok(!nested.text.includes(title), `the rail lists no other Fin: ${title}`)
  assert.equal(await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-fin-pips]')].length"), 1, "one Apex row wears the pips")
  const label = await evaluate("document.querySelector('.thread-jump-scope [data-fin-pips]').getAttribute('aria-label')")
  assert.equal(label, "12 Fins: 2 need you · 5 working · 2 queued · 1 idle · 2 done")
  assert.equal(await evaluate("document.querySelector('.thread-jump-scope [data-fin-pips]').dataset.tip"), label)
  await both("rail")

  // Recent (the filter menu's choice) and search list no other either; the Apex is there in each.
  for (const [scope, heading] of [["recent", "Recent"], ["project", "Threads"]]) {
    await evaluate(`import('/src/state/prefs.ts').then(({setPref}) => setPref('railGrouping', ${JSON.stringify(scope)}))`)
    await until(`document.querySelector('[data-rail-threads-heading]')?.textContent === ${JSON.stringify(heading)}`, `the rail's ${heading}`)
    await settle()
    const listed = await evaluate("(() => { const rail = document.querySelector('.thread-jump-scope').cloneNode(true); rail.querySelectorAll('[data-asking-fin]').forEach((node) => node.remove()); return rail.innerText })()")
    assert.match(listed, /Mobile polish/, `${scope} lists the Apex`)
    for (const title of children) assert.ok(!listed.includes(title), `${scope} lists no Fin but those under the Apex: ${title}`)
  }
  await evaluate("window.dispatchEvent(new CustomEvent('mako:search-threads')); true")
  await until("Boolean(document.querySelector('[aria-label=\"Search every thread\"]'))", "the rail's search")
  for (const query of ["Sheet motion", "Mobile"]) {
    await evaluate(`(() => { const input = document.querySelector('[aria-label="Search every thread"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await settle()
    const found = await evaluate("document.querySelector('.thread-jump-scope').innerText")
    if (query === "Mobile") {
      assert.match(found, /Mobile polish/, "search finds the Apex")
      assert.ok(!found.includes("Refactor the composer"), "search filters the rail")
    }
    else assert.ok(!found.includes("Sheet motion on iPad"), "search finds no Fin")
  }
  await click('[aria-label="Close search"]')

  // The Apex opens from its row.
  await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.querySelector('[data-fin-pips]')).click(); true")
  // The strip: the Apex's Sessions, and no tab a Fin didn't earn by being opened, however many it has.
  await until("Boolean(document.querySelector('[data-crew]'))", "the Apex's crew card")
  const strip = await evaluate(`(() => ({ tabs: document.querySelectorAll('[data-child-tab]').length, sessions: document.querySelectorAll('[data-session-tab]').length, count: document.querySelector('[data-apex-count]') !== null }))()`)
  console.log("STRIP", JSON.stringify(strip))
  assert.deepEqual(strip, { tabs: 0, sessions: 1, count: false }, "twelve Fins add nothing to the strip")
  // The composer's agents line counts the Apex's Fins by the rollup: queued and asking ones aren't "running".
  assert.equal(await evaluate("document.querySelector('[data-agents-toggle]')?.innerText.trim()"), "12", "the composer's chip is the count, its needs pip beside it")
  assert.equal(await evaluate("document.querySelector('[data-agents-toggle]')?.getAttribute('aria-label')"), "12 Fins · 2 need you · 5 working")
  await both("strip")

  // The front door: the composer says a message goes to the Apex; where the Apex sent one stands as a line in its
  // turn, the Thread by name, and the person can send it elsewhere.
  await until("Boolean(document.querySelector('[data-routed]'))", "the Apex's routing line")
  const door = await evaluate(`(() => ({
    note: document.querySelector('[data-child-note=apex]')?.innerText,
    line: document.querySelector('[data-routed]').innerText.replace(/\\s+/g, ' '),
    elsewhere: Boolean(document.querySelector('[data-routed-elsewhere]')),
  }))()`)
  console.log("FRONT DOOR", JSON.stringify(door))
  assert.equal(door.note, undefined, "no hint line over the composer: @ and the Reply on a routing line say who a message goes to")
  assert.match(door.line, /^Passed your message to Sheet motion on iPad at its next step/)
  assert.equal(door.elsewhere, true)
  await evaluate("document.querySelector('[data-routed]').scrollIntoView({ block: 'center' }); true")
  await both("apex", "orch-front-door-")
  await click("[data-routed-elsewhere]")
  await until("[...document.querySelectorAll('[data-slot=popover-content]')].some((node) => node.innerText.startsWith('Move your message to'))", "Send elsewhere's list")
  await both("elsewhere", "orch-front-door-")
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true")
  await until("![...document.querySelectorAll('[data-slot=popover-content]')].some((node) => node.innerText.startsWith('Move your message to'))", "the list closing")

  // What the person wrote to a Fin straight stands apart from the Apex's turn: their words, then the routing line,
  // marked direct. Reply on a line writes the next message to that Fin; × takes it back to the Apex.
  const directLine = await evaluate(`(() => {
    const exchange = document.querySelector('[data-direct-exchange]')
    exchange?.scrollIntoView({ block: 'center' })
    return exchange ? { text: exchange.innerText.replace(/\\s+/g, ' '), reply: Boolean(exchange.querySelector('[data-routed-reply]')) } : null
  })()`)
  console.log("DIRECT LINE", JSON.stringify(directLine))
  assert.match(directLine?.text ?? "", /Keep the keyboard's own mic as the fallback.*Fin · Dictation fallback · direct/)
  assert.equal(directLine.reply, true)
  await both("direct-line", "orch-names-")
  await click("[data-direct-exchange] [data-routed-reply]")
  await until("Boolean(document.querySelector('[data-child-note=direct][data-addressee=dictation]'))", "Reply addressing the next message")
  const addressed = await evaluate(`(() => ({ note: document.querySelector('[data-child-note=direct]').innerText.replace(/\\s+/g, ' '), placeholder: document.querySelector('.composer-input')?.placeholder, focused: document.activeElement === document.querySelector('.composer-input') }))()`)
  console.log("ADDRESSED", JSON.stringify(addressed))
  assert.equal(addressed.note, "To Dictation fallback")
  assert.equal(addressed.placeholder, "Message Dictation fallback")
  assert.equal(addressed.focused, true, "Reply puts the caret in the composer")
  await both("reply", "orch-names-")
  await click("[data-child-note=direct] button")
  await until("!document.querySelector('[data-child-note=direct]')", "× writing to the Apex again")
  // `@` offers the Apex's Fins first; a pick addresses the message rather than inserting a mention.
  await evaluate("document.querySelector('.composer-input').focus(); true")
  await type("@Push")
  await until("Boolean(document.querySelector('[data-mention-menu=\"@\"] [role=group][aria-label=Fins] [role=option]'))", "the Fins in the @ menu")
  const menu = await evaluate("[...document.querySelectorAll('[data-mention-menu] [role=group]')].map((group) => ({ group: group.getAttribute('aria-label'), rows: [...group.querySelectorAll('[role=option]')].map((row) => row.innerText.replace(/\\s+/g, ' ')) }))")
  console.log("MENTION", JSON.stringify(menu))
  assert.equal(menu[0]?.group, "Fins", "the Fins come first")
  assert.match(menu[0].rows[0], /Push token refresh.*Fin · token-refresh · straight to it/)
  await both("mention", "orch-names-")
  await key("Enter", "Enter", 13)
  await until("Boolean(document.querySelector('[data-child-note=direct][data-addressee=token-refresh]'))", "the pick addressing the message")
  assert.equal(await evaluate("document.querySelector('.composer-input').value"), "", "the mention isn't left in the draft")
  // Sent, it goes to the Fin through the host: no request of the Apex's, its own line in the transcript, and the next
  // message goes to the Apex again.
  const asked = await evaluate("window.apexScene.asked()")
  const lines = await evaluate("document.querySelectorAll('[data-direct-exchange]').length")
  await type("Retry once, then drop it.")
  await key("Enter", "Enter", 13)
  await until("window.apexScene.directs().length === 1", "the direct message")
  const sent = await evaluate("window.apexScene.directs()[0]")
  assert.equal(sent.text, "Retry once, then drop it.")
  assert.match(sent.to, /^[0-9a-f-]{36}$/, "the Fin by its Thread")
  assert.match(sent.request, /^[0-9a-f-]{36}$/, "under the message's own ID")
  await until(`document.querySelectorAll('[data-direct-exchange]').length === ${lines + 1}`, "its routing line")
  await until("!document.querySelector('[data-child-note=direct]')", "the next message going to the Apex")
  assert.equal(await evaluate("window.apexScene.asked()"), asked, "no turn of the Apex's")
  await evaluate("[...document.querySelectorAll('[data-direct-exchange]')].at(-1).scrollIntoView({ block: 'center' }); true")
  await both("direct-sent", "orch-names-")

  // The composer's chip opens the Agents panel: the Apex's Fins by group, above what its harness runs in the turn.
  await click("[data-agents-toggle]")
  await until("Boolean(document.querySelector('[data-apex-fins]'))", "the panel's Fins section")
  const panel = await evaluate(`(() => {
    const section = document.querySelector('[data-apex-fins]')
    return { heading: section.querySelector('div').innerText, groups: [...section.querySelectorAll('[data-child-group]')].map((group) => group.innerText.replace(/\\s+/g, ' ')), rows: section.querySelectorAll('[data-child-row]').length }
  })()`)
  console.log("PANEL", JSON.stringify(panel))
  assert.match(panel.heading, /12 Fins · 2 need you · 5 working · 2 queued · 1 idle · 2 done/)
  assert.match(panel.heading, /Stop all/)
  assert.deepEqual(panel.groups, ["Needs you 2", "Working 5", "Queued 2", "Idle 1", "Done 2"])
  await both("panel")

  // Opening a Fin opens it in place: its breadcrumb, its brief from the Apex first, the approval it waits on, its
  // composer saying the Apex hears it, and the one tab a Fin gets, selected in the Apex's strip.
  const opened = await evaluate(`[...document.querySelectorAll('[data-child-row]')].find((node) => node.innerText.startsWith('Sheet motion')).dataset.childRow`)
  assert.ok(opened, "the Fin waiting on approval has a row")
  await press(`[data-child-row="${opened}"]`)
  await until("Boolean(document.querySelector('[data-child-breadcrumb]'))", "the Fin's breadcrumb")
  await until("Boolean(document.querySelector('[data-agent-words=Brief]'))", "the brief's card")
  const child = await evaluate(`(() => ({
    crumb: document.querySelector('[data-child-breadcrumb]').innerText.replace(/\\s+/g, ' '),
    brief: document.querySelector('[data-agent-words=Brief]').innerText.replace(/\\s+/g, ' '),
    first: document.querySelector('[data-exchange]')?.querySelector('[data-agent-words]') !== null,
    note: document.querySelector('[data-child-note]')?.innerText,
    selected: document.querySelector('[data-child-tab="${opened}"]').getAttribute('aria-selected'),
    tabs: document.querySelectorAll('[data-child-tab]').length,
    sessionSelected: [...document.querySelectorAll('[data-session-tab]')].some((tab) => tab.getAttribute('aria-selected') === 'true'),
    approval: document.body.innerText.includes('Allow once'),
    lit: document.querySelector('[data-child-row][aria-current=true]')?.innerText.split('\\n')[0],
  }))()`)
  console.log("CHILD", JSON.stringify(child))
  assert.match(child.crumb, /^Mobile polish \/ Sheet motion on iPad/)
  assert.match(child.crumb, /Stop$/)
  assert.match(child.brief, /^From Mobile polish · Brief/)
  assert.doesNotMatch(child.brief, /agents_report|You're (fin|child):/, "the brief's lines for the Fin alone stay out of the card")
  assert.equal(child.first, true, "the brief is the first card")
  assert.equal(child.note, undefined, "no line over the composer: the crumb says whose it is")
  assert.equal(child.selected, "true")
  assert.equal(child.tabs, 1, "the Fin opened has the one tab")
  assert.equal(child.sessionSelected, false, "no Session of the Apex is selected while its Fin is shown")
  assert.equal(child.approval, true)
  assert.equal(child.lit, "Sheet motion on iPad", "the panel keeps the Apex's Fins, the open one lit")
  await both("child")
  // The message the Apex passed on reads as the person's own, with what the Apex added under it.
  const passed = await evaluate(`(() => { const card = document.querySelector('[data-agent-words="Passed on"]'); if (!card) return null; card.scrollIntoView({ block: 'center' }); return card.innerText.replace(/\\s+/g, ' ') })()`)
  console.log("PASSED ON", JSON.stringify(passed))
  assert.match(passed ?? "", /^Your message, passed on by Mobile polish/)
  assert.match(passed ?? "", /The sheet still jumps when the keyboard opens in split view\./)
  assert.match(passed ?? "", /Mobile polish added It shows on the 11-inch iPad/)
  await both("child", "orch-front-door-")

  // Back returns to the Apex; the Apex's own tab does too.
  await click("[data-child-breadcrumb] button")
  await until("!document.querySelector('[data-child-breadcrumb]') && [...document.querySelectorAll('[data-session-tab]')].some((tab) => tab.getAttribute('aria-selected') === 'true')", "the Apex after Back")
  assert.equal(await evaluate("document.querySelectorAll('[data-child-tab]').length"), 0, "going back gives the Fin's tab up")
  await press(`[data-child-row="${opened}"]`)
  await until("Boolean(document.querySelector('[data-child-breadcrumb]'))", "the Fin again")
  await press("[data-session-tab]")
  await until("!document.querySelector('[data-child-breadcrumb]')", "the Apex after its tab")
  await press(`[data-child-row="${opened}"]`)
  await until("Boolean(document.querySelector('[data-child-tab]'))", "the Fin's tab again")
  await click('[role="tablist"] button[aria-label="Close Sheet motion on iPad"]')
  await until("!document.querySelector('[data-child-breadcrumb]') && !document.querySelector('[data-child-tab]')", "the Apex after closing the Fin's tab")

  // Stop in the Apex's composer asks first while any of its Fins works.
  const stop = "[data-composer] button[aria-label=Stop]"
  await until(`Boolean(document.querySelector(${JSON.stringify(stop)}))`, "the Apex's Stop")
  await click(stop)
  await until("Boolean(document.querySelector('[data-stop-apex]'))", "the stop popover")
  const popover = await evaluate(`(() => {
    const card = document.querySelector('[data-stop-apex]')
    const box = card.getBoundingClientRect()
    return { width: box.width, height: box.height, text: card.innerText.replace(/\\s+/g, ' '), focused: document.activeElement?.innerText, scrim: getComputedStyle(document.body).overflow }
  })()`)
  console.log("STOP", JSON.stringify(popover))
  assert.ok(popover.width <= 320 && popover.height <= 120, `the popover is at most 320×120 (${popover.width}×${popover.height})`)
  assert.match(popover.text, /^12 Fins · 2 need you · 5 working · 2 queued · 1 idle · 2 done/)
  assert.match(popover.text, /Stop the Apex only/)
  assert.match(popover.text, /Stop all$/)
  assert.equal(await evaluate("[...document.querySelectorAll('[data-stop-apex] button')].at(-1).title"), "Stop the Apex and 9 Fins")
  assert.equal(popover.focused, "Stop the Apex only", "the safe choice is focused")
  await both("stop")
  await evaluate("[...document.querySelectorAll('[data-stop-apex] button')].find((button) => button.innerText === 'Stop the Apex only').click(); true")
  await until("!document.querySelector('[data-stop-apex]')", "the popover closing on Stop the Apex only")
  await evaluate("window.apexScene.setRunning(true); true")
  await until(`Boolean(document.querySelector(${JSON.stringify(stop)}))`, "the Apex's Stop again")
  await click(stop)
  await until("Boolean(document.querySelector('[data-stop-apex]'))", "the popover reopening")
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true")
  await until("!document.querySelector('[data-stop-apex]')", "Escape closing the popover")
  assert.ok(await evaluate(`Boolean(document.querySelector(${JSON.stringify(stop)}))`), "Escape closed the popover without stopping the Apex")
  await click(stop)
  await until("Boolean(document.querySelector('[data-stop-apex]'))", "the popover again")
  await evaluate("document.querySelector('main').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true")
  await until("!document.querySelector('[data-stop-apex]')", "an outside click closing the popover")

  // Diagnostics counts the Fins and where the person's messages went, straight to a Fin among them.
  await evaluate(`window.dispatchEvent(new CustomEvent("mako:settings", { detail: "diagnostics" })); true`)
  await until("Boolean(document.querySelector('[data-agents-diagnostics]'))", "Diagnostics' Fins")
  const diagnostics = await evaluate(`(() => { const node = document.querySelector('[data-agents-diagnostics]'); node.scrollIntoView({ block: 'center' }); return node.innerText.replace(/\\s+/g, ' ') })()`)
  console.log("DIAGNOSTICS", JSON.stringify(diagnostics))
  assert.match(diagnostics, /^Fins 7 Fins · \d+ running/)
  assert.match(diagnostics, /Each Apex and its Fins run at most/)
  assert.match(diagnostics, /the person wrote 4 messages straight to a Fin/)
  assert.match(diagnostics, /Apexes answered 3 asks of their Fins and left 1 ask to the person · 1 approval was refused to an Apex below full access/)
  await both("diagnostics", "orch-names-")
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true")
  await until("!document.querySelector('[data-agents-diagnostics]')", "Settings closing")

  // The phone: the list shows the Apex as one row with the same pips, and each Fin that needs the person as a row of
  // its own under Needs you, no other; its crew card opens a Fin, whose back reads the Apex's name; Stop asks
  // first, full width.
  window.setContentSize(390, 844)
  await window.loadURL(`${base}scripts/phone-apex.html?app=apex`)
  await until("Boolean(document.querySelector('[data-thread] [data-fin-pips]'))", "the Apex's pips in the phone's list")
  const list = await evaluate(`(() => { const rows = document.querySelector('[data-list]').cloneNode(true); const asking = [...rows.querySelectorAll('[data-fin-row]')].map((node) => node.querySelector('.font-medium').textContent); rows.querySelectorAll('[data-fin-row]').forEach((node) => node.remove()); return { text: rows.innerText, asking, rows: document.querySelectorAll('[data-thread]').length, label: document.querySelector('[data-thread] [data-fin-pips]').getAttribute('aria-label') } })()`)
  assert.deepEqual(list.asking.sort(), ["Quiet-hours push wording", "Sheet motion on iPad"], "the phone lists the Fins that need the person, each a row")
  for (const title of children) assert.ok(!list.text.includes(title), `the phone's list lists no other Fin (${title})`)
  assert.equal(list.rows, 4)
  assert.equal(list.label, "12 Fins: 2 need you · 5 working · 2 queued · 1 idle · 2 done")
  await both("phone-list")
  await click("[data-thread]")
  await until("Boolean(document.querySelector('[data-crew]'))", "the Apex's crew card on the phone")
  assert.equal(await evaluate("document.querySelector('[data-apex-count]')?.dataset.apexCount"), "12", "the bar counts the Fins")
  assert.equal(await evaluate("document.querySelectorAll('[data-child-chip]').length"), 0, "no chip a Fin repeating the card")
  await until("Boolean(document.querySelector('[data-send-action=stop]'))", "the Apex's transcript and dock on the phone")
  await both("phone-apex")
  await until("Boolean(document.querySelector('[data-routed]'))", "the routing line on the phone")
  const phoneDoor = await evaluate(`(() => ({ note: document.querySelector('[data-child-note=apex]')?.innerText, line: document.querySelector('[data-routed]').innerText.replace(/\\s+/g, ' ') }))()`)
  console.log("PHONE FRONT DOOR", JSON.stringify(phoneDoor))
  assert.equal(phoneDoor.note, undefined, "no hint line over the phone's composer")
  assert.match(phoneDoor.line, /^Passed your message to Sheet motion on iPad/)
  await evaluate("document.querySelector('[data-routed]').scrollIntoView({ block: 'center' }); true")
  await both("phone-apex", "orch-front-door-")
  // On the phone, Reply on a routing line writes the next message to that Fin, straight.
  await click("[data-routed] [data-routed-reply]")
  await until("Boolean(document.querySelector('[data-child-note=direct][data-addressee=sheet-motion]'))", "Reply on the phone")
  const phoneAddressed = await evaluate(`(() => ({ note: document.querySelector('[data-child-note=direct]').innerText.replace(/\\s+/g, ' '), placeholder: document.querySelector('.web-dock textarea')?.placeholder }))()`)
  console.log("PHONE ADDRESSED", JSON.stringify(phoneAddressed))
  assert.equal(phoneAddressed.note, "To Sheet motion on iPad")
  assert.equal(phoneAddressed.placeholder, "Message Sheet motion on iPad")
  await both("phone-reply", "orch-names-")
  await click("[data-child-note=direct] button")
  await until("!document.querySelector('[data-child-note=direct]')", "the phone writing to the Apex again")
  // The count opens the Agents sheet on the Apex's Fins; a row there opens that Fin, the sheet put away.
  await click("[data-apex-count]")
  await until("Boolean(document.querySelector('[data-agents-sheet] [data-apex-fins]'))", "the phone's Agents sheet on the Apex's Fins")
  await both("phone-agents")
  await click(`[data-agents-sheet] [data-child-row="${opened}"]`)
  await until("Boolean(document.querySelector('[data-child-of]')) && !document.querySelector('[data-agents-sheet] [data-apex-fins]')", "the Fin from the sheet")
  await click("[data-back-to-apex]")
  await until("Boolean(document.querySelector('[data-apex-count]')) && !document.querySelector('[data-child-of]')", "the Apex again")
  await click(`[data-crew-row="${opened}"] button`)
  await until("Boolean(document.querySelector('[data-child-of]'))", "the Fin on the phone")
  await until("Boolean(document.querySelector('[data-agent-words=Brief]'))", "the Fin's brief on the phone")
  const phoneChild = await evaluate(`(() => ({ back: document.querySelector('[data-back-to-apex]')?.innerText, brief: document.querySelector('[data-agent-words=Brief]').innerText.replace(/\\s+/g, ' '), note: document.querySelector('[data-child-note]')?.innerText }))()`)
  console.log("PHONE CHILD", JSON.stringify(phoneChild))
  assert.equal(phoneChild.back, "Mobile polish")
  assert.match(phoneChild.brief, /^From Mobile polish · Brief/)
  assert.equal(phoneChild.note, undefined, "no line over the phone's composer: the back button names the Apex")
  await both("phone-child")
  await click("[data-back-to-apex]")
  await until("Boolean(document.querySelector('[data-apex-count]')) && !document.querySelector('[data-child-of]')", "the Apex after the phone's back")
  const phoneStop = "[data-send-action=stop]"
  await until(`Boolean(document.querySelector(${JSON.stringify(phoneStop)}))`, "the Apex's Stop on the phone")
  await click(phoneStop)
  await until("Boolean(document.querySelector('[data-stop-apex]'))", "the stop popover on the phone")
  const phonePopover = await evaluate("(() => { const box = document.querySelector('[data-stop-apex]').getBoundingClientRect(); return { left: box.left, right: innerWidth - box.right, height: box.height } })()")
  console.log("PHONE STOP", JSON.stringify(phonePopover))
  assert.deepEqual([Math.round(phonePopover.left), Math.round(phonePopover.right)], [12, 12], "full width less its margins")
  assert.ok(phonePopover.height <= 120)
  await both("phone-stop")

  // What the Fins ask the person is answered in the crew card on the desk, which stays through the Apex's turn, each in
  // a click as the person's own answer, under a request ID; the rail marks the Apex with the first; an answered ask
  // leaves. An ask is drawn in one place: the composer holds none while the card is on screen.
  window.setContentSize(1440, 900)
  await window.loadURL(`${base}?mock&app=apex`)
  await until("document.querySelectorAll('[data-crew] [data-fin-ask]').length === 2", "the Fins' asks in the crew card through the Apex's turn")
  assert.equal(await evaluate("document.querySelectorAll('[data-fin-asks] [data-fin-ask]').length"), 0, "and none over the composer as well")
  const deskAsks = await evaluate(`(() => ({
    rows: [...document.querySelectorAll('[data-crew] [data-fin-ask]')].map((row) => ({ kind: row.dataset.finAsk, fin: row.dataset.fin, text: row.innerText.replace(/\\s+/g, ' '), recommended: row.querySelector('[data-recommended]')?.innerText.replace(/\\s+/g, ' ') })),
    marks: [...document.querySelectorAll('.thread-jump-scope [role=img][aria-label]')].map((mark) => mark.getAttribute('aria-label')),
  }))()`)
  console.log("DESK ASKS", JSON.stringify(deskAsks))
  const finName = (fin) => evaluate(`window.apexScene.children().find((agent) => agent.child?.thread === ${JSON.stringify(fin)})?.child?.name`)
  const report = deskAsks.rows.find((row) => row.kind === "report")
  assert.equal(await finName(report?.fin), "push-wording")
  assert.match(report.text, /Quiet-hours push wording.*Which tone for the quiet-hours notice\? Plain or friendly\?.*Plain.*Friendly/)
  assert.match(report.recommended ?? "", /^Plain/)
  const approval = deskAsks.rows.find((row) => row.kind === "approval")
  assert.equal(await finName(approval?.fin), "sheet-motion")
  assert.match(approval.text, /Approve: npm ci Allow once Refuse/)
  assert.ok(deskAsks.marks.includes("Quiet-hours push wording: Which tone for the quiet-hours notice? Plain or friendly?") || deskAsks.marks.includes("Sheet motion on iPad: Approve: npm ci"), "the rail marks the Apex with its Fin's ask")
  await both("desk-asks", "orch-gaps-")
  await click('[data-crew] [data-fin-ask=report] [data-fin-answer="0"]')
  await until("window.apexScene.responds().length === 1", "the person's answer reaching the Apex's host")
  const deskAnswer = await evaluate("window.apexScene.responds()[0]")
  assert.deepEqual({ fin: deskAnswer.fin, ask: deskAnswer.ask, option: deskAnswer.option }, { fin: report.fin, ask: "report:push-wording:tone", option: 0 })
  assert.equal(deskAnswer.conversation, "1ead1ead-2000-4000-8000-000000001ead", "to the Apex's conversation")
  assert.match(deskAnswer.request, /^[0-9a-f-]{36}$/)
  await until("document.querySelectorAll('[data-crew] [data-fin-ask]').length === 1", "the answered ask leaving the desk")
  await both("desk-asks-answered", "orch-gaps-")

  // On the phone the same: the crew card stays through the Apex's turn and holds its Fins' asks, each a tap; the dock
  // holds none of them while the card is drawn.
  window.setContentSize(390, 844)
  await window.loadURL(`${base}scripts/phone-apex.html?app=apex`)
  await click("[data-thread]")
  await until("document.querySelectorAll('[data-crew] [data-fin-ask]').length === 2", "the Fins' asks in the phone's crew card")
  assert.equal(await evaluate("Boolean(document.querySelector('.web-dock [data-ask=fin]'))"), false, "none in the dock as well")
  await both("phone-ask", "orch-gaps-")
  await click('[data-crew] [data-fin-ask=approval] [data-fin-answer="allow"]')
  await until("window.apexScene.responds().length === 1", "the phone's tap reaching the Apex's host")
  assert.equal(await finName((await evaluate("window.apexScene.responds()[0]")).fin), "sheet-motion")
  await click('[data-crew] [data-fin-ask=report] [data-fin-answer="1"]')
  await until("window.apexScene.responds().length === 2", "the second tap reaching the Apex's host")
  const tapped = await evaluate("window.apexScene.responds()[1]")
  assert.deepEqual({ fin: await finName(tapped.fin), option: tapped.option }, { fin: "push-wording", option: 1 })
  await until("!document.querySelector('[data-crew] [data-fin-ask]')", "no Fin's ask left in the card")
  await both("phone-ask-answered", "orch-gaps-")

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

/** One Fin waiting on its Apex, made the person's with a new ask each time, until its card is there; then back, until it's gone. */
const FIN_ASK_DRAWN = `(async () => {
  const base = window.apexScene.children()
  const index = base.findIndex((agent) => agent.child?.state.kind === "blocked" && agent.child.state.on === "lead")
  const fin = base[index].child
  const there = (present) => new Promise((done) => {
    const check = () => (Boolean(document.querySelector('[data-fin-asks] [data-fin="' + fin.thread + '"]')) === present ? done() : requestAnimationFrame(check))
    check()
  })
  const drawn = []
  const cleared = []
  for (let i = 0; i < 30; i += 1) {
    const asking = { ...base[index], child: { ...fin, state: { ...fin.state, on: "person", ask: { kind: "report", id: "bench-" + i, options: [{ label: "Drop it" }, { label: "Retry once" }], recommended: 1 } } } }
    let began = performance.now()
    window.apexScene.setChildren(base.map((each, at) => (at === index ? asking : each)))
    await there(true)
    drawn.push(performance.now() - began)
    began = performance.now()
    window.apexScene.setChildren(base)
    await there(false)
    cleared.push(performance.now() - began)
  }
  return { drawn, cleared }
})()`

function spread(values) {
  const sorted = values.toSorted((left, right) => left - right)
  const round = (value) => Math.round(value * 10) / 10
  return { p50: round(sorted[Math.floor(sorted.length * 0.5)]), p95: round(sorted[Math.floor(sorted.length * 0.95)]), max: round(sorted.at(-1)) }
}

function frameNumbers({ gaps, longest }) {
  const sorted = gaps.toSorted((left, right) => left - right)
  const round = (value) => Math.round(value * 10) / 10
  return { frames: gaps.length, longestFrameMs: round(sorted.at(-1) ?? 0), p95FrameMs: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0), over33ms: gaps.filter((gap) => gap > 33.4).length, longestAnimationFrameMs: round(longest) }
}

/**
 * The numbers the brief asks for, on the mock: twenty Fins each changing once a second under the Apex's strip,
 * the rail's badge and the Agents panel (commits a second by area, renders a second by component, the longest
 * frame); and a rail of fifty Apexes of twenty Fins each (its first render, and frames scrolling it).
 */
async function bench(BrowserWindow, base, root) {
  const preload = join(root, "commit-counter.cjs")
  await writeFile(preload, COMMIT_COUNTER)
  const open = async (query, counting) => {
    const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false, ...(counting && { preload, contextIsolation: false, sandbox: false }) } })
    atSize(window, 1440, 900)
    // A cold dev server reloads the page once its dependencies are bundled, aborting this load; the wait below holds.
    await window.loadURL(`${base}?mock&app=apex${query}`).catch((error) => {
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

  // The Apex open, its Agents panel showing, twenty Fins churning: one moves every 50 ms, so each once a second.
  const churned = async (counting) => {
    const { window, evaluate, until } = await open("", counting)
    await until("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].some((row) => row.innerText.includes('Mobile polish'))", "the Apex's row")
    await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.innerText.includes('Mobile polish')).click(); true")
    await until("Boolean(document.querySelector('[data-composer]'))", "the Apex's composer")
    await evaluate("[...document.querySelectorAll('button, [role=tab]')].find((node) => node.innerText.trim() === 'Agents')?.click(); true")
    await evaluate("window.__stopChurn = window.apexScene.churn(20, 50); true")
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
    // The Fins' own components, then the most rendered of any: where a regression shows first.
    componentRendersPerSecond: Object.fromEntries(["ChildTab", "ApexCrewLine", "ChildRow", "AgentRow"].map((name) => [name, perSecond(tally.components[name] ?? 0)])),
    mostRenderedPerSecond: Object.fromEntries(Object.entries(tally.components).toSorted((left, right) => right[1] - left[1]).slice(0, 12).map(([name, count]) => [name, perSecond(count)])),
    reactRenderMsPerSecond: perSecond(tally.renderMs),
    longestCommitMs: Math.round(tally.longestCommitMs * 10) / 10,
    ...frameNumbers((say("churn, frames"), await churned(false))),
  }

  // Fifty Apexes of twenty: React's work drawing the rail the first time, then frames scrolling it top to bottom.
  const rail = async (counting) => {
    const { window, evaluate, until } = await open("&apexes=50", counting)
    await until("document.querySelectorAll('.thread-jump-scope [data-flip-key]').length > 10", "the rail's rows")
    await wait(1500)
    const boot = counting ? await evaluate("window.__benchTally()") : undefined
    await evaluate("import('/src/state/prefs.ts').then(({setPref}) => setPref('railGrouping', 'recent'))")
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

  // A Fin's ask that's the person's arriving in the Apex's batch, to its card over the composer drawn; then answered
  // elsewhere, to the card gone. Thirty times, on the Apex at rest.
  say("a Fin's ask, drawn")
  const asked = await (async () => {
    const { window, evaluate, until } = await open("", false)
    await until("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].some((row) => row.innerText.includes('Mobile polish'))", "the Apex's row")
    await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.innerText.includes('Mobile polish')).click(); true")
    await until("Boolean(document.querySelector('[data-fin-asks]'))", "the Fins' asks over the Apex's composer")
    const timed = await evaluate(FIN_ASK_DRAWN)
    window.destroy()
    return timed
  })()
  return {
    finAsk: { samples: asked.drawn.length, drawnMs: spread(asked.drawn), clearedMs: spread(asked.cleared) },
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
