// The Appshot shortcut end to end, on this Mac, with nothing of the person's
// in it: a development desktop on a private profile, a private data root and
// an empty home (so its rail and stores are empty), and the fixture page
// (scripts/fixtures/appshot/window.html) in an Electron window of its own as
// the app being captured.
//
//   npm run build:electron && node --import tsx scripts/test-appshot-shortcut-live.mjs [evidence-dir]
//
// It turns the shortcut on through the desk's own preference, brings the
// fixture forward (the moment this test takes focus; it gives it back at the
// end), presses both Shift keys as keyboard events, and requires: the
// capture lands as a window chip in the composer, the desk's client showed a
// flash and a card without taking the front (the frontmost app is sampled
// every 40 ms throughout), and the message the agent would receive carries
// the window's elements with boxes. Then a key combination, keys another app
// registered first (what macOS does is recorded: it let both hold them), an
// everyday command (refused before it is registered), and "Switch to Mako". Ports: Vite 20027, the desk's
// automation endpoint 20028.
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { createRequire } from "node:module"
import { createServer } from "vite"
import { frontmostPid } from "@mako/host/control/appshots"
import { CuaEmbedded } from "@mako/host/control/cua-embedded"
import { resolveExecutable } from "@mako/host/base/executable"
import { connectMcpComputerDriver } from "@mako/control-runtime/host"

const run = promisify(execFile)
const VITE_PORT = 20027
const AUTOMATION_PORT = 20028
const root = await mkdtemp(join(tmpdir(), "mako-appshot-shortcut-"))
const evidence = resolve(process.argv[2] ?? join(root, "evidence"))
await mkdir(evidence, { recursive: true })
const home = join(root, "home")
const dataRoot = join(root, "data")
await mkdir(home, { recursive: true })
// The app itself, not npm's wrapper script, so the desk's pid is the one that owns its windows.
const electron = createRequire(import.meta.url)("electron")
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(check, what, timeoutMs = 20_000, everyMs = 100) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check().catch(() => undefined)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`)
    await wait(everyMs)
  }
}

/** Run an expression in the desk window through its development automation endpoint (`electron/automation.ts`). */
async function desk(source) {
  const response = await fetch(`http://127.0.0.1:${AUTOMATION_PORT}/eval`, { method: "POST", body: source })
  const answer = await response.json()
  if (!answer.ok) throw new Error(answer.error)
  return answer.value
}

/** Keyboard events as a person's keyboard would post them: both Shift keys, or a chord. */
const KEYS = `
ObjC.import("CoreGraphics");
function post(code, down, flags) {
  const event = $.CGEventCreateKeyboardEvent($(), code, down);
  $.CGEventSetFlags(event, flags);
  $.CGEventPost(0, event);
  delay(0.03);
}
function run(argv) {
  if (argv[0] === "shifts") {
    const shift = 0x20000;
    post(56, true, shift | 0x2);
    post(60, true, shift | 0x2 | 0x4);
    delay(0.15);
    post(60, false, shift | 0x2);
    post(56, false, 0);
  } else {
    const flags = Number(argv[1]);
    post(Number(argv[0]), true, flags);
    post(Number(argv[0]), false, flags);
  }
  return "posted";
}`
const press = (...args) => run("/usr/bin/osascript", ["-l", "JavaScript", "-e", KEYS, ...args])
const COMMAND = 0x100000
const CONTROL = 0x40000
const OPTION = 0x80000
const S = 1

/** The frontmost application's pid, every 40 ms, until stopped. */
function sampleFront() {
  const seen = new Map()
  let stopped = false
  const loop = (async () => {
    while (!stopped) {
      const pid = await frontmostPid()
      if (pid) seen.set(pid, (seen.get(pid) ?? 0) + 1)
      await wait(40)
    }
  })()
  return { stop: async () => { stopped = true; await loop; return seen } }
}

const before = await frontmostPid()
let server
let desktop
let fixture
let driver
const cua = new CuaEmbedded()
const results = {}
try {
  // The fixture: a window of its own app, which can come forward and can hold a shortcut.
  const fixtureMain = join(root, "fixture.cjs")
  await writeFile(
    fixtureMain,
    `const {app, BrowserWindow, globalShortcut} = require('electron');
app.setPath('userData', ${JSON.stringify(join(root, "fixture-data"))});
app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true);
  const window = new BrowserWindow({show:false, width:1000, height:700, x:180, y:120, webPreferences:{contextIsolation:true}});
  await window.loadFile(${JSON.stringify(resolve("scripts/fixtures/appshot/window.html"))});
  // On whatever Space the person is on, full-screen ones too: an Appshot takes what is on screen.
  window.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});
  window.showInactive();
  process.stdin.on('data', (chunk) => {
    const command = String(chunk).trim();
    if (command === 'front') { app.focus({steal: true}); window.focus(); }
    if (command === 'hold') console.log('held ' + globalShortcut.register('Control+Option+Command+K', () => {}));
    if (command === 'release') { globalShortcut.unregisterAll(); console.log('released'); }
  });
  console.log('ready ' + process.pid);
});`
  )
  fixture = spawn(electron, [fixtureMain], { stdio: ["pipe", "pipe", "inherit"] })
  const fixtureOut = []
  fixture.stdout.on("data", (chunk) => fixtureOut.push(String(chunk)))
  const fixturePid = await until(async () => Number(/ready (\d+)/.exec(fixtureOut.join(""))?.[1]) || undefined, "the fixture window")

  // The desk: Vite for the renderer, then the desktop client, which starts its own host on this profile.
  server = await createServer({
    cacheDir: join(root, "vite"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true", "import.meta.env.MAKO_SHARED_RUNTIME": "true", "import.meta.env.MAKO_CLIENT_PROFILE": JSON.stringify("appshot-live"), "import.meta.env.MAKO_SOURCE_ROOT": JSON.stringify(resolve(".")) },
    server: { host: "127.0.0.1", port: VITE_PORT, strictPort: true, hmr: false },
  })
  await server.listen()
  // The empty home has no ~/.local/bin, so the driver the person installed is put on PATH.
  const env = { ...process.env, PATH: `${dirname(resolveExecutable("cua-driver"))}:${process.env.PATH}`, HOME: home, MAKO_PROFILE: "appshot-live", MAKO_DATA_ROOT: dataRoot, VITE_DEV_SERVER_URL: `http://127.0.0.1:${VITE_PORT}/`, MAKO_AUTOMATION: String(AUTOMATION_PORT) }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.MAKO_WEB_SOCKET
  desktop = spawn(electron, ["."], { cwd: resolve("."), env, stdio: ["ignore", "inherit", "inherit"] })
  await until(() => desk("Boolean(document.querySelector('textarea'))"), "the desk's composer", 90_000, 500)
  const deskPid = desktop.pid
  results.deskPid = deskPid

  // Turn the shortcut on as Settings does, and wait for the client to hold it.
  await desk(`import("/src/state/prefs.ts").then((m) => { m.setPref("appshotShortcut", {kind: "modifiers", modifier: "shift"}); m.setPref("appshotShortcutOn", true); return true })`)
  const status = await until(async () => {
    const value = await desk(`import("/src/state/appshot-shortcut.ts").then((m) => JSON.stringify(m.appshotShortcutStore.get().status))`)
    return value && JSON.parse(value)?.state === "on" ? JSON.parse(value) : undefined
  }, "the client holding both Shift keys")
  results.pairStatus = status

  // The person is in the fixture app.
  fixture.stdin.write("front\n")
  await until(async () => (await frontmostPid()) === fixturePid, "the fixture in front")
  const chips = () => desk(`document.querySelectorAll('[data-window-capture]').length`)
  const sampler = sampleFront()
  const socket = await cua.ensure(join(root, "cua"), "com.mako.appshot-shortcut-live")
  driver = await connectMcpComputerDriver({ command: resolveExecutable("cua-driver"), args: ["mcp", "--embedded", "--socket", socket] })
  /**
   * The desk's windows at every layer, from CoreGraphics: the flash and the
   * card float above other apps, and the driver lists only layer 0.
   */
  const LIST = `ObjC.import("CoreGraphics"); function run(argv) { const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0)); const out = []; for (let i = 0; i < list.count; i++) { const w = list.objectAtIndex(i); if (ObjC.unwrap(w.objectForKey("kCGWindowOwnerPID")) !== Number(argv[0])) continue; const b = w.objectForKey("kCGWindowBounds"); out.push({ id: ObjC.unwrap(w.objectForKey("kCGWindowNumber")), layer: ObjC.unwrap(w.objectForKey("kCGWindowLayer")), width: ObjC.unwrap(b.objectForKey("Width")), height: ObjC.unwrap(b.objectForKey("Height")) }) } return JSON.stringify(out) }`
  const floating = async () => JSON.parse((await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", LIST, String(deskPid)])).stdout)
  const deskWindows = async () =>
    (await driver.callTool("list_windows", { pid: deskPid }, { timeout: 10_000 })).structuredContent.windows.filter((window) => window.is_on_screen)

  /* Both Shift keys ------------------------------------------------------------- */

  const pressed = Date.now()
  await press("shifts")
  // The flash covers the captured window and the card sits in the corner, both the desk's own windows.
  const flash = await until(async () => (await floating()).find((window) => window.layer > 0 && window.width >= 900 && window.width <= 1100), "the flash over the captured window", 3000, 20).catch(() => null)
  const card = await until(async () => (await floating()).find((window) => window.layer > 0 && window.width === 380 && window.height === 104), "the card", 30_000, 50)
  await wait(250)
  await run("/usr/sbin/screencapture", ["-x", "-l", String(card.id), join(evidence, "01-card-capturing.png")]).catch(() => undefined)
  await until(async () => (await chips()) === 1, "the capture's chip in the composer", 20_000)
  results.pairLandedMs = Date.now() - pressed
  results.flashSeen = Boolean(flash)
  await wait(400)
  // The card is the desk's own window: only it is in the picture.
  await run("/usr/sbin/screencapture", ["-x", "-l", String(card.id), join(evidence, "02-card.png")]).catch((error) => console.error(`card picture: ${error.message}`))
  const front = await sampler.stop()
  results.frontmostDuringCapture = Object.fromEntries(front)
  assert.deepEqual([...front.keys()], [fixturePid], "the fixture stayed in front throughout: the flash, the card and the capture took no focus")

  // The draft's record and the message the agent would receive for it.
  const record = JSON.parse(await desk(`(() => { const all = JSON.parse(localStorage.getItem("mako.attachment-drafts.v1") || "{}"); return JSON.stringify(Object.values(all).flat().find((item) => item.origin === "window")) })()`))
  assert.equal(record.origin, "window")
  assert.equal(record.window.title, "Invoices · Fixture Books")
  assert.ok(record.contextPath, "the elements were staged beside the picture")
  const message = await desk(`Promise.all([import("/src/lib/context/draft.ts"), import("/src/lib/attachment-references.ts"), import("/src/lib/bridge.ts")]).then(async ([draft, references, bridge]) => {
    const record = ${JSON.stringify(record)}
    const context = (await bridge.getMako().readFile(record.contextPath)).contents
    return draft.writeDraft({ draft: "What's wrong with the failed invoices in " + references.attachmentReference(record) + "?", records: [{ ...record, context }] }).text
  })`)
  await writeFile(join(evidence, "agent-message.txt"), message)
  assert.match(message, /\[Window 1: Electron — Invoices · Fixture Books\]/)
  assert.match(message, /\n {2}Window capture of Electron: “Invoices · Fixture Books”/)
  assert.match(message, /Button "Delete draft" \[\d+,\d+,\d+,\d+\]/)

  /* A key combination, and keys another app holds -------------------------------- */

  await desk(`import("/src/state/prefs.ts").then((m) => { m.setPref("appshotShortcut", {kind: "keys", chord: "ctrl+alt+mod+s"}); return true })`)
  results.chordStatus = await until(async () => {
    const value = JSON.parse(await desk(`import("/src/state/appshot-shortcut.ts").then((m) => JSON.stringify(m.appshotShortcutStore.get().status))`))
    return value?.state === "on" && value.shortcut.kind === "keys" ? value : undefined
  }, "the chord held")
  await press(String(S), String(COMMAND | CONTROL | OPTION))
  await until(async () => (await chips()) === 2, "a second chip from the chord", 20_000)

  fixture.stdin.write("hold\n")
  await until(async () => /held true/.test(fixtureOut.join("")), "the fixture holding ⌃⌥⌘K")
  await desk(`import("/src/state/prefs.ts").then((m) => { m.setPref("appshotShortcut", {kind: "keys", chord: "ctrl+alt+mod+k"}); return true })`)
  // What macOS does with keys another app already registered: recorded, not assumed.
  results.heldElsewhere = await until(async () => {
    const value = JSON.parse(await desk(`import("/src/state/appshot-shortcut.ts").then((m) => JSON.stringify(m.appshotShortcutStore.get().status))`))
    return value?.state === "refused" || (value?.state === "on" && value.shortcut.chord === "ctrl+alt+mod+k") ? value : undefined
  }, "the chord another app holds answered")
  if (results.heldElsewhere.state === "on") {
    const count = await chips()
    fixture.stdin.write("front\n")
    await until(async () => (await frontmostPid()) === fixturePid, "the fixture in front")
    await press("40", String(COMMAND | CONTROL | OPTION))
    results.heldElsewhereReachedMako = await until(async () => ((await chips()) > count ? true : undefined), "a chip from keys another app holds", 8000).catch(() => false)
  }
  fixture.stdin.write("release\n")
  await desk(`import("/src/state/prefs.ts").then((m) => { m.setPref("appshotShortcut", {kind: "keys", chord: "mod+s"}); return true })`)
  results.everyday = await until(async () => {
    const value = JSON.parse(await desk(`import("/src/state/appshot-shortcut.ts").then((m) => JSON.stringify(m.appshotShortcutStore.get().status))`))
    return value?.state === "refused" && /Save/.test(value.reason) ? value : undefined
  }, "⌘S refused")

  /* Switch to Mako -------------------------------------------------------------- */

  await desk(`import("/src/state/prefs.ts").then((m) => { m.setPref("appshotShortcut", {kind: "modifiers", modifier: "shift"}); m.setPref("appshotThenMako", true); return true })`)
  await until(async () => JSON.parse(await desk(`import("/src/state/appshot-shortcut.ts").then((m) => JSON.stringify(m.appshotShortcutStore.get().status))`))?.state === "on", "both Shift keys again")
  fixture.stdin.write("front\n")
  await until(async () => (await frontmostPid()) === fixturePid, "the fixture in front again")
  await press("shifts")
  await until(async () => (await chips()) === 3, "a third chip", 20_000)
  results.switchedToMako = await until(async () => ((await frontmostPid()) === deskPid ? true : undefined), "Mako forward after the capture", 5000)
  await wait(150)
  const deskWindow = (await deskWindows()).sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0]
  const flight = await driver.callTool("get_window_state", { pid: deskPid, window_id: deskWindow.window_id, include_accessibility_tree: false }, { timeout: 10_000 })
  const flightImage = flight.content.find((block) => block.type === "image")
  if (flightImage) await writeFile(join(evidence, "03-switch-to-mako.png"), Buffer.from(flightImage.data, "base64"))
  await wait(1500)
  const composed = await driver.callTool("get_window_state", { pid: deskPid, window_id: deskWindow.window_id, include_accessibility_tree: false }, { timeout: 10_000 })
  const composedImage = composed.content.find((block) => block.type === "image")
  if (composedImage) await writeFile(join(evidence, "04-desk-chips.png"), Buffer.from(composedImage.data, "base64"))

  await writeFile(join(evidence, "results.json"), `${JSON.stringify(results, null, 2)}\n`)
  console.log(`Appshot shortcut live: both Shift keys and ⌃⌥⌘S each captured the fixture into the composer (${results.pairLandedMs} ms to the first chip on a fresh host), the flash ${results.flashSeen ? "and" : "was not seen but"} the card showed with the fixture in front throughout; keys another app registered first were ${results.heldElsewhere.state === "refused" ? "refused" : `held as well and ${results.heldElsewhereReachedMako ? "still reached Mako" : "did not reach Mako"}`}; ⌘S was refused by name; Switch to Mako brought the desk forward. Evidence: ${evidence}`)
} finally {
  await driver?.close().catch(() => undefined)
  cua.stop()
  if (desktop && desktop.exitCode === null) {
    desktop.kill("SIGTERM")
    await new Promise((done) => { desktop.once("exit", done); setTimeout(done, 10_000) })
  }
  fixture?.kill()
  await server?.close()
  if (before) await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", `ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${before}).activateWithOptions(0)`]).catch(() => undefined)
}
