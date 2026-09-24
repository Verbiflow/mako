// Real AppKit sheet ownership: exact window, semantic input, stale refs and no activation.
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { ControlCliProbe } from "./lib/control-cli-probe.mjs"
import { snapshotControlRuntime } from "./lib/control-runtime-snapshot.mjs"

assert.ok(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === "--app"), "Use --app <exact bundle>, running its executable with ELECTRON_RUN_AS_NODE=1")
const archive = process.argv[3] ? resolve(process.argv[3], "Contents/Resources/app.asar") : undefined
const hostRoot = archive ? join(archive, "dist-electron") : resolve("dist-electron")
const { ensureCuaEmbedded, stopCuaEmbedded } = await import(pathToFileURL(join(hostRoot, "cua-embedded.js")).href)
const { environmentForExecutable, resolveExecutable } = await import(pathToFileURL(join(hostRoot, "executable.js")).href)

const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-native-dialog-"))
const client = new ControlCliProbe({ name: "native-file-sheet" })
const evidence = { passed: false, root, calls: [] }
let fixture
const read = async () => JSON.parse(await readFile(join(root, "state.json"), "utf8"))
async function until(fn) {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    const result = await fn().catch(() => null)
    if (result) return result
    await delay(25)
  }
  throw new Error("Dialog fixture did not reach the expected state")
}
async function cell(source, uncertain = false) {
  const started = performance.now()
  const response = await client.request({ method: "exec", arguments: { source } })
  assert.equal(response.content.some(block => block.type === "image"), false)
  const result = JSON.parse(response.content.filter(block => block.type === "text").at(-1).text)
  evidence.calls.push({ source, result, elapsedMs: performance.now()-started })
  if (!uncertain) assert.equal(response.isError, undefined, JSON.stringify(result))
  return result
}
try {
  const binary = join(root, "fixture")
  await run("xcrun", ["swiftc", "-O", resolve("scripts/lib/native-settling-fixture.swift"), "-o", binary], { timeout: 180000 })
  await writeFile(join(root,"fixture-choice.txt"),"chosen fixture\n")
  await writeFile(join(root,"decoy.txt"),"leave this untouched\n")
  fixture = spawn(binary, [join(root, "state.json")], { stdio: "ignore" })
  const initial = await until(read)
  evidence.initial = initial
  assert.notEqual(initial.frontmostPid, initial.pid)
  const requestedDriver = process.env.MAKO_TEST_DRIVER
  if (requestedDriver) assert.ok(isAbsolute(requestedDriver))
  const driver = resolveExecutable(requestedDriver ?? "cua-driver")
  assert.ok(driver, "The requested driver must exist; no fallback")
  const driverEnv = environmentForExecutable(driver, process.env)
  evidence.driver = (await run(driver, ["--version"])).stdout.trim()
  if (archive) evidence.build = JSON.parse(await readFile(join(archive, "package.json"), "utf8")).makoBuild
  else await snapshotControlRuntime(root)
  const socket = await ensureCuaEmbedded(join(root, "driver"), "dev.mako.file-sheet", driverEnv)
  await client.start({
    runtimeRoot: archive ? join(archive, "node_modules/@mako/control-runtime/dist") : join(root, "control-runtime-snapshot/node_modules/@mako/control-runtime/dist"),
    native: { driver, socket },
    env: driverEnv,
  })
  await cell(`state.window=control.window({pid:${initial.pid},window_id:${initial.window}});return await state.window.observe()`)
  evidence.rounds = []
  for (let round=0;round<4;round++) {
    await cell("return await state.window.observe()")
    const open = await cell("return await state.window.locator({role:'Button',name:'Open test panel'}).click()", true)
    if (open.code) {
      assert.equal(open.code, 'native-driver-error')
      assert.equal(open.outcome, 'unknown')
      assert.match(open.message, /AXUIElementPerformAction.*-25204/)
    } else assert.equal(open.status, 'dispatched')
    await until(async()=>{const actual=await read();return actual.sheetAttached?actual:null})
    const windows = await cell(`return await control.app({pid:${initial.pid}}).windows()`)
    const panels = windows.windows.filter(window=>window.title==='Mako test panel' && window.is_on_screen===true)
    assert.equal(panels.length,1,'Exactly one visible fixture panel')
    const panelWindow = panels[0]
    const observation = await cell(`state.panel=control.window({pid:${initial.pid},window_id:${panelWindow.window_id}});return await state.panel.observe({max:1000})`)
    assert.ok(observation.lines.some(line=>line.includes('Sheet "mako test panel"')))
    assert.ok(observation.lines.every(line=>!line.includes('Evidence text') && !line.includes('MenuBar')), 'A sheet observation contains no parent controls or menu bar')
    const cancelLines = observation.lines.filter(line=>/^[^ ]+ Button "Cancel"$/.test(line))
    assert.equal(cancelLines.length,1)
    const ref = cancelLines[0].split(' ')[0]
    // A real reference from the sheet must not be accepted by its parent.
    const wrong = await cell(`return await state.window.activate(${JSON.stringify(ref)})`,true)
    assert.ok(['stale-reference','observation-required'].includes(wrong.code), 'Cross-window references are refused')
    assert.equal(wrong.outcome,'not-dispatched')
    let actionRef = ref
    let selection
    if (round===3) {
      const files = observation.lines.filter(line=>/^[^ ]+ TextField "fixture-choice.txt"$/.test(line))
      assert.equal(files.length,1,'The requested fixture file is observed explicitly')
      selection = await cell(`return await state.panel.activate(${JSON.stringify(files[0].split(' ')[0])})`,true)
      const selected = await cell("return await state.panel.observe({max:1000})")
      const buttons = selected.lines.filter(line=>/^[^ ]+ Button "Choose fixture"$/.test(line))
      assert.equal(buttons.length,1,'Selecting the file enables the confirmation button')
      actionRef = buttons[0].split(' ')[0]
    }
    const receipt = await cell(`return await state.panel.activate(${JSON.stringify(actionRef)})`)
    const final = await until(async()=>{const actual=await read();return !actual.sheetAttached && actual.panelEvents.filter(event=>event.kind==='close').length===round+1?actual:null})
    assert.equal(final.panelEvents.filter(event=>event.kind==='open').length,round+1, 'No replay of an uncertain opening click')
    assert.equal(final.panelEvents.at(-1).response,round===3?1:0,'AppKit independently confirms the response')
    assert.equal(final.panelEvents.at(-1).selected,round===3?'fixture-choice.txt':'')
    assert.deepEqual(final.foregroundEvents,initial.foregroundEvents)
    const stale = await cell(`return await state.panel.activate(${JSON.stringify(actionRef)})`,true)
    assert.equal(stale.code,'stale-reference','A closed sheet reference cannot mutate the parent')
    assert.equal(stale.outcome,'not-dispatched')
    assert.equal(final.saves,0,'Parent controls are untouched')
    evidence.rounds.push({window:panelWindow.window_id,open,coverage:observation.coverage,wrong,selection,receipt,stale})
    evidence.final = final
  }
  assert.equal(await readFile(join(root,"decoy.txt"),"utf8"),"leave this untouched\n")
  evidence.passed = true
} catch (error) {
  evidence.error = error.message
  evidence.final = await read().catch(() => null)
  process.exitCode = 1
} finally {
  await client.close().catch(() => {})
  await stopCuaEmbedded()
  fixture?.kill()
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n")
  console.log(JSON.stringify({ passed: evidence.passed, error: evidence.error, root }))
}
