// Disposable jobs through an existing installed task. No provider/session restart.
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { installedControlAudit } from "./lib/installed-control-audit.mjs"
import { startCocoaFixture } from "./lib/cocoa-fixture.mjs"
import { sampleFrontmost } from "./lib/control-fixture.mjs"
import { processResources, summarizeProcessResources } from "./lib/control-process-resources.mjs"

const [sessionFile, browser, output] = process.argv.slice(2)
assert.ok(sessionFile && browser && output, "Pass existing session file, discovered browser ID and evidence directory")
const root = resolve(output)
await mkdir(root, { recursive: true })
const client = await installedControlAudit(sessionFile)
const cell = source => client.execute(source)
const q = JSON.stringify
const report = { identity: client.identity, status: "running", root }
const saves = []
const server = createServer(async (request, response) => {
  if (request.url === "/save") {
    let body = ""
    for await (const chunk of request) body += chunk
    saves.push(JSON.parse(body)); response.end("Saved"); return
  }
  response.setHeader("content-type", "text/html")
  response.end(`<!doctype html><title>Installed media recovery fixture</title>
    <style>body{background:#18202c;color:white;font:24px system-ui;padding:30px}input,button{font:inherit}canvas{display:block}</style>
    <label>Proof <input aria-label="Proof"></label><button>Verify proof</button><output></output><canvas width="640" height="200"></canvas>
    <script>document.querySelector('button').onclick=async()=>{await fetch('/save',{method:'POST',body:JSON.stringify({value:document.querySelector('input').value})});document.querySelector('output').textContent='Saved'};
    let n=0;const c=document.querySelector('canvas').getContext('2d');function draw(){c.fillStyle='#18202c';c.fillRect(0,0,640,200);c.fillStyle='white';c.fillRect((n++*4)%600,40,30,60);requestAnimationFrame(draw)}draw()</script>`)
})
await new Promise(done => server.listen(0, "127.0.0.1", done))
const url = `http://127.0.0.1:${server.address().port}`
let fixture, sampler, preview, resourcesTimer
async function until(read, check, label, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read()
    if (check(value)) return value
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}
async function settled(name) {
  return until(() => cell(`return await state.${name}.status()`), value => !["recording", "finalizing"].includes(value.status), name)
}
async function probe(receipt) {
  assert.ok(receipt.video, receipt.error)
  const executable = "/Applications/Mako.app/Contents/Resources/control-media/darwin-arm64/ffprobe"
  const result = JSON.parse((await promisify(execFile)(executable, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", receipt.video])).stdout)
  assert.ok(Number(result.streams[0].nb_read_frames) > 0, "Video must decode actual frames")
  return { ...receipt, probe: result }
}
try {
  if (!process.argv.includes("--native-only")) {
  const original = await cell(`state.mediaRecoveryTab=await control.openTab({browser:${q(browser)},url:${q(url)},background:true});await state.mediaRecoveryTab.observe();return state.mediaRecoveryTab.target`)
  const first = `  Installed before detach ${randomUUID()} é 🐟  `
  await cell(`state.mediaRecoveryRecording=await state.mediaRecoveryTab.record({directory:${q(root)},name:'Before debugger detach',fps:60});await state.mediaRecoveryTab.locator({role:'textbox',name:'Proof'}).setValue(${q(first)});await state.mediaRecoveryTab.locator({role:'button',name:'Verify proof'}).click();return await state.mediaRecoveryTab.expect({role:'textbox',name:'Proof',value:${q(first)}})`)
  await until(async () => saves.length, count => count === 1, "first exact save")
  assert.equal(saves[0].value, first)
  await delay(2500)
  await cell("await artifacts.save('installed-browser-before-detach.png',await state.mediaRecoveryTab.screenshot());return await state.mediaRecoveryTab.release()")
  const interrupted = await settled("mediaRecoveryRecording")
  assert.equal(interrupted.status, "interrupted", q(interrupted))
  report.browserInterruption = await probe(interrupted)
  assert.equal(await cell("try{await state.mediaRecoveryTab.observe();return false}catch{return true}"), true, "Released handle must refuse")
  const pages = await cell(`return await control.tabs(${q(browser)})`)
  assert.ok(pages.pages.some(page => page.targetId === original.tab && page.url === url + "/"), "The exact scratch tab must survive release")
  const reclaimed = await cell(`state.mediaRecoveryTab=await control.claimTab({browser:${q(browser)},tab:${q(original.tab)}});await state.mediaRecoveryTab.observe();return state.mediaRecoveryTab.target`)
  assert.equal(reclaimed.tab, original.tab)
  assert.notEqual(reclaimed.lease, original.lease)
  const second = `  Installed after reattach ${randomUUID()} é 🧪  `
  await cell(`state.mediaResumedRecording=await state.mediaRecoveryTab.record({directory:${q(root)},name:'After debugger reattach'});await state.mediaRecoveryTab.locator({role:'textbox',name:'Proof'}).setValue(${q(second)});await state.mediaRecoveryTab.locator({role:'button',name:'Verify proof'}).click();return await state.mediaRecoveryTab.expect({role:'textbox',name:'Proof',value:${q(second)}})`)
  await until(async () => saves.length, count => count === 2, "second exact save")
  assert.equal(saves[1].value, second)
  await delay(1500)
  await cell("return await state.mediaResumedRecording.stop()")
  const resumed = await settled("mediaResumedRecording")
  assert.equal(resumed.status, "finished", q(resumed))
  report.browserReattached = { original, reclaimed, saves, recording: await probe(resumed) }
  await cell("await state.mediaRecoveryTab.close();delete state.mediaRecoveryTab;return true")
  console.log("Installed browser: exact saves, debugger release/interrupted prefix, stale refusal, exact-tab reattach and resumed recording passed")
  }

  const title = `Installed native media ${randomUUID().slice(0,8)}`
  fixture = await startCocoaFixture({ root, title })
  const native = await fixture.started()
  sampler = sampleFrontmost(100)
  const windows = await cell(`return await control.windows(${native.pid})`)
  report.nativeWindows = windows
  const matches = windows.windows.filter(window => window.title === title)
  assert.equal(matches.length, 1, q(windows))
  const windowId = matches[0].window_id
  assert.ok(Number.isInteger(windowId), "Use the observed native window ID")
  const target = { pid: native.pid, window_id: windowId }
  report.nativeTarget = target
  const view = await cell(`state.mediaNative=control.window(${q(target)});return (await state.mediaNative.observe()).data`)
  report.nativeInitialView = view
  const proofFields = view.nodes.filter(node => node.name === "Proof")
  const verifyButtons = view.nodes.filter(node => node.name === "Verify proof")
  assert.equal(proofFields.length, 1, q(view))
  assert.equal(verifyButtons.length, 1, q(view))
  const proofSelector = { role: proofFields[0].role, name: "Proof" }
  const verifySelector = { role: verifyButtons[0].role, name: "Verify proof" }
  await cell(`state.mediaNativeRecording=await state.mediaNative.record({directory:${q(root)},name:'Installed native exact job',fps:60});return state.mediaNativeRecording`)
  const dist = process.argv.find(value => value.startsWith("--preview-dist="))?.slice(15)
  const conversation = process.argv.find(value => value.startsWith("--conversation="))?.slice(15)
  const resourceSamples = [], resourceStart = performance.now()
  if (dist) {
    assert.ok(conversation, "Native preview requires the exact conversation ID")
    const { startInstalledNativePreview } = await import("./lib/installed-native-preview.mjs")
    preview = await startInstalledNativePreview({ dist, root, conversation, socket: client.socket, target })
    void preview.done.catch(() => {})
    let pending = false
    resourcesTimer = setInterval(() => {
      if (pending) return
      pending = true
      void processResources({ installedHostTree: client.hostPid, taskSessionTree: client.sessionPid, nativeFixture: native.pid, nativeViewer: preview.pid })
        .then(value => { value.hostAndEncoder = value.installedHostTree.filter(row => row.pid === client.hostPid || row.executable.endsWith("/ffmpeg")); resourceSamples.push(value) })
        .catch(error => { report.resourceError = error.message })
        .finally(() => { pending = false })
    }, 500)
  }
  const jobs = []
  for (let index = 0; index < 6; index++) {
    const value = `  native-${index} é 🧪 ${randomUUID().slice(0,8)}  `
    const start = performance.now()
    const press = index === 5
      // This test owns the AppKit layout: button center (395,90) in window
      // coordinates including its title bar. Map through the actual screenshot.
      ? "const image=await state.mediaNative.screenshot();await artifacts.save('installed-native-pointer.png',image);const g=image.coordinates;await state.mediaNative.click({x:395*g.imageWidth/g.sourceWidth,y:90*g.imageHeight/g.sourceHeight,view:image.view});"
      : `await state.mediaNative.locator(${q(verifySelector)}).click();`
    await cell(`await state.mediaNative.locator(${q(proofSelector)}).setValue(${q(value)});${press}return (await state.mediaNative.observe()).get(${q(proofSelector)}).value`)
    const observed = await until(() => fixture.state(), result => result.value === value && result.input === value, "native exact result")
    jobs.push({ value: observed.value, verifiedMs: performance.now() - start })
  }
  // AppKit buttons can legitimately use AXPress even for a point click, which
  // emits no pointer event. A secondary click on this fixture's blank content
  // exercises real pointer delivery without inventing a cursor for semantic input.
  report.nativePointerDispatch = await cell("const image=await state.mediaNative.screenshot();const g=image.coordinates;const receipt=await state.mediaNative.click({x:450*g.imageWidth/g.sourceWidth,y:200*g.imageHeight/g.sourceHeight,view:image.view},{button:'right'});await state.mediaNative.observe();return receipt")
  assert.equal((await fixture.state()).value, jobs.at(-1).value, "Pointer fixture action must preserve the saved value")
  if (preview) {
    report.nativePreview = await preview.done
    clearInterval(resourcesTimer)
    assert.ok(resourceSamples.length && !report.resourceError, "Resource sampling must succeed")
    report.nativeResources = { boundary: "Active installed host includes other Mako work; driver is included in host tree, not hostAndEncoder", samples: resourceSamples, summary: summarizeProcessResources(resourceSamples, performance.now() - resourceStart) }
  }
  await cell("await artifacts.save('installed-native-recording.png',await state.mediaNative.screenshot());return await state.mediaNativeRecording.stop()")
  const nativeRecording = await settled("mediaNativeRecording")
  assert.equal(nativeRecording.status, "finished", q(nativeRecording))
  const timeline = JSON.parse(await readFile(nativeRecording.timeline, "utf8"))
  report.native = { jobs, recording: await probe(nativeRecording), pointerSamples: timeline.pointer.length }
  const seen = await sampler.stop(); sampler = undefined
  report.foregroundSamples = Object.fromEntries(seen)
  assert.ok(seen.size)
  assert.ok(!seen.has(native.pid), "Native fixture must not take foreground")
  assert.ok(timeline.pointer.length, "Native cursor dispatches must be retained")
  report.status = "passed"
  console.log("Installed native: six exact background jobs, screenshot, 60 fps request, cursor timeline and playable video passed")
} catch (error) {
  report.status = "failed"; report.error = error.message; process.exitCode = 1
  console.error(error)
} finally {
  await sampler?.stop()
  clearInterval(resourcesTimer)
  preview?.stop()
  // These names and targets belong only to this acceptance fixture.
  await cell("if(state.mediaRecoveryTab)await state.mediaRecoveryTab.close();if(state.mediaNativeRecording)await state.mediaNativeRecording.stop();return true").catch(error => { report.cleanupError = error.message })
  fixture?.stop()
  server.closeAllConnections()
  await new Promise(done => server.close(done))
  await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2) + "\n")
}
