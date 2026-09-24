// Real AppKit sheet ownership: exact window, semantic input, stale refs and no activation.
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { ControlCliProbe } from "./lib/control-cli-probe.mjs"
import { snapshotControlRuntime } from "./lib/control-runtime-snapshot.mjs"
import { parseArgs } from "node:util"

const { values } = parseArgs({options:{app:{type:"string"},sandbox:{type:"boolean",default:false},save:{type:"boolean",default:false}}})
const archive = values.app ? resolve(values.app, "Contents/Resources/app.asar") : undefined
const hostRoot = archive ? join(archive, "dist-electron") : resolve("dist-electron")
const { ensureCuaEmbedded, stopCuaEmbedded } = await import(pathToFileURL(join(hostRoot, "cua-embedded.js")).href)
const { environmentForExecutable, resolveExecutable } = await import(pathToFileURL(join(hostRoot, "executable.js")).href)

const run = promisify(execFile)
const root = await realpath(await mkdtemp(join(tmpdir(), "mako-native-dialog-")))
const client = new ControlCliProbe({ name: "native-file-sheet" })
const evidence = { passed: false, root, sandbox: values.sandbox, panel: values.save ? "save" : "open", calls: [] }
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
  let executable = binary
  if (values.sandbox) {
    const bundle=join(root,"Mako Sandbox Panel.app")
    await mkdir(join(bundle,"Contents/MacOS"),{recursive:true})
    executable=join(bundle,"Contents/MacOS/fixture")
    await cp(binary,executable)
    await writeFile(join(bundle,"Contents/Info.plist"),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleIdentifier</key><string>dev.mako.sandbox-panel-fixture</string><key>CFBundleName</key><string>Mako Sandbox Panel</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
    const entitlements=join(root,"sandbox.plist")
    const xmlRoot=root.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    await writeFile(entitlements,`<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.files.user-selected.read-write</key><true/><key>com.apple.security.temporary-exception.files.absolute-path.read-write</key><array><string>${xmlRoot}/</string></array></dict></plist>`)
    await run("codesign",["--force","--sign",process.env.MAKO_LOCAL_SIGNING_IDENTITY ?? "-","--entitlements",entitlements,bundle])
    await run("codesign",["--verify","--strict",bundle])
    evidence.entitlements=JSON.parse((await run("plutil",["-convert","json","-o","-",entitlements])).stdout)
    await run("xcrun",["swiftc","-O",resolve("scripts/lib/native-panel-processes.swift"),"-o",join(root,"inspect-panel")],{timeout:180000})
  }
  fixture = spawn(executable, [join(root, "state.json"),...(values.save ? ["--save-panel"] : [])], { stdio: "ignore" })
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
    let observation = await cell(`state.panel=control.window({pid:${initial.pid},window_id:${panelWindow.window_id}});return await state.panel.observe(${JSON.stringify(values.save ? {max:1000,maxDepth:5} : {max:1000})})`)
    if(values.save) {
      const expand=observation.lines.find(line=>/^[^ ]+ DisclosureTriangle "show more options"/.test(line))
      if(expand) {
        await cell(`return await state.panel.activate(${JSON.stringify(expand.split(' ')[0])})`)
        observation=await cell("return await state.panel.observe({max:1000,maxDepth:5})")
      }
    }
    if(values.sandbox && round===0) {
      const diagnostic=await run(join(root,"inspect-panel"),[String(initial.pid),String(panelWindow.window_id)],{timeout:10000})
      evidence.panelProcesses=JSON.parse(diagnostic.stdout)
      assert.equal(evidence.panelProcesses.incomplete,false,"Remote-process diagnostic must finish within its bounds")
      const other=Object.keys(evidence.panelProcesses.processes).map(Number).filter(pid=>pid!==initial.pid)
      assert.ok(other.length>0,"A remote accessibility process must actually be present")
      evidence.remoteProcesses=(await run("ps",["-p",other.join(","),"-o","pid=,comm="])).stdout
      assert.match(evidence.remoteProcesses,/\/com\.apple\.appkit\.xpc\.openAndSavePanelService$/m,"The remote process must be Apple's panel service")
    }
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
      const files = observation.lines.filter(line=>values.save ? /^[^ ]+ TextField "untouched(?:\.txt)?"$/.test(line) : /^[^ ]+ TextField "fixture-choice.txt"$/.test(line))
      assert.equal(files.length,1,'The requested fixture file is observed explicitly')
      const fieldRef=JSON.stringify(files[0].split(' ')[0])
      selection = await cell(values.save ? `return await state.panel.setValue(${fieldRef},"saved-choice.txt")` : `return await state.panel.activate(${fieldRef})`)
      const selected = await cell(`return await state.panel.observe(${JSON.stringify(values.save ? {max:1000,maxDepth:5} : {max:1000})})`)
      const buttons = selected.lines.filter(line=>values.save ? /^[^ ]+ Button "Save fixture file"$/.test(line) : /^[^ ]+ Button "Choose fixture"$/.test(line))
      assert.equal(buttons.length,1,'Selecting the file enables the confirmation button')
      actionRef = buttons[0].split(' ')[0]
    }
    const receipt = await cell(`return await state.panel.activate(${JSON.stringify(actionRef)})`)
    const final = await until(async()=>{const actual=await read();return !actual.sheetAttached && actual.panelEvents.filter(event=>event.kind==='close').length===round+1?actual:null})
    assert.equal(final.panelEvents.filter(event=>event.kind==='open').length,round+1, 'No replay of an uncertain opening click')
    assert.equal(final.panelEvents.at(-1).response,round===3?1:0,'AppKit independently confirms the response')
    assert.equal(final.panelEvents.at(-1).selected,round===3 ? (values.save ? 'saved-choice.txt' : 'fixture-choice.txt') : '')
    assert.equal(final.panelEvents.at(-1).writeError,"")
    assert.deepEqual(final.foregroundEvents,initial.foregroundEvents)
    const stale = await cell(`return await state.panel.activate(${JSON.stringify(actionRef)})`,true)
    assert.equal(stale.code,'stale-reference','A closed sheet reference cannot mutate the parent')
    assert.equal(stale.outcome,'not-dispatched')
    assert.equal(final.saves,0,'Parent controls are untouched')
    evidence.rounds.push({window:panelWindow.window_id,open,coverage:observation.coverage,wrong,selection,receipt,stale})
    evidence.final = final
  }
  assert.equal(await readFile(join(root,"decoy.txt"),"utf8"),"leave this untouched\n")
  if(values.save) assert.equal(await readFile(join(root,"saved-choice.txt"),"utf8"),"saved fixture\n")
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
