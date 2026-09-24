import { ControlCliProbe } from "./lib/control-cli-probe.mjs"
import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, writeFile, mkdir, cp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import {
  ensureCuaEmbedded,
  stopCuaEmbedded,
} from "../dist-electron/cua-embedded.js"
import { resolveExecutable } from "../dist-electron/executable.js"
import { frontmostPid, sampleFrontmost } from "./lib/control-fixture.mjs"
const root = await mkdtemp(join(tmpdir(), "mako-native-settling-"))
const run = promisify(execFile)
const status = join(root, "state.json")
const binary = join(root, "fixture")
await run(
  "xcrun",
  [
    "swiftc",
    "-O",
    "-o",
    binary,
    resolve("scripts/lib/native-settling-fixture.swift"),
  ],
  { timeout: 180000 }
)
const before = await frontmostPid()
const foregroundPhase = process.argv.includes("--foreground-gestures")
let fixturePid
let app
if (foregroundPhase) {
  // LaunchServices must register the foreground fixture as an app. A bare
  // command-line AppKit process can own WindowServer focus without appearing
  // as NSWorkspace's active application, and is correctly refused by the host.
  const bundle = join(root, "Mako Gesture Fixture.app")
  await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true })
  await cp(binary, join(bundle, "Contents", "MacOS", "fixture"))
  await writeFile(join(bundle, "Contents", "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleIdentifier</key><string>dev.mako.gesture-fixture</string><key>CFBundleName</key><string>Mako Gesture Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
  await run("codesign", ["--force", "--sign", "-", bundle])
  app = spawn("open", ["-n", "-g", bundle, "--args", status, "--regular"], { stdio: ["ignore", "ignore", "pipe"] })
} else app = spawn(binary, [status], { stdio: ["ignore", "ignore", "pipe"] })
let fixtureErrors = ""
app.stderr.on("data", (chunk) => {
  fixtureErrors = (fixtureErrors + chunk.toString()).slice(-65536)
})
const client = new ControlCliProbe({ name: "native-settling-proof", version: "1" })
const evidence = { passed: false, root, calls: [] }
let samples
const read = async () => JSON.parse(await readFile(status, "utf8"))
async function until(fn, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const result = await fn().catch(() => null)
    if (result) return result
    await delay(25)
  }
  throw new Error("Fixture did not reach the expected state")
}
async function cell(source) {
  const start = performance.now()
  let output = await client.request({method:"exec",arguments:{ source }}, { timeout: 70000 })
  
  const result = JSON.parse(
    output.content.filter((block) => block.type === "text").at(-1).text
  )
  evidence.calls.push({
    source,
    milliseconds: performance.now() - start,
    result,
  })
  if (output.isError || (result.code && result.outcome)) throw new Error(JSON.stringify(result))
  return result
}
try {
  const state = await until(read)
  fixturePid = state.pid
  evidence.driver = {
    executable: resolveExecutable("cua-driver"),
    version: (
      await run(resolveExecutable("cua-driver"), ["--version"])
    ).stdout.trim(),
  }
  const socket = await ensureCuaEmbedded(join(root, "driver"), "dev.mako.audit")
  assert.ok(socket)
  await client.start({native:{driver:resolveExecutable("cua-driver"),socket:socket},env:{ ...process.env }})
  samples = sampleFrontmost()
  const observed = await cell(
    `state.target={pid:${state.pid},window_id:${state.window}};state.window=control.window(state.target);return await state.window.observe();`
  )
  assert.equal(
    observed.coverage.complete,
    true,
    "Optional AppKit identifiers do not invalidate tree coverage"
  )
  assert.equal(
    observed.coverage.omitted,
    0,
    "Application menu rows are outside the window observation scope"
  )
  if (!foregroundPhase) {
  const clicked = await cell(
    "return await control.native('click',{...state.target,x:440,y:40});"
  )
  evidence.afterBurst = await until(async () => {
    const value = await read()
    return value.bursts === 8 ? value : null
  })
  assert.ok(
    clicked.settling,
    "Native action reports bounded settling separately"
  )
  assert.equal(clicked.settling.status, "events_quiet")
  assert.ok(
    clicked.settling.events > 0,
    "Actual accessibility notifications were received"
  )
  const busy = await cell(
    "return await state.window.locator({role:'Button',name:'Keep changing'}).click();"
  )
  evidence.afterSettling = await read()
  assert.ok(
    ["deadline", "events_quiet"].includes(busy.settling?.status),
    "A live observer reports activity or a bounded quiet interval"
  )
  assert.equal(
    busy.verification,
    "not-requested",
    "Settling does not claim an action postcondition"
  )
  // Background timers may coalesce beyond the quiet interval. Verify the actual
  // requested result through the public API; never replay the triggering action.
  evidence.completion = await cell(
    "return await state.window.expect({role:'StaticText',name:'Saved text',value:'Change 160'},{timeoutMs:10000});"
  )
  assert.equal(evidence.completion.status, "matched")
  evidence.afterCompletion = await until(async () => {
    const value = await read()
    return value.bursts === 160 ? value : null
  })
  await cell(
    `state.recording=await state.window.record({directory:${JSON.stringify(root)},maxDurationMs:30000});return state.recording;`
  )
  evidence.drag = await cell(
    "try {await control.native('drag',{...state.target,from_x:345,from_y:110,to_x:535,to_y:180,steps:20,duration_ms:400});return {status:'dispatched'};} catch(error) {return {status:'refused',message:error.message};}"
  )
  assert.equal(
    evidence.drag.status,
    "refused",
    "Mac background drag remains restricted"
  )
  await cell("return await state.window.observe();")
  evidence.pixelClick = await cell(
    "return await control.native('click',{...state.target,x:440,y:150});"
  )
  const clickedPad = await until(async () => {
    const value = await read()
    return value.points.some((point) => point.kind === "up") ? value : null
  })
  assert.ok(
    clickedPad.points.some((point) => point.kind === "down"),
    "Raw target-only click reaches the canvas"
  )
  evidence.scrollStages = []
  async function scrollProbe(label) {
    const prior = (await read()).points.filter(
      (point) => point.kind === "scroll"
    ).length
    await cell(
      "return await control.native('scroll',{...state.target,x:440,y:150,direction:'down',amount:1});"
    )
    try {
      const observed = await until(async () => {
        const value = await read()
        return value.points.filter((point) => point.kind === "scroll").length >
          prior
          ? value
          : null
      })
      evidence.scrollStages.push({
        label,
        received:
          observed.points.filter((point) => point.kind === "scroll").length -
          prior,
      })
    } catch (error) {
      throw new Error(`Scroll failed ${label}: ${error.message}`)
    }
  }
  await scrollProbe("after left")
  evidence.buttons = []
  for (const button of ["right", "middle"]) {
    evidence.buttons.push(
      await cell(
        `return await control.native('click',{...state.target,x:440,y:150,button:${JSON.stringify(button)}});`
      )
    )
    await until(async () =>
      (await read()).points.some((point) => point.kind === `${button}-up`)
    )
    await scrollProbe(`after ${button}`)
  }
  evidence.doubleClick = await cell(
    "return await control.native('double_click',{...state.target,x:440,y:150});"
  )
  await until(async () =>
    (await read()).points.some(
      (point) => point.kind === "up" && point.clickCount === 2
    )
  )
  await cell(
    "return await control.native('scroll',{...state.target,x:440,y:150,direction:'down',amount:3});"
  )
  const actual = await until(async () => {
    const value = await read()
    return value.points.filter((point) => point.kind === "scroll").length >= 6
      ? value
      : null
  })
  evidence.gestures = actual.points
  assert.equal(
    actual.points.filter((point) => point.kind === "scroll").length,
    6,
    "Each requested scroll tick arrives once"
  )
  for (const point of actual.points) {
    assert.ok(
      Math.abs(point.windowX - 440) < 1 && Math.abs(point.windowY - 150) < 1,
      "The app receives the exact requested window coordinates"
    )
  }
  for (const button of ["right", "middle"]) {
    assert.equal(
      actual.points.filter((point) => point.kind === `${button}-down`).length,
      1,
      "One delivered down per requested click"
    )
    assert.equal(
      actual.points.filter((point) => point.kind === `${button}-up`).length,
      1,
      "One delivered up per requested click"
    )
  }
  assert.equal(
    actual.points.filter((point) => point.kind === "down").length,
    3,
    "Single click plus two double-click downs"
  )
  assert.equal(
    actual.points.filter((point) => point.kind === "up").length,
    3,
    "Single click plus two double-click ups"
  )
  assert.ok(
    !actual.points.some((point) => point.kind === "drag"),
    "Refused drag did not reach the target"
  )
  assert.ok(
    actual.points.some((point) => point.kind === "scroll"),
    "The target received scrolling"
  )
  await cell("return await state.recording.stop();")
  const recording = await until(async () => {
    const value = await cell("return await state.recording.status();")
    return value.status === "finalizing" ? null : value
  }, 30000)
  assert.equal(recording.status, "finished", recording.error)
  const timeline = JSON.parse(await readFile(recording.timeline, "utf8"))
  assert.ok(
    timeline.pointer.length > 0,
    "Recording retains the dispatched scroll anchor"
  )
  for (const pointer of timeline.pointer) {
    assert.ok(
      Math.abs(pointer.x - 440) < 1 && Math.abs(pointer.y - 150) < 1,
      "Recorded cursor matches independently received coordinates"
    )
  }
  evidence.recording = recording
  evidence.pointerCount = timeline.pointer.length
  evidence.foreground = [...(await samples.stop())]
  samples = undefined
  evidence.initialForeground = before
  assert.ok(
    evidence.foreground.length > 0 &&
      evidence.foreground.every(([pid]) => pid !== state.pid),
    "The fixture never took the foreground"
  )
  } else {
    evidence.initialForeground = before
    evidence.preGestureForeground = [...(await samples.stop())]
    samples = undefined
  }
  if (process.argv.includes("--foreground-gestures")) {
    // This explicitly requested phase uses only the disposable fixture. It is
    // excluded from the background focus-continuity evidence above.
    await cell("return await state.window.raw('bring_to_front',{foreground:true});")
    const prior = (await read()).points.length
    await cell(`state.dragVideo=await state.window.record({directory:${JSON.stringify(join(root, "foreground-drag"))},maxDurationMs:15000});return state.dragVideo;`)
    evidence.beforeGestureWindows = await cell("return await control.native('list_windows',{pid:state.target.pid,on_screen_only:true});")
    await cell("return await state.window.raw('drag',{from_x:345,from_y:110,to_x:535,to_y:180,steps:20,duration_ms:400,delivery_mode:'foreground',foreground:true});")
    const received = await until(async () => {
      const state = await read()
      return state.points.slice(prior).some(point => point.kind === "up") ? state : null
    })
    const points = received.points.slice(prior)
    assert.equal(points.filter(point => point.kind === "down").length, 1)
    assert.equal(points.filter(point => point.kind === "up").length, 1)
    assert.ok(points.filter(point => point.kind === "drag").length >= 10)
    const down = points.find(point => point.kind === "down")
    const up = points.find(point => point.kind === "up")
    assert.ok(Math.abs(down.windowX - 345) < 1 && Math.abs(down.windowY - 110) < 1)
    assert.ok(Math.abs(up.windowX - 535) < 1 && Math.abs(up.windowY - 180) < 1)
    assert.equal(received.pressedButtons, 0, "Drag releases its button")
    await cell("return await state.dragVideo.stop();")
    const video = await until(async () => {
      const status = await cell("return await state.dragVideo.status();")
      return status.status === "finalizing" ? null : status
    }, 30000)
    assert.equal(video.status, "finished", video.error)
    const timeline = JSON.parse(await readFile(video.timeline, "utf8"))
    assert.ok(timeline.pointer.length >= 22, "Recorded cursor retains the actual drag path")
    assert.ok(new Set(timeline.pointer.map(point => Math.round(point.x))).size >= 15)
    const press = timeline.pointer.find(point => point.pressed)
    assert.ok(press && Math.abs(press.x - down.windowX) < 1 && Math.abs(press.y - down.windowY) < 1)
    const held = timeline.pointer.slice(timeline.pointer.indexOf(press), -1)
    assert.ok(held.length >= 21 && held.every(point => point.pressed), "The recorded button stays held throughout the drag")
    assert.equal(timeline.pointer.at(-1).pressed, false, "The recorded button releases at the end")
    evidence.foregroundDrag = { points, pointer: timeline.pointer, video }
  }
  assert.doesNotMatch(
    fixtureErrors,
    /NSInternalInconsistencyException|unexpected event type/,
    "No fixture event-handler exceptions"
  )
  evidence.passed = true
} catch (error) {
  evidence.error = error.message
  throw error
} finally {
  await writeFile(join(root, "fixture-stderr.log"), fixtureErrors)
  if (samples) evidence.foreground = [...(await samples.stop())]
  await client.close().catch(() => {})
  await stopCuaEmbedded()
  app.kill()
  if (foregroundPhase && fixturePid) {
    try { process.kill(fixturePid, "SIGTERM") } catch {}
  }
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n"
  )
  console.log(
    JSON.stringify({
      passed: evidence.passed,
      evidence: root,
      error: evidence.error,
    })
  )
}
