// Fixture-only acceptance. Its private driver cannot restart the live host's daemon.
// Run with ELECTRON_RUN_AS_NODE=1 using the installed Mako permission host.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { join, resolve, isAbsolute, dirname } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import sharp from "sharp"
import { ControlCliProbe } from "./lib/control-cli-probe.mjs"
import { startCocoaFixture } from "./lib/cocoa-fixture.mjs"
import { sampleFrontmost, frontmostPid } from "./lib/control-fixture.mjs"
import { snapshotControlRuntime } from "./lib/control-runtime-snapshot.mjs"
import { ensureCuaEmbedded, stopCuaEmbedded } from "../dist-electron/cua-embedded.js"
import { environmentForExecutable } from "../dist-electron/executable.js"
import { mediaExecutable } from "../packages/control-runtime/dist/control-media.js"

const run = promisify(execFile)
const manifest = JSON.parse(await readFile("vendor/cua-driver/release.json", "utf8"))
const driver = process.env.MAKO_TEST_DRIVER ?? resolve(`release/control-driver/${manifest.version}/CuaDriverLocal.app/Contents/MacOS/cua-driver`)
assert.ok(isAbsolute(driver), "Pin the exact test driver; never fall back to PATH")
const root = await realpath(await mkdtemp(join(tmpdir(), "mako-pointer-proof-")))
const idleCheck = process.argv.includes("--idle-check")
const sessionFile = process.argv.find(arg => arg.startsWith("--session-file="))?.slice(15)
assert.ok(!idleCheck || !sessionFile, "An accelerated TTL requires a private test daemon")
// Borrow through the SDK shipped with this exact Electron executable. Importing
// the checkout SDK after a rebuild correctly refuses an older installed session.
const installedSession = sessionFile ? await import(pathToFileURL(join(dirname(process.execPath),
  "../Resources/app.asar/node_modules/@mako/control-runtime/dist/session.js")).href) : undefined
const descriptor = installedSession ? await installedSession.readControlSession(sessionFile) : undefined
const report = { passed: false, root, driver,
  scope: descriptor ? "Borrowed existing task session; host and driver are unchanged" : "Private candidate driver and frozen runtime",
  calls: [] }
const client = descriptor ? {
  async request({ method, arguments: args }) {
    assert.equal(method, "exec")
    const content = await installedSession.invokeControlSession(descriptor, { method: "exec", source: args.source }, AbortSignal.timeout(60000))
    assert.ok(Array.isArray(content))
    return { content }
  },
  async close() {},
} : new ControlCliProbe({ name: "native-pointer-recording-proof" })
let fixture, sampler
async function cell(source) {
  const startedAt = Date.now()
  const foregroundBefore = await frontmostPid()
  const response = await client.request({ method: "exec", arguments: { source } })
  const result = JSON.parse(response.content.filter(block => block.type === "text").at(-1).text)
  report.calls.push({ source, result, startedAt, endedAt: Date.now(), foregroundBefore, foregroundAfter: await frontmostPid() })
  assert.equal(response.isError, undefined, JSON.stringify(result))
  return result
}
try {
  report.version = (await run(driver, ["--version"])).stdout.trim()
  assert.equal(report.version, `cua-driver ${manifest.version}`)
  sampler = sampleFrontmost(100)
  const title = "Mako pointer recording proof"
  fixture = await startCocoaFixture({ root, title })
  const started = await fixture.started()
  report.fixturePid = started.pid
  report.foregroundAtStartup = await frontmostPid()
  report.fixtureStartup = await fixture.state()
  assert.notEqual(report.foregroundAtStartup, started.pid, "Fixture was foreground before any control action")
  if (!descriptor) {
    const env = environmentForExecutable(driver, process.env)
    if (idleCheck) env.CUA_DRIVER_RS_SESSION_IDLE_TTL_SECS = "1"
    const socket = await ensureCuaEmbedded(join(root, "driver"), "dev.mako.pointer-proof", env)
    assert.ok(socket, "The owned test daemon must start")
    await snapshotControlRuntime(root)
    await client.start({ native: { driver, socket }, env,
      runtimeRoot: join(root, "control-runtime-snapshot/node_modules/@mako/control-runtime/dist") })
  }
  const windows = await cell(`return await control.windows(${started.pid})`)
  if (idleCheck) {
    // The real SDK sweeper runs every 30 seconds. Cross it with an alive,
    // completely idle proxy before creating the named action session.
    const idleStarted = Date.now()
    await delay(35000)
    const afterIdle = await cell(`return await control.windows(${started.pid})`)
    assert.equal(afterIdle.pid, windows.pid)
    assert.deepEqual(afterIdle.windows.map(window => window.window_id).sort(),
      windows.windows.map(window => window.window_id).sort(),
      "Connected native discovery must retain the same fixture windows across idle maintenance")
    report.idle = { elapsedMs: Date.now() - idleStarted, configuredTtlSeconds: 1 }
  }
  const matches = windows.windows.filter(window => window.title === title)
  assert.equal(matches.length, 1)
  report.target = { pid: started.pid, window_id: matches[0].window_id }
  const view = await cell(`state.pointerProofWindow=control.window(${JSON.stringify(report.target)});return (await state.pointerProofWindow.observe()).data`)
  assert.ok(view.nodes.some(node => node.role === "TextField" && node.name === "Proof"))
  await cell(`state.pointerProofRecording=await state.pointerProofWindow.record({directory:${JSON.stringify(root)},fps:60});await state.pointerProofWindow.locator({role:'TextField',name:'Proof'}).setValue('  exact é 🧪  ');await state.pointerProofWindow.locator({role:'Button',name:'Verify proof'}).click();return await state.pointerProofWindow.observe()`)
  const gestures = [{ x: 450, y: 200, options: { button: "right" }, tool: "right_click" },
    { x: 430, y: 180, options: { count: 2 }, tool: "double_click" }]
  for (const gesture of gestures) {
    // These blank-content positions come from this test's owned AppKit layout.
    await cell(`const image=await state.pointerProofWindow.screenshot();const g=image.coordinates;await state.pointerProofWindow.click({x:${gesture.x}*g.imageWidth/g.sourceWidth,y:${gesture.y}*g.imageHeight/g.sourceHeight,view:image.view},${JSON.stringify(gesture.options)});return await state.pointerProofWindow.observe()`)
    assert.equal((await fixture.state()).value, '  exact é 🧪  ')
  }
  await delay(500)
  let receipt = await cell("return await state.pointerProofRecording.stop()")
  for (let i = 0; receipt.status === "finalizing" && i < 180; i++) {
    await delay(500)
    receipt = await cell("return await state.pointerProofRecording.status()")
  }
  report.recording = receipt
  assert.equal(receipt.status, "finished", receipt.error)
  const actions = []
  for (const entry of await readdir(receipt.directory))
    if (entry.startsWith("turn-")) actions.push(JSON.parse(await readFile(join(receipt.directory, entry, "action.json"), "utf8")))
  report.dispatches = actions.filter(action => gestures.some(gesture => gesture.tool === action.tool))
  for (const gesture of gestures) {
    const action = report.dispatches.find(action => action.tool === gesture.tool)
    assert.ok(action, gesture.tool)
    assert.ok(action.pointer_dispatches.some(point => point.pressed), `${gesture.tool} retains real button-down`)
    assert.ok(action.pointer_dispatches.some(point => !point.pressed), `${gesture.tool} retains release/movement`)
    for (const point of action.pointer_dispatches) {
      assert.ok(Math.abs(point.x - gesture.x / 480) < 0.01)
      assert.ok(Math.abs(point.y - gesture.y / 232) < 0.01)
    }
  }
  const timeline = JSON.parse(await readFile(receipt.timeline, "utf8"))
  report.pointerSamples = timeline.pointer.length
  assert.ok(timeline.pointer.length >= 6, "Driver dispatches reach the shared recording timeline")
  const first = timeline.pointer.find(point => point.pressed)
  assert.ok(first)
  const decoded = join(root, "cursor.png")
  await run(mediaExecutable("ffmpeg"), ["-v", "error", "-ss", String((first.at + 100) / 1000), "-i", receipt.video, "-frames:v", "1", decoded])
  const crop = await sharp(decoded).extract({ left: 444, top: 192, width: 30, height: 35 }).removeAlpha().raw().toBuffer()
  // This fixture area is blank. Require both the light cursor stroke and the
  // amber press ring, rather than accepting any bright background pixel.
  let light = 0, amber = 0
  for (let index = 0; index < crop.length; index += 3) {
    const [r, g, b] = crop.subarray(index, index + 3)
    if (r > 225 && g > 225 && b > 225) light++
    if (r > 160 && g > 90 && g < 200 && b < 140 && r > g + 30 && g > b + 30) amber++
  }
  assert.ok(light >= 10 && amber >= 8, "Decoded video includes the cursor stroke and press ring")
  report.cursorPassed = true
  report.fixtureFinal = await fixture.state()
  assert.equal(report.fixtureFinal.eventsDropped, 0, "Activation evidence must be complete")
  assert.ok(!report.fixtureFinal.events.some(event => event.kind === "workspaceActivatedFixture"),
    "Workspace reported fixture activation, even if the sampler missed it")
  report.foreground = Object.fromEntries(await sampler.stop()); sampler = undefined
  assert.ok(Object.keys(report.foreground).length)
  assert.ok(!(String(started.pid) in report.foreground), "Fixture must stay in the background")
  report.passed = true
} catch (error) {
  report.error = error.message
  process.exitCode = 1
} finally {
  if (fixture) report.fixtureFinal = await fixture.state().catch(() => undefined)
  if (descriptor) await client.request({ method: "exec", arguments: { source:
    "if(state.pointerProofRecording)await state.pointerProofRecording.stop();delete state.pointerProofRecording;delete state.pointerProofWindow;return true"
  } }).catch(error => { report.cleanupError = error.message; report.passed = false; process.exitCode = 1 })
  await client.close().catch(error => {
    report.cleanupError = error.message
    report.passed = false
    process.exitCode = 1
  })
  if (!descriptor) stopCuaEmbedded()
  fixture?.stop()
  if (sampler) report.foreground = Object.fromEntries(await sampler.stop())
  await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify({ passed: report.passed, cursorPassed: report.cursorPassed, error: report.error, root }))
}
