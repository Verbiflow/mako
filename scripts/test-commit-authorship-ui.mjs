import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * Who cloud commits and pull requests are authored as, in Settings › Git on the desktop (the fixture desk's own
 * Settings), in a laptop's browser and on a phone (the web client's Settings, against a stand-in for the gateway's
 * route): As you by default; under As you with no token, one line that Mako's App opens pull requests until one is
 * added, pointing at "Open pull requests as me"; under As Mako, one line that commits name Mako's bot with the person
 * as co-author. A cloud without the setting says so plainly with no control to press, and one that can't read or save
 * it says what to do, never a raw error, on every form. Screenshots of each, dark and light, stay in the printed
 * directory.
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = testScratch("mako-commit-authorship-ui-", { given: process.env.MAKO_UI_EVIDENCE_DIR })
  const server = await createServer({
    cacheDir: join(testScratch("mako-commit-authorship-cache-"), "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port: 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-commit-authorship-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolveExit(code ?? 1))
    })
  } finally {
    await server.close()
  }
}

const FALLBACK = "Pull requests are opened by Mako by Verbiflow until you add a token in Open pull requests as me."
const AS_MAKO = "Commits name Mako's bot, with you as co-author."
const UNAVAILABLE = "This choice isn't on Mako Cloud yet. It will appear here after Mako Cloud's next update, and there's nothing you need to do."
const UNREAD = "Mako couldn't read this from Mako Cloud. Check your connection, then try again."
const UNCONFIRMED = "Mako couldn't confirm that choice, so this shows what Mako Cloud has now. Check your connection, then choose again if you need to."
const RAW = /remote method|answered \d{3}|^Error/

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const base = process.env.MAKO_UI_TEST_URL
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  const watchdog = setTimeout(() => {
    console.error("Commit authorship UI verification exceeded its 240-second limit")
    app.exit(1)
  }, 240_000)
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code).catch((error) => {
    throw new Error(`${error.message} in: ${code.slice(0, 400)}`)
  })
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  const settle = async () => {
    await evaluate(`(() => { if (!document.getElementById('hide-toasts')) document.head.insertAdjacentHTML('beforeend', '<style id="hide-toasts">[data-sonner-toaster]{display:none!important}</style>'); return true })()`)
    await evaluate("document.fonts.ready.then(() => true)")
    await evaluate(`Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))).then(() => true)`)
    await frames()
  }
  /** The window, cropped around `around` when given. */
  const capture = async (name, around) => {
    await settle()
    const rect = around && await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(around)})
      if (!node) return null
      const r = node.getBoundingClientRect()
      const pad = 20
      const x = Math.max(0, Math.floor(r.left - pad)), y = Math.max(0, Math.floor(r.top - pad))
      return { x, y, width: Math.min(innerWidth - x, Math.ceil(r.width + pad * 2)), height: Math.min(innerHeight - y, Math.ceil(r.height + pad * 2)) }
    })()`)
    await writeFile(join(root, `${name}.png`), (await (rect ? page.capturePage(rect) : page.capturePage())).toPNG())
  }
  const until = async (code, label = code) => {
    const deadline = Date.now() + 30_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure")
        throw new Error(`UI condition timed out: ${label}`)
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
    }
  }
  const click = async (selector) => {
    const at = await evaluate(`(() => { const node = [...document.querySelectorAll(${JSON.stringify(selector.css)})].find(node => ${selector.text ? `node.textContent.trim() === ${JSON.stringify(selector.text)}` : "true"}); if (!node) throw new Error('Missing target ' + ${JSON.stringify(JSON.stringify(selector))}); node.scrollIntoView({ block: 'nearest' }); const r = node.getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} })()`)
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await page.debugger.sendCommand("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...at })
  }
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText.replace(/\\s+/g, ' ') ?? ''`)
  const has = (selector, words) => `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '').replace(/\\s+/g, ' ').includes(${JSON.stringify(words)})`

  // The desktop: the fixture desk's own Settings › Git, opened where "Open pull requests as me" is.
  const section = "#pull-requests"
  const desktop = async (query, theme) => {
    await window.loadURL(`${base}?mock${query}`)
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({theme: ${JSON.stringify(theme)}}))`)
    await until(`Boolean(document.querySelector('.composer-input'))`, "the desk")
    await evaluate(`window.dispatchEvent(new CustomEvent('mako:settings', { detail: 'git#pull-requests' }))`)
    await until(`Boolean(document.querySelector('${section} [aria-label="Commits and pull requests"] button[aria-pressed="true"]:not([disabled])'))`, "the authorship control, read")
    await evaluate(`document.querySelector('${section}').scrollIntoView({ block: 'center' })`)
  }
  const failing = async (query, theme) => {
    await window.loadURL(`${base}?mock${query}`)
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({theme: ${JSON.stringify(theme)}}))`)
    await until(`Boolean(document.querySelector('.composer-input'))`, "the desk")
    await evaluate(`window.dispatchEvent(new CustomEvent('mako:settings', { detail: 'git#pull-requests' }))`)
    await until(`Boolean(document.querySelector('${section}'))`, "the section")
    await evaluate(`document.querySelector('${section}').scrollIntoView({ block: 'center' })`)
  }
  const pressed = (scope) => evaluate(`document.querySelector(${JSON.stringify(`${scope} [aria-label="Commits and pull requests"] [aria-pressed="true"], ${scope} [aria-label="Commits and pull requests"] [aria-checked="true"]`)})?.textContent.trim()`)

  for (const theme of ["dark", "light"]) {
    // As you by default, with no token: the line that the App opens pull requests until one is added.
    await desktop("", theme)
    assert.equal(await pressed(section), "As you", "As you by default")
    let said = await text(section)
    assert.ok(said.includes("Commits name you."), said)
    assert.ok(said.includes(FALLBACK), said)
    await capture(`desktop-as-you-no-token-${theme}`, section)
    // Its Add token opens "Open pull requests as me"'s form, and the line gives way to it.
    await click({ css: `${section} button`, text: "Add token" })
    await until(`Boolean(document.querySelector('${section} input[aria-label="GitHub token"]'))`, "the token form")
    assert.ok(!(await text(section)).includes(FALLBACK))
    // As Mako: one line, and no fallback.
    await desktop("", theme)
    await click({ css: `${section} [aria-label="Commits and pull requests"] button`, text: "As Mako" })
    await until(has(section, AS_MAKO), "the As Mako line")
    await until(`!document.querySelector('${section} [aria-label="Commits and pull requests"] button[disabled]')`, "saved")
    said = await text(section)
    assert.ok(!said.includes(FALLBACK), said)
    assert.ok(said.includes("Used once commits and pull requests are as you."), said)
    await capture(`desktop-as-mako-${theme}`, section)
    // As you with a token: commits and pull requests are theirs, nothing to add.
    await desktop("&github-token=on", theme)
    await until(has(section, "Signed in as @ada"), "the token's listing")
    said = await text(section)
    assert.ok(said.includes("Commits name you, and pull requests open with your GitHub token."), said)
    assert.ok(!said.includes(FALLBACK), said)
    await capture(`desktop-as-you-token-${theme}`, section)
    // Kept As Mako by the account, with a token kept but unused.
    await desktop("&github-token=on&github-authorship=mako", theme)
    assert.equal(await pressed(section), "As Mako")
    assert.ok((await text(section)).includes("Your token is kept, but not used while commits and pull requests are as Mako."))
    // A cloud without the setting: said plainly, nothing to press, and the token's own row still works.
    await failing("&github-authorship=missing", theme)
    await until(has(section, UNAVAILABLE), "the desktop's cloud without the setting")
    said = await text(section)
    assert.ok(!RAW.test(said) && !said.includes("Try again"), said)
    assert.equal(await evaluate(`Boolean(document.querySelector('${section} [aria-label="Commits and pull requests"]'))`), false, "no choice to press")
    assert.equal(await evaluate(`document.querySelector('${section} [role=switch][aria-label="Open pull requests as me"]').disabled`), false)
    await capture(`desktop-unavailable-${theme}`, section)
    // A cloud that can't be read: what to do, and a way to ask again.
    await failing("&github-authorship=failed", theme)
    await until(has(section, UNREAD), "the desktop's failure")
    said = await text(section)
    assert.ok(!RAW.test(said) && said.includes("Try again"), said)
    assert.equal(await evaluate(`Boolean(document.querySelector('${section} [aria-label="Commits and pull requests"]'))`), false, "no choice to press")
    await capture(`desktop-unread-${theme}`, section)
    // A save with no answer: what the account has now, read back, whichever way the save went.
    await desktop("&github-authorship=refused", theme)
    await click({ css: `${section} [aria-label="Commits and pull requests"] button`, text: "As Mako" })
    await until(has(section, UNCONFIRMED), "the desktop's unconfirmed save")
    await until(`!document.querySelector('${section} [aria-label="Commits and pull requests"] button[disabled]')`, "read back")
    assert.ok(!RAW.test(await text(section)))
    assert.equal(await pressed(section), "As you", "a save that didn't land reads back as it was")
    await capture(`desktop-unconfirmed-${theme}`, section)
    await desktop("&github-authorship=unanswered", theme)
    await click({ css: `${section} [aria-label="Commits and pull requests"] button`, text: "As Mako" })
    await until(has(section, UNCONFIRMED), "the desktop's save that landed unanswered")
    await until(`!document.querySelector('${section} [aria-label="Commits and pull requests"] button[disabled]')`, "read back")
    assert.equal(await pressed(section), "As Mako", "a save that landed with its answer lost reads back as landed")
    await capture(`desktop-unanswered-${theme}`, section)
  }

  // The web client: a laptop's browser draws the desktop's group; a phone the touch layout.
  const fixture = async (query, size) => {
    window.setContentSize(size.width, size.height)
    await window.loadURL(`${base}scripts/github-person-check.html?${query}`)
  }
  const deskGroup = "#pull-requests"
  const phoneGroup = "section:has([role=radiogroup][aria-label='Commits and pull requests'])"
  for (const theme of ["dark", "light"]) {
    const tone = theme === "light" ? "&theme=light" : ""
    await fixture(`view=desk&scene=off${tone}`, { width: 1100, height: 760 })
    await until(has(deskGroup, FALLBACK), "the laptop's fallback line")
    await capture(`web-as-you-no-token-${theme}`, deskGroup)
    await fixture(`view=desk&scene=off&authorship=mako${tone}`, { width: 1100, height: 760 })
    await until(has(deskGroup, AS_MAKO), "the laptop's As Mako line")
    await capture(`web-as-mako-${theme}`, deskGroup)

    await fixture(`view=phone&scene=off${tone}`, { width: 390, height: 844 })
    await until(has(phoneGroup, FALLBACK), "the phone's fallback line")
    assert.equal(await pressed(phoneGroup), "As you", "As you by default on a phone")
    await capture(`phone-as-you-no-token-${theme}`)
    await click({ css: `${phoneGroup} [role=radio]`, text: "As Mako" })
    await until(has(phoneGroup, AS_MAKO), "the phone's As Mako line")
    assert.ok(!(await text(phoneGroup)).includes(FALLBACK))
    await capture(`phone-as-mako-${theme}`)
    await fixture(`view=phone&scene=on${tone}`, { width: 390, height: 844 })
    await until(has(phoneGroup, "Commits name you, and pull requests open with your GitHub token."), "the phone with a token")
    assert.ok(!(await text(phoneGroup)).includes(FALLBACK))
    await capture(`phone-as-you-token-${theme}`)
    // As Mako with a token kept: the row says what the footer does, on the phone as on the desk.
    await fixture(`view=phone&scene=on&authorship=mako${tone}`, { width: 390, height: 844 })
    await until(has(phoneGroup, "Your token is kept, but not used while commits and pull requests are as Mako."), "the phone's kept token")
    assert.ok(!(await text(phoneGroup)).includes("GitHub shows you as the author"), "not the opposite of its footer")
    await capture(`phone-as-mako-token-${theme}`)

    // Each failure, on the laptop's and the phone's forms, and neither choice shown until it's known.
    const forms = [["web", "desk", { width: 1100, height: 760 }], ["phone", "phone", { width: 390, height: 844 }]]
    for (const [form, view, size] of forms) {
      await fixture(`view=${view}&scene=off&authorship=slow${tone}`, size)
      await until(`Boolean(document.querySelector('[aria-label="Commits and pull requests"]'))`, `the ${form}'s reading`)
      assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Commits and pull requests"] [aria-checked="true"], [aria-label="Commits and pull requests"] [aria-pressed="true"]').length`), 0, "As you isn't said before it's known")
      await fixture(`view=${view}&scene=off&authorship=missing${tone}`, size)
      await until(has("body", UNAVAILABLE), `the ${form}'s cloud without the setting`)
      const without = await text("body")
      assert.ok(!RAW.test(without) && !without.includes("Try again") && !without.includes(FALLBACK), without)
      assert.equal(await evaluate(`Boolean(document.querySelector('[aria-label="Commits and pull requests"]'))`), false, "no choice to press")
      assert.equal(await evaluate(`document.querySelector('[role=switch][aria-label="Open pull requests as me"]').disabled`), false)
      await capture(`${form}-unavailable-${theme}`)
      await fixture(`view=${view}&scene=off&authorship=failed${tone}`, size)
      await until(has("body", UNREAD), `the ${form}'s failure`)
      const unread = await text("body")
      assert.ok(!RAW.test(unread) && unread.includes("Try again"), unread)
      assert.equal(await evaluate(`Boolean(document.querySelector('[aria-label="Commits and pull requests"]'))`), false, "no choice to press")
      assert.equal(await evaluate(`document.querySelector('[role=switch][aria-label="Open pull requests as me"]').disabled`), false)
      await capture(`${form}-unread-${theme}`)
      await fixture(`view=${view}&scene=off&authorship=refused${tone}`, size)
      await until(`Boolean(document.querySelector('[aria-label="Commits and pull requests"]'))`, `the ${form}'s choice`)
      const choice = `[aria-label="Commits and pull requests"] ${view === "phone" ? "[role=radio]" : "button"}`
      const chosen = `document.querySelector('[aria-label="Commits and pull requests"] [aria-checked="true"], [aria-label="Commits and pull requests"] [aria-pressed="true"]')?.innerText`
      await click({ css: choice, text: "As Mako" })
      await until(has("body", UNCONFIRMED), `the ${form}'s unconfirmed save`)
      await until(`${chosen} === "As you"`, `the ${form} reading back a save that didn't land`)
      assert.ok(!RAW.test(await text("body")))
      await capture(`${form}-unconfirmed-${theme}`)
      await fixture(`view=${view}&scene=off&authorship=unanswered${tone}`, size)
      await until(`Boolean(document.querySelector('[aria-label="Commits and pull requests"]'))`, `the ${form}'s choice`)
      await click({ css: choice, text: "As Mako" })
      await until(has("body", UNCONFIRMED), `the ${form}'s save that landed unanswered`)
      await until(`${chosen} === "As Mako"`, `the ${form} reading back a save that landed`)
      // A save with no answer and a read that fails too: nothing claimed, and a way to ask again.
      await fixture(`view=${view}&scene=off&authorship=gone${tone}`, size)
      await until(`Boolean(document.querySelector('[aria-label="Commits and pull requests"]'))`, `the ${form}'s choice`)
      await click({ css: choice, text: "As Mako" })
      await until(has("body", UNREAD), `the ${form} losing the cloud mid-save`)
      const gone = await text("body")
      assert.ok(!RAW.test(gone) && gone.includes("Try again") && !gone.includes(UNCONFIRMED), gone)
      assert.equal(await evaluate(`Boolean(document.querySelector('[aria-label="Commits and pull requests"]'))`), false, "no choice said")
    }
  }

  clearTimeout(watchdog)
  app.exit(0)
}
