import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"
import { atSize, withMotion } from "./lib/test-window.mjs"

// The person's waiting line, where a Thread's agent waits for its turn's wait (`wait` on the `mako` server): on the mock
// bridge's Apex scene with a wait armed (`?mock&app=apex&idle=1&wait=1`), at a 1352 × 847 desk window and on the phone
// (390 × 844), the line says what it waits for and until when, each thing it named ticked off or pending, and Stop
// waiting, its one action, ends the wait and the line clears by itself. Screenshots land in the printed folder (or
// `MAKO_TURN_WAIT_SHOTS`).
if (process.versions.electron) {
  void check().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const root = testScratch("mako-turn-wait-ui-")
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-turn-wait-ui", main: fileURLToPath(import.meta.url) }))
  const { createServer } = await import("vite")
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**"] } } })
  await server.listen()
  const env = { ...process.env, MAKO_TURN_WAIT_ROOT: root, MAKO_TURN_WAIT_URL: server.resolvedUrls.local[0] }
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
  console.log(`Turn wait UI evidence: ${process.env.MAKO_TURN_WAIT_SHOTS ?? join(root, "shots")}`)
}

/** The mock Apex's Thread (`mock-apex-thread.ts`). */
const APEX_THREAD = "1ead1ead-0000-4000-8000-000000001ead"

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_TURN_WAIT_ROOT
  const shots = process.env.MAKO_TURN_WAIT_SHOTS ?? join(root, "shots")
  await mkdir(shots, { recursive: true })
  app.setPath("userData", join(root, "profile"))
  app.dock?.hide()
  withMotion(app)
  await app.whenReady()
  const base = process.env.MAKO_TURN_WAIT_URL

  const open = async (url, width, height) => {
    const window = new BrowserWindow({ width, height, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true } })
    atSize(window, width, height)
    const page = window.webContents
    const errors = []
    page.on("console-message", (event) => {
      if (event.level === "error") errors.push(event.message)
    })
    const evaluate = (code) => page.executeJavaScript(code)
    const shoot = async (name) => writeFile(join(shots, `${name}.png`), (await page.capturePage()).toPNG())
    const until = async (code, what = code) => {
      const deadline = Date.now() + 20_000
      while (!(await evaluate(code))) {
        if (Date.now() > deadline) {
          await shoot("failure")
          throw new Error(`Timed out waiting for ${what}${errors.length ? `; the page said: ${errors.join(" | ")}` : ""}`)
        }
        await new Promise((done) => setTimeout(done, 40))
      }
    }
    await window.loadURL(url)
    return { window, evaluate, until, shoot }
  }

  /** The desk opens on another Thread: the Apex's row in the rail opens it. */
  const openApex = async (surface) => {
    const row = "[...document.querySelectorAll('.thread-jump-scope [data-flip-key]')].find((row) => row.innerText.includes('Mobile polish'))"
    await surface.until(`Boolean(${row})`, "the Apex's row")
    await surface.evaluate(`${row}.click(); true`)
  }

  /** The line as drawn, then Stop waiting ending it: the same on every surface. */
  const throughTheLine = async (surface, where) => {
    await surface.until("Boolean(document.querySelector('[data-turn-wait-line]'))", `${where}: the waiting line`)
    const line = await surface.evaluate(`(() => {
      const line = document.querySelector('[data-turn-wait-line]')
      return {
        words: line.querySelector('[data-turn-wait-words]').innerText,
        items: [...line.querySelectorAll('[data-turn-wait-item]')].map((item) => [item.dataset.turnWaitItem, item.innerText]),
        buttons: [...line.querySelectorAll('button')].map((button) => button.innerText),
        visible: line.getBoundingClientRect().height > 0,
      }
    })()`)
    assert.match(line.words, /^Waiting for CI on #412 · until /, `${where}: what it waits for, and until when`)
    assert.deepEqual(line.items, [["met", "acme/app#412 checks"], ["pending", "fin:sheet-motion"]], `${where}: each item ticked off as it's met`)
    assert.deepEqual(line.buttons, ["Stop waiting"], `${where}: Stop waiting is its only action`)
    assert.ok(line.visible, `${where}: drawn`)
    assert.ok(await surface.evaluate("(() => { const words = document.querySelector('[data-turn-wait-words]'); return words.scrollWidth <= words.clientWidth })()"), `${where}: its words whole, the time included`)
    await surface.evaluate("document.querySelector('[data-turn-wait-line]').scrollIntoView({ block: 'center' }); true")
    await new Promise((done) => setTimeout(done, 300))
    await surface.shoot(`${where}-waiting`)
    await surface.evaluate("document.querySelector('[data-turn-wait-stop]').click(); true")
    await surface.until("!document.querySelector('[data-turn-wait-line]')", `${where}: the line clears once the wait ended`)
    await surface.shoot(`${where}-stopped`)
    console.log(`${where}: the line says what it waits for and until when, ticks off what's met, and clears on Stop waiting`)
  }

  try {
    const desk = await open(`${base}?mock&app=apex&idle=1&wait=1`, 1352, 847)
    await openApex(desk)
    await throughTheLine(desk, "desk")
    desk.window.close()
    const phone = await open(`${base}scripts/phone-apex.html?app=apex&idle=1&wait=1&open=${APEX_THREAD}`, 390, 844)
    await throughTheLine(phone, "phone")
    phone.window.close()
    // With no wait armed, no line.
    const none = await open(`${base}?mock&app=apex&idle=1`, 1352, 847)
    await openApex(none)
    await none.until("Boolean(document.querySelector('[data-background-work], [data-shiver-card], [data-prompt-actions]'))", "the Apex's conversation")
    await new Promise((done) => setTimeout(done, 500))
    assert.equal(await none.evaluate("document.querySelectorAll('[data-turn-wait-line]').length"), 0, "no wait, no line")
    none.window.close()
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
}
