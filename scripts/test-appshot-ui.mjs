import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Appshots in the production desk with the fixture bridge (`?mock`): the
 * Appshots settings with trusted input (the switch and the press that
 * checks it, a chord refused for being Save, modifiers that arrived with no
 * key, a chord refused as macOS's own, one accepted and checked, a refusal
 * at start with its fallback to both Shift keys, both Shift keys that
 * reached the window but not the shortcut, keys taken since they were set,
 * another app that came to the front after a press, and the shortcut's
 * readout in Diagnostics), a capture arriving
 * while Mako is in front (the pill, the flight, the tile with the app and
 * the window's title), the tile's preview with the elements drawn over the
 * picture and one named under the pointer, and the chip in the sent prompt
 * opening the same. The capture is a real one of the fixture page
 * (`scripts/fixtures/appshot/`). Screenshots go to the printed directory,
 * or the one given as the first argument. Vite listens on 20029.
 */
if (process.versions.electron) {
  const { app } = await import("electron")
  void check().then(() => app.exit(0)).catch((error) => {
    console.error(error)
    app.exit(1)
  })
} else {
  const { createServer } = await import("vite")
  const root = await mkdtemp(join(tmpdir(), "mako-appshot-ui-"))
  const evidence = process.argv[2] ? resolve(process.argv[2]) : root
  await mkdir(evidence, { recursive: true })
  const server = await createServer({ cacheDir: join(root, "cache"), server: { host: "127.0.0.1", port: 20029, strictPort: true, hmr: false } })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-appshot-ui-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_APPSHOT_ROOT: root, MAKO_APPSHOT_EVIDENCE: evidence, MAKO_APPSHOT_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((done, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => done(code ?? 1))
    })
  } finally {
    await server.close()
  }
  console.log(`Appshot UI evidence: ${evidence}`)
}

async function check() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_APPSHOT_ROOT
  const evidence = process.env.MAKO_APPSHOT_EVIDENCE
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const watchdog = setTimeout(() => app.exit(1), 180_000)
  const window = new BrowserWindow({ width: 1360, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const page = window.webContents
  page.debugger.attach("1.3")
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const shots = []
  const capture = async (name) => {
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    await writeFile(join(evidence, name), (await page.capturePage()).toPNG())
    shots.push(name)
  }
  const until = async (code, label = code, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await evaluate(code)
      if (value) return value
      if (Date.now() > deadline) {
        await capture("failure.png")
        throw new Error(`Timed out: ${label}`)
      }
      await new Promise((done) => setTimeout(done, 30))
    }
  }
  const mouse = (type, point, extra = {}) =>
    page.debugger.sendCommand("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, x: point.x, y: point.y, ...extra })
  const click = async (selector, text) => {
    const point = await evaluate(`(() => {
      const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(n => ${text ? `n.textContent.includes(${JSON.stringify(text)})` : "true"})
      if (!node) return null
      node.scrollIntoView({ block: "center" })
      const box = node.getBoundingClientRect()
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
    })()`)
    if (!point) {
      await capture("failure.png")
      throw new Error(`Nothing to click: ${selector} ${text ?? ""}`)
    }
    await mouse("mouseMoved", point, { button: "none" })
    await mouse("mousePressed", point)
    await mouse("mouseReleased", point)
    return point
  }
  const keyEvent = (type, key, code, modifiers, keyCode) =>
    page.debugger.sendCommand("Input.dispatchKeyEvent", { type, key, code, modifiers, windowsVirtualKeyCode: keyCode })
  const key = async (key, code, modifiers, keyCode) => {
    await keyEvent("rawKeyDown", key, code, modifiers, keyCode)
    await keyEvent("keyUp", key, code, modifiers, keyCode)
  }
  /** The client's word that the shortcut was pressed, as its event delivers it. */
  const pressShortcut = () => evaluate(`import("/src/state/appshot-shortcut.ts").then((m) => { m.shortcutPressed([]); return true })`)
  /** Wait out a popover's entrance, so a click lands on where its button ends up. */
  const settled = () => evaluate(`Promise.all(document.getAnimations().filter(a => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))).then(() => true)`)
  const toggleElements = async () => {
    await settled()
    await click('[aria-label="Capture of Electron"] button[aria-pressed]')
    await until(`document.querySelector('[aria-label="Capture of Electron"] button[aria-pressed]').getAttribute("aria-pressed") === "true"`, "the elements toggle on")
  }
  const text = (selector) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(n => n.textContent).join("\\n")`)

  await window.loadURL(new URL("/?mock", process.env.MAKO_APPSHOT_URL).href)
  // The person is looking at Mako: a capture they asked for here flies into the draft.
  await page.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true })
  await until("Boolean(document.querySelector('[data-composer] textarea'))", "the composer", 30_000)

  /* Settings › Appshots --------------------------------------------------------- */

  await evaluate(`window.dispatchEvent(new CustomEvent("mako:settings", { detail: "appshots" })); true`)
  await until(`document.body.textContent.includes("Appshot shortcut")`, "the Appshots section")
  await until(`document.body.textContent.includes("Allowed")`, "the grants read")
  await capture("01-settings-off.png")
  await click('[role="switch"][aria-label="Appshot shortcut"]')
  await until(`document.body.textContent.includes("Press both Shift keys once to check it reaches Mako.")`, "the shortcut on, asking for one press")
  await capture("02-settings-on.png")
  await pressShortcut()
  await until(`document.body.textContent.includes("Pressed — it reaches Mako.")`, "the press arrived")
  assert.equal(await evaluate(`document.querySelectorAll('[data-window-capture]').length`), 0, "the press Settings waited for is the check, not an Appshot")
  await capture("02b-settings-pressed.png")
  await click('[aria-label="Appshot keys"] button', "Keys…")
  await until(`Boolean(document.querySelector('[aria-label="Recording the Appshot shortcut"]'))`, "the recorder")
  await key("s", "KeyS", 4, 83)
  await until(`document.body.textContent.includes("This is Save in most apps.")`, "⌘S refused")
  assert.equal(await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent === "Save")?.disabled`), true, "Save waits for keys nothing else uses")
  await capture("03-settings-conflict.png")
  // ⌃⇧ and a key another app's shortcut took: only the modifiers come and go.
  await keyEvent("rawKeyDown", "Control", "ControlLeft", 2, 17)
  await keyEvent("rawKeyDown", "Shift", "ShiftLeft", 2 | 8, 16)
  await keyEvent("keyUp", "Shift", "ShiftLeft", 2, 16)
  await keyEvent("keyUp", "Control", "ControlLeft", 0, 17)
  await until(`document.body.textContent.includes("Only ⌃⇧ arrived. If you pressed a key with them, another app or macOS has it.")`, "modifiers that arrived alone")
  await capture("03b-recorder-alone.png")
  await key("ArrowUp", "ArrowUp", 2, 38)
  await until(`document.body.textContent.includes("⌃↑ is the shortcut for Mission Control in System Settings.")`, "⌃↑ refused as macOS's")
  assert.equal(await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent === "Save")?.disabled`), true)
  await capture("03c-recorder-macos.png")
  await key("s", "KeyS", 1 | 2 | 4, 83)
  await until(`document.body.textContent.includes("No other app took ⌘⌃⌥S. Press Save to use it.")`, "⌃⌥⌘S free")
  await capture("03d-recorder-free.png")
  await pressShortcut()
  await until(`document.body.textContent.includes("Pressed — it reaches Mako. Press Save to use it.")`, "⌃⌥⌘S pressed again while held")
  await capture("03e-recorder-pressed.png")
  await click("button", "Save")
  await until(`document.body.textContent.includes("Pressed — it reaches Mako.") && !document.querySelector('[aria-label="Recording the Appshot shortcut"]')`, "the chord held, checked while recording")
  await capture("04-settings-chord.png")
  // At the next start the client refuses the keys: another app took them meanwhile.
  await evaluate(`import("/src/state/appshot-shortcut.ts").then((m) => { m.appshotShortcutStore.set({ status: { state: "refused", reason: "macOS or another app already holds these keys for itself.", clash: { by: "held" } }, check: null }); return true })`)
  await until(`document.body.textContent.includes("macOS or another app already holds ⌘⌃⌥S for itself.")`, "a refusal at start, in one line")
  await capture("04b-settings-refused.png")
  // Taken since: a later check (a wake, System Settings changing) found the keys held exclusively elsewhere.
  const saved = JSON.parse(await evaluate(`localStorage.getItem("mako.prefs.v1")`)).appshotShortcut
  await evaluate(`import("/src/state/appshot-shortcut.ts").then((m) => { m.appshotShortcutStore.set({ status: { state: "refused", reason: "Since you set it, macOS or another app took these keys for itself.", clash: { by: "held" }, later: true } }); return true })`)
  await until(`document.body.textContent.includes("Since you set it, macOS or another app took ⌘⌃⌥S for itself.")`, "keys taken since they were set")
  await capture("04d-settings-taken-later.png")
  // Held, and a launcher came to the front right after a press: what the client watches for.
  const now = Date.now()
  const reacted = { app: "Raycast", bundleId: "com.raycast.macos", pid: 4242, afterMs: 4, shortcut: saved }
  const watch = {
    state: { state: "on", shortcut: saved },
    checks: [
      { at: now - 4 * 60_000, reason: "preferences", result: "clear", ms: 163 },
      { at: now - 31 * 60_000, reason: "wake", result: "busy", ms: 287 },
      { at: now - 52 * 60_000, reason: "set", result: "clear", ms: 251 },
    ],
    next: now + 56 * 60_000,
    watching: { preferences: "file", activations: true },
    press: { at: now - 2 * 60_000, evidence: reacted },
    evidence: reacted,
  }
  const held = `import("/src/state/appshot-shortcut.ts").then((m) => { m.appshotShortcutStore.set({ status: ${JSON.stringify(watch.state)}, check: null, watch: ${JSON.stringify(watch)} }); return true })`
  await evaluate(held)
  await until(`document.body.textContent.includes("Another app may also react to ⌘⌃⌥S: Raycast came to the front right after you pressed it.")`, "the press's evidence, in one line")
  await capture("04e-settings-evidence.png")
  await evaluate(`window.dispatchEvent(new CustomEvent("mako:settings", { detail: "diagnostics" })); true`)
  await until(`Boolean(document.querySelector("[data-appshot-shortcut-readout]"))`, "the shortcut's readout in Diagnostics")
  const readout = await text("[data-appshot-shortcut-readout]")
  assert.match(readout, /Held: ⌘⌃⌥S/)
  assert.match(readout, /System Settings’ shortcuts \(file\) and apps coming to the front/)
  assert.match(readout, /skipped, keys in use · woke/)
  assert.match(readout, /Last press 2m ago: Raycast came to the front 4 ms after it/)
  await evaluate(`document.querySelector("[data-appshot-shortcut-readout]").scrollIntoView({ block: "center" }); true`)
  await settled()
  await capture("04f-diagnostics-readout.png")
  await evaluate(`window.dispatchEvent(new CustomEvent("mako:settings", { detail: "appshots" })); true`)
  await until(`document.body.textContent.includes("Appshot shortcut") && !document.querySelector("[data-appshot-shortcut-readout]")`, "back in Appshots")
  // Opening Appshots asks the client again; then the refusal at start, for its fallback below.
  await new Promise((done) => setTimeout(done, 300))
  await evaluate(`import("/src/state/appshot-shortcut.ts").then((m) => { m.appshotShortcutStore.set({ status: { state: "refused", reason: "macOS or another app already holds these keys for itself.", clash: { by: "held" } }, check: null }); return true })`)
  await until(`document.body.textContent.includes("macOS or another app already holds ⌘⌃⌥S for itself.")`, "the refusal at start again")
  await click("button", "Use both Shift keys")
  await until(`document.body.textContent.includes("Press both Shift keys once to check it reaches Mako.")`, "back to both Shift keys")
  // Both Shift keys reach the window but the helper says nothing.
  await keyEvent("rawKeyDown", "Shift", "ShiftLeft", 8, 16)
  await keyEvent("rawKeyDown", "Shift", "ShiftRight", 8, 16)
  await until(`document.body.textContent.includes("Both Shift keys reached this window, but the shortcut didn’t fire. Hold them a moment longer.")`, "both Shift keys missed", 4000)
  await keyEvent("keyUp", "Shift", "ShiftRight", 8, 16)
  await keyEvent("keyUp", "Shift", "ShiftLeft", 0, 16)
  await capture("04c-pair-missed.png")
  await pressShortcut()
  await until(`document.body.textContent.includes("Pressed — it reaches Mako.")`, "both Shift keys pressed")
  const prefs = JSON.parse(await evaluate(`localStorage.getItem("mako.prefs.v1")`))
  assert.equal(prefs.appshotShortcutOn, true)
  assert.deepEqual(prefs.appshotShortcut, { kind: "modifiers", modifier: "shift" })
  await key("Escape", "Escape", 0, 27)
  await until(`!document.body.textContent.includes("Appshot shortcut")`, "Settings closed")

  /* A capture with Mako in front ----------------------------------------------- */

  await evaluate(`import("/src/state/appshot-shortcut.ts").then((m) => { void m.captureFromShortcut([]); return true })`)
  await until(`document.body.textContent.includes("Taking an Appshot of Electron…")`, "the capturing pill")
  await capture("05-capturing.png")
  await until(`Boolean(document.querySelector('img[alt="Appshot of Electron"]'))`, "the flight", 5000)
  await new Promise((done) => setTimeout(done, 300))
  await capture("06-flight.png")
  await until(`Boolean(document.querySelector('[data-window-capture]')) && !document.querySelector('img[alt="Appshot of Electron"]')`, "the tile, after the flight", 5000)
  await until(`!document.querySelector('[data-window-capture]').closest('.opacity-60')`, "the tile staged")
  const tile = await text("[data-window-capture]")
  assert.match(tile, /Electron/)
  assert.match(tile, /Invoices · Fixture Books/)
  await capture("07-tile.png")

  /* The tile's preview and the elements over the picture ----------------------- */

  await click("[data-window-capture]")
  await until(`Boolean(document.querySelector('[aria-label="Capture of Electron"] img[alt^="Electron"]'))`, "the preview")
  await toggleElements()
  await until(`document.querySelectorAll('svg[aria-label="Element boxes"] g').length > 20`, "the element boxes")
  const outline = await readFile(resolve("scripts/fixtures/appshot/capture.txt"), "utf8")
  const red = /Button "Delete draft" \[(\d+),(\d+),(\d+),(\d+)\]/.exec(outline).slice(1).map(Number)
  const point = await evaluate(`(() => {
    const rect = [...document.querySelectorAll('svg[aria-label="Element boxes"] g > rect:last-child')].find(r => r.getAttribute("x") === "${red[0]}" && r.getAttribute("y") === "${red[1]}")
    const box = rect.getBoundingClientRect()
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
  })()`)
  await mouse("mouseMoved", point, { button: "none" })
  await until(`document.body.textContent.includes('Button "Delete draft" [${red.join(",")}]')`, "the line under the pointer")
  await capture("08-elements-overlay.png")
  await key("Escape", "Escape", 0, 27)

  /* Sent: the chip in the prompt ----------------------------------------------- */

  // Type after the chip, as a person returning to the draft would.
  await evaluate(`(() => { const area = document.querySelector("[data-composer] textarea"); area.focus(); area.setSelectionRange(area.value.length, area.value.length); return true })()`)
  await page.debugger.sendCommand("Input.insertText", { text: " Why did the two invoices fail to sync?" })
  await capture("09-draft.png")
  await settled()
  await key("Enter", "Enter", 0, 13)
  await new Promise((done) => setTimeout(done, 500))
  // The send the composer's own ⌘↩ and annotations use, should Enter have been taken by a menu.
  await evaluate(`document.querySelector("[data-composer] textarea").value.includes("Why did") && window.dispatchEvent(new Event("mako:composer-send")); true`)
  await until(`Boolean(document.querySelector('[data-context-chip="window"]'))`, "the window chip in the sent prompt", 20_000)
  await click('[data-context-chip="window"]')
  await until(`Boolean(document.querySelector('[aria-label="Capture of Electron"] img'))`, "the chip's preview")
  await toggleElements()
  await until(`document.querySelectorAll('svg[aria-label="Element boxes"] g').length > 20`, "the boxes from the staged outline")
  await capture("10-transcript-chip.png")

  clearTimeout(watchdog)
  console.log(`Appshot UI: settings (switch and its check press, ⌘S refused, modifiers that arrived alone, ⌃↑ refused as Mission Control, ⌃⌥⌘S free and checked, a refusal at start falling back to ⇧⇧, keys taken since, another app's reaction, the Diagnostics readout, ⇧⇧ that missed the helper), the capture's pill, flight and tile, the elements over the picture and the sent chip; ${shots.length} screenshots in ${evidence}`)
}
