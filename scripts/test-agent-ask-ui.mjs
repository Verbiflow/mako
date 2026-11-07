import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

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
  const root = await mkdtemp(join(tmpdir(), "mako-agent-ask-ui-"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-agent-ask-ui", main: fileURLToPath(import.meta.url) }))
  const { createServer } = await import("vite")
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
  await server.listen()
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
  console.log(`Agent ask UI evidence: ${process.env.MAKO_ASK_UI_SHOTS ?? join(root, "shots")}`)
}

const TITLE = "wants to move this Thread to the cloud"
const APEX_THREAD = "1ead1ead-0000-4000-8000-000000001ead"

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_ASK_UI_ROOT
  const shots = process.env.MAKO_ASK_UI_SHOTS ?? join(root, "shots")
  await mkdir(shots, { recursive: true })
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  await app.whenReady()
  const base = process.env.MAKO_ASK_UI_URL
  const window = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true } })
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
  await evaluate("document.querySelector('[data-inbox-kind=agent-ask] [data-inbox-answer=allow]').click(); true")
  await until("document.querySelectorAll('[data-inbox-kind=agent-ask]').length === 0", "the answered ask leaving the Inbox")
  assert.equal((await answers()).at(-1).allow, true)
  console.log("PASS: the desk's Inbox lists the ask once, and its answer reaches the host")

  // An ask arriving with another Thread open is said at once, by the control-only batch that carries it.
  await window.loadURL(`${base}?mock&app=apex`)
  await until("[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].some((row) => row.innerText.includes('Mobile polish'))", "the rail")
  await until("Boolean(window.apexScene)", "the scene")
  await evaluate("window.apexScene.raiseAgentAsk(); true")
  await until("import('/src/state/notifications.ts').then(({ notificationsStore }) => notificationsStore.get().items.some((item) => item.body.includes('move this Thread to the cloud')))", "the notice of a new ask")
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

  assert.deepEqual(errors.filter((message) => !/Download the React DevTools/.test(message)), [])
  console.log("Agent ask UI: passed")
  app.exit(0)
}
