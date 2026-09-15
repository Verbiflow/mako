import { Appshots } from "../dist-electron/appshots.js"
import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { resolveExecutable } from "../dist-electron/executable.js"
import {
  ensureCuaEmbedded,
  stopCuaEmbedded,
} from "../dist-electron/cua-embedded.js"

// Live check of Mako's computer control against the installed driver and a
// real backgrounded Electron window. Every action is a mako_computer_exec
// program. The invariant throughout: the user's frontmost application never
// changes, and the fixture stays behind it.
const runCommand = promisify(execFile)
async function frontmostPid() {
  const { stdout } = await runCommand("osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier'], { timeout: 3000 })
  const pid = Number(stdout.trim())
  assert.ok(Number.isInteger(pid) && pid > 0)
  return pid
}
// "prohibited" keeps the fixture out of the Dock and off the menu bar, which
// is the harder background case; "regular" gives it Electron's default menu
// so invoke_menu can be exercised.
const fixturePolicy = process.env.MAKO_FIXTURE_POLICY === "regular" ? "regular" : "prohibited"
const root = await mkdtemp(join(tmpdir(), "mako-control-e2e-"))
const proof = randomUUID()
const replacement = `replaced-${randomUUID().slice(0, 8)}`
const statusFile = join(root, "status.json")
const fixtureFile = join(root, "fixture.cjs")
await writeFile(
  join(root, "fixture.html"),
  `<title>Mako control fixture</title><h1>Mako control fixture</h1><label>Proof <input aria-label="Proof" id="proof"></label><button onclick="document.getElementById('result').textContent=document.getElementById('proof').value">Verify proof</button><output id="result"></output>`
)
await writeFile(
  fixtureFile,
  `
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
app.setPath('userData', ${JSON.stringify(join(root, "user-data"))});
app.whenReady().then(async () => {
 app.setAccessibilitySupportEnabled(true);
 app.setActivationPolicy(${JSON.stringify(fixturePolicy)});
 const window = new BrowserWindow({show:false,width:650,height:420,title:'Mako control fixture',webPreferences:{contextIsolation:true}});
 await window.loadFile(${JSON.stringify(join(root, "fixture.html"))});
 window.showInactive();
 setInterval(async () => { if (!window.isDestroyed()) fs.writeFileSync(${JSON.stringify(statusFile + ".next")}, JSON.stringify({pid:process.pid, input:await window.webContents.executeJavaScript('document.getElementById("proof").value'), selection:await window.webContents.executeJavaScript('(()=>{const e=document.getElementById("proof");return e.selectionEnd-e.selectionStart})()'), value:await window.webContents.executeJavaScript('document.getElementById("result").textContent')})); fs.renameSync(${JSON.stringify(statusFile + ".next")}, ${JSON.stringify(statusFile)}); }, 100);
});
app.on('window-all-closed', () => app.quit());
`
)
const fixture = spawn(resolve("node_modules/.bin/electron"), [fixtureFile], {
  stdio: ["ignore", "ignore", "pipe"],
})
fixture.stderr.on("data", (chunk) => process.stderr.write(chunk))
const client = new Client({ name: "mako-control-e2e", version: "1" })
let outcome = { status: "failed", error: "Test did not complete" }
const events = []
let appshots
/** Run one program and parse its return value. */
async function exec(label, source) {
  const start = performance.now()
  const result = await client.callTool(
    { name: "mako_computer_exec", arguments: { source } },
    undefined,
    { timeout: 70_000 }
  )
  // Logged and emitted blocks come first; the return value is the last text block.
  const text = result.content.filter((block) => block.type === "text")
  const value = text.length ? JSON.parse(text.at(-1).text) : null
  events.push({
    label,
    source,
    milliseconds: Math.round(performance.now() - start),
    isError: !!result.isError,
    bytes: Buffer.byteLength(JSON.stringify(result.content)),
    value,
  })
  if (result.isError) throw new Error(`${label}: ${text[0]?.text ?? "failed"}`)
  return value
}
/** One driver action as a one-line program; returns the driver's MCP result. */
function call(name, args) {
  return exec(name, `return await computer.${name}(${JSON.stringify(args)})`)
}
async function fixtureState() {
  return JSON.parse(await readFile(statusFile, "utf8"))
}
async function until(check, what) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Fixture condition timed out: ${what}`)
}
try {
  const fixtureStatus = await until(async () => {
    try {
      return await fixtureState()
    } catch {
      return null
    }
  }, "fixture started")
  const socket = await ensureCuaEmbedded(join(root, "driver"), "dev.mako.audit")
  assert.ok(socket)
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve("dist-electron/computer-tools-main.js"),
        "--driver",
        resolveExecutable("cua-driver"),
        "--socket",
        socket,
      ],
      stderr: "pipe",
    })
  )
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort()
  assert.deepEqual(tools, ["mako_computer_exec", "mako_computer_help", "mako_computer_status"])
  const help = JSON.parse(
    (await client.callTool({ name: "mako_computer_help", arguments: {} })).content[0].text
  )
  for (const action of ["invoke_menu", "hotkey", "press_key", "verify_state", "zoom"])
    assert.ok(help.actions.some((entry) => entry.action === action), `driver offers ${action}`)

  const permissions = await call("check_permissions", { prompt: false })
  assert.equal(permissions.structuredContent?.accessibility, true)
  await call("start_session", { capture_scope: "window" })
  const frontmostBefore = await frontmostPid()
  // The preview capture takes its own snapshot of the window, and a newer
  // snapshot supersedes every earlier token, so it goes first.
  const windows = await call("list_windows", { pid: fixtureStatus.pid })
  const fixtureWindow = windows.structuredContent.windows.find(
    (entry) => entry.pid === fixtureStatus.pid && entry.title === "Mako control fixture"
  )
  assert.ok(fixtureWindow, "Fixture window must be discovered by its actual pid")
  appshots = new Appshots(async () => ({ command: resolveExecutable("cua-driver"), args: ["mcp", "--embedded", "--socket", socket] }))
  const shot = await appshots.capture({ pid: fixtureStatus.pid, windowId: fixtureWindow.window_id })
  assert.ok(shot.image.data.length > 1000)
  assert.ok(shot.text.includes("Proof"), "Appshot includes text from the selected window")

  // One program: find the window by its real pid, snapshot it, keep the
  // identifiers in state, and return only what the next step needs.
  const found = await exec(
    "discover",
    `const windows = await computer.list_windows({pid: ${fixtureStatus.pid}});
     const window = windows.structuredContent.windows.find(w => w.pid === ${fixtureStatus.pid} && w.title === 'Mako control fixture');
     if (!window) return {found: false, windows: windows.structuredContent.windows.map(w => [w.pid, w.title])};
     state.target = {pid: ${fixtureStatus.pid}, window_id: window.window_id};
     const view = await computer.get_window_state(state.target);
     state.snapshot = view.structuredContent.snapshot_id;
     const field = view.structuredContent.elements.find(e => e.role === 'AXTextField' && e.label === 'Proof');
     const button = view.structuredContent.elements.find(e => /button/i.test(e.role) && e.label === 'Verify proof');
     state.field = field?.element_token; state.button = button?.element_token; state.fieldFrame = field?.frame;
     emitImage(view);
     return {found: true, target: state.target, field: state.field, button: state.button, elements: view.structuredContent.elements.length, screenshot: view.content.some(b => b.type === 'image'), frame: field?.frame, bounds: view.structuredContent.window_bounds, scale: view.structuredContent.screenshot_scale, image: [view.structuredContent.screenshot_width, view.structuredContent.screenshot_height]}`
  )
  assert.ok(found.found, `Fixture window must be discovered by its actual pid: ${JSON.stringify(found)}`)
  assert.ok(found.field && found.button, "Proof field and button found from live accessibility state")
  assert.ok(found.screenshot, "Actual screenshot returned through the program")
  const target = found.target

  // Accessibility route: set the value, press the button, read back through
  // the renderer, all in one program.
  const filled = await exec(
    "fill-and-verify",
    `const set = await computer.set_value({element_token: state.field, value: ${JSON.stringify(proof)}});
     if (set.isError) return {set: set.structuredContent};
     const clicked = await computer.click({element_token: state.button});
     return {set: set.structuredContent?.effect ?? null, clicked: !clicked.isError}`
  )
  assert.ok(filled.clicked, JSON.stringify(filled))
  await until(async () => (await fixtureState()).value === proof, "renderer shows the proof")

  // Background keyboard, measured rather than assumed: a focus click by
  // window-local pixels (element frames are screen points, so the program
  // converts through window_bounds and screenshot_scale), then keys posted
  // to the pid with the window still behind the user's. On a backgrounded
  // Electron renderer the driver reports every key as delivery_failed and
  // the renderer's own value does not move; Mako's wrapper must say so.
  const keyboard = await exec(
    "background-keyboard",
    `const view = await computer.get_window_state(state.target);
     const s = view.structuredContent;
     const field = s.elements.find(e => e.role === 'AXTextField' && e.label === 'Proof');
     const x = Math.round((field.frame.x - s.window_bounds.x + field.frame.w / 2) * s.screenshot_scale);
     const y = Math.round((field.frame.y - s.window_bounds.y + field.frame.h / 2) * s.screenshot_scale);
     const focus = await computer.click({...state.target, x, y});
     const wait = (ms) => new Promise(r => setTimeout(r, ms));
     await wait(300);
     const selectAll = await computer.hotkey({...state.target, keys: ['cmd', 'a']});
     await wait(300);
     const remove = await computer.press_key({...state.target, key: 'delete'});
     await wait(300);
     const typed = await computer.type_text({...state.target, text: 'XYZ'});
     await wait(500);
     return {at: [x, y], focus: focus.structuredContent?.route, selectAll: selectAll.structuredContent, remove: remove.structuredContent?.mako_routes?.status, typed: typed.structuredContent?.mako_routes?.status}`
  )
  const afterKeys = await fixtureState()
  const keyboardLanded = afterKeys.input !== proof
  if (!keyboardLanded) {
    assert.equal(keyboard.selectAll?.delivery?.mode, "background")
    assert.equal(keyboard.selectAll?.mako_routes?.status, "not-delivered", `a dropped background combo is reported as not delivered: ${JSON.stringify(keyboard.selectAll)}`)
    assert.match(keyboard.selectAll?.mako_routes?.routes ?? "", /set_value/)
    assert.equal(keyboard.typed, "not-delivered")
  }

  // The routes that do reach a backgrounded renderer: set_value replaced the
  // text above; invoke_menu performs a menu item (Select All) and the
  // renderer's own selection confirms it. The driver fronts the app for the
  // invocation and restores the previous frontmost app itself.
  const menu = await exec(
    "menu-select-all",
    `const view = await computer.get_window_state(state.target);
     const field = view.structuredContent.elements.find(e => e.role === 'AXTextField' && e.label === 'Proof');
     await computer.click({element_token: field.element_token});
     await new Promise(r => setTimeout(r, 300));
     const menu = await computer.invoke_menu({...state.target, path: ['Edit', 'Select All']});
     return {isError: !!menu.isError, delivery: menu.structuredContent?.delivery, effect: menu.structuredContent?.effect}`
  )
  const frontmostAfterMenu = await frontmostPid()
  assert.equal(frontmostAfterMenu, frontmostBefore, "invoke_menu restores the previous frontmost application")
  if (fixturePolicy === "regular") {
    assert.equal(menu.isError, false, JSON.stringify(menu))
    await until(async () => (await fixtureState()).selection === (await fixtureState()).input.length && (await fixtureState()).input.length > 0, `invoke_menu Select All selected the field (${JSON.stringify(menu)})`)
  }
  const cleared = await exec(
    "clear-by-accessibility",
    `const view = await computer.get_window_state(state.target);
     const field = view.structuredContent.elements.find(e => e.role === 'AXTextField' && e.label === 'Proof');
     state.field = field.element_token;
     const set = await computer.set_value({element_token: state.field, value: ${JSON.stringify(replacement)}});
     return set.structuredContent?.effect ?? set.isError`
  )
  await until(async () => (await fixtureState()).input === replacement, `set_value replaced the field in the background (${JSON.stringify(cleared)})`)

  // Foreground is never automatic: the fixture is not frontmost, so an
  // explicit foreground combo is refused before dispatch, and a program can
  // catch that and stay on the background ladder.
  const refused = await exec(
    "foreground-refused",
    `try { await computer.hotkey({...state.target, keys: ['cmd', 'a'], delivery_mode: 'foreground'}); return {sent: true} } catch (error) { return {sent: false, reason: error.message} }`
  )
  assert.equal(refused.sent, false)
  assert.match(refused.reason, /not frontmost/)

  // A superseded token is refused by the driver, through the program.
  const stale = await exec(
    "stale-token",
    `try { const r = await computer.click({element_token: ${JSON.stringify(found.field)}}); return {isError: !!r.isError} } catch (error) { return {isError: true} }`
  )
  assert.equal(stale.isError, true, "Superseded accessibility references must be refused")

  const frontmostAfter = await frontmostPid()
  assert.equal(frontmostAfter, frontmostBefore, "Background actions must not change the user's frontmost application")
  assert.notEqual(frontmostAfter, target.pid, "Fixture stays in the background")
  const totalBytes = events.reduce((sum, event) => sum + event.bytes, 0)
  outcome = {
    status: "passed",
    frontmostPreserved: true,
    programs: events.length,
    resultBytes: totalBytes,
    fixturePolicy,
    backgroundKeyboard: keyboardLanded ? "posted keys reached the backgrounded Electron renderer" : "posted keys dropped (delivery_failed) and reported not-delivered; set_value and invoke_menu did the work",
    invokeMenu: menu,
    appshot: { textCharacters: shot.text.length, imageBytes: Math.floor(shot.image.data.length * 3 / 4) },
  }
  console.log(
    `PASS: ${events.length} programs, ${totalBytes} result bytes; native screenshot, accessibility fill and press with renderer read-back, background keyboard ${keyboardLanded ? "landed" : "dropped and reported not-delivered"}, invoke_menu ${fixturePolicy === "regular" ? "selected the field" : "skipped (fixture has no menu bar; run with MAKO_FIXTURE_POLICY=regular)"} with the frontmost app restored, set_value replaced the field, foreground refused while not frontmost, stale token refused, frontmost app unchanged`
  )
} catch (error) {
  outcome = {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  }
  throw error
} finally {
  await exec("end-session", "return await computer.end_session({})").catch(() => {})
  await appshots?.close()
  await client.close()
  stopCuaEmbedded()
  fixture.kill("SIGTERM")
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(
      {
        host: "Node launched from the checkout; signed Mako release not certified",
        outcome,
        proof,
        replacement,
        events,
      },
      null,
      2
    )
  )
  console.log("Evidence:", root)
}
