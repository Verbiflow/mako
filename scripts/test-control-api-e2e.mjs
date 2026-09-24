import { ControlCliProbe } from "./lib/control-cli-probe.mjs"
import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { resolveExecutable } from "../dist-electron/executable.js"
import {
  ensureCuaEmbedded,
  stopCuaEmbedded,
} from "../dist-electron/cua-embedded.js"
import { BrowserService } from "../packages/control-runtime/dist/browser-service.js"
import { startControlService } from "../dist-electron/control-service.js"
import { cocoaFixtureSource } from "./lib/cocoa-fixture.mjs"
import {
  frontmostPid,
  sampleFrontmost,
  startElectronFixture,
} from "./lib/control-fixture.mjs"

// Exercise only the public API. Fixture files supply independent state oracles.
const root = await mkdtemp(join(tmpdir(), "mako-control-api-e2e-"))
const run = promisify(execFile)
const status = join(root, "native.json")
const swift = join(root, "fixture.swift")
const binary = join(root, "fixture")
await writeFile(swift, cocoaFixtureSource)
await run("xcrun", ["swiftc", "-O", "-o", binary, swift], { timeout: 180_000 })
const native = spawn(binary, [status], { stdio: "ignore" })
const page = await startElectronFixture({
  root,
  name: "page",
  title: "Mako API page fixture",
  policy: "prohibited",
  form: true,
  start: false,
})
// Repeated labels and a controlled field that rejects intermediate emptiness.
await writeFile(
  page.html,
  (await readFile(page.html, "utf8")) +
    `
<script>window.inputLog=[];</script>
<form aria-label="Shipping" onsubmit="event.preventDefault();document.getElementById('result').textContent=JSON.stringify({shipping:document.getElementById('shipping').value,billing:document.getElementById('billing').value,events:window.inputLog})">
<label>Email <input id="shipping" aria-label="Email" value="old" oninput="window.inputLog.push(this.value);if(!this.value)this.value='old'"></label><button>Save</button></form>
<form aria-label="Billing" onsubmit="event.preventDefault()"><label>Email <input id="billing" aria-label="Email" value="untouched"></label><button>Save</button></form>`
)
const client = new ControlCliProbe({ name: "control-api-e2e", version: "2" })
const service = await startControlService(new BrowserService([]), () => {})
let pagePid
let samples
const evidence = { status: "running", cells: [] }
const read = async (path) => JSON.parse(await readFile(path, "utf8"))
async function until(fn) {
  const end = Date.now() + 10_000
  while (Date.now() < end) {
    try {
      const value = await fn()
      if (value) return value
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Fixture state did not match before deadline")
}
async function cell(source, image = false) {
  const started = performance.now()
  let result = await client.request({method:"exec",arguments:{ source }}, { timeout: 70_000 })
  // Collect the runtime's text receipt without replaying source.
  
  assert.ok(!result.isError, JSON.stringify(result))
  if (image) {
    assert.ok(
      result.content.some((block) => block.type === "text" && JSON.parse(block.text).artifact === true),
      "explicit image emission writes a file artifact"
    )
    assert.ok(
      result.content.some(
        (block) => block.type === "text" && block.text.includes('"view"')
      ),
      "image preserves its coordinate view token"
    )
  }
  evidence.cells.push({
    milliseconds: Math.round(performance.now() - started),
    bytes: Buffer.byteLength(JSON.stringify(result.content)),
    image,
  })
  return JSON.parse(
    result.content.filter((block) => block.type === "text").at(-1).text
  )
}
try {
  const nativeState = await until(() => read(status))
  const socket = await ensureCuaEmbedded(join(root, "driver"), "dev.mako.audit")
  assert.ok(socket)
  const credentials = service.mint("control-api-e2e", "binding")
  await client.start({native:{driver:resolveExecutable("cua-driver"),socket:socket},browser:{url:credentials.url,token:credentials.token},env:{
        ...process.env,
        MAKO_CONTROL_URL: credentials.url,
        MAKO_CONTROL_TOKEN: credentials.token,
        MAKO_TASK_ID: "api-e2e",
      }})
  const fullHelp = await client.request({method:"help",arguments:{}})
  const focusedHelp = await client.request({method:"help",arguments:{ topic: "actions" }})
  const fullBytes = Buffer.byteLength(JSON.stringify(fullHelp))
  const focusedBytes = Buffer.byteLength(JSON.stringify(focusedHelp))
  assert.ok(
    focusedBytes < fullBytes / 2,
    "Focused help avoids resending unrelated API sections"
  )
  evidence.help = { fullBytes, focusedBytes }
  const baseline = await frontmostPid()
  samples = sampleFrontmost()
  const nativeProof =
    await cell(`const windows=await control.app({pid:${nativeState.pid}}).windows();
const selected=windows.windows.find(w=>w.title==='Mako cocoa fixture'); if(!selected) throw new Error('Fixture window missing');
state.window=control.window({pid:${nativeState.pid},window_id:selected.window_id});
state.nativeCapabilities=await state.window.capabilities();
const view=await state.window.observe(); const receipt=await state.window.setValue(view.get({role:'TextField',name:'Proof'}).ref,'native-v2');
return {receipt,proof:await state.window.expect({role:'TextField',name:'Proof',value:'native-v2'})};`)
  assert.equal(nativeProof.receipt.verification, "not-requested")
  assert.equal(nativeProof.proof.status, "matched")
  await until(async () => (await read(status)).input === "native-v2")
  if (process.argv.includes("--recording")) {
    await cell(
      `state.recording=await state.window.record({directory:${JSON.stringify(root)},name:'Native exact-value job',maxDurationMs:30000});return state.recording;`
    )
    await cell(
      `const image=await state.window.screenshot();await state.window.click({x:30,y:70,view:image.view});return true;`
    )
  }
  await cell(
    `const view=await state.window.observe(); await state.window.click(view.get({role:'Button',name:'Verify proof'}).ref); emitImage(await state.window.screenshot()); return true;`,
    true
  )
  await until(async () => (await read(status)).value === "native-v2")
  for (const value of ["", "  ", "  東京 🐟  ", "00123", "\tline\n"]) {
    const exact = await cell(`const view=await state.window.observe();
await state.window.setValue(view.get({role:'TextField',name:'Proof'}).ref,${JSON.stringify(value)});
const proof=await state.window.expect({role:'TextField',name:'Proof',value:${JSON.stringify(value)}});
let negative=false;try {await state.window.expect({role:'TextField',name:'Proof',value:${JSON.stringify(value + " ")}},{timeoutMs:0})} catch {negative=true}
return {proof,negative};`)
    assert.equal(exact.proof.evidence.value, value)
    assert.equal(exact.negative, true)
    await until(async () => (await read(status)).input === value)
  }
  if (process.argv.includes("--recording")) {
    await cell("return await state.recording.stop()")
    let recording
    const deadline = Date.now() + 120_000
    do {
      recording = await cell("return await state.recording.status()")
      if (recording.status !== "finalizing") break
      await new Promise((resolve) => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    assert.equal(recording.status, "finished", recording.error)
    const probe = JSON.parse(
      (
        await run("ffprobe", [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          recording.video,
        ])
      ).stdout
    )
    const timeline = await read(recording.timeline)
    assert.ok(
      timeline.pointer.length > 0,
      "native pointer dispatch reaches the video timeline"
    )
    assert.ok(Number(probe.format.duration) > 0)
    assert.equal(probe.streams[0].codec_name, "h264")
    await run("ffmpeg", [
      "-v",
      "error",
      "-sseof",
      "-0.5",
      "-i",
      recording.video,
      "-frames:v",
      "1",
      join(recording.directory, "decoded.png"),
    ])
    evidence.recording = { ...recording, probe, pointer: timeline.pointer }
  }
  const launched = await cell(
    `return await control.native('launch_app',{app_path:${JSON.stringify(resolve("node_modules/electron/dist/Electron.app"))},additional_arguments:[${JSON.stringify(page.main)}],page_route:true});`
  )
  pagePid = launched.pid
  const browser = JSON.stringify(launched.page_route.browser)
  const webWindow = launched.windows.find(
    (window) => window.title === "Mako API page fixture"
  )
  assert.ok(webWindow)
  const guarded = await cell(
    `const window=control.window({pid:${pagePid},window_id:${webWindow.window_id}}); const view=await window.observe(); const field=view.get({role:'TextField',name:'Proof'}); try {await window.setValue(field.ref,'must-not-write'); return {refused:false,node:field}} catch(e) {return {refused:true,code:e.code,outcome:e.outcome,inputRoute:field.inputRoute}}`
  )
  assert.deepEqual(guarded, {
    refused: true,
    code: "page-input-required",
    outcome: "not-dispatched",
    inputRoute: "page",
  })
  assert.notEqual((await read(page.status)).input, "must-not-write")
  const pageProof = await cell(
    `const tabs=await control.tabs(${browser}); const selected=tabs.pages.find(t=>t.selectable && /API page fixture/.test(t.title)); if(!selected) throw new Error('Fixture tab missing');
state.tab=await control.claimTab({browser:${browser},tab:selected.targetId}); const view=await state.tab.observe();
const receipt=await state.tab.setValue(view.get({role:'textbox',name:'Proof'}).ref,'page-v2');
const proof=await state.tab.expect({role:'textbox',name:'Proof',value:'page-v2'}); emitImage(await state.tab.screenshot({format:'png'})); return {receipt,proof};`,
    true
  )
  assert.equal(pageProof.receipt.verification, "not-requested")
  assert.equal(pageProof.proof.status, "matched")
  await until(async () => (await read(page.status)).input === "page-v2")
  await cell(
    `const view=await state.tab.observe(); await state.tab.click(view.get({role:'button',name:'Verify proof'}).ref); return await state.tab.observe();`
  )
  await until(async () => (await read(page.status)).value === "page-v2")
  // Use observed names and ancestry, with no app-specific selectors in the control program.
  const targeting = await cell(
    `const view=await state.tab.observe(); let ambiguous=false;try{view.get({role:'button',name:'Save'})}catch{ambiguous=true};return {ambiguous,billing:view.get({role:'textbox',name:'Email',within:[{role:'form',name:'Billing'}]}).value};`
  )
  assert.deepEqual(targeting, { ambiguous: true, billing: "untouched" })
  evidence.scoped = []
  for (const value of [
    "00123",
    "  東京 🐟  ",
    "long-" + "x".repeat(1300) + "-end",
  ]) {
    await cell(
      `const form=state.tab.locator({role:'form',name:'Shipping'});await form.locator({role:'textbox',name:'Email'}).setValue(${JSON.stringify(value)});const proof=await form.locator({role:'textbox',name:'Email'}).expect({value:${JSON.stringify(value)}});await form.locator({role:'button',name:'Save'}).click();return {matched:proof.status};`
    )
    const submitted = await until(async () => {
      const state = await read(page.status)
      try {
        const result = JSON.parse(state.value)
        return result.shipping === value && result
      } catch {
        return false
      }
    })
    assert.equal(
      submitted.billing,
      "untouched",
      "same-named sibling field is unchanged"
    )
    assert.ok(
      submitted.events.every((event) => event !== ""),
      "replacement never emits an intermediate empty input"
    )
    evidence.scoped.push({
      length: value.length,
      billingUnchanged: true,
      matched: true,
    })
  }
  for (const value of ["00123", "", "  spaced  ", "😀 end"]) {
    await cell(
      `const view=await state.tab.observe({match:{role:'textbox',name:'Proof'}});await state.tab.setValue(view.get({role:'textbox',name:'Proof'}).ref,${JSON.stringify(value)});return (await state.tab.expect({role:'textbox',name:'Proof',value:${JSON.stringify(value)}})).status;`
    )
    await until(async () => (await read(page.status)).input === value)
  }
  await cell("await state.tab.release(); return true")
  if (process.argv.includes("--recording")) {
    await cell(`state.failureRecording=await state.window.record({directory:${JSON.stringify(root)},name:'Closed native window',maxDurationMs:10000});return state.failureRecording;`)
    await new Promise(resolve=>setTimeout(resolve,500))
    native.kill("SIGTERM")
    let receipt
    for (let i=0;i<300;i++) {
      receipt=await cell("return await state.failureRecording.status()")
      if (!["recording","finalizing"].includes(receipt.status)) break
      await new Promise(resolve=>setTimeout(resolve,100))
    }
    assert.equal(receipt.status,"interrupted",receipt.error)
    assert.ok(receipt.video,"closed-window interruption retains finalized video")
    assert.match(receipt.error,/closed|owner|resized|ended/i)
    evidence.interruption=receipt
  }
  const seen = await samples.stop()
  samples = undefined
  assert.deepEqual(
    [...seen.keys()],
    [baseline],
    "Mako did not change the frontmost app"
  )
  evidence.status = "passed"
  evidence.native = {
    value: (await read(status)).value,
    screenshot: true,
    persistentHandle: true,
  }
  evidence.page = {
    value: (await read(page.status)).value,
    screenshot: true,
    persistentHandle: true,
  }
  evidence.frontmostUnchanged = true
  console.log(
    "PASS: public API native and page exact assertions, independent submitted values, persistent handles, explicit screenshots with view tokens, foreground unchanged"
  )
} catch (error) {
  evidence.status = "failed"
  evidence.error = error.message
  throw error
} finally {
  await samples?.stop()
  await client.close()
  service.close()
  stopCuaEmbedded()
  native.kill("SIGTERM")
  if (pagePid) {
    try {
      process.kill(pagePid, "SIGTERM")
    } catch {}
  }
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2)
  )
  console.log("Evidence:", root)
}
