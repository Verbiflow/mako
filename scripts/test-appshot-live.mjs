// Live check of an Appshot against the installed driver and a real window:
// a fixture page (scripts/fixtures/appshot/window.html) in an Electron
// window of its own, shown without taking focus. Everything goes through one
// `DriverBroker`, as in the host. It captures through the host's `Appshots`,
// as the + menu's chooser and the shortcut do, and checks the picture and the
// outline together: the elements the page has, the menu bar and its Recent
// Items left out, every box inside the picture, and the one red button's box
// landing on red pixels. It measures the outline against the same tree as
// JSON, the driver's own JSON and the flat text Appshots sent before. Then it
// takes the same window's Appshot the way an agent does, through a control
// session on a broker grant (`window.appshot()`) and the `mako-control
// appshot` command, and checks that they carry the same outline. It checks
// the broker against the driver's own MCP proxy (the same results), that an
// Appshot doesn't wait behind an agent's slow call, and that a daemon that
// dies is reconnected and warmed once. It times the first capture on a new
// driver and after the warm-up.
//
// Then the snapshots. On a driver that keeps each lease's own
// (`snapshot_scope: "transport"`), an Appshot's tree read leaves an agent's
// ref acting; consumer A reads the window, B reads it, and A clicks and
// writes with its earlier tokens; several consumers read and click on the
// window at once with no stale token; and 1,000 reads by one consumer keep
// one snapshot and release it when the lease closes. On an older driver, an
// Appshot's read retires the agent's ref before dispatch and says so, and A's
// and the consumers' tokens are refused as stale. On either, no click lands
// anywhere but the button its token named. Both time each read and click and
// the daemon's memory over the 1,000. Nothing but the fixture is captured;
// the only input is semantic (AXPress, a value write) to the fixture's own
// Export button and search field, which takes no focus.
//
//   node --import tsx scripts/test-appshot-live.mjs [evidence-dir] [--front] [--fixture]
//
// The driver is the first `cua-driver` on PATH: put a release's
// `CuaDriverLocal.app/Contents/MacOS` first to test it, before or after a patch.
//
// --front also checks which window the shortcut takes: it brings the fixture
// forward (the one moment this test takes focus), asks for the front window
// with and without the fixture excluded, and gives focus back to whatever
// had it. --fixture writes the capture the fixture desk's mock serves.
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import sharp from "sharp"
import { Appshots, frontmostPid } from "@mako/host/control/appshots"
import { CuaEmbedded } from "@mako/host/control/cua-embedded"
import { WindowStateSchema, readWindowOutline, treeWindowFrame, windowOutline, writeWindowOutline } from "@mako/control/computer"
import { PRESENT, controlClient } from "@mako/control/control"
import { resolveExecutable } from "@mako/host/base/executable"
import { DriverBroker, connectMcpComputerDriver, createControlSession } from "@mako/control-runtime/host"
import { serveControlSession } from "@mako/control-runtime/session"

const run = promisify(execFile)
const args = process.argv.slice(2)
const front = args.includes("--front")
const fixtureOut = args.includes("--fixture")
const root = await mkdtemp(join(tmpdir(), "mako-appshot-live-"))
const evidence = resolve(args.find((arg) => !arg.startsWith("--")) ?? join(root, "evidence"))
await mkdir(evidence, { recursive: true })

/** A tokenizer when one is installed beside the test (o200k, `npm i js-tiktoken` in /tmp/tok); else a count of characters / 4, said as such. */
const tokens = (() => {
  try {
    const { getEncoding } = createRequire("/tmp/tok/")("js-tiktoken")
    const encoding = getEncoding("o200k_base")
    return { name: "o200k_base", count: (text) => encoding.encode(text).length }
  } catch {
    return { name: "characters / 4 (no tokenizer installed)", count: (text) => Math.ceil(text.length / 4) }
  }
})()

const main = join(root, "fixture.cjs")
await writeFile(
  main,
  `const {app, BrowserWindow, screen} = require('electron');
app.setPath('userData', ${JSON.stringify(join(root, "user-data"))});
app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true);
  // On the sharpest display there is: the outline's boxes and the fold are measured at 2x.
  const display = screen.getAllDisplays().sort((a, b) => b.scaleFactor - a.scaleFactor)[0];
  const window = new BrowserWindow({show:false, width:1000, height:700, x: display.workArea.x + 40, y: display.workArea.y + 40, webPreferences:{contextIsolation:true}});
  await window.loadFile(${JSON.stringify(resolve("scripts/fixtures/appshot/window.html"))});
  // On whatever Space the person is on, full-screen ones too: an Appshot takes what is on screen.
  window.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});
  window.showInactive();
  // What the snapshot checks did to the page: clicks anywhere, which control each landed on, and the search field's value.
  await window.webContents.executeJavaScript("window.__clicks = 0; window.__hits = {}; document.addEventListener('click', (event) => { window.__clicks++; const control = event.target.closest('button, a, input'); const name = control ? (control.getAttribute('aria-label') || control.textContent.trim() || control.tagName) : event.target.tagName; window.__hits[name] = (window.__hits[name] || 0) + 1 }, true)");
  process.stdin.on('data', async (chunk) => {
    if (String(chunk).includes('front')) { app.focus({steal: true}); window.focus(); }
    if (String(chunk).includes('page'))
      console.log('page ' + JSON.stringify(await window.webContents.executeJavaScript("({clicks: window.__clicks, hits: window.__hits, search: document.querySelector('input[type=search]').value})")));
  });
  console.log('ready ' + process.pid);
});
app.on('window-all-closed', () => app.quit());`
)
const fixture = spawn(resolve("node_modules/.bin/electron"), [main], { stdio: ["pipe", "pipe", "inherit"] })
/** The page's click count and search field value, read in the page itself. */
const page = () =>
  new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("The fixture didn't report its page")), 5000)
    const read = (chunk) => {
      const line = /page (\{.*\})/.exec(String(chunk))
      if (!line) return
      clearTimeout(timer)
      fixture.stdout.off("data", read)
      done(JSON.parse(line[1]))
    }
    fixture.stdout.on("data", read)
    fixture.stdin.write("page\n")
  })
/** The daemon's operator readout: its sessions and, from 0003 on, each owner's snapshot counts. */
const daemonSessions = (path) =>
  new Promise((done, fail) => {
    const connection = createConnection(path)
    let text = ""
    connection.on("data", (chunk) => {
      text += chunk
      if (text.includes("\n")) {
        connection.destroy()
        done(JSON.parse(text).result)
      }
    })
    connection.on("error", fail)
    connection.write(`${JSON.stringify({ method: "sessions_list" })}\n`)
  })
/** A process's memory: its physical footprint (what Activity Monitor shows; RSS drops as macOS compresses pages) and its RSS, in MB. */
const memoryMB = async (pid) => {
  const rss = Math.round(Number((await run("/bin/ps", ["-o", "rss=", "-p", String(pid)])).stdout.trim()) / 1024)
  const reading = /Footprint: ([\d.]+) (KB|MB|GB)/.exec((await run("/usr/bin/footprint", ["-p", String(pid)]).catch(() => ({ stdout: "" }))).stdout)
  const footprint = reading ? Math.round(Number(reading[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[reading[2]]) : undefined
  return { footprint, rss }
}
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((values.length * p) / 100))]
const cua = new CuaEmbedded()
let broker
let appshots
let session
let server
let probe
let restore
try {
  const pid = await new Promise((resolvePid, reject) => {
    const timer = setTimeout(() => reject(new Error("The fixture window didn't open")), 20_000)
    fixture.stdout.on("data", (chunk) => {
      const ready = /ready (\d+)/.exec(String(chunk))
      if (ready) {
        clearTimeout(timer)
        resolvePid(Number(ready[1]))
      }
    })
  })
  // The page lays out and its accessibility tree fills in after it shows.
  await new Promise((done) => setTimeout(done, 1500))
  const ensure = () => cua.ensure(join(root, "cua"), "com.mako.appshot-live")
  let socket = await ensure()
  assert.ok(socket, "the embedded driver started")
  const backendOf = (path) => ({ command: resolveExecutable("cua-driver"), args: ["mcp", "--embedded", "--socket", path] })
  const ms = (since) => Math.round(performance.now() - since)
  // The fixture's window, found over the driver's own MCP proxy so that nothing reads a picture first.
  const finder = await connectMcpComputerDriver(backendOf(socket))
  const found = (await finder.callTool("list_windows", { pid }, { timeout: 15_000 })).structuredContent.windows.find(
    (window) => window.pid === pid && window.is_on_screen
  )
  await finder.close()
  assert.ok(found, "the fixture's window is listed")
  const target = { pid, windowId: found.window_id }
  const lines = []
  const brokerFor = () => new DriverBroker({ socket: ensure, own: () => [pid], log: (message, fields) => lines.push({ message, ...fields }) })
  const appshotsOn = (owner) =>
    new Appshots({ connect: () => owner.connect({ kind: "appshots", label: "appshots" }, { parallel: true }), warm: () => owner.warm() })

  /* The first capture on a new driver, and after the warm-up -------------------- */

  // The broker warms a daemon as it connects to it, so a capture asked for at
  // once overlaps the warm-up rather than adding to it.
  let since = performance.now()
  broker = brokerFor()
  appshots = appshotsOn(broker)
  await appshots.capture(target)
  const unwarmed = ms(since)
  await appshots.close()
  await broker.close()
  // A new driver, warmed as the chooser opening or the shortcut being turned on warms it.
  cua.stop()
  socket = await ensure()
  broker = brokerFor()
  appshots = appshotsOn(broker)
  since = performance.now()
  const listed = (await appshots.windows()).find((window) => window.pid === pid)
  assert.ok(listed, `the fixture's window is listed (${JSON.stringify((await appshots.windows()).map((w) => [w.pid, w.app]))} vs ${pid})`)
  await appshots.warm()
  const warming = ms(since)
  assert.equal(broker.status().warm.state, "warm", "the broker warmed the daemon")
  since = performance.now()
  const shot = await appshots.capture(target)
  const cold = ms(since)
  const warmRuns = []
  for (let run = 0; run < 5; run++) {
    since = performance.now()
    await appshots.capture(target)
    warmRuns.push(ms(since))
  }
  const warm = [...warmRuns].sort((a, b) => a - b)[2]
  assert.equal(shot.window.title, listed.title, "the picture names its window as the window list does")

  /* The broker returns what the driver's own proxy returns ---------------------- */

  const proxy = await connectMcpComputerDriver(backendOf(socket))
  const brokered = await broker.connect({ kind: "agent", label: "parity" })
  const volatile = /z_index|snapshot_id|element_token|elapsed|captured|_ms$/
  const comparable = (result) =>
    JSON.parse(
      JSON.stringify(
        {
          content: result.content.map((block) => (block.type === "image" ? { type: "image", mimeType: block.mimeType } : block)),
          structuredContent: result.structuredContent,
          isError: result.isError ?? false,
        },
        (key, value) => (volatile.test(key) ? "~" : value)
      )
    )
  for (const [name, args] of [
    ["list_windows", { pid }],
    ["get_window_state", { pid, window_id: target.windowId, include_accessibility_tree: false, max_dimension: 64 }],
    ["get_window_state", { pid, window_id: target.windowId, include_screenshot: false, max_elements: 40 }],
    ["get_window_state", { pid, window_id: 999_999 }],
    ["no_such_tool", {}],
  ])
    assert.deepEqual(
      comparable(await brokered.callTool(name, args)),
      comparable(await proxy.callTool(name, args, { timeout: 15_000 })),
      `${name} reads the same through the broker as through the driver's MCP proxy`
    )
  assert.deepEqual(
    (await brokered.listTools()).map((tool) => [tool.name, tool.inputSchema]),
    (await proxy.listTools()).map((tool) => [tool.name, tool.inputSchema]),
    "and so do the tools"
  )
  await proxy.close()
  await brokered.close()

  /* The picture and its outline ------------------------------------------------ */

  const picture = Buffer.from(shot.image.data, "base64")
  const meta = await sharp(picture).metadata()
  const outline = readWindowOutline(shot.text)
  await writeFile(join(evidence, "outline.txt"), shot.text)
  assert.deepEqual(outline.image, { width: meta.width, height: meta.height }, "the outline measures the picture it came with")
  const find = (role, name) => outline.elements.find((element) => element.role === role && element.name === name)
  for (const [role, name] of [["Button", "Delete draft"], ["Button", "Export"], ["TextField", "Search invoices"], ["Link", "Customers"], ["Heading", "Invoices"]])
    assert.ok(find(role, name)?.box, `${role} "${name}" is in the outline with a box`)
  assert.deepEqual(find("Button", "Send reminders")?.flags, ["disabled"], "a disabled button says so")
  assert.ok(find("Button", "Save invoice") && !find("Button", "Save invoice").box, "below the fold the form is listed, without a box: the page didn't place it on screen")
  assert.ok(outline.elements.some((element) => element.role === "CheckBox" && element.name === "Send by email"), "the form's checkbox is there")
  assert.ok(!/Recent Items|About This Mac|MenuBar/.test(shot.text), "the application's menu bar and Recent Items are left out")
  for (const element of outline.elements)
    if (element.box) {
      const [x, y, width, height] = element.box
      assert.ok(x >= 0 && y >= 0 && x + width <= meta.width && y + height <= meta.height, `${element.role} "${element.name ?? ""}" lies inside the picture`)
    }
  const red = find("Button", "Delete draft").box
  const { data, info } = await sharp(picture).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const at = (x, y) => {
    const offset = (y * info.width + x) * info.channels
    return [data[offset], data[offset + 1], data[offset + 2]]
  }
  // A few points inside the button, away from its label's white letters.
  const samples = [[red[0] + 3, red[1] + red[3] / 2], [red[0] + red[2] - 3, red[1] + red[3] / 2], [red[0] + red[2] / 2, red[1] + 3]].map(([x, y]) => at(Math.round(x), Math.round(y)))
  assert.ok(samples.every(([r, g, b]) => r > 150 && g < 90 && b < 100), `the red button's box lands on red pixels (${JSON.stringify(samples)})`)

  /* What the formats cost ----------------------------------------------------- */

  probe = await broker.connect({ kind: "agent", label: "formats" })
  const raw = await probe.callTool("get_window_state", { pid, window_id: listed.windowId, include_screenshot: false, max_elements: 4000, max_depth: 64 }, { timeout: 30_000 })
  const legacy = await probe.callTool("get_window_state", { pid, window_id: listed.windowId, include_screenshot: true, max_elements: 1000, max_depth: 25 }, { timeout: 30_000 })
  const walked = WindowStateSchema.parse(raw.structuredContent)
  const tree = windowOutline({ ...walked, window_bounds: treeWindowFrame(walked), screenshot_width: meta.width, screenshot_height: meta.height }, shot.capturedAt)
  const formats = {
    "driver elements as JSON (what get_window_state returns)": JSON.stringify(raw.structuredContent.elements),
    "flat tree_markdown, menu bar included (what Appshots sent before)": legacy.structuredContent.tree_markdown ?? "",
    "the outline's tree as compact JSON": JSON.stringify(tree.root),
    "the outline as lines (header included)": writeWindowOutline(tree),
  }
  const measured = Object.fromEntries(Object.entries(formats).map(([name, text]) => [name, { chars: text.length, tokens: tokens.count(text) }]))
  const report = {
    tokenizer: tokens.name,
    window: { app: shot.window.app, title: shot.window.title, image: outline.image },
    driverElements: raw.structuredContent.elements.length,
    outlineElements: shot.elements,
    captureMs: { firstOnNewDaemon: unwarmed, warmUp: warming, firstAfterWarmUp: cold, warm, warmRuns },
    formats: measured,
  }
  await writeFile(join(evidence, "measurements.json"), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(join(evidence, "outline.txt"), shot.text)
  await writeFile(join(evidence, "capture.png"), picture)
  if (fixtureOut) {
    await writeFile(resolve("scripts/fixtures/appshot/capture.png"), picture)
    await writeFile(resolve("scripts/fixtures/appshot/capture.txt"), shot.text)
  }

  /* The same Appshot, as an agent takes it ------------------------------------- */

  session = createControlSession(await broker.grant("agent appshot-live"), "appshot-live", undefined, { surface: "control", artifacts: join(root, "artifacts") })
  const sdk = controlClient((action, args) => session.call({ action, ...args }, AbortSignal.timeout(60_000)))
  since = performance.now()
  const agentShot = await sdk.window({ pid, window_id: target.windowId }).appshot()
  const sdkMs = ms(since)
  const body = (text) => text.slice(text.indexOf("\n\n"))
  assert.equal(body(agentShot.text), body(shot.text), "an agent's Appshot carries the person's outline, line for line")
  assert.equal(agentShot.elements, shot.elements)
  assert.deepEqual([agentShot.window.app, agentShot.window.title], [shot.window.app, shot.window.title])
  const printed = agentShot[PRESENT]()
  assert.ok(printed.startsWith("Window capture of "), "it prints as its outline")
  assert.match(printed, /\n\nimage image\/png \d+×\d+ \(\d+ KB\) view [0-9a-f-]+ · emitImage\(shot\) shows it/, "then its picture's size and view token, never its pixels")
  await writeFile(join(evidence, "sdk-appshot.txt"), printed)
  server = await serveControlSession(session)
  since = performance.now()
  const cliShot = await new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [resolve("packages/control-runtime/dist/control-cli.js"), "appshot", "--target-file", "-", "--output", join(evidence, "cli-appshot.png"), "--overwrite", "--session-file", server.file],
      { stdio: ["pipe", "pipe", "pipe"] }
    )
    let out = ""
    let err = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (err += chunk))
    child.once("exit", (code) => (code === 0 ? done(JSON.parse(out)) : fail(new Error(`mako-control appshot exited ${code}: ${err}`))))
    child.stdin.end(JSON.stringify({ kind: "window", pid, window_id: target.windowId }))
  })
  const cliMs = ms(since)
  assert.equal(body(cliShot.text), body(shot.text), "the CLI's Appshot is the same outline")
  assert.equal(cliShot.path, join(evidence, "cli-appshot.png"))
  assert.ok(!("data" in cliShot), "the picture goes to the file, never to stdout")
  await writeFile(join(evidence, "cli-appshot.json"), `${JSON.stringify({ ...cliShot, text: `${cliShot.text.split("\n").slice(0, 10).join("\n")}\n…` }, null, 2)}\n`)
  report.agent = { sdkMs, cliMs }

  /* No head-of-line blocking: an Appshot beside an agent's slow call ------------- */

  // A bounded wait that only reads: a predicate the page never satisfies.
  const window = { kind: "window", pid, window_id: target.windowId }
  const slowCall = session
    .call({ action: "native", name: "verify_state", args: { pid, window_id: target.windowId, expect: [{ element: { selector: { label_contains: "never-on-this-page" }, exists: true } }], timeout_ms: 3000 } }, AbortSignal.timeout(30_000))
    .catch((error) => error)
  await new Promise((done) => setTimeout(done, 300))
  since = performance.now()
  await appshots.capture(target)
  report.besideAgentSlowCallMs = ms(since)
  await slowCall
  assert.ok(report.besideAgentSlowCallMs < 2000, `an Appshot doesn't wait behind an agent's 3 s call (${report.besideAgentSlowCallMs} ms)`)

  /* Another consumer's read of the window, and an agent's ref ------------------- */

  // Who owns a window's snapshot is the daemon's to say (`snapshot_scope`); the broker reads it once per daemon.
  const snapshots = broker.status().daemon.snapshots
  report.snapshots = { scope: snapshots, driver: broker.status().daemon.version }
  /** Clicks on the page since `earlier`, by the control they landed on. */
  const hitsSince = (earlier, later) =>
    Object.fromEntries(Object.entries(later.hits).flatMap(([name, count]) => (count > (earlier.hits[name] ?? 0) ? [[name, count - (earlier.hits[name] ?? 0)]] : [])))
  // A press, not a value write: the session sends web content's text to its page, never as a native value.
  const observed = await session.call({ action: "observe", target: window }, AbortSignal.timeout(30_000))
  const ref = observed.nodes.find((node) => node.ref && node.role === "Button" && node.name === "Export")?.ref
  assert.ok(ref, "the agent observed a button it could press")
  await appshots.capture(target)
  await new Promise((done) => setTimeout(done, 50))
  if (snapshots === "lease") {
    const pressedBefore = await page()
    await session.call({ action: "dispatch", target: window, operation: { kind: "activate", ref } }, AbortSignal.timeout(30_000))
    assert.deepEqual(hitsSince(pressedBefore, await page()), { Export: 1 }, "an Appshot's tree read left the agent's ref acting on its own snapshot")
    assert.equal(broker.status().totals.superseded, 0, "and the broker tracked no supersession")
  } else {
    await assert.rejects(
      session.call({ action: "dispatch", target: window, operation: { kind: "activate", ref } }, AbortSignal.timeout(30_000)),
      (error) => error.code === "stale-reference" && error.outcome === "not-dispatched" && /an Appshot read this window since/.test(error.message),
      "at an older driver the agent's ref is refused before dispatch, naming the Appshot"
    )
    assert.ok(broker.status().totals.superseded >= 1)
  }

  /* A reads, B reads, A acts with its earlier tokens ----------------------------- */

  const windowArgs = { pid, window_id: target.windowId }
  /** One tree read on `client`: its tokens for the Export button and the search field, and how long it took. */
  const readTree = async (client) => {
    const started = performance.now()
    const state = await client.callTool("get_window_state", { ...windowArgs, include_screenshot: false }, { timeout: 30_000 })
    const ms = performance.now() - started
    assert.notEqual(state.isError, true, `a tree read: ${JSON.stringify(state.content?.[0])}`)
    const token = (label) => state.structuredContent.elements.find((element) => element.label === label && element.element_token)?.element_token
    return { ms, export: token("Export"), search: token("Search invoices"), snapshot: state.structuredContent.snapshot_id }
  }
  const refusalOf = (result) => result.structuredContent?.refusal?.code ?? result.structuredContent?.code
  /** Why a token was stale, when the driver says (per-lease drivers do). */
  const causeOf = (result) => result.structuredContent?.refusal?.cause
  {
    const [a, b] = await Promise.all([broker.connect({ kind: "agent", label: "consumer A" }), broker.connect({ kind: "agent", label: "consumer B" })])
    const readA = await readTree(a)
    assert.ok(readA.export && readA.search, "A's read has tokens for the Export button and the search field")
    const readB = await readTree(b)
    await appshots.capture(target)
    assert.notEqual(readA.snapshot, readB.snapshot, "each read is a fresh snapshot of its own")
    const pageBefore = await page()
    const click = await a.callTool("click", { ...windowArgs, element_token: readA.export }, { timeout: 30_000 })
    const write = await a.callTool("set_value", { ...windowArgs, element_token: readA.search, value: "written by A" }, { timeout: 30_000 })
    const after = await page()
    report.consumerAfterAnothersRead = { click: refusalOf(click) ?? "ok", write: refusalOf(write) ?? "ok", hits: hitsSince(pageBefore, after) }
    if (snapshots === "lease") {
      assert.notEqual(click.isError, true, `A's earlier token clicks after B's read and an Appshot (${refusalOf(click)})`)
      assert.notEqual(write.isError, true, `and writes (${refusalOf(write)})`)
      assert.deepEqual(hitsSince(pageBefore, after), { Export: 1 }, "the click landed on Export, once")
      assert.equal(after.search, "written by A", "the value landed in the field")
      const foreign = await b.callTool("click", { ...windowArgs, element_token: readA.export }, { timeout: 30_000 })
      assert.equal(refusalOf(foreign), "foreign_element_token", "B can't act with A's token, and is told whose it is")
      assert.equal((await page()).clicks, after.clicks, "nothing was clicked for it")
      const own = await b.callTool("click", { ...windowArgs, element_token: readB.export }, { timeout: 30_000 })
      assert.notEqual(own.isError, true, "B's own earlier token still acts")
    } else {
      // One snapshot per window: B's read and the Appshot's replaced A's, and the driver says so rather than acting on another element.
      assert.equal(refusalOf(click), "stale_element_token", "at an older driver A's earlier token is refused as stale")
      assert.equal(refusalOf(write), "stale_element_token")
      assert.deepEqual(hitsSince(pageBefore, after), {}, "and nothing on the page was clicked")
      assert.equal(after.search, pageBefore.search, "or written")
    }
    // A's own newer read replaces its older one, at either driver: the older token is refused, never resolved to whatever the new read holds.
    const newer = await readTree(a)
    const clicksBefore = (await page()).clicks
    const old = await a.callTool("click", { ...windowArgs, element_token: readA.export }, { timeout: 30_000 })
    assert.equal(refusalOf(old), "stale_element_token", "A's token from before its own newer read is refused as stale")
    assert.equal((await page()).clicks, clicksBefore, "and nothing was clicked for it")
    if (snapshots === "lease") assert.equal(causeOf(old), "replaced", `and the refusal says A's newer read replaced it (${old.content?.[0]?.text})`)
    report.consumerOwnOlderRead = { code: refusalOf(old), cause: causeOf(old) ?? null, text: old.content?.[0]?.text }
    assert.ok(newer.export, "the newer read has its own token")
    await Promise.all([a.close(), b.close()])
  }

  /* One consumer clicking alone: what a click costs without a queue --------------- */

  // The driver runs one background action per process at a time and lets each
  // settle, so in the stress below a click waits for the others' clicks.
  {
    const solo = await broker.connect({ kind: "agent", label: "solo" })
    const read = await readTree(solo)
    const soloBefore = await page()
    const runs = []
    for (let index = 0; index < 5; index++) {
      const started = performance.now()
      const clicked = await solo.callTool("click", { ...windowArgs, element_token: read.export }, { timeout: 30_000 })
      runs.push(Math.round(performance.now() - started))
      assert.notEqual(clicked.isError, true, `a click alone (${refusalOf(clicked)})`)
    }
    assert.deepEqual(hitsSince(soloBefore, await page()), { Export: 5 }, "each click alone landed on Export")
    report.soloClickMs = { median: percentile(runs, 50), runs }
    await solo.close()
  }

  /* Several consumers reading and clicking on one window at once ------------------ */

  // Each consumer reads the tree, takes a moment to decide (the others read
  // meanwhile), then clicks Export with its token, while the person's Appshots
  // capture the same window. A token is refused only as stale; every click
  // that isn't refused lands on Export, once.
  const CONSUMERS = 8
  const ROUNDS = 6
  const stressBefore = await page()
  const stressMemoryBefore = await memoryMB(broker.status().daemon.pid)
  const reads = []
  const clicks = []
  let stressing = true
  const appshotsDuring = (async () => {
    let count = 0
    while (stressing) {
      await appshots.capture(target)
      count++
    }
    return count
  })()
  const stressStarted = performance.now()
  const outcomes = await Promise.all(
    Array.from({ length: CONSUMERS }, async (_, index) => {
      const client = await broker.connect({ kind: "agent", label: `stress ${index}` })
      const refused = []
      try {
        for (let round = 0; round < ROUNDS; round++) {
          const readStart = performance.now()
          const read = await readTree(client)
          const readEnd = performance.now()
          reads.push({ consumer: index, start: readStart, end: readEnd, ms: read.ms })
          await new Promise((done) => setTimeout(done, 150))
          const clickStart = performance.now()
          const clicked = await client.callTool("click", { ...windowArgs, element_token: read.export }, { timeout: 30_000 })
          clicks.push({ consumer: index, readEnd, start: clickStart, ms: performance.now() - clickStart })
          if (clicked.isError) refused.push(refusalOf(clicked) ?? clicked.content?.[0]?.text)
        }
      } finally {
        await client.close()
      }
      return refused
    })
  )
  const stressMs = Math.round(performance.now() - stressStarted)
  stressing = false
  const appshotCount = await appshotsDuring
  const refused = outcomes.flat()
  const stressHits = hitsSince(stressBefore, await page())
  // Clicks whose token another consumer's read replaced (a read publishes as it
  // finishes): at a driver with one snapshot per window, each of those is stale.
  const crossed = clicks.filter((click) =>
    reads.some((read) => read.consumer !== click.consumer && read.end > click.readEnd && read.end < click.start)
  ).length
  const byCode = refused.reduce((counts, code) => ({ ...counts, [code]: (counts[code] ?? 0) + 1 }), {})
  report.stress = {
    consumers: CONSUMERS,
    rounds: ROUNDS,
    clicks: CONSUMERS * ROUNDS,
    appshots: appshotCount,
    landed: stressHits,
    refused: byCode,
    clicksAfterAnotherConsumersRead: crossed,
    readMs: { median: Math.round(percentile(reads.map((read) => read.ms), 50)), p90: Math.round(percentile(reads.map((read) => read.ms), 90)) },
    clickMs: { median: Math.round(percentile(clicks.map((click) => click.ms), 50)), p90: Math.round(percentile(clicks.map((click) => click.ms), 90)) },
    ms: stressMs,
    daemonMB: { before: stressMemoryBefore, after: await memoryMB(broker.status().daemon.pid) },
  }
  assert.ok(crossed > 0, "the consumers' reads did interleave with each other's clicks")
  assert.deepEqual(Object.keys(stressHits).filter((name) => name !== "Export"), [], `no click landed anywhere but Export (${JSON.stringify(stressHits)})`)
  assert.equal(stressHits.Export ?? 0, CONSUMERS * ROUNDS - refused.length, "every click that wasn't refused landed, once")
  if (snapshots === "lease") assert.deepEqual(refused, [], "no consumer's click was refused")
  else assert.deepEqual(Object.keys(byCode), ["stale_element_token"], `at an older driver a click is refused only as stale (${JSON.stringify(byCode)})`)

  /* 1,000 reads by one consumer: time per read, and memory ------------------------ */

  const READS = 1000
  const reader = await broker.connect({ kind: "agent", label: "reader" })
  const daemonPid = broker.status().daemon.pid
  const memoryBefore = await memoryMB(daemonPid)
  const readMs = []
  let memoryAt100
  for (let index = 0; index < READS; index++) {
    readMs.push((await readTree(reader)).ms)
    if (index === 99) memoryAt100 = await memoryMB(daemonPid)
  }
  const memoryAfter = await memoryMB(daemonPid)
  const lanesDuring = (await daemonSessions(socket)).snapshots
  await reader.close()
  await new Promise((done) => setTimeout(done, 100))
  const lanesAfter = (await daemonSessions(socket)).snapshots
  const round1 = (value) => Math.round(value * 10) / 10
  report.reads = {
    count: READS,
    medianMs: round1(percentile(readMs, 50)),
    p90Ms: round1(percentile(readMs, 90)),
    first100MedianMs: round1(percentile(readMs.slice(0, 100), 50)),
    last100MedianMs: round1(percentile(readMs.slice(-100), 50)),
    daemonMB: { before: memoryBefore, after100: memoryAt100, after1000: memoryAfter },
    ...(lanesDuring && { lanesWhileReading: lanesDuring, lanesAfterClose: lanesAfter }),
  }
  if (snapshots === "lease") {
    const lane = lanesDuring.find((entry) => entry.owner?.startsWith("mcp-mako-") && entry.snapshots > 0 && entry.elements > 0 && lanesAfter.every((later) => later.owner !== entry.owner))
    assert.ok(lane, `the reader's lane, gone once its lease closed (${JSON.stringify({ lanesDuring, lanesAfter })})`)
    assert.equal(lane.snapshots, 1, "1,000 reads of one window keep one snapshot")
    assert.ok(lanesDuring.reduce((sum, entry) => sum + entry.snapshots, 0) <= 32, "and the daemon holds a handful in all")
    if (memoryAt100.footprint !== undefined && memoryAfter.footprint !== undefined)
      assert.ok(memoryAfter.footprint - memoryAt100.footprint < 64, `the daemon's footprint stays put from read 100 to ${READS} (${memoryAt100.footprint} → ${memoryAfter.footprint} MB)`)
  }

  /* Many leases holding a snapshot of the window at once: what each one costs ----- */

  const HOLDERS = 16
  const holdersMemoryBefore = await memoryMB(daemonPid)
  const ownersBefore = new Set(((await daemonSessions(socket)).snapshots ?? []).map((entry) => entry.owner))
  const holders = await Promise.all(Array.from({ length: HOLDERS }, (_, index) => broker.connect({ kind: "agent", label: `holder ${index}` })))
  const held = await Promise.all(holders.map((holder) => readTree(holder)))
  const holdersMemory = await memoryMB(daemonPid)
  const lanesHeld = (await daemonSessions(socket)).snapshots
  const stillActs = await holders[0].callTool("click", { ...windowArgs, element_token: held[0].export }, { timeout: 30_000 })
  await Promise.all(holders.map((holder) => holder.close()))
  await new Promise((done) => setTimeout(done, 100))
  const lanesReleased = (await daemonSessions(socket)).snapshots
  const holderLanes = (lanes) => (lanes ?? []).filter((entry) => entry.owner?.startsWith("mcp-mako-") && !ownersBefore.has(entry.owner) && entry.snapshots > 0)
  report.holders = {
    leases: HOLDERS,
    daemonMB: { before: holdersMemoryBefore, holding: holdersMemory, released: await memoryMB(daemonPid) },
    ...(lanesHeld && {
      lanesHolding: holderLanes(lanesHeld).length,
      elementsHolding: holderLanes(lanesHeld).reduce((sum, entry) => sum + entry.elements, 0),
      lanesAfterClose: holderLanes(lanesReleased).length,
    }),
    firstHolderClick: refusalOf(stillActs) ?? "ok",
  }
  if (snapshots === "lease") {
    assert.ok(holderLanes(lanesHeld).length >= HOLDERS, `each lease holds its own snapshot (${holderLanes(lanesHeld).length} lanes)`)
    assert.notEqual(stillActs.isError, true, `the first lease's token acts after ${HOLDERS - 1} other leases read the window (${refusalOf(stillActs)})`)
    assert.equal(holderLanes(lanesReleased).length, 0, "and every lane went when its lease closed")
  } else assert.equal(refusalOf(stillActs), "stale_element_token", "at an older driver the first lease's token went with the others' reads")
  await writeFile(join(evidence, "measurements.json"), `${JSON.stringify(report, null, 2)}\n`)

  /* The daemon dies: one reconnect, one warm-up ----------------------------------- */

  // A token the dying daemon issues, for its replacement to refuse.
  const prior = await broker.connect({ kind: "agent", label: "before the restart" })
  const priorRead = await readTree(prior)
  // The snapshot checks clicked and wrote on the page, so the capture to match is the one just before the kill.
  const beforeKill = await appshots.capture(target)
  const before = broker.status()
  const killedPid = cua.pid()
  process.kill(killedPid, "SIGKILL")
  // `CuaEmbedded` replaces it on the same socket; the broker follows, once, for everyone.
  const deadline = Date.now() + 15_000
  const reconnected = () => broker.status().daemon.state === "connected" && broker.status().daemon.generation > before.daemon.generation
  while (!reconnected() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50))
  await broker.warm()
  const after = broker.status()
  assert.equal(after.daemon.generation, before.daemon.generation + 1, "the broker reconnected once")
  assert.equal(after.reconnects, before.reconnects + 1)
  assert.notEqual(after.daemon.pid, killedPid, "to the replacement daemon")
  assert.equal(after.warm.state, "warm", "and warmed it")
  assert.equal(lines.filter((line) => line.message === "driver warmed" && line.generation === after.daemon.generation).length, 1, "once")
  since = performance.now()
  const again = await appshots.capture(target)
  report.afterDaemonRestart = { appshotMs: ms(since), reconnectMs: after.daemon.connectMs }
  assert.equal(body(again.text), body(beforeKill.text), "an Appshot after the restart is the same capture")
  const agentAgain = await sdk.window({ pid, window_id: target.windowId }).appshot()
  assert.equal(body(agentAgain.text), body(beforeKill.text), "and the agent's session reconnects on its next call")
  await prior.close().catch(() => undefined)
  {
    const fresh = await broker.connect({ kind: "agent", label: "after the restart" })
    const clicksBefore = (await page()).clicks
    const carried = await fresh.callTool("click", { ...windowArgs, element_token: priorRead.export }, { timeout: 30_000 })
    const clicked = (await page()).clicks - clicksBefore
    report.tokenFromKilledDaemon = { code: refusalOf(carried) ?? "ok", cause: causeOf(carried) ?? null, clicked, text: carried.content?.[0]?.text }
    if (snapshots === "lease") {
      assert.equal(refusalOf(carried), "stale_element_token", "the replacement daemon refuses the dead one's token")
      assert.equal(causeOf(carried), "earlier_process", `and says an earlier driver process issued it (${carried.content?.[0]?.text})`)
      assert.equal(clicked, 0, "nothing was clicked for it")
    }
    await fresh.close()
  }
  report.readout = broker.status()
  await writeFile(join(evidence, "measurements.json"), `${JSON.stringify(report, null, 2)}\n`)

  /* Which window the shortcut takes -------------------------------------------- */

  if (front) {
    const before = await frontmostPid()
    restore = async () => {
      if (!before) return
      await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", `ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${before}).activateWithOptions(0)`]).catch(() => undefined)
    }
    fixture.stdin.write("front\n")
    const deadline = Date.now() + 5000
    while ((await frontmostPid()) !== pid && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50))
    assert.equal(await frontmostPid(), pid, "the fixture came forward")
    const chosen = await appshots.frontWindow([])
    assert.deepEqual([chosen.pid, chosen.windowId], [pid, listed.windowId], "the shortcut takes the front application's window")
    const other = await appshots.frontWindow([pid]).catch((error) => error)
    assert.ok(other instanceof Error || other.pid !== pid, "with the fixture's app excluded (as Mako excludes itself) it is never the answer")
    await restore()
    restore = undefined
  }

  console.log(
    `Appshot live: ${shot.window.app} “${shot.window.title}” captured at ${meta.width}×${meta.height}; on a new driver ${unwarmed} ms, ${cold} ms after the warm-up (${warming} ms to warm), ${warm} ms warm (median of 5), ${report.besideAgentSlowCallMs} ms beside an agent's 3 s call; ` +
      `the broker's results equal the MCP proxy's; ` +
      (snapshots === "lease"
        ? `snapshots per lease: an Appshot left the agent's ref acting, A clicked and wrote with tokens read before B's read, ${report.stress.consumers} consumers made ${report.stress.clicks} clicks together in ${report.stress.ms} ms with no stale token (${report.stress.clicksAfterAnotherConsumersRead} right after another's read); `
        : `snapshots shared (an older driver): an Appshot retired the agent's ref before dispatch, A's token was refused as stale after B's read, and of ${report.stress.clicks} clicks by ${report.stress.consumers} consumers ${report.stress.clicks - (report.stress.landed.Export ?? 0)} were refused as stale (${report.stress.clicksAfterAnotherConsumersRead} right after another's read), none landing elsewhere; `) +
      `${READS} reads at ${report.reads.medianMs} ms median (p90 ${report.reads.p90Ms}), the daemon's footprint ${report.reads.daemonMB.after100.footprint} MB after 100 and ${report.reads.daemonMB.after1000.footprint} MB after ${READS}; ` +
      `a killed daemon was reconnected and warmed once; ` +
      `the same outline through window.appshot() in ${sdkMs} ms and mako-control appshot in ${cliMs} ms; ` +
      `${raw.structuredContent.elements.length} driver elements → ${shot.elements} outline lines, boxes inside the picture and on the red button's pixels; ` +
      `${Object.entries(measured).map(([name, size]) => `${name}: ${size.tokens} tokens`).join("; ")}` +
      `${front ? "; the front app's window chosen and the excluded app never" : ""}. Evidence: ${evidence}`
  )
} finally {
  await restore?.()
  await probe?.close().catch(() => undefined)
  await server?.close().catch(() => undefined)
  await session?.close().catch(() => undefined)
  await appshots?.close()
  await broker?.close()
  cua.stop()
  fixture.kill()
  // The evidence stays; what the fixture and the driver kept goes.
  await rm(join(root, "user-data"), { recursive: true, force: true }).catch(() => undefined)
  await rm(join(root, "cua"), { recursive: true, force: true }).catch(() => undefined)
}
