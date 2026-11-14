import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"
import { electronExit, guardElectronCheck } from "./lib/electron-check.mjs"
import { testScratch } from "./lib/test-scratch.mjs"
import { atSize, withMotion } from "./lib/test-window.mjs"
import { checkInboxNavigation } from "./lib/inbox-navigation-ui.mjs"

/**
 * The rail's top rows and the Inbox, against the production components on the Apex scene (`?mock&app=apex`, "Mobile
 * polish" and its twelve Fins): the rows in order with no view switch under them, the Inbox's count equal to the
 * needs-you facts the marks read (each Fin blocked on the person, each Thread whose status needs the person), an
 * answer in the Inbox reaching the Apex's host and moving that Fin to working in the Inbox and the rail at once,
 * Cmd+Shift+U opening it, and the phone's list with its Inbox chip, its sections, the asking Fins as rows of their
 * own and its Inbox screen answering in place. Screenshots stay in the printed directory.
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { uiVite } = await import("./lib/ui-vite.mjs")
  const portAt = process.argv.indexOf("--port")
  const port = portAt === -1 ? 0 : Number(process.argv[portAt + 1])
  const root = testScratch("mako-inbox-ui-")
  const server = await uiVite({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port, strictPort: port !== 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-inbox-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolveExit(electronExit("The Inbox UI check", code, signal)))
    })
  } finally {
    await server.close()
  }
}

/** The needs-you facts, read in the page from the contract and the Thread status the marks read, not from the Inbox. */
const NEEDS_FACTS = `Promise.all([import('/src/state/acp-state.ts'), import('/src/state/apex-fins.ts'), import('/packages/host/src/contracts/children.ts'), import('/src/state/thread-store.ts'), import('/src/state/thread-status.ts'), import('/src/state/setup.ts')]).then(([{ acpStore }, { threadChildren }, { childStateOf, childGroup }, { threadsStore }, { threadStatus }, { allAsks, setupStore }]) => {
  const acp = acpStore.get()
  const apexes = [...new Set(Object.values(acp.conversations).flatMap((conversation) => conversation.kind === 'live' && conversation.threadId ? [conversation.threadId] : []))]
  const fins = apexes.flatMap((thread) => threadChildren(acp, thread).filter((agent) => { const state = childStateOf(agent); return childGroup(state) === 'needs' && state.on !== 'lead' }).map((agent) => ({ apex: thread, fin: agent.child.thread })))
  const asking = new Set(fins.flatMap((fin) => [fin.apex, fin.fin]))
  const state = threadsStore.get()
  const threads = state.threads.filter((ref) => !ref.parent && !asking.has(ref.threadId) && threadStatus(ref, state).kind === 'needs-permission').map((ref) => ref.path)
  // A Setup ask waits on the person too, once its folder's Setup has been read: each listed once.
  const setup = allAsks(setupStore.get()).map((entry) => entry.ask.id)
  return { fins: fins.map((fin) => fin.fin), threads, setup }
})`

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL
  app.setPath("userData", join(root, "profile"))
  withMotion(app)
  await app.whenReady()
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  atSize(window, 1440, 900)
  const page = window.webContents
  page.debugger.attach("1.3")
  const guard = guardElectronCheck({ app, page, name: "The Inbox UI check", ms: 120_000 })
  const errors = []
  page.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message)
    if (details.level === "error" || details.level === "warning") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
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
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
    }
  }
  const move = (x, y) => page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
  const click = async (selector) => {
    const point = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing click target ' + ${JSON.stringify(selector)}); node.scrollIntoView({ block: 'nearest' }); const r = node.getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} })()`)
    await move(point.x, point.y)
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point })
  }
  const chord = async (key, code, modifiers) => {
    for (const type of ["rawKeyDown", "keyUp"]) await page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: code, modifiers })
  }
  // Meta on a Mac, Control elsewhere, with Shift: the desk's "mod+shift".
  const MOD_SHIFT = (process.platform === "darwin" ? 4 : 2) | 8
  const inboxCount = () => evaluate(`Number(document.querySelector('[data-rail-top-row="inbox"] [data-inbox-count]')?.textContent ?? 0)`)
  const rollup = () => evaluate(`document.querySelector('.thread-jump-scope [data-apex-row] [data-fin-pips]')?.getAttribute('aria-label') ?? ''`)

  await window.loadURL(`${base}?mock&app=apex`)
  await until(`document.querySelector('[data-rail-top]') !== null && document.querySelector('.thread-jump-scope [data-apex-row] [data-fin-pips]') !== null`, "the rail with the Apex")
  await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({railGrouping: 'project', railWidth: 264, theme: 'dark'}))`)
  await frames()

  // 1. The fixed top rows, in order, each 28px, and no Projects / Recent / Status switch under them.
  const rows = await evaluate(`[...document.querySelectorAll('[data-rail-top-row]')].map((node) => ({ id: node.dataset.railTopRow, text: node.innerText.split('\\n')[0], height: Math.round(node.getBoundingClientRect().height) }))`)
  assert.deepEqual(rows.map((row) => row.text), ["New thread", "Search", "Inbox", "Pull requests", "Setup", "Automations"])
  assert.ok(rows.every((row) => row.height === 28), `the top rows are 28px: ${JSON.stringify(rows)}`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="Thread view"]')`), null, "no view switch")
  assert.equal(await evaluate(`document.querySelector('[data-rail-threads-heading]')?.textContent`), "Threads")
  assert.equal(await evaluate(`[...document.querySelectorAll('.thread-jump-scope button')].some((node) => ['Projects', 'Recent', 'Status'].includes(node.innerText.trim()))`), false, "no Projects, Recent or Status button in the rail")
  console.log("PASS: six top rows, then Threads, no view switch")

  // Setup is reachable without opening Settings or the right rail first.
  await click('[data-rail-top-row="setup"]')
  await until(`Boolean(document.querySelector('[data-project-tab="setup"][aria-selected="true"], [data-app-project]'))`, "Setup from the left rail")
  if (await evaluate(`!document.querySelector('[data-project-tab="setup"][aria-selected="true"]')`))
    await click('[data-app-project]')
  await until(`Boolean(document.querySelector('[data-project-tab="setup"][aria-selected="true"]'))`, "the chosen project's Setup, not its recipe")
  await evaluate(`Promise.all(document.querySelector('[data-project-tab="setup"]').closest('[role="dialog"]').getAnimations().map((animation) => animation.finished)).then(() => true)`)
  await capture("setup-from-rail.png")
  await evaluate(`window.dispatchEvent(new CustomEvent('mako:close-settings'))`)
  await until(`document.querySelector('[data-project-tab="setup"]') === null`, "Setup closed")
  await evaluate(`import('/src/extend/commands.ts').then(({runCommand}) => runCommand('view.project-setup'))`)
  await until(`Boolean(document.querySelector('[data-project-tab="setup"][aria-selected="true"], [data-app-project]'))`, "Project setup command")
  await evaluate(`window.dispatchEvent(new CustomEvent('mako:close-settings'))`)
  await until(`document.querySelector('[data-project-tab="setup"]') === null`, "Setup command closed")
  console.log("PASS: Setup rail entry and command reuse the project's Setup page")

  // Search through the rendered inputs, not the command registry or Settings store.
  const searchFailures = []
  const replaceInput = async (selector, text) => {
    await click(selector)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`)
    await page.debugger.sendCommand("Input.insertText", { text })
    await until(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(text)}`, `typed ${text}`)
    await frames()
  }
  for (const term of ["drive", "credentials", "packages", "grants", "secrets", "environment", "Project setup"]) {
    await chord("k", 75, process.platform === "darwin" ? 4 : 2)
    await until(`Boolean(document.querySelector('[aria-label="Command palette"] input'))`, "Cmd+K palette")
    await replaceInput('[aria-label="Command palette"] input', term)
    const index = await evaluate(`[...document.querySelectorAll('[aria-label="Command palette"] button')].find((button) => button.querySelector('span')?.textContent === 'Project setup')?.dataset.index ?? null`)
    if (index === null) searchFailures.push(`Cmd+K ${term} omits Project setup`)
    if (term === "drive" && index !== null) {
      await click(`[aria-label="Command palette"] button[data-index="${index}"]`)
      await until(`Boolean(document.querySelector('[data-project-tab="setup"][aria-selected="true"], [data-app-project]'))`, "Drive palette result opens Setup")
      await evaluate(`window.dispatchEvent(new CustomEvent('mako:close-settings'))`)
      await until(`!document.querySelector('[aria-label="Search settings"]')`, "palette's Setup closed")
    } else {
      await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
      await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    }
    await until(`!document.querySelector('[aria-label="Command palette"]')`, "palette closed")
  }
  for (const [term, tab] of [["Drive", "setup"], ["credentials", "setup"], ["packages", "setup"], ["grants", "setup"], ["app", "recipe"], ["run", "recipe"], ["checks", "recipe"]]) {
    await evaluate(`import('/src/state/app-setup.ts').then(({appSetupStore}) => {appSetupStore.set({chosen: undefined, tab: undefined}); window.dispatchEvent(new CustomEvent('mako:settings', {detail: 'models'}))})`)
    await until(`Boolean(document.querySelector('[aria-label="Search settings"]'))`, "fresh Settings")
    await replaceInput('[aria-label="Search settings"]', term)
    if (term === "Drive" && !(await evaluate(`document.querySelector('[role="dialog"] main').textContent.includes('Choose a project to see its files')`))) searchFailures.push("Settings Drive auto-selection loses Setup intent")
    await click('[data-settings-section="apps"]')
    await until(`Boolean(document.querySelector('[data-app-project="mako"]'))`, `${term} project picker`)
    if (term === "Drive" && !(await evaluate(`document.querySelector('[role="dialog"] main').textContent.includes('Choose a project to see its files')`))) searchFailures.push("Settings Drive picker loses Setup intent")
    await click('[data-app-project="mako"]')
    await until(`Boolean(document.querySelector('[data-project-tab]'))`, `${term} chosen project`)
    if (!(await evaluate(`Boolean(document.querySelector('[data-project-tab="${tab}"][aria-selected="true"]'))`))) searchFailures.push(`Settings ${term} opens the wrong project tab`)
    if (term === "Drive") {
      await replaceInput('[aria-label="Search settings"]', "run")
      if (!(await evaluate(`Boolean(document.querySelector('[data-project-tab="recipe"][aria-selected="true"]'))`))) searchFailures.push("Settings run does not return the open project to Recipe")
      await replaceInput('[aria-label="Search settings"]', "Drive")
      if (!(await evaluate(`Boolean(document.querySelector('[data-project-tab="setup"][aria-selected="true"]'))`))) searchFailures.push("Settings Drive does not return the open project to Setup")
      await click('[role="dialog"] main button')
      await until(`Boolean(document.querySelector('[data-app-project="api"]'))`, "All projects preserves Setup")
      await click('[data-app-project="api"]')
      await until(`Boolean(document.querySelector('[data-project-tab]'))`, "another project")
      if (!(await evaluate(`Boolean(document.querySelector('[data-project-tab="setup"][aria-selected="true"]'))`))) searchFailures.push("All projects loses Setup on another project")
      await capture("setup-settings-search.png")
    }
    await click('[role="dialog"] header button')
    await until(`!document.querySelector('[aria-label="Search settings"]')`, "Settings closed")
  }
  assert.deepEqual(searchFailures, [], "command aliases and Settings search keep the intended destination")
  console.log("PASS: actual Cmd+K aliases and Settings resource/recipe searches, including another project")

  // 2. The Inbox's count is the needs-you facts.
  // The facts as the Inbox's count reads them: a Setup ask arrives once its folder's Setup is read.
  await until(`${NEEDS_FACTS}.then((facts) => Number(document.querySelector('[data-rail-top-row="inbox"] [data-inbox-count]')?.textContent ?? 0) === facts.fins.length + facts.threads.length + facts.setup.length)`, "the Inbox row counts the needs-you facts")
  const facts = await evaluate(NEEDS_FACTS)
  console.log("NEEDS FACTS", JSON.stringify(facts))
  const expected = facts.fins.length + facts.threads.length + facts.setup.length
  assert.ok(facts.fins.length >= 2, "the scene has Fins asking the person")
  assert.match(await rollup(), new RegExp(`${facts.fins.length} needs? you`), "the Apex row's rollup says the same")
  await capture("desktop-rail.png")
  console.log(`PASS: the Inbox counts ${expected}, the needs-you facts`)

  // 3. Cmd+Shift+U opens it, the first item focused; Escape puts it away.
  await click(".thread-jump-scope [data-thread-row]")
  await chord("u", 85, MOD_SHIFT)
  await until(`document.querySelector('[data-inbox]') !== null`, "Cmd+Shift+U opens the Inbox")
  await until(`document.activeElement?.matches('[data-inbox-item]')`, "the first item focused")
  assert.equal(await evaluate(`document.querySelector('[data-rail-top-row="inbox"]').getAttribute('aria-current')`), "page", "the Inbox row is the open one")
  const items = await evaluate(`[...document.querySelectorAll('[data-inbox-section="needs"] [data-inbox-item]')].map((node) => ({ key: node.dataset.inboxItem, kind: node.dataset.inboxKind, fin: node.dataset.fin, text: node.innerText.replace(/\\s+/g, ' ') }))`)
  console.log("INBOX", JSON.stringify(items))
  assert.equal(items.length, expected, "the Inbox lists every fact")
  assert.deepEqual(items.filter((item) => item.kind === "fin").map((item) => item.fin).sort(), [...facts.fins].sort(), "one item per asking Fin")
  assert.ok(items.filter((item) => item.kind === "fin").every((item) => item.text.includes("Mobile polish")), "each Fin's item says where it is")
  await capture("desktop-inbox.png")
  await chord("Escape", 27, 0)
  await until(`document.querySelector('[data-inbox]') === null`, "Escape puts it away")
  console.log("PASS: Cmd+Shift+U opens the Inbox")

  // 4. An answer in the Inbox reaches the Apex's host, and that Fin is working in the Inbox and the rail at once.
  await click('[data-rail-top-row="inbox"]')
  await until(`document.querySelector('[data-inbox]') !== null`)
  const target = items.find((item) => item.kind === "fin")
  const answer = await evaluate(`(() => { const card = document.querySelector('[data-inbox-item=${JSON.stringify(target.key)}]'); const button = card.querySelector('[data-inbox-answer="allow"], [data-inbox-answer="0"]'); button.setAttribute('data-inbox-test', 'answer'); return button.dataset.inboxAnswer })()`)
  const before = await rollup()
  await click('[data-inbox-test="answer"]')
  await until("window.apexScene.responds().length === 1", "the answer reaching the Apex's host")
  assert.equal((await evaluate("window.apexScene.responds()[0]")).fin, target.fin)
  await until(`document.querySelector('[data-inbox-item=${JSON.stringify(target.key)}]') === null`, "the answered Fin leaves the Inbox")
  await until(`Number(document.querySelector('[data-rail-top-row="inbox"] [data-inbox-count]')?.textContent ?? 0) === ${expected - 1}`, "the Inbox row counts one fewer")
  const working = await evaluate(`import('/src/state/acp-state.ts').then(({acpStore}) => import('/src/state/apex-fins.ts').then(({threadChildren}) => import('/packages/host/src/contracts/children.ts').then(({childStateOf}) => { const acp = acpStore.get(); const thread = Object.values(acp.conversations).find((c) => c.kind === 'live' && threadChildren(acp, c.threadId).some((agent) => agent.child?.thread === ${JSON.stringify(target.fin)})).threadId; return childStateOf(threadChildren(acp, thread).find((agent) => agent.child?.thread === ${JSON.stringify(target.fin)})).kind })))`)
  assert.equal(working, "working", "the answered Fin is working")
  await until(`(document.querySelector('.thread-jump-scope [data-apex-row] [data-fin-pips]')?.getAttribute('aria-label') ?? '') !== ${JSON.stringify(before)}`, "the rail's rollup moves with it")
  assert.match(await rollup(), new RegExp(`${facts.fins.length - 1} needs? you`))
  assert.equal(await inboxCount(), expected - 1)
  console.log(`PASS: answering ${answer === "allow" ? "Allow once" : "the first option"} in the Inbox moves the Fin to working everywhere (${await rollup()})`)
  await capture("desktop-inbox-answered.png")

  await checkInboxNavigation({ window, page, base, evaluate, until, frames, click, capture })

  // 5. The phone: the Inbox chip with its count, Needs you / Working / Recent, the asking Fins as rows of their own.
  window.setContentSize(390, 844)
  await window.loadURL(`${base}scripts/phone-apex.html?app=apex`)
  await until(`document.querySelector('[data-list-chips]') !== null && document.querySelectorAll('[data-fin-row]').length > 0`, "the phone's chips and Fin rows")
  const phone = await evaluate(`({ chips: [...document.querySelectorAll('[data-list-chip]')].map((node) => node.dataset.listChip), count: Number(document.querySelector('[data-list-chip="inbox"] [data-inbox-count]')?.textContent ?? 0), sections: [...document.querySelectorAll('[data-list-section]')].map((node) => node.dataset.listSection), fins: [...document.querySelectorAll('[data-list-section="needs"] [data-fin-row]')].map((node) => ({ fin: node.dataset.finRow, text: node.innerText.replace(/\\s+/g, ' ') })) })`)
  console.log("PHONE", JSON.stringify(phone))
  assert.deepEqual(phone.chips, ["inbox"], "the phone's chips: the Inbox (pull requests and automations live on a Mac)")
  assert.equal(phone.sections[0], "needs", "Needs you leads")
  assert.ok(phone.sections.includes("working"), "Working follows")
  assert.ok(phone.fins.length >= 2, "each asking Fin is a row")
  assert.equal(phone.count, phone.fins.length + (await evaluate(`document.querySelectorAll('[data-list-section="needs"] [data-thread]').length`)), "the chip counts Needs you")
  assert.ok(phone.fins.every((fin) => fin.text.includes("Mobile polish · ")), "a Fin's row says its Apex before its question")
  await capture("phone-list.png")
  console.log("PASS: the phone's chips, sections and Fin rows")

  // 6. The phone's Inbox screen: the asks answered in place.
  await click('[data-list-chip="inbox"]')
  await until(`document.querySelector('[data-inbox] [data-ask=fin]') !== null`, "the phone's Inbox")
  const cards = await evaluate(`document.querySelectorAll('[data-inbox] [data-ask=fin]').length`)
  assert.equal(cards, phone.fins.length, "one card per asking Fin")
  await capture("phone-inbox.png")
  const phoneTarget = await evaluate(`(() => { const card = document.querySelector('[data-inbox] [data-ask=fin]'); const button = card.querySelector('[data-fin-answer="allow"], [data-fin-answer="0"]'); button.setAttribute('data-inbox-test', 'answer'); return card.dataset.fin })()`)
  await click('[data-inbox-test="answer"]')
  await until("window.apexScene.responds().length === 1", "the phone's answer reaching the Apex's host")
  assert.equal((await evaluate("window.apexScene.responds()[0]")).fin, phoneTarget)
  await until(`document.querySelectorAll('[data-inbox] [data-ask=fin]').length === ${cards - 1}`, "the answered Fin leaves the phone's Inbox")
  await click('[aria-label="Back to threads"]')
  await until(`document.querySelectorAll('[data-fin-row]').length === ${phone.fins.length - 1} && Number(document.querySelector('[data-list-chip="inbox"] [data-inbox-count]')?.textContent ?? 0) === ${phone.count - 1}`, "the list and its chip say it too")
  console.log("PASS: the phone's Inbox answers in place")

  assert.deepEqual(errors.filter((message) => !/Download the React DevTools/.test(message)), [])
  console.log("Inbox UI: passed")
  app.exit(0)
}
