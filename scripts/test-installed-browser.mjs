import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { frontmostPid, sampleFrontmost } from "./lib/control-fixture.mjs"

const browser = process.argv[2]
assert.ok(browser, "Pass the exact installed extension browser ID")
const app = process.argv[3] ? resolve(process.argv[3]) : undefined
if (app) assert.equal(process.execPath, join(app, "Contents/MacOS/Mako"), "Run packaged acceptance with that candidate's Electron-as-Node")
const packageRoot = app ? join(app, "Contents/Resources/app.asar") : resolve(".")
const runtimeRoot = app ? join(packageRoot, "node_modules/@mako/control-runtime/dist") : join(packageRoot, "packages/control-runtime/dist")
const { BrowserService } = await import(pathToFileURL(join(runtimeRoot, "browser-service.js")).href)
const { extensionBrowsers } = await import(pathToFileURL(join(runtimeRoot, "browser-extension-registration.js")).href)
const { mediaExecutable } = await import(pathToFileURL(join(runtimeRoot, "control-media.js")).href)
const { startControlService } = await import(pathToFileURL(join(packageRoot, "dist-electron/control-service.js")).href)
const root = await mkdtemp(join(tmpdir(), "mako-installed-browser-"))
const evidence = { browser, root, packageRoot, jobs: [], status: "running" }
const saves = []
const page = createServer(async (request, response) => {
  if (request.url === "/save") {
    let bytes = ""
    for await (const chunk of request) bytes += chunk
    saves.push(JSON.parse(bytes))
    response.end("Saved")
    return
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8")
  response.end(`<!doctype html><title>Mako installed browser acceptance</title>
  <style>body{font:18px system-ui;padding:40px}form{padding:20px;border:1px solid #999;margin:20px}input,button{font:inherit}</style>
  <form aria-label="Shipping"><label>Email <input aria-label="Email" value="old"></label><button>Save</button><output></output></form>
  <form aria-label="Billing"><label>Email <input aria-label="Email" value="untouched"></label><button>Save</button></form>
  <script>document.forms[0].onsubmit=async e=>{e.preventDefault();if(!confirm('Save this scratch value?'))return;const value=document.forms[0].querySelector('input').value;const r=await fetch('/save',{method:'POST',body:JSON.stringify({value})});document.querySelector('output').textContent=await r.text()};document.forms[1].onsubmit=e=>e.preventDefault()</script>`)
})
await new Promise((done) => page.listen(0, "127.0.0.1", done))
const definitions = await extensionBrowsers()
assert.ok(definitions.some((entry) => entry.id === browser))
const service = new BrowserService(definitions, { preferencePath: join(root, "preferences.json") })
const host = await startControlService(service, () => {})
const credentials = host.mint("installed-browser-acceptance", "test")
const client = new Client({ name: "installed-browser-acceptance", version: "2" })
let samples
async function cell(source) {
  let result = await client.callTool({ name: "mako_control_exec", arguments: { source } }, undefined, { timeout: 70000 })
  for (;;) {
    const text = result.content.find((block) => block.type === "text")?.text
    let receipt
    try { receipt = JSON.parse(text) } catch {}
    if (receipt?.status !== "running") break
    result = await client.callTool({ name: "mako_control_exec", arguments: { cell: receipt.cell } }, undefined, { timeout: 70000 })
  }
  assert.ok(!result.isError, JSON.stringify(result))
  return JSON.parse(result.content.filter((block) => block.type === "text").at(-1).text)
}
try {
  await service.connect(browser)
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(runtimeRoot, "computer-tools-main.js")], env: { ...process.env, MAKO_CONTROL_URL: credentials.url, MAKO_CONTROL_TOKEN: credentials.token, MAKO_TASK_ID: "installed-browser-acceptance" }, stderr: "pipe" }))
  evidence.frontmostBefore = await frontmostPid()
  samples = sampleFrontmost()
  await cell(`state.tab=await control.openTab({browser:${JSON.stringify(browser)},url:${JSON.stringify(`http://127.0.0.1:${page.address().port}`)},background:true});return true`)
  await cell(`const view=await state.tab.observe();let ambiguous=false;try{view.get({role:'button',name:'Save'})}catch{ambiguous=true}if(!ambiguous)throw new Error('Ambiguous Save accepted');await state.tab.raw('dialog',{auto:'accept'});return true`)
  for (const phase of ["baseline", "recording"]) {
    if (phase === "recording") await cell(`state.recording=await state.tab.record({directory:${JSON.stringify(root)},name:'Installed browser complete jobs',maxDurationMs:120000});return state.recording`)
    for (let i = 0; i < 20; i++) {
      const value = `  ${phase}-${i}-東京-🐟-00123  `
      const started = performance.now()
      await cell(`const scope=[{role:'form',name:'Shipping'}];const view=await state.tab.observe({within:scope});await state.tab.setValue(view.get({role:'textbox',name:'Email'}).ref,${JSON.stringify(value)});await state.tab.expect({role:'textbox',name:'Email',within:scope,value:${JSON.stringify(value)}});const updated=await state.tab.observe({within:scope});await state.tab.click(updated.get({role:'button',name:'Save'}).ref);return true`)
      const deadline = Date.now() + 5000
      while (saves.length < evidence.jobs.length + 1 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25))
      assert.equal(saves.length, evidence.jobs.length + 1)
      assert.deepEqual(saves.at(-1), { value })
      evidence.jobs.push({ phase, ms: performance.now() - started })
    }
  }
  evidence.billing = await cell(`return (await state.tab.observe({within:[{role:'form',name:'Billing'}]})).get({role:'textbox',name:'Email'}).value`)
  assert.equal(evidence.billing, "untouched")
  await cell(`const image=await state.tab.screenshot({format:'png'});await artifacts.save('installed-browser.png',image);return true`)
  await cell(`return await state.recording.stop()`)
  let recording
  for (let i = 0; i < 300; i++) {
    recording = await cell(`return await state.recording.status()`)
    if (recording.status !== "finalizing" && recording.status !== "recording") break
    await new Promise((done) => setTimeout(done, 100))
  }
  assert.equal(recording.status, "finished", JSON.stringify(recording))
  const timeline = JSON.parse(await readFile(recording.timeline, "utf8"))
  assert.ok(timeline.pointer.some((point) => point.pressed))
  const { stdout } = await promisify(execFile)(mediaExecutable("ffprobe"), ["-v", "error", "-show_streams", "-show_format", "-of", "json", recording.video])
  const probe = JSON.parse(stdout)
  assert.equal(probe.streams[0].codec_name, "h264")
  assert.ok(Number(probe.format.duration) > 0)
  evidence.recording = { ...recording, pointerSamples: timeline.pointer.length, probe }
  await promisify(execFile)(mediaExecutable("ffmpeg"), ["-v", "error", "-sseof", "-0.5", "-i", recording.video, "-frames:v", "1", join(root, "decoded.png")])
  // Disconnect this test client while capture is active. The browser and its
  // other clients remain running; old handles must fail without replay.
  await cell(`state.interrupted=await state.tab.record({directory:${JSON.stringify(root)},name:'Interrupted installed job'});await state.tab.screenshot();return true`)
  await new Promise((done) => setTimeout(done, 300))
  service.disconnect(browser)
  const refused = await cell(`try{await state.tab.observe();return false}catch{return true}`)
  assert.equal(refused, true)
  for (let i = 0; i < 300; i++) {
    evidence.interrupted = await cell(`return await state.interrupted.status()`)
    if (!["recording", "finalizing"].includes(evidence.interrupted.status)) break
    await new Promise((done) => setTimeout(done, 100))
  }
  assert.equal(evidence.interrupted.status, "interrupted", JSON.stringify(evidence.interrupted))
  assert.ok(evidence.interrupted.video)
  await service.connect(browser)
  assert.equal(await cell(`try{await state.tab.observe();return false}catch{return true}`), true)
  // The extension closes this client's task tab after disconnect; do not claim
  // a replacement or close any tab belonging to the user's regular profile.
  await cell(`state.tab=await control.openTab({browser:${JSON.stringify(browser)},url:'about:blank',background:true});await state.tab.close();return true`)
  evidence.status = "passed"
} catch (error) {
  evidence.status = "failed"
  evidence.error = String(error.stack ?? error)
  throw error
} finally {
  if (samples) evidence.frontmostSamples = Object.fromEntries(await samples.stop())
  await client.close()
  host.close()
  await new Promise((done) => page.close(done))
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2))
  console.log(root)
}
