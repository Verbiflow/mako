import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * Which of a Thread's Sessions a message goes to, on every client, through the production pieces on the mock bridge
 * (`src/dev/session-picker-check.tsx`'s Thread: an old Cursor fork, two Claude Code Sessions, the Cursor Session worked
 * in four hours ago), dark and light:
 *
 * - Nothing picks a Session for the person: a phone and an iPad open the Thread where they always did, on its first
 *   Session, the old fork, and name it under the bar and over the field ("To Cursor fork · …"); pressed, the Sessions
 *   newest first, the ones asleep folded. A send to the old fork the screen opened by itself asks first in a line
 *   above the composer: "Switch to the newest" takes the words there, "Send here" sends them. The fork picked from the
 *   sheet, a send goes without asking.
 * - A laptop's browser and the desktop app: each tab says when it was last worked in, the line over the field says
 *   where the words go, and only a Session the window opened by itself asks, in the composer's notice line.
 * - The message that woke the fork says so above it in the transcript.
 *
 * Screenshots go to the directory given as the first argument (default: a temporary one), named
 * `session-picker-<client>-<state>-<theme>.png`; `--port` serves the pages on that port.
 */
if (process.versions.electron) {
  const { app } = await import("electron")
  void check().then(() => app.exit(0)).catch((error) => {
    console.error(error)
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const args = process.argv.slice(2)
  const portAt = args.indexOf("--port")
  const port = portAt === -1 ? 0 : Number(args.splice(portAt, 2)[1])
  const onlyAt = args.indexOf("--only")
  const only = onlyAt === -1 ? "" : args.splice(onlyAt, 2)[1]
  const root = testScratch("mako-session-picker-ui-")
  const evidence = args[0] ? resolve(args[0]) : root
  await mkdir(evidence, { recursive: true })
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port, strictPort: port !== 0, hmr: false } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-session-picker-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_PICKER_ROOT: root, MAKO_PICKER_EVIDENCE: evidence, MAKO_PICKER_URL: server.resolvedUrls.local[0], MAKO_PICKER_ONLY: only }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
  } finally {
    await server.close()
  }
}

const FORK = "Thread Environments, the review screen"
const NEWEST = "Ship the session picker"

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_PICKER_ROOT
  const evidence = process.env.MAKO_PICKER_EVIDENCE
  app.setPath("userData", join(root, "profile"))
  // Each client's window closes before the next opens: the app stays.
  app.on("window-all-closed", () => {})
  await app.whenReady()
  const watchdog = setTimeout(() => app.exit(1), 360_000)

  /** A window as one client has it: a phone or an iPad under a finger, a laptop's or the desktop's under a mouse. */
  async function client(kind) {
    const touch = kind === "phone" || kind === "tablet"
    const size = { phone: [393, 852, 3], tablet: [834, 1194, 2], laptop: [1440, 900, 2], desktop: [1440, 900, 2] }[kind]
    const window = new BrowserWindow({ width: size[0], height: size[1], show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    const page = window.webContents
    page.debugger.attach("1.3")
    page.on("console-message", (details) => {
      if (details.level === "error") console.error(`[${kind}] ${details.message}`)
    })
    const evaluate = (code) => page.executeJavaScript(code)
    const frames = (count = 2) => evaluate(`new Promise(resolve => { let left = ${count}; const step = () => --left > 0 ? requestAnimationFrame(step) : resolve(true); requestAnimationFrame(step) })`)
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    /** Every finite animation on the page finished, or 800 ms gone: a sheet closing still takes touches. */
    const settled = async () => {
      await frames(3)
      await evaluate("Promise.race([Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))), new Promise(done => setTimeout(done, 800))]).then(() => true)")
    }
    const capture = async (name) => {
      await settled()
      await writeFile(join(evidence, `session-picker-${kind}-${name}.png`), (await page.capturePage()).toPNG())
    }
    const until = async (code, label = code) => {
      const deadline = Date.now() + 15_000
      while (!(await evaluate(code))) {
        if (Date.now() > deadline) {
          await capture("failure")
          throw new Error(`${kind}: timed out: ${label}`)
        }
        await wait(30)
      }
    }
    const find = (code) => `(() => { const node = ${code}; if (!node) throw new Error('Missing ' + ${JSON.stringify(code)}); const r = node.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`
    /** A tap or a click on what `code` finds. */
    const press = async (code) => {
      await settled()
      const { x, y } = await evaluate(find(code))
      if (touch) {
        await page.debugger.sendCommand("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] })
        await wait(40)
        await page.debugger.sendCommand("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
      } else for (const type of ["mousePressed", "mouseReleased"]) await page.debugger.sendCommand("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 })
      await frames(2)
    }
    const button = (scope, words) => `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find(node => node.textContent.trim() === ${JSON.stringify(words)})`
    const enter = async () => {
      for (const type of ["rawKeyDown", "char", "keyUp"]) await page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "char" && { text: "\r" }) })
      await frames(2)
    }
    const write = async (field, text) => {
      await evaluate(`document.querySelector(${JSON.stringify(field)}).focus(), true`)
      await page.debugger.sendCommand("Input.insertText", { text })
      await until(`document.querySelector(${JSON.stringify(field)})?.value.includes(${JSON.stringify(text)})`, "the words in the field")
    }
    await window.loadURL("about:blank")
    if (touch) {
      // A page first: emulating a window that has drawn nothing yet crashes Electron.
      await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: size[0], height: size[1], deviceScaleFactor: size[2], mobile: true })
      await page.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
    }
    const open = async (path, ready) => {
      if ((await evaluate("location.protocol")) === "http:") await evaluate("localStorage.clear(), true")
      await window.loadURL(new URL(path, process.env.MAKO_PICKER_URL).href)
      await until(ready, `${path} drawn`)
      await evaluate("document.fonts.ready.then(() => true)")
    }
    return { window, evaluate, capture, until, press, button, enter, write, open, wait }
  }

  /**
   * A phone or an iPad: the Thread opens where it always did (its first Session, the old fork), named under the bar and
   * over the field; a send there asks first, the screen having picked it; the sheet; a Session the person picks never
   * asks; the line that says what woke a Session.
   */
  async function touchClient(kind, theme) {
    const c = await client(kind)
    const form = `scripts/session-picker.html?form=${kind}&theme=${theme}`
    const current = "document.querySelector('[data-session-switcher] .web-session-current')"
    const field = ".web-composer-input"
    const sendsTo = "document.querySelector('[data-sends-to]')?.textContent"
    const asks = "Boolean(document.querySelector('[data-stale-send]'))"
    const send = "document.querySelector('[data-send-action=\"send\"]')"
    const ready = `Boolean(${current}) && Boolean(document.querySelector('${field}'))`
    try {
      await c.open(form, ready)
      assert.equal(await c.evaluate("matchMedia('(pointer: coarse)').matches"), true, "under a finger")
      const opened = await c.evaluate(`${current}.textContent`)
      assert.ok(opened.includes(FORK) && opened.includes("Fork · Asleep"), `nothing picks the newest for the person: it opens on its first, and says so: ${opened}`)
      assert.equal(await c.evaluate(sendsTo), `To Cursor fork · ${FORK}`, "the composer says where the words go")
      assert.equal(await c.evaluate(`document.querySelector('${field}').placeholder`), "Message", "the line names the Session; the placeholder doesn't again")
      await c.capture(`default-${theme}`)

      // The screen picked the old fork, not the person: a send asks first, the words kept.
      await c.write(field, "Please continue")
      await c.press(send)
      await c.until(asks, "the line asking first")
      const asked = await c.evaluate("document.querySelector('[data-stale-send]').textContent")
      assert.ok(asked.includes("Send to Cursor fork, idle 20 days?") && asked.includes(`Newest: Cursor · ${NEWEST}, last message 4 hours ago`), asked)
      assert.equal(await c.evaluate(`document.querySelector('${field}').value`), "Please continue", "the words stay in the field")
      const line = await c.evaluate("(() => { const r = document.querySelector('[data-stale-send]').getBoundingClientRect(); return { height: r.height } })()")
      assert.ok(line.height <= 96, `a line, not a dialog: ${line.height}px`)
      await c.capture(`confirm-${theme}`)

      // "Switch to the newest": the newest opens, the words in its field, and the composer says so.
      await c.press(c.button("[data-stale-send]", "Switch to the newest"))
      await c.until(`${current}.textContent.includes(${JSON.stringify(NEWEST)})`, "the newest open")
      await c.until(`document.querySelector('${field}')?.value === "Please continue"`, "the words carried")
      assert.equal(await c.evaluate(sendsTo), `To Cursor · ${NEWEST}`)
      assert.equal(await c.evaluate(asks), false, "a send to the newest doesn't ask")
      await c.capture(`switched-${theme}`)

      await c.press(current)
      await c.until("document.querySelectorAll('[data-session-row]').length === 1 && Boolean(document.querySelector('[data-session-fold]'))", "one row, three folded")
      assert.equal(await c.evaluate("document.querySelector('[data-session-fold]').textContent.trim()"), "3 more, asleep")
      await c.capture(`sheet-${theme}`)
      await c.press("document.querySelector('[data-session-fold]')")
      await c.until("document.querySelectorAll('[data-session-row]').length === 4", "every Session")
      const order = await c.evaluate("[...document.querySelectorAll('[data-session-row]')].map(node => node.textContent)")
      assert.ok(order[0].includes(NEWEST) && order[3].includes(FORK), `newest first, the fork last: ${JSON.stringify(order)}`)
      assert.ok(order[3].includes("Fork · Asleep · last message 20 days ago"), order[3])
      assert.equal(await c.evaluate("document.querySelector('[data-session-row][aria-current]').textContent.includes(" + JSON.stringify(NEWEST) + ")"), true, "the one sent to is marked")
      await c.capture(`sheet-all-${theme}`)

      // The person picks the old fork: it's theirs, and a send to it goes without asking.
      await c.press(`[...document.querySelectorAll('[data-session-row]')].at(-1)`)
      await c.until(`${current}.textContent.includes(${JSON.stringify(FORK)})`, "the fork open")
      if (!(await c.evaluate(`document.querySelector('${field}').value`))) await c.write(field, "Please continue")
      await c.press(send)
      await c.until(`document.querySelector('${field}').value === ''`, "sent")
      assert.equal(await c.evaluate(asks), false, "a Session the person picked never asks")
      await c.capture(`picked-${theme}`)

      // "Send here": the line goes and the message with it.
      await c.open(form, ready)
      await c.write(field, "Please continue")
      await c.press(send)
      await c.until(asks, "the line asking first")
      await c.press(c.button("[data-stale-send]", "Send here"))
      await c.until(`!document.querySelector('[data-stale-send]') && document.querySelector('${field}').value === ''`, "sent")

      // The message that woke the fork, above it.
      await c.open(`${form}&session=fork&woke`, "Boolean(document.querySelector('[data-woke-after]'))")
      const woke = await c.evaluate("document.querySelector('[data-woke-after]').textContent")
      assert.ok(/Sent to this Cursor session, idle since [A-Z][a-z]{2} \d{1,2}/.test(woke), woke)
      await c.capture(`woke-${theme}`)
      console.log(`${kind} ${theme}: opens where it always did and names it, asks only before the screen's own pick, carries the words, a pick sends, says what woke it`)
    } finally {
      c.window.destroy()
    }
  }

  /**
   * A laptop's browser: the desktop's tabs, the line over the field and the notice line, in the web app. The address
   * names no Session, so the Thread opens on its first, the old fork, and a send there asks; a tab the person picks
   * never does.
   */
  async function laptop(theme) {
    const c = await client("laptop")
    const form = `scripts/session-picker.html?form=desk&theme=${theme}`
    const field = "main textarea"
    const asks = "Boolean(document.querySelector('[data-stale-send]'))"
    const selected = "document.querySelector('[data-session-tab][aria-selected=\"true\"]')"
    try {
      await c.open(form, `document.querySelectorAll('.session-tab').length === 4 && Boolean(document.querySelector('${field}')) && Boolean(document.querySelector('[data-sends-to]'))`)
      const ages = await c.evaluate("[...document.querySelectorAll('[data-session-age]')].map(node => node.textContent)")
      // By the last message, not the journal's write: the two Sessions read this evening still say their weeks.
      assert.equal(ages.length, 4, `each tab says when it was worked in: ${JSON.stringify(ages)}`)
      assert.equal(ages[3], "4h", JSON.stringify(ages))
      assert.ok(ages.slice(0, 3).every((age) => !/^(now|\d+[mh])$/.test(age)), JSON.stringify(ages))
      const to = await c.evaluate("document.querySelector('[data-sends-to]').textContent")
      assert.ok(to.startsWith(`To Cursor fork · ${FORK}`) && to.includes("Asleep"), to)
      await c.capture(`default-${theme}`)
      await c.write(field, "Please continue")
      await c.enter()
      await c.until(asks, "the notice asking first")
      const asked = await c.evaluate("document.querySelector('[data-stale-send]').textContent")
      assert.ok(asked.includes("Send to Cursor fork, idle 20 days?"), asked)
      await c.capture(`confirm-${theme}`)
      await c.press(c.button("[data-stale-send]", "Switch to the newest"))
      await c.until(`${selected}?.textContent.includes(${JSON.stringify(NEWEST)})`, "the newest tab")
      await c.until(`document.querySelector('${field}')?.value.includes('Please continue')`, "the words carried")
      await c.until(`document.querySelector('[data-sends-to]')?.textContent.startsWith(${JSON.stringify(`To Cursor · ${NEWEST}`)})`, "the line over the field follows")

      // The person picks the old fork's tab: a send there goes without asking.
      await c.press("document.querySelectorAll('[data-session-tab]')[0]")
      await c.until(`${selected}?.getAttribute('data-session-tab') === document.querySelectorAll('[data-session-tab]')[0].getAttribute('data-session-tab') && Boolean(document.querySelector('${field}'))`, "the fork's tab")
      await c.write(field, "Please continue")
      await c.enter()
      await c.until(`document.querySelector('${field}')?.value === ''`, "sent")
      assert.equal(await c.evaluate(asks), false, "a tab the person picked never asks")
      await c.capture(`picked-${theme}`)

      await c.open(`${form}&session=fork&woke`, "Boolean(document.querySelector('[data-woke-after]'))")
      await c.capture(`woke-${theme}`)
      console.log(`laptop ${theme}: tabs say their age, the field says where it sends, asks only before the screen's own pick, carries the words, says what woke it`)
    } finally {
      c.window.destroy()
    }
  }

  /**
   * The desktop app's own window on its mock host: the busy Thread with its second Session an old fork of its first. A
   * narrow pane cuts the tabs short; the line over the field says where the words go. The fork's tab picked, a send
   * goes without asking; opened by the window itself, as a rail row with nothing to go on does, it asks.
   */
  async function desktop(theme) {
    const c = await client("desktop")
    const fork = "document.querySelectorAll('[data-session-tab]')[1]"
    const asks = "Boolean(document.querySelector('[data-stale-send]'))"
    try {
      await c.open("index.html?mock&app=busy&aged", "document.querySelectorAll('.session-tab').length === 4")
      await c.evaluate(`import("/src/state/prefs.ts").then(({ setPref, bindTheme }) => (setPref("theme", ${JSON.stringify(theme)}), bindTheme(), true))`)
      await c.capture(`tabs-${theme}`)
      await c.press(fork)
      await c.until(`${fork}.getAttribute('aria-selected') === 'true' && Boolean(document.querySelector('textarea')) && Boolean(document.querySelector('[data-sends-to]'))`, "the old fork's tab")
      const to = await c.evaluate("document.querySelector('[data-sends-to]').textContent")
      assert.ok(to.startsWith("To Claude Code fork · I'll read the MetaHarness track plan for the review screen") && to.includes("Asleep") && to.includes("fork of I'll read the MetaHarness track plan and the phone composer"), to)
      assert.ok((await c.evaluate(`${fork}.title`)).includes("Fork of I'll read the MetaHarness track plan and the phone composer · Asleep"), "its tooltip names its parent")
      await c.write("textarea", "Please continue")
      await c.enter()
      await c.until("document.querySelector('textarea')?.value === ''", "sent")
      assert.equal(await c.evaluate(asks), false, "a tab the person picked never asks")
      await c.capture(`picked-${theme}`)

      // As a folded rail row opens a Thread with nothing of the person's to go on: the window's own pick, the fork old again.
      await c.open("index.html?mock&app=busy&aged", "document.querySelectorAll('.session-tab').length === 4")
      await c.evaluate(`import("/src/state/prefs.ts").then(({ setPref, bindTheme }) => (setPref("theme", ${JSON.stringify(theme)}), bindTheme(), true))`)
      await c.press(fork)
      await c.until(`${fork}.getAttribute('aria-selected') === 'true' && Boolean(document.querySelector('textarea'))`, "the old fork's tab")
      const session = await c.evaluate(`${fork}.getAttribute('data-session-tab')`)
      await c.evaluate(`import("/src/state/thread-sessions.ts").then(({ noteOpenedByScreen }) => (noteOpenedByScreen(${JSON.stringify(session)}), true))`)
      await c.write("textarea", "Please continue")
      await c.enter()
      await c.until(asks, "the notice asking first")
      const asked = await c.evaluate("document.querySelector('[data-stale-send]').textContent")
      assert.ok(asked.includes("idle 20 days?"), asked)
      await c.capture(`confirm-${theme}`)
      console.log(`desktop ${theme}: tabs say their age, the field says where it sends and the fork's parent, a pick sends, the window's own pick asks`)
    } finally {
      c.window.destroy()
    }
  }

  const runs = { phone: (theme) => touchClient("phone", theme), tablet: (theme) => touchClient("tablet", theme), laptop, desktop }
  const kinds = process.env.MAKO_PICKER_ONLY ? process.env.MAKO_PICKER_ONLY.split(",") : Object.keys(runs)
  try {
    for (const theme of ["dark", "light"]) for (const kind of kinds) await runs[kind](theme)
  } finally {
    clearTimeout(watchdog)
  }
}
