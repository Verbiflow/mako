import { ControlCliProbe } from "../lib/control-cli-probe.mjs"
import { exerciseGestures } from "./wayland-gestures.mjs"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
const sharp = createRequire(import.meta.url)("sharp")
import { readFile, writeFile, stat } from "node:fs/promises"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
const exec = promisify(execFile)
let cover
const client = new ControlCliProbe({ name: "wayland-acceptance", version: "1" })
const evidence = { passed: false, calls: [] }
async function readState() { return JSON.parse(await readFile("/tmp/wayland-target.json", "utf8")) }
async function until(fn) {
  const deadline = Date.now() + 15000
  do { const value = await fn().catch(() => null); if (value) return value; await delay(100) } while (Date.now() < deadline)
  throw new Error("Wayland fixture did not become ready")
}
async function cell(source) {
  const start = performance.now()
  let response = await client.request({method:"exec",arguments:{ source }}, { timeout: 70000 })
  
  const result = JSON.parse(response.content.filter(item => item.type === "text").at(-1).text)
  evidence.calls.push({ source, result, milliseconds: performance.now() - start })
  if (response.isError || (result.code && result.outcome)) throw Error(JSON.stringify(result))
  return result
}
try {
  const target = await until(readState)
  await until(() => stat("/tmp/mako-driver.sock").then(value => value.isSocket()))
  await client.start({native:{driver:process.env.MAKO_RECORDING_DRIVER,socket:"/tmp/mako-driver.sock"},env:{ ...process.env }})
  const windows = await cell(`return await control.windows(${target.pid});`)
  evidence.windows = windows
  const window = windows.windows?.find(item => item.title.startsWith("Mako Wayland target")) ?? windows.find?.(item => item.title.startsWith("Mako Wayland target"))
  assert.ok(window, "Compositor identifies the exact native Wayland window")
  await cell(`state.target={pid:${target.pid},window_id:${JSON.stringify(window.window_id ?? window.id)}};state.window=control.window(state.target);state.view=await state.window.observe();return state.view;`)
  const value = "Wayland exact — 日本語 🧪 é"
  await cell(`return await state.window.locator({role:'TextArea',name:'Exact text'}).setValue(${JSON.stringify(value)});`)
  evidence.afterValue = await until(async () => { const state = await readState(); return state.text === value ? state : null })
  assert.ok(evidence.afterValue.width <= window.bounds.width && evidence.afterValue.height <= window.bounds.height, "GTK fixture fits inside the compositor window; its far-corner marker must not be clipped")
  evidence.visibleCapture = await cell("try {const image=await state.window.screenshot({screenshot_out_file:'/tmp/wayland-visible.png'});return {status:'captured',keys:Object.keys(image)};} catch(error) {return {status:'refused',message:error.message};}")
  assert.equal(evidence.visibleCapture.status, "captured")
  const metadata = await sharp("/tmp/wayland-visible.png").metadata()
  assert.equal(metadata.width, window.bounds.width)
  assert.equal(metadata.height, window.bounds.height)
  const corner = await sharp("/tmp/wayland-visible.png").extract({left:metadata.width-35,top:metadata.height-35,width:1,height:1}).removeAlpha().raw().toBuffer()
  evidence.corner = [...corner]
  assert.deepEqual(evidence.corner, [224,88,69], "Screenshot preserves the actual far corner at the action scale")
  evidence.gestures = await exerciseGestures({cell, readState, until});
  await exec("swaymsg", [`[con_id=${window.window_id ?? window.id}] move container to workspace 2`])
  cover = spawn("python3", ["/repo/scripts/linux-control/recording-fixture.py", "Human work", "/tmp/wayland-cover.json", "ba3084"], { stdio: "ignore" })
  const coverState = await until(async () => JSON.parse(await readFile("/tmp/wayland-cover.json", "utf8")))
  evidence.hiddenJobs = []
  for (let index = 0; index < 10; index++) {
    const text = `Hidden Wayland ${index} — 日本語 🧪 é`
    await cell(`return await state.window.locator({role:'TextArea',name:'Exact text'}).setValue(${JSON.stringify(text)});`)
    const actual = await until(async () => { const state = await readState(); return state.text === text ? state : null })
    const tree = JSON.parse((await exec("swaymsg", ["-r", "-t", "get_tree"])).stdout)
    const flatten = node => [node, ...(node.nodes ?? []).flatMap(flatten), ...(node.floating_nodes ?? []).flatMap(flatten)]
    const targetNode = flatten(tree).find(node => node.pid === target.pid)
    const foreground = flatten(tree).find(node => node.pid === coverState.pid)
    assert.equal(targetNode.visible, false, "Target stays on its hidden workspace")
    assert.equal(foreground.focused, true, "Human window retains compositor focus")
    evidence.hiddenJobs.push({ text: actual.text, targetVisible: targetNode.visible, coverFocused: foreground.focused })
  }
  evidence.hiddenCapture = await cell("try {await state.window.screenshot();return {status:'captured'};} catch(error) {return {status:'refused',message:error.message};}")
  assert.equal(evidence.hiddenCapture.status, "refused", "Hidden window capture must not return unrelated desktop pixels")
  assert.match(evidence.hiddenCapture.message, /capture|visible|window|scope/i)
  evidence.recording = await cell("try {state.recording=await state.window.record({directory:'/tmp/wayland-recording'});await state.recording.stop();return {status:'started'};} catch(error) {return {status:'refused',message:error.message};}")
  assert.equal(evidence.recording.status, "refused", "Unsupported exact-window recording refuses before desktop capture")
  evidence.compositor = JSON.parse((await exec("swaymsg", ["-r", "-t", "get_tree"])).stdout)
  evidence.passed = true
} catch (error) {
  evidence.error = error.message
  evidence.failureState = await readState().catch(() => null)
  evidence.failureOutputs = await readFile("/tmp/outputs.json", "utf8").then(JSON.parse).catch(() => null)
  process.exitCode = 1
}
finally {
  await client.close().catch(() => {})
  cover?.kill()
  await writeFile("/tmp/wayland-evidence.json", JSON.stringify(evidence, null, 2) + "\n")
  console.log(JSON.stringify({passed:evidence.passed,error:evidence.error,hiddenJobs:evidence.hiddenJobs?.length}))
}
