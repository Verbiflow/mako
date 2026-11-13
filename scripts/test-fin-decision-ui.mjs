import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"
import { atSize, withMotion } from "./lib/test-window.mjs"

// Done · needs you, on the production components and the mock bridge's Apex scene with two Fins that finished with a
// decision (`?mock&app=apex&fins=decisions`): Thread list swipe leaves the person "Merge #371 into main?", Pull to
// refresh leaves its Apex a pick. The person's reads "Done · needs you: …" with its options as buttons, the
// recommended one first and labelled, in the crew card, the Inbox, the rail's pips and the phone, and counts under
// needs you; the Apex's counts as done and says it asks its Apex. An answer in the Inbox reaches the Apex's host and
// the Fin's row says "You answered: Merge". Screenshots of the crew card and the Inbox row, dark and light, land in
// the printed folder (or `MAKO_DECISION_UI_SHOTS`).
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = testScratch("mako-fin-decision-ui-")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-fin-decision-ui", main: fileURLToPath(import.meta.url) }))
  const { uiVite } = await import("./lib/ui-vite.mjs")
  const server = await uiVite({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
  await server.listen()
  const env = { ...process.env, MAKO_DECISION_UI_ROOT: root, MAKO_DECISION_UI_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server.close()
  }
}

const QUESTION = "Merge #371 into main?"
const WORDS = `Done · needs you: ${QUESTION}`

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_DECISION_UI_ROOT
  const shots = process.env.MAKO_DECISION_UI_SHOTS ?? join(root, "shots")
  await mkdir(shots, { recursive: true })
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  withMotion(app)
  await app.whenReady()
  const base = process.env.MAKO_DECISION_UI_URL
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true } })
  atSize(window, 1440, 900)
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
  const settle = () =>
    evaluate("document.fonts.ready.then(() => Promise.all(document.getAnimations().filter((each) => each.effect?.getTiming().iterations !== Infinity).map((each) => each.finished.catch(() => undefined)))).then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))).then(() => true)")
  const theme = (light) => evaluate(`document.documentElement.classList.toggle('light', ${light}); document.documentElement.style.colorScheme = '${light ? "light" : "dark"}'; true`)
  /** The element `selector` names (a selector with no quote in it), cropped with a margin, in both themes. */
  const shoot = async (name, selector) => {
    const files = []
    for (const light of [false, true]) {
      await theme(light)
      await settle()
      const rect = await evaluate(`(() => { const node = document.querySelector('${selector}'); node.scrollIntoView({ block: 'center' }); const r = node.getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.x - 12)), y: Math.max(0, Math.floor(r.y - 12)), width: Math.ceil(r.width + 24), height: Math.ceil(r.height + 24) } })()`)
      await settle()
      const file = join(shots, `${name}-${light ? "light" : "dark"}.png`)
      await writeFile(file, (await page.capturePage(rect)).toPNG())
      files.push(file)
    }
    await theme(false)
    console.log(`SHOTS ${files.join(" ")}`)
  }

  await window.loadURL(`${base}?mock&app=apex&fins=decisions`)
  await until("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].some((row) => row.innerText.includes('Mobile polish'))", "the Apex's row")
  await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({theme: 'dark'}))`)
  await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.innerText.includes('Mobile polish')).click(); true")
  await until("Boolean(document.querySelector('[data-composer]'))", "the Apex's composer")
  await evaluate("window.apexScene.setRunning(false); true")
  await until("Boolean(document.querySelector('[data-crew]'))", "the crew card")
  await settle()

  // 1. The crew card: counted under needs you, its words, its options as buttons, the recommended one first and labelled.
  const header = await evaluate("document.querySelector('[data-crew] header').innerText.replace(/\\s+/g, ' ')")
  assert.match(header, /12 Fins 3 need you · 5 working · 2 queued · 1 idle · 1 done/, "the person's decision counts as needs you, the Apex's as done")
  await until("Boolean(document.querySelector('[data-crew] [data-fin-decision]'))", "the decision's row")
  const row = await evaluate(`(() => { const node = document.querySelector('[data-crew] [data-fin-decision]'); return { group: node.dataset.childGroup, text: node.innerText.replace(/\\s+/g, ' '), buttons: [...node.querySelectorAll('[data-fin-answer]')].map((button) => ({ answer: button.dataset.finAnswer, text: button.innerText.replace(/\\s+/g, ' ').trim(), recommended: button.dataset.recommended === 'true' })) } })()`)
  console.log("CREW ROW", JSON.stringify(row))
  assert.equal(row.group, "needs")
  assert.ok(row.text.includes("Thread list swipe") && row.text.includes(WORDS), "its words: Done · needs you: and its question")
  assert.deepEqual(row.buttons, [{ answer: "0", text: "Merge Recommended", recommended: true }, { answer: "1", text: "Leave open", recommended: false }])
  await shoot("crew-card", "[data-crew]")
  // The card draws rows as they scroll into view: Pull to refresh is at its end, under done, and the fold of the
  // settled Fins never hides a done one whose decision is still open.
  await evaluate("(() => { const el = document.querySelector('[data-crew-scroller]'); el.scrollTop = el.scrollHeight; return true })()")
  await settle()
  await until("[...document.querySelectorAll('[data-crew] [data-crew-row]')].some((node) => node.innerText.includes('Pull to refresh'))", "the Apex's decision's row")
  const lead = await evaluate("(() => { const node = [...document.querySelectorAll('[data-crew] [data-crew-row]')].find((each) => each.innerText.includes('Pull to refresh')); return { group: node.dataset.childGroup, text: node.innerText.replace(/\\s+/g, ' ') } })()")
  assert.ok(lead.text.includes("Asking its Apex: Ship the cached list or the fresh read on pull?"), `the Apex's decision reads as asking it: ${lead.text}`)
  assert.equal(lead.group, "done", "and stands under done")
  const fold = await evaluate("(() => { const node = document.querySelector('[data-crew-settled]'); return node ? { state: node.dataset.crewSettled, text: node.innerText.replace(/\\s+/g, ' ').trim() } : null })()")
  console.log("FOLD", JSON.stringify(fold))
  assert.equal(fold?.state, "folded", "the settled Fins are folded")
  assert.doesNotMatch(fold.text, /done/, "and the fold doesn't count the Fin whose decision is open")
  await shoot("crew-card-end", "[data-crew]")
  await evaluate("(() => { const el = document.querySelector('[data-crew-scroller]'); el.scrollTop = 0; return true })()")
  console.log("PASS: the crew card says Done · needs you with its options, recommended first")

  // 2. The rail's pips count it, and the Inbox lists it with its buttons.
  const pips = await evaluate("document.querySelector('.thread-jump-scope [data-apex-row] [data-fin-pips]')?.getAttribute('aria-label') ?? ''")
  assert.equal(pips, "12 Fins: 3 need you · 5 working · 2 queued · 1 idle · 1 done")
  await evaluate("document.querySelector('[data-rail-top-row=\"inbox\"]').click(); true")
  await until("Boolean(document.querySelector('[data-inbox]'))", "the Inbox")
  const item = await evaluate(`(() => { const node = [...document.querySelectorAll('[data-inbox-item]')].find((each) => each.innerText.includes('Merge #371 into main?')); if (!node) return null; node.setAttribute('data-decision-test', 'item'); return { kind: node.dataset.inboxKind, text: node.innerText.replace(/\\s+/g, ' '), buttons: [...node.querySelectorAll('[data-inbox-answer]')].map((button) => button.innerText.replace(/\\s+/g, ' ').trim()) } })()`)
  console.log("INBOX ITEM", JSON.stringify(item))
  assert.equal(item?.kind, "fin")
  assert.ok(item.text.includes("Mobile polish") && item.text.includes(WORDS), "where it is, and its words")
  assert.deepEqual(item.buttons, ["Merge Recommended", "Leave open"])
  assert.equal(await evaluate("[...document.querySelectorAll('[data-inbox-item]')].some((each) => each.innerText.includes('Ship the cached list'))"), false, "the Apex's decision isn't the person's")
  await shoot("inbox-row", "[data-decision-test=item]")
  console.log("PASS: the rail's pips and the Inbox say it")

  // 3. Answered in place: the answer reaches the Apex's host and the Fin's row says who answered.
  await evaluate("document.querySelector('[data-decision-test=item] [data-inbox-answer=\"0\"]').click(); true")
  await until("window.apexScene.responds().length === 1", "the answer reaching the Apex's host")
  assert.equal(await evaluate("window.apexScene.responds()[0].option"), 0)
  await until(`![...document.querySelectorAll('[data-inbox-item]')].some((each) => each.innerText.includes('Merge #371 into main?'))`, "the answered decision leaves the Inbox")
  await evaluate("document.querySelector('[data-rail-top-row=\"inbox\"]').click(); true")
  await until("!document.querySelector('[data-inbox]')", "back to the Apex")
  await until("[...document.querySelectorAll('[data-crew] [data-crew-row]')].some((node) => node.innerText.includes('Thread list swipe') && node.innerText.includes('You answered: Merge'))", "the row saying who answered")
  console.log("PASS: answered in the Inbox, the row says You answered: Merge")

  // 4. The phone: a row of its own under Needs you, in the same words.
  window.setContentSize(390, 844)
  await window.loadURL(`${base}scripts/phone-apex.html?app=apex&fins=decisions`)
  await until("document.querySelectorAll('[data-fin-row]').length > 0", "the phone's Fin rows")
  const phone = await evaluate("[...document.querySelectorAll('[data-list-section=\"needs\"] [data-fin-row]')].map((node) => node.innerText.replace(/\\s+/g, ' '))")
  console.log("PHONE", JSON.stringify(phone))
  assert.ok(phone.some((text) => text.includes(`Mobile polish · ${WORDS}`)), "the phone's row says it")
  console.log("PASS: the phone's row says Done · needs you")

  assert.deepEqual(errors.filter((message) => !/Download the React DevTools/.test(message)), [])
  console.log("Fin decision UI: passed")
  app.exit(0)
}
