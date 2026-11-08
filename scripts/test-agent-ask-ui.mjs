import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"
import { atSize, withMotion } from "./lib/test-window.mjs"

// What an agent asked below full access through Mako's tools, on the production components and the mock bridge's Apex
// scene with an ask in its conversation (`&ask=move`): the desk's card above the composer and the phone's in the dock
// say the same words, and an answer on either reaches the conversation's host and takes the card away. Screenshots
// land in the printed folder (or `MAKO_ASK_UI_SHOTS`).
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = testScratch("mako-agent-ask-ui-")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-agent-ask-ui", main: fileURLToPath(import.meta.url) }))
  const { createServer } = await import("vite")
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
  const timestamped = []
  server.httpServer.on("request", (request) => {
    if (request.url?.startsWith("/src/state/notifications.ts?t=")) timestamped.push(request.url)
  })
  await server.listen()
  if (process.argv.includes("--warm-server")) {
    // Reproduce a reused dev server: its next page imports the invalidated module with Vite's timestamp.
    await server.transformRequest("/src/state/acp-live.ts")
    const notifications = await server.moduleGraph.getModuleByUrl("/src/state/notifications.ts")
    assert.ok(notifications, "the UI's notification module is in Vite's graph")
    server.moduleGraph.invalidateModule(notifications, new Set(), Date.now(), true)
  }
  const env = { ...process.env, MAKO_ASK_UI_ROOT: root, MAKO_ASK_UI_URL: server.resolvedUrls.local[0] }
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
  if (process.argv.includes("--warm-server")) assert.ok(timestamped.length, "the fresh profile loaded Vite's timestamped notification module")
  console.log(`Agent ask UI evidence: ${process.env.MAKO_ASK_UI_SHOTS ?? join(root, "shots")}`)
}

const TITLE = "Wants to move this Thread to the cloud"
const APEX_THREAD = "1ead1ead-0000-4000-8000-000000001ead"

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_ASK_UI_ROOT
  const shots = process.env.MAKO_ASK_UI_SHOTS ?? join(root, "shots")
  await mkdir(shots, { recursive: true })
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  withMotion(app)
  await app.whenReady()
  const base = process.env.MAKO_ASK_UI_URL
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
  // Once its entrance has played, the card has to be on screen and painted, not only in the document.
  const shoot = async (name, selector) => {
    await evaluate("Promise.all(document.getAnimations().filter((each) => each.effect?.getTiming().iterations !== Infinity).map((each) => each.finished.catch(() => undefined)))")
    await new Promise((done) => setTimeout(done, 300))
    const seen = await evaluate(`(() => { const box = document.querySelector('${selector}').getBoundingClientRect(); return { top: box.top, bottom: box.bottom, height: box.height, tall: innerHeight, opacity: getComputedStyle(document.querySelector('${selector}')).opacity } })()`)
    assert.ok(seen.height >= 24 && seen.top >= 0 && seen.bottom <= seen.tall && Number(seen.opacity) > 0.9, `${name}: the card isn't on screen: ${JSON.stringify(seen)}`)
    await writeFile(join(shots, `${name}.png`), (await page.capturePage()).toPNG())
  }
  const answers = () => evaluate("window.apexScene.agentAsks()")

  // The desk: the card above the composer; Keep here reaches the host and takes it away.
  await window.loadURL(`${base}?mock&app=apex&ask=move`)
  await until("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].some((row) => row.innerText.includes('Mobile polish'))", "the rail")
  await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.innerText.includes('Mobile polish')).click(); true")
  await until("Boolean(document.querySelector('[data-composer]'))", "the Apex's composer")
  await until("Boolean(document.querySelector('[data-agent-ask=move]'))", "the desk's card")
  const desk = await evaluate("document.querySelector('[data-agent-ask=move]').innerText.replace(/\\s+/g, ' ')")
  assert.ok(desk.includes(TITLE), desk)
  await shoot("desk", "[data-agent-ask=move]")
  await evaluate("[...document.querySelectorAll('[data-agent-ask=move] button')].find((node) => node.innerText.includes('Keep here')).click(); true")
  await until("!document.querySelector('[data-agent-ask=move]')", "the answered card leaving the desk")
  const [kept] = await answers()
  assert.equal(kept.allow, false)
  console.log("PASS: the desk's card, and Keep here reaching the host")

  // The desk's Inbox: the ask is listed once, counted, with the card's two answers, and an answer takes it away.
  await window.loadURL(`${base}?mock&app=apex&ask=move`)
  await until("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].some((row) => row.innerText.includes('Mobile polish'))", "the rail")
  await evaluate("document.querySelector('[data-rail-top-row=inbox]').click(); true")
  await until("Boolean(document.querySelector('[data-inbox]'))", "the Inbox")
  await until("document.querySelectorAll('[data-inbox-kind=agent-ask]').length === 1", "the ask in the Inbox, once")
  const inbox = await evaluate("document.querySelector('[data-inbox-kind=agent-ask]').innerText.replace(/\\s+/g, ' ')")
  assert.ok(inbox.includes("Move to the cloud") && inbox.includes("Keep here"), inbox)
  assert.ok(await evaluate("!document.querySelector('[data-inbox]').innerText.includes('Nothing waits on you')"), "the Inbox says what the rail says")
  await shoot("inbox", "[data-inbox-kind=agent-ask]")
  // An answer the host refuses frees the card, so the ask can be answered again.
  await evaluate("window.apexScene.refuseNextAgentAnswer(); document.querySelector('[data-inbox-kind=agent-ask] [data-inbox-answer=allow]').click(); true")
  await until("document.querySelector('[data-inbox-kind=agent-ask] [data-inbox-answer=allow]')?.disabled === false && document.querySelector('[data-inbox-kind=agent-ask]')", "the refused answer freeing the card")
  await new Promise((done) => setTimeout(done, 300))
  assert.equal(await evaluate("document.querySelector('[data-inbox-kind=agent-ask] [data-inbox-answer=allow]').disabled"), false, "a refused answer leaves the ask answerable")
  await evaluate("document.querySelector('[data-inbox-kind=agent-ask] [data-inbox-answer=allow]').click(); true")
  await until("document.querySelectorAll('[data-inbox-kind=agent-ask]').length === 0", "the answered ask leaving the Inbox")
  assert.equal((await answers()).at(-1).allow, true)
  console.log("PASS: the desk's Inbox lists the ask once, and its answer reaches the host")

  // A Fin's ask goes to its Apex first, as its harness's approvals do: the person's Inbox doesn't list it on its own.
  await window.loadURL(`${base}?mock&app=apex&ask=fin`)
  await until("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].some((row) => row.innerText.includes('Mobile polish'))", "the rail")
  await evaluate("document.querySelector('[data-rail-top-row=inbox]').click(); true")
  await until("Boolean(document.querySelector('[data-inbox]'))", "the Inbox")
  // The Fin's conversation held in this window, as it is once opened: its ask is in what the Inbox reads.
  await evaluate("window.mockState.hydrateLive('1ead1ead-5000-4000-8000-000000000004').then(() => true)")
  await until("Boolean(window.mockState.liveState().conversations['1ead1ead-5000-4000-8000-000000000004']?.control?.asks?.length)", "the Fin's ask, held")
  await new Promise((done) => setTimeout(done, 300))
  assert.equal(await evaluate("document.querySelectorAll('[data-inbox-kind=agent-ask]').length"), 0, "a Fin's ask isn't the person's until its Apex leaves it")
  console.log("PASS: a Fin's ask goes through its Apex, not straight to the person's Inbox")

  // On its Apex's row the Fin's ask reads in its own words, as its own card does: never as a command's approval.
  await until("[...document.querySelectorAll('[data-inbox-kind=fin]')].some((node) => node.innerText.includes('Dictation fallback'))", "the Fin's ask in the Inbox, from its Apex's row")
  const inboxFin = await evaluate("[...[...document.querySelectorAll('[data-inbox-kind=fin]')].find((node) => node.innerText.includes('Dictation fallback')).querySelectorAll('[data-inbox-answer]')].map((node) => node.innerText.trim())")
  assert.deepEqual(inboxFin, ["Move to the cloud", "Keep here"], `the Inbox answers in the ask's words: ${JSON.stringify(inboxFin)}`)
  await evaluate("[...[...document.querySelectorAll('[data-inbox-kind=fin]')].find((node) => node.innerText.includes('Dictation fallback')).querySelectorAll('[data-inbox-answer]')][0].click(); true")
  await until("window.apexScene.responds().some((each) => each.allow === true)", "its answer reaching the Apex's host as an allow")
  await window.loadURL(`${base}?mock&app=apex&ask=fin`)
  await until("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].some((row) => row.innerText.includes('Mobile polish'))", "the rail")
  await evaluate("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.innerText.includes('Mobile polish')).click(); true")
  await evaluate("window.apexScene.setRunning(false); true")
  await until("[...document.querySelectorAll('[data-crew] [data-fin-ask]')].some((node) => node.innerText.includes('Dictation fallback'))", "the Fin's ask on the crew card")
  const crew = await evaluate("[...document.querySelectorAll('[data-crew] [data-fin-ask]')].find((node) => node.innerText.includes('Dictation fallback')).innerText.replace(/\\s+/g, ' ')")
  assert.ok(crew.includes("Move to the cloud") && crew.includes("Keep here"), `the crew card answers in the ask's words: ${crew}`)
  assert.ok(!crew.includes("Allow once") && !crew.includes("waits on this command"), `and not as a command's approval: ${crew}`)
  await shoot("crew-fin-ask", "[data-crew]")
  console.log("PASS: a Fin's ask reads in its own words on its Apex's crew card and in the Inbox")

  // An ask arriving with another Thread open is said at once, by the control-only batch that carries it.
  await window.loadURL(`${base}?mock&app=apex`)
  await until("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].some((row) => row.innerText.includes('Mobile polish'))", "the rail")
  await until("Boolean(window.apexScene)", "the scene")
  await evaluate("window.apexScene.raiseAgentAsk(); true")
  await until("window.mockState.notifications().items.some((item) => item.body.includes('move this Thread to the cloud'))", "the notice of a new ask")
  console.log("PASS: a new ask is said as it arrives")

  // A laptop's browser: the desk's composer draws the card, and the answer reaches the host.
  window.setContentSize(1280, 800)
  await window.loadURL(`${base}scripts/web-desk.html?app=apex&thread=apex&ask=move`)
  await until("Boolean(document.querySelector('[data-agent-ask=move]'))", "the laptop browser's card")
  await shoot("laptop", "[data-agent-ask=move]")
  await evaluate("[...document.querySelectorAll('[data-agent-ask=move] button')].find((node) => node.innerText.includes('Move to the cloud')).click(); true")
  await until("!document.querySelector('[data-agent-ask=move]')", "the answered card leaving the laptop browser")
  assert.equal((await answers()).at(-1).allow, true)
  console.log("PASS: the laptop browser's card, and its answer reaching the host")

  // The laptop browser's crew card answers a Fin's ask in its own words.
  await window.loadURL(`${base}scripts/web-desk.html?app=apex&thread=apex&ask=fin`)
  await until("[...document.querySelectorAll('[data-crew] [data-fin-ask]')].some((node) => node.innerText.includes('Dictation fallback'))", "the laptop browser's crew card")
  const laptopFin = await evaluate("[...document.querySelectorAll('[data-crew] [data-fin-ask]')].find((node) => node.innerText.includes('Dictation fallback')).innerText.replace(/\\s+/g, ' ')")
  assert.ok(laptopFin.includes("Move to the cloud") && !laptopFin.includes("Allow once"), `the laptop browser answers in the ask's words: ${laptopFin}`)
  console.log("PASS: the laptop browser's crew card answers a Fin's ask in its own words")

  // The phone: the dock's card in the same words; Move to the cloud reaches the host and takes it away.
  window.setContentSize(390, 844)
  await window.loadURL(`${base}scripts/phone-apex.html?app=apex&ask=move&open=${APEX_THREAD}`)
  await until("Boolean(document.querySelector('[data-ask=agent]'))", "the phone's card")
  const phone = await evaluate("document.querySelector('[data-ask=agent]').innerText.replace(/\\s+/g, ' ')")
  assert.ok(phone.includes("Wants to move this Thread to the cloud"), phone)
  assert.equal(await evaluate("document.querySelector('[data-agent-answer=keep]').hasAttribute('data-refuse')"), false, "the safe answer doesn't read as a refusal")
  await shoot("phone", "[data-ask=agent]")
  await evaluate("document.querySelector('[data-agent-answer=allow]').click(); true")
  await until("!document.querySelector('[data-ask=agent]')", "the answered card leaving the phone")
  assert.equal((await answers()).at(-1).allow, true)
  console.log("PASS: the phone's card, and Move to the cloud reaching the host")

  // The phone's Inbox answers a Fin's ask in its own words too.
  await window.loadURL(`${base}scripts/phone-apex.html?app=apex&ask=fin&screen=inbox`)
  await until("[...document.querySelectorAll('[data-ask=fin]')].some((node) => node.innerText.includes('Wants to move'))", "the Fin's ask in the phone's Inbox")
  const phoneFin = await evaluate("[...document.querySelectorAll('[data-ask=fin]')].find((node) => node.innerText.includes('Wants to move')).innerText.replace(/\\s+/g, ' ')")
  assert.ok(phoneFin.includes("Move to the cloud") && phoneFin.includes("Keep here") && !phoneFin.includes("Allow once"), `the phone answers in the ask's words: ${phoneFin}`)
  await shoot("phone-fin-ask", "[data-ask=fin]")
  console.log("PASS: the phone's Inbox answers a Fin's ask in its own words")

  // From inside a cloud Thread, on the desk: allowed, it's Bring it back on this Mac, which the Inbox leaves to the card.
  window.setContentSize(1440, 900)
  await window.loadURL(`${base}?mock&app=apex&ask=back`)
  await until("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].some((row) => row.innerText.includes('Mobile polish'))", "the rail")
  await evaluate("document.querySelector('[data-rail-top-row=inbox]').click(); true")
  await until("document.querySelectorAll('[data-inbox-kind=agent-ask]').length === 1", "the ask to come back in the Inbox")
  assert.equal(await evaluate("document.querySelectorAll('[data-inbox-kind=agent-ask] [data-inbox-answer]').length"), 0, "only the card can press Bring it back")
  assert.ok((await evaluate("document.querySelector('[data-inbox-kind=agent-ask]').innerText")).includes("Bring it back from its Thread"), "the Inbox says where to answer it")
  await evaluate("document.querySelector('[data-inbox-kind=agent-ask] [data-inbox-open]').click(); true")
  await until("Boolean(document.querySelector('[data-agent-ask=back]'))", "the desk's card to come back")
  await evaluate("[...document.querySelectorAll('[data-agent-ask=back] button')].find((node) => node.innerText.includes('Bring it back')).click(); true")
  await until("window.apexScene.returns().length === 1", "the desk's Bring it back")
  console.log("PASS: on the desk, allowing it presses Bring it back, and the Inbox leaves that to the card")

  // In a laptop's browser: allowed, it's the sheet that picks the Mac.
  window.setContentSize(1280, 800)
  await window.loadURL(`${base}scripts/web-desk.html?app=apex&thread=apex&ask=back`)
  await until("Boolean(document.querySelector('[data-agent-ask=back]'))", "the laptop browser's card to come back")
  await evaluate("[...document.querySelectorAll('[data-agent-ask=back] button')].find((node) => node.innerText.includes('Bring it back')).click(); true")
  await until("Boolean(document.querySelector('[data-move-ask=device]'))", "the laptop browser's sheet that brings it back")
  console.log("PASS: in a laptop's browser, allowing it opens the Bring it back sheet")

  // From inside a cloud Thread: allowed on the phone, it's the sheet that picks the Mac, as the menu's Bring it back opens.
  window.setContentSize(390, 844)
  await window.loadURL(`${base}scripts/phone-apex.html?app=apex&ask=back&open=${APEX_THREAD}`)
  await until("Boolean(document.querySelector('[data-ask=agent]'))", "the phone's card to come back")
  const back = await evaluate("document.querySelector('[data-ask=agent]').innerText.replace(/\\s+/g, ' ')")
  assert.ok(back.includes("Wants to bring this Thread back to your Mac") && back.includes("Bring it back"), back)
  await evaluate("document.querySelector('[data-agent-answer=allow]').click(); true")
  await until("Boolean(document.querySelector('[data-move-ask=device]'))", "the sheet that brings it back")
  await shoot("phone-back", "[data-move-ask=device]")
  console.log("PASS: allowed, the phone's Bring it back sheet opens")

  assert.deepEqual(errors.filter((message) => !/Download the React DevTools/.test(message)), [])
  console.log("Agent ask UI: passed")
  app.exit(0)
}
