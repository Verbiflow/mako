import { cocoaFixtureSource as cocoaSource } from "./lib/cocoa-fixture.mjs"
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
  cuaEmbeddedPid,
  ensureCuaEmbedded,
  stopCuaEmbedded,
} from "../dist-electron/cua-embedded.js"
import { BrowserService } from "../dist-electron/browser-service.js"
import { startControlService } from "../dist-electron/control-service.js"
import {
  frontmostPid,
  sampleFrontmost,
  startElectronFixture,
} from "./lib/control-fixture.mjs"

// Live check of Mako's computer control against the installed driver and a
// real backgrounded Electron window. Every action is a mako_computer_exec
// program. The invariant throughout: the user's frontmost application never
// changes, and the fixture stays behind it. A second Electron instance is
// launched by Mako with a page route and driven through the browser object,
// and a Cocoa fixture compiled here with swiftc covers the pid keyboard on
// the application kind it was designed for.
const runCommand = promisify(execFile)
// "prohibited" keeps the fixture out of the Dock and off the menu bar, which
// is the harder background case; "regular" gives it Electron's default menu
// so invoke_menu can be exercised.
const fixturePolicy =
  process.env.MAKO_FIXTURE_POLICY === "regular" ? "regular" : "prohibited"
const root = await mkdtemp(join(tmpdir(), "mako-control-e2e-"))
const proof = randomUUID()
const replacement = `replaced-${randomUUID().slice(0, 8)}`
const mainFixture = await startElectronFixture({
  root,
  name: "fixture",
  title: "Mako control fixture",
  policy: fixturePolicy,
})
const statusFile = mainFixture.status
// The page-route fixture is written here and launched by Mako itself.
const pageFixture = await startElectronFixture({
  root,
  name: "page-fixture",
  title: "Mako page fixture",
  policy: fixturePolicy,
  initial: "initial",
  form: true,
  start: false,
})
const pageStatusFile = pageFixture.status
const pageFixtureFile = pageFixture.main
const fixture = mainFixture.process
// A Cocoa fixture, built here: one window, a text field and a button, its
// state written to a file, shown without activating. The pid keyboard was
// designed for this application kind, so its verdicts are measured on it.

const cocoaStatusFile = join(root, "cocoa-status.json")
const cocoaBinary = join(root, "mako-cocoa-fixture")
let cocoa = null
const cocoaBuild = (async () => {
  try {
    await runCommand("xcrun", ["-f", "swiftc"], { timeout: 10_000 })
  } catch {
    return "swiftc is not installed"
  }
  await writeFile(join(root, "cocoa.swift"), cocoaSource)
  try {
    await runCommand(
      "xcrun",
      ["swiftc", "-O", "-o", cocoaBinary, join(root, "cocoa.swift")],
      { timeout: 180_000 }
    )
  } catch (error) {
    return `swiftc failed: ${error.stderr ?? error.message}`
  }
  return "built"
})()
const client = new Client({ name: "mako-control-e2e", version: "1" })
let outcome = { status: "failed", error: "Test did not complete" }
const events = []
let appshots
let browserService
let controlService
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
/** One driver action as a one-line program; resolves to the driver's data. */
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
  // The driver starts behind the user's window: nothing but the app that
  // was frontmost before may be frontmost while it launches and answers.
  const userFrontmost = await frontmostPid()
  const startSamples = sampleFrontmost()
  const socket = await ensureCuaEmbedded(join(root, "driver"), "dev.mako.audit")
  assert.ok(socket)
  const driverPid = cuaEmbeddedPid()
  assert.ok(driverPid, "the daemon's pid is known to the host")
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const seenDuringStart = await startSamples.stop()
  assert.ok(
    !seenDuringStart.has(driverPid),
    `the driver became frontmost while starting (pids seen: ${[...seenDuringStart.keys()].join(", ")})`
  )
  assert.ok(seenDuringStart.has(userFrontmost), "sampler read the user's app")
  // The host's browser control, as a Mako task lends it: page routes are
  // registered there and programs get the browser object through it.
  browserService = new BrowserService([])
  controlService = await startControlService(browserService, () => {})
  const credentials = controlService.mint("mako-control-e2e", "binding")
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve("dist-electron/computer-tools-main.js"),
        "--driver-test",
        "--driver",
        resolveExecutable("cua-driver"),
        "--socket",
        socket,
      ],
      env: {
        ...process.env,
        MAKO_CONTROL_URL: credentials.url,
        MAKO_CONTROL_TOKEN: credentials.token,
        MAKO_TASK_ID: "e2e",
      },
      stderr: "pipe",
    })
  )
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort()
  assert.deepEqual(tools, [
    "mako_computer_exec",
    "mako_computer_help",
    "mako_computer_status",
  ])
  const help = JSON.parse(
    (await client.callTool({ name: "mako_computer_help", arguments: {} }))
      .content[0].text
  )
  for (const action of [
    "invoke_menu",
    "hotkey",
    "press_key",
    "verify_state",
    "zoom",
  ])
    assert.ok(
      help.actions.some((entry) => entry.action === action),
      `driver offers ${action}`
    )

  const permissions = await call("check_permissions", { prompt: false })
  assert.equal(permissions.accessibility, true)
  await call("start_session", { capture_scope: "window" })
  const frontmostBefore = await frontmostPid()
  // The preview capture takes its own snapshot of the window, and a newer
  // snapshot supersedes every earlier token, so it goes first.
  const windows = await call("list_windows", { pid: fixtureStatus.pid })
  const fixtureWindow = windows.windows.find(
    (entry) =>
      entry.pid === fixtureStatus.pid && entry.title === "Mako control fixture"
  )
  assert.ok(
    fixtureWindow,
    "Fixture window must be discovered by its actual pid"
  )
  assert.equal(fixtureWindow.kind, "document", "a titled window is a document")
  appshots = new Appshots(async () => ({
    command: resolveExecutable("cua-driver"),
    args: ["mcp", "--embedded", "--socket", socket],
  }))
  const shot = await appshots.capture({
    pid: fixtureStatus.pid,
    windowId: fixtureWindow.window_id,
  })
  assert.ok(shot.image.data.length > 1000)
  assert.ok(
    shot.text.includes("Proof"),
    "Appshot includes text from the selected window"
  )

  // One program: find the window by its real pid, snapshot it, keep the
  // identifiers in state, and return only what the next step needs.
  const found = await exec(
    "discover",
    `const documents = await windows(${fixtureStatus.pid});
     const window = documents.find(w => w.title === 'Mako control fixture');
     if (!window) return {found: false, windows: documents.map(w => [w.kind, w.title])};
     state.target = {pid: ${fixtureStatus.pid}, window_id: window.window_id};
     const view = await computer.get_window_state(state.target);
     state.snapshot = view.snapshot_id;
     const field = view.elements.find(e => e.role === 'AXTextField' && e.label === 'Proof');
     const button = view.elements.find(e => /button/i.test(e.role) && e.label === 'Verify proof');
     state.field = field?.element_token; state.button = button?.element_token; state.fieldFrame = field?.frame;
     emitImage(view);
     return {found: true, target: state.target, field: state.field, button: state.button, elements: view.elements.length, menuBar: view.menu_bar_elements_omitted ?? 0, roles: [...new Set(view.elements.map(e => e.role))], screenshot: view.content.some(b => b.type === 'image'), frame: field?.frame, bounds: view.window_bounds, scale: view.screenshot_scale, image: [view.screenshot_width, view.screenshot_height]}`
  )
  assert.ok(
    found.found,
    `Fixture window must be discovered by its actual pid: ${JSON.stringify(found)}`
  )
  assert.ok(
    found.field && found.button,
    "Proof field and button found from live accessibility state"
  )
  assert.ok(found.screenshot, "Actual screenshot returned through the program")
  assert.ok(
    !found.roles.some((role) => role.startsWith("AXMenu")),
    `the menu bar is not in a window state: ${found.roles.join(", ")}`
  )
  const target = found.target

  // The compact read: the same window as one line per element, then a step
  // whose delta comes back with it, then an expectation that holds.
  const stepped = await exec(
    "view-act-expect",
    `const full = JSON.stringify((await computer.get_window_state(state.target)).elements).length;
     const lines = await view(state.target);
     const bytes = JSON.stringify(lines).length;
     const proofLine = lines.find(l => /TextField "Proof"/.test(l));
     const step = await act('set_value', {element_token: proofLine.split(' ')[0], value: 'act-proof'}, {settle: 400});
     await expect(l => l.some(line => /TextField "Proof" ="act-proof"/.test(line)), 'the field did not take the value');
     let failed = null; try { await expect(l => l.length === 0, 'never') } catch (error) { failed = error.message.split('\\n')[0] }
     return {lines: lines.length, bytes, full, step, failed}`
  )
  assert.ok(stepped.lines >= 3, JSON.stringify(stepped))
  assert.ok(
    stepped.bytes * 4 < stepped.full,
    `view lines (${stepped.bytes} B) are far smaller than the elements JSON (${stepped.full} B)`
  )
  assert.ok(
    stepped.step.added.some((line) => /="act-proof"/.test(line)),
    `act returned the changed line: ${JSON.stringify(stepped.step)}`
  )
  assert.equal(stepped.failed, "never. The window shows:")
  await until(
    async () => (await fixtureState()).input === "act-proof",
    "renderer shows the value act set"
  )

  // Accessibility route: set the value, press the button, read back through
  // the renderer, all in one program. Two actions on two different elements
  // are timed: the driver glides its agent cursor to every new target and
  // awaits the glide (2.5 s per action on driver 0.28.0) unless the session's
  // motion is quieted, which Mako does before the first action.
  const filled = await exec(
    "fill-and-verify",
    `const view = await computer.get_window_state(state.target);
     state.field = view.elements.find(e => e.role === 'AXTextField' && e.label === 'Proof').element_token;
     state.button = view.elements.find(e => /button/i.test(e.role) && e.label === 'Verify proof').element_token;
     const t0 = Date.now();
     const set = await computer.set_value({element_token: state.field, value: ${JSON.stringify(proof)}});
     const t1 = Date.now();
     const clicked = await computer.click({element_token: state.button});
     return {set: set.effect ?? null, clicked: clicked.route ?? clicked.effect ?? 'done', setMs: t1 - t0, clickMs: Date.now() - t1}`
  )
  assert.ok(filled.clicked, JSON.stringify(filled))
  assert.ok(
    filled.setMs < 2_000 && filled.clickMs < 2_000,
    `actions on two elements finish without a cursor glide: ${JSON.stringify(filled)}`
  )
  await until(
    async () => (await fixtureState()).value === proof,
    "renderer shows the proof"
  )

  // fill: text into the field without a keyboard, read back by the helper
  // and confirmed by the renderer; the frontmost app never moves. routes()
  // reports the verdicts before a round trip is spent on a refusal.
  const fillText = `fill-${randomUUID().slice(0, 8)}`
  const filledHelper = await exec(
    "fill-helper",
    `const lines = await view(state.target);
     const field = token(lines.find(l => /TextField "Proof"/.test(l)));
     const written = await fill(field, ${JSON.stringify(fillText)});
     const button = token(written.view.find(l => /Button "Verify proof"/.test(l)));
     const t0 = Date.now();
     const clicked = await act('click', {element_token: button}, {wait: 800});
     const verdicts = await routes();
     return {written, clicked, actMs: Date.now() - t0, verdicts}`
  )
  assert.equal(
    filledHelper.written.confirmed,
    true,
    JSON.stringify(filledHelper.written)
  )
  assert.match(filledHelper.written.line, new RegExp(`="${fillText}"`))
  assert.ok(
    filledHelper.actMs < 2_000,
    `act and independent verification stay bounded (${filledHelper.actMs} ms)`
  )
  await until(
    async () => (await fixtureState()).input === fillText,
    "renderer shows what fill wrote"
  )
  const keyboardCapability = filledHelper.verdicts.routes.find(
    (route) => route.route === "pid-keyboard"
  )
  assert.equal(keyboardCapability.status, "available")
  assert.match(keyboardCapability.detail, /renderer-backed controls/i)
  assert.equal(
    filledHelper.verdicts.routes.find((route) => route.route === "page").status,
    "unavailable"
  )
  assert.equal(await frontmostPid(), frontmostBefore, "fill never fronts")

  // Background keyboard, measured rather than assumed: a focus click by
  // window-local pixels (element frames are screen points, so the program
  // converts through window_bounds and screenshot_scale), then keys posted
  // to the pid with the window still behind the user's. On a backgrounded
  // Electron renderer the driver reports every key as delivery_failed and
  // the renderer's own value does not move; Mako's wrapper must say so.
  const keyboard = await exec(
    "background-keyboard",
    `const s = await computer.get_window_state(state.target);
     const field = s.elements.find(e => e.role === 'AXTextField' && e.label === 'Proof');
     const x = Math.round((field.frame.x - s.window_bounds.x + field.frame.w / 2) * s.screenshot_scale);
     const y = Math.round((field.frame.y - s.window_bounds.y + field.frame.h / 2) * s.screenshot_scale);
     const focus = await computer.click({...state.target, x, y});
     const wait = (ms) => new Promise(r => setTimeout(r, ms));
     await wait(300);
     let chord; const t0 = Date.now(); try { await computer.hotkey({...state.target, keys: ['cmd', 'a']}); chord = {refused: false} } catch (error) { chord = {refused: true, ms: Date.now() - t0, reason: error.message} }
     const remove = await act('press_key', {...state.target, key: 'delete'}, {settle: 200, wait: 800});
     let typed; try { const result = await computer.type_text({...state.target, text: 'XYZ'}); typed = {status: result.mako_routes?.status, escalation: result.escalation} } catch (error) { typed = {status: 'refused', reason: error.message} }
     await wait(500);
     return {at: [x, y], focus: focus.route, chord, remove: {status: remove.result.mako_routes?.status, escalation: remove.result.escalation, added: remove.added.length}, typed}`
  )
  // A background Cmd chord is refused before the driver is asked, in
  // milliseconds rather than after the driver's second-long wait.
  assert.equal(keyboard.chord.refused, true, JSON.stringify(keyboard.chord))
  assert.ok(
    keyboard.chord.ms < 200,
    `refused before dispatch (${keyboard.chord.ms} ms)`
  )
  assert.match(keyboard.chord.reason, /menu key equivalent/)
  const afterKeys = await fixtureState()
  const keyboardLanded = afterKeys.input !== proof
  // The driver's verdict on posted keys is a hint, never "not delivered";
  // the read-back decides, and no result carries the driver's nudge.
  for (const outcome of [keyboard.remove, keyboard.typed]) {
    assert.ok(
      ["unconfirmed", "unverifiable", "refused", undefined].includes(
        outcome.status
      ),
      JSON.stringify(outcome)
    )
    if (outcome.status === "refused")
      assert.doesNotMatch(
        outcome.reason,
        /foreground/,
        `the driver's error carries no foreground nudge through Mako: ${outcome.reason}`
      )
    assert.notEqual(outcome.status, "not-delivered")
    if (outcome.escalation)
      assert.deepEqual(
        Object.keys(outcome.escalation),
        ["reason"],
        `the foreground nudge is stripped: ${JSON.stringify(outcome)}`
      )
  }
  if (!keyboardLanded)
    assert.equal(
      keyboard.remove.added,
      0,
      "a dropped key changes nothing in the window"
    )

  // The routes that do reach a backgrounded renderer: set_value replaced the
  // text above; invoke_menu performs a menu item (Select All) and the
  // renderer's own selection confirms it. The driver fronts the app for the
  // invocation and restores the previous frontmost app itself.
  const menu = await exec(
    "menu-select-all",
    `const view = await computer.get_window_state(state.target);
     const field = view.elements.find(e => e.role === 'AXTextField' && e.label === 'Proof');
     await computer.click({element_token: field.element_token});
     await new Promise(r => setTimeout(r, 300));
     let undeclared; try { await computer.invoke_menu({...state.target, path: ['Edit', 'Select All']}); undeclared = 'invoked' } catch (error) { undeclared = error.message }
     try { const menu = await computer.invoke_menu({...state.target, path: ['Edit', 'Select All'], foreground: true}); return {isError: false, undeclared, delivery: menu.delivery, effect: menu.effect, fronted: menu.fronted} } catch (error) { return {isError: true, undeclared, reason: error.message} }`
  )
  // Fronting is declared: without the flag the call never reaches the driver.
  assert.match(menu.undeclared, /takes the user's screen.*foreground: true/)
  const frontmostAfterMenu = await frontmostPid()
  assert.equal(
    frontmostAfterMenu,
    frontmostBefore,
    "invoke_menu restores the previous frontmost application"
  )
  if (fixturePolicy === "regular") {
    assert.equal(menu.isError, false, JSON.stringify(menu))
    assert.ok(
      Number.isInteger(menu.fronted?.ms) && menu.fronted.pid === target.pid,
      `a fronting call reports fronted: ${JSON.stringify(menu)}`
    )
    await until(
      async () =>
        (await fixtureState()).selection ===
          (await fixtureState()).input.length &&
        (await fixtureState()).input.length > 0,
      `invoke_menu Select All selected the field (${JSON.stringify(menu)})`
    )
  }
  const statusAfterMenu = JSON.parse(
    (await client.callTool({ name: "mako_computer_status", arguments: {} }))
      .content[0].text
  )
  assert.equal(
    statusAfterMenu.frontingEvents,
    fixturePolicy === "regular" ? 1 : 0,
    "status counts the fronting events of the task"
  )

  const cleared = await exec(
    "clear-by-accessibility",
    `const view = await computer.get_window_state(state.target);
     const field = view.elements.find(e => e.role === 'AXTextField' && e.label === 'Proof');
     state.field = field.element_token;
     const set = await computer.set_value({element_token: state.field, value: ${JSON.stringify(replacement)}});
     return set.effect ?? null`
  )
  await until(
    async () => (await fixtureState()).input === replacement,
    `set_value replaced the field in the background (${JSON.stringify(cleared)})`
  )

  // Foreground is never automatic: the fixture is not frontmost, so an
  // explicit foreground combo is refused before dispatch, and a program can
  // catch that and stay on the background ladder.
  const refused = await exec(
    "foreground-refused",
    `let undeclared; try { await computer.hotkey({...state.target, keys: ['cmd', 'a'], delivery_mode: 'foreground'}); undeclared = 'sent' } catch (error) { undeclared = error.message }
     try { await computer.hotkey({...state.target, keys: ['cmd', 'a'], delivery_mode: 'foreground', foreground: true}); return {sent: true, undeclared} } catch (error) { return {sent: false, undeclared, reason: error.message} }`
  )
  assert.match(refused.undeclared, /Pass foreground: true/)
  assert.equal(refused.sent, false)
  assert.match(refused.reason, /not frontmost/)

  // Superseded tokens remain stale. Mako does not guess identity from a role,
  // label or list position: reordered duplicate controls could turn that into
  // an action on the wrong element.
  const stale = await exec(
    "stale-token",
    `let existing; try { await computer.click({element_token: ${JSON.stringify(found.field)}}); existing = {refused: false} } catch (error) { existing = {refused: true, reason: error.message} }
     let gone; try { await computer.click({element_token: ${JSON.stringify(found.field.replace(/:\d+$/, ":9999"))}}); gone = {refused: false} } catch (error) { gone = {refused: true, reason: error.message} }
     return {existing, gone}`
  )
  assert.equal(
    stale.existing.refused,
    true,
    "an older snapshot token is refused"
  )
  assert.match(stale.existing.reason, /stale/)
  assert.equal(
    stale.gone.refused,
    true,
    "a control the snapshot never had is refused"
  )
  assert.ok(
    stale.gone.reason.length > 0,
    "the refusal carries the driver's reason"
  )
  assert.equal(
    await frontmostPid(),
    frontmostBefore,
    "a stale click never fronts"
  )

  // The page route: Mako launches a second Electron instance behind the user
  // with a private DevTools port, registers it as a browser, and a program
  // drives its page through the browser object: click, select all, insert
  // text, Enter, screenshot. Nothing fronts; the click is milliseconds.
  const pageSamples = sampleFrontmost()
  const launched = await exec(
    "launch-page-route",
    `const launched = await computer.launch_app({app_path: ${JSON.stringify(resolve("node_modules/electron/dist/Electron.app"))}, additional_arguments: [${JSON.stringify(pageFixtureFile)}], page_route: true});
     state.page = launched;
     return launched`
  )
  assert.ok(launched.pid > 0, JSON.stringify(launched))
  assert.match(
    launched.page_route.browser,
    /^app:com\.github\.Electron:\d+:[a-f0-9]{8}$/
  )
  assert.match(
    launched.page_route.endpoint,
    /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//
  )
  assert.ok(
    launched.windows.some((row) => row.kind === "document"),
    `launch_app waited for the document window: ${JSON.stringify(launched.windows)}`
  )
  const pageStatus = await until(async () => {
    try {
      return JSON.parse(await readFile(pageStatusFile, "utf8"))
    } catch {
      return null
    }
  }, "page fixture started")
  assert.equal(
    pageStatus.pid,
    launched.pid,
    "the pid is the process that owns the port"
  )
  const driven = await exec(
    "drive-page-route",
    `const browserId = state.page.page_route.browser;
     const tabs = await browser.tabs({browser: browserId});
     const page = tabs.find(t => t.selectable && /page fixture/.test(t.title));
     if (!page) return {found: false, tabs};
     const target = await browser.select({browser: browserId, tab: page.targetId});
     const seen = await browser.observe({target, interactiveOnly: true});
     const field = seen.nodes.find(n => /Proof/.test(n.name ?? '') && /textbox/.test(n.role ?? ''));
     const t0 = performance.now();
     const clicked = await browser.click({target, at: {ref: field.ref}});
     const clickMs = performance.now() - t0;
     await browser.type({target, text: ${JSON.stringify(proof)}, clear: true, submit: true});
     const shot = await browser.screenshot({target, format: 'png'});
     emitImage(shot);
     await browser.release({target});
     const verdicts = await routes({pid: state.page.pid, window_id: state.page.windows.find(w => w.kind === 'document').window_id});
     return {found: true, clickMs, clicked: clicked.outcome ?? clicked, image: shot.data.length, verdicts}`
  )
  assert.equal(driven.found, true, JSON.stringify(driven))
  await until(
    async () =>
      JSON.parse(await readFile(pageStatusFile, "utf8")).input === proof,
    `insertText replaced the field through the page route (${JSON.stringify(driven)})`
  )
  await until(
    async () =>
      JSON.parse(await readFile(pageStatusFile, "utf8")).value === proof,
    "Enter submitted through the page route"
  )
  assert.ok(
    driven.image > 1000,
    "a screenshot came back through the page route"
  )
  assert.ok(
    driven.clickMs < 500,
    `a page-route click completes quickly (${Math.round(driven.clickMs)} ms)`
  )
  assert.equal(
    driven.verdicts.routes.find((route) => route.route === "page").browser,
    launched.page_route.browser
  )
  const pageStatusAfter = JSON.parse(
    (await client.callTool({ name: "mako_computer_status", arguments: {} }))
      .content[0].text
  )
  assert.equal(
    pageStatusAfter.pageRoutes[String(launched.pid)]?.browser,
    launched.page_route.browser
  )
  const seenDuringPage = await pageSamples.stop()
  assert.ok(
    !seenDuringPage.has(launched.pid),
    `the launched app never became frontmost (pids seen: ${[...seenDuringPage.keys()].join(", ")})`
  )
  assert.deepEqual(
    [...seenDuringPage.keys()],
    [frontmostBefore],
    `only the user's app was frontmost during the page route (${[...seenDuringPage.keys()].join(", ")})`
  )

  // The Cocoa fixture: the pid keyboard on the application kind it was
  // designed for. fill confirms, type_text lands, a Shift chord is never
  // reported "not delivered", a Cmd chord is refused before dispatch.
  const cocoaBuilt = await cocoaBuild
  let cocoaOutcome = { skipped: cocoaBuilt }
  if (cocoaBuilt === "built") {
    cocoa = spawn(cocoaBinary, [cocoaStatusFile], {
      stdio: ["ignore", "ignore", "pipe"],
    })
    cocoa.stderr.on("data", (chunk) => process.stderr.write(chunk))
    const cocoaStatus = await until(async () => {
      try {
        return JSON.parse(await readFile(cocoaStatusFile, "utf8"))
      } catch {
        return null
      }
    }, "cocoa fixture started")
    // A bare binary (not a bundle) cannot be launched with open -g, so this
    // fixture is frontmost like the user's own app would be; the invariant
    // under test is that Mako's background actions do not change frontmost
    // from whatever it is when they run.
    const cocoaBaseline = await frontmostPid()
    const cocoaText = `cocoa-${randomUUID().slice(0, 8)}`
    const cocoaRun = await exec(
      "cocoa-keyboard",
      `const documents = await windows(${cocoaStatus.pid});
       const window = documents.find(w => w.title === 'Mako cocoa fixture');
       if (!window) return {found: false, documents};
       state.target = {pid: ${cocoaStatus.pid}, window_id: window.window_id};
       const lines = await view(state.target);
       const field = lines.find(l => /TextField "Proof"/.test(l));
       if (!field) return {found: false, lines};
       const written = await fill(field.split(' ')[0], ${JSON.stringify(cocoaText)});
       const verdicts = await routes();
       let chord; const t0 = Date.now(); try { await computer.hotkey({...state.target, keys: ['cmd', 'a']}); chord = {refused: false} } catch (error) { chord = {refused: true, ms: Date.now() - t0} }
       const shifted = await act('press_key', {element_token: (await view(state.target)).find(l => /TextField "Proof"/.test(l)).split(' ')[0], key: 'left', modifiers: ['shift']}, {settle: 300, wait: 1000});
       const typed = await act('type_text', {element_token: (await view(state.target)).find(l => /TextField "Proof"/.test(l)).split(' ')[0], text: '-typed'}, {settle: 300, wait: 1500});
       return {found: true, written, verdicts, chord, shifted: {status: shifted.result.mako_routes?.status, escalation: shifted.result.escalation}, typed: {status: typed.result.mako_routes?.status, added: typed.added}}`
    )
    assert.equal(cocoaRun.found, true, JSON.stringify(cocoaRun))
    // fill confirmed against the field's own accessibility read-back; on a
    // Cocoa field the driver even reports effect: confirmed, where Electron
    // could only say unverifiable.
    assert.equal(
      cocoaRun.written.confirmed,
      true,
      JSON.stringify(cocoaRun.written)
    )
    assert.match(cocoaRun.written.line, new RegExp(`="${cocoaText}"`))
    // The pid keyboard the driver was designed for: type_text landed in the
    // background (the field now holds the fill text plus what was typed), the
    // Cmd chord was refused before dispatch, and the Shift chord is reported
    // unverifiable, never not-delivered.
    assert.equal(cocoaRun.chord.refused, true)
    assert.ok(cocoaRun.chord.ms < 200)
    assert.notEqual(
      cocoaRun.shifted.status,
      "not-delivered",
      `a Shift chord is never reported not delivered: ${JSON.stringify(cocoaRun.shifted)}`
    )
    if (cocoaRun.shifted.escalation)
      assert.deepEqual(Object.keys(cocoaRun.shifted.escalation), ["reason"])
    assert.equal(
      await frontmostPid(),
      cocoaBaseline,
      "Mako's background keyboard on the Cocoa fixture never changed frontmost"
    )
    const cocoaField = JSON.parse(await readFile(cocoaStatusFile, "utf8")).input
    const typeLanded = cocoaField.includes("typed")
    assert.ok(
      typeLanded,
      `type_text reached the Cocoa field in the background (field: ${JSON.stringify(cocoaField)})`
    )
    cocoaOutcome = {
      fill: `confirmed (${cocoaRun.written.result?.effect})`,
      cmdChord: `refused before dispatch in ${cocoaRun.chord.ms} ms`,
      shiftChord: cocoaRun.shifted.status ?? "confirmed",
      typeText: `landed (${cocoaField})`,
      routes: cocoaRun.verdicts.keyboard,
    }
    assert.equal(
      await frontmostPid(),
      cocoaBaseline,
      "the Cocoa fixture stayed frontmost through Mako's background work"
    )
    cocoa.kill("SIGTERM")
    cocoa = null
  }

  const routedClient = new Client({
    name: "mako-routed-control-e2e",
    version: "1",
  })
  let routed
  try {
    const routedCredentials = controlService.mint(
      "mako-routed-control-e2e",
      "binding"
    )
    await routedClient.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          resolve("dist-electron/computer-tools-main.js"),
          "--driver",
          resolveExecutable("cua-driver"),
          "--socket",
          socket,
        ],
        env: {
          ...process.env,
          MAKO_CONTROL_URL: routedCredentials.url,
          MAKO_CONTROL_TOKEN: routedCredentials.token,
          MAKO_TASK_ID: "routed-e2e",
        },
        stderr: "pipe",
      })
    )
    assert.deepEqual(
      (await routedClient.listTools()).tools.map((tool) => tool.name).sort(),
      ["mako_control_exec", "mako_control_help", "mako_control_status"]
    )
    const routedText = `routed-${randomUUID().slice(0, 8)}`
    const started = performance.now()
    const setRouted = () =>
      routedClient.callTool(
        {
          name: "mako_control_exec",
          arguments: {
            source: `const tabs=await control.tabs(${JSON.stringify(launched.page_route.browser)});
const selected=tabs.pages.find(tab=>tab.selectable && tab.title==='Mako page fixture');
if(!selected) throw Error('Fixture tab missing');
const tab=await control.claimTab({browser:${JSON.stringify(launched.page_route.browser)},tab:selected.targetId});
const observed=await tab.observe();
const ref=observed.get({role:'textbox',name:'Proof'}).ref;
const receipt=await tab.setValue(ref,${JSON.stringify(routedText)});
const proof=await tab.expect({role:'textbox',name:'Proof',value:${JSON.stringify(routedText)}});
return {receipt,proof,observation:await tab.observe()};`,
          },
        },
        undefined,
        { timeout: 70_000 }
      )
    let result = await setRouted()
    // Resume a yielded cell; never replay its source.
    for (;;) {
      const text = result.content.find((block) => block.type === "text")
      const receipt = text ? JSON.parse(text.text) : null
      if (receipt?.status !== "running" || !Number.isInteger(receipt.cell))
        break
      result = await routedClient.callTool(
        { name: "mako_control_exec", arguments: { cell: receipt.cell } },
        undefined,
        { timeout: 70_000 }
      )
    }
    assert.ok(!result.isError, JSON.stringify(result))
    const value = JSON.parse(
      result.content.filter((block) => block.type === "text").at(-1).text
    )
    assert.ok(value.receipt, JSON.stringify(value))
    assert.equal(value.receipt.route, "page")
    assert.equal(
      value.receipt.verification,
      "not-requested",
      JSON.stringify(value)
    )
    assert.equal(value.proof.status, "matched")
    assert.equal(value.receipt.delivery, "background")
    assert.equal(value.receipt.guard.status, "settled")
    await until(
      async () =>
        JSON.parse(await readFile(pageStatusFile, "utf8")).input === routedText,
      "routed set-text reached the renderer"
    )
    routed = {
      milliseconds: Math.round(performance.now() - started),
      responseBytes: Buffer.byteLength(JSON.stringify(result.content)),
      lines: value.observation.lines.length,
      route: value.receipt.route,
      attempts: 1,
    }
  } finally {
    await routedClient.close()
  }

  await exec(
    "kill-page-fixture",
    `return await computer.shell({command: 'kill ${launched.pid}'})`
  )

  const frontmostAfter = await frontmostPid()
  assert.notEqual(frontmostAfter, target.pid, "Fixture stays in the background")
  assert.notEqual(
    frontmostAfter,
    launched.pid,
    "the page-route app never became frontmost"
  )
  const totalBytes = events.reduce((sum, event) => sum + event.bytes, 0)
  outcome = {
    status: "passed",
    frontmostPreserved: true,
    programs: events.length,
    resultBytes: totalBytes,
    fixturePolicy,
    backgroundKeyboard: keyboardLanded
      ? "posted keys reached the backgrounded Electron renderer"
      : "posted keys dropped (delivery_failed) and reported not-delivered; set_value and invoke_menu did the work",
    invokeMenu: menu,
    pageRoute: {
      browser: launched.page_route.browser,
      clickMs: Math.round(driven.clickMs),
    },
    routed,
    verifiedActMs: filledHelper.actMs,
    cocoa: cocoaOutcome,
    appshot: {
      textCharacters: shot.text.length,
      imageBytes: Math.floor((shot.image.data.length * 3) / 4),
    },
  }
  console.log(
    `PASS: ${events.length} driver-adapter programs, ${totalBytes} driver-adapter result bytes; routed set-text ${routed.milliseconds} ms/${routed.responseBytes} bytes through ${routed.route}; driver started behind the user's window, native and page control stayed behind the user, route-bound refs and verified receipts held, background Cmd chord and undeclared foreground were refused, Cocoa fixture ${JSON.stringify(cocoaOutcome)}, frontmost app unchanged throughout`
  )
} catch (error) {
  outcome = {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  }
  throw error
} finally {
  await exec("end-session", "return await computer.end_session({})").catch(
    () => {}
  )
  await appshots?.close()
  await client.close()
  controlService?.close()
  stopCuaEmbedded()
  fixture.kill("SIGTERM")
  cocoa?.kill("SIGTERM")
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
