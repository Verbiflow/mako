import { ControlCliProbe } from "../lib/control-cli-probe.mjs"
import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"

// Compositors without a trusted window/input adapter must still support exact
// AT-SPI form work, and must refuse raw input/capture rather than guess a target.
const evidence = { passed: false, compositor: process.env.MAKO_COMPOSITOR, calls: [], jobs: [] }
const client = new ControlCliProbe({ name: "portable-wayland-acceptance", version: "1" })
const read = async path => JSON.parse(await readFile(path, "utf8"))
async function until(fn) {
  const deadline = Date.now() + 15000
  do {
    const value = await fn().catch(() => null)
    if (value) return value
    await delay(50)
  } while (Date.now() < deadline)
  throw Error("Wayland fixture did not reach the expected state")
}
async function cell(source) {
  const start = performance.now()
  let response = await client.request({method:"exec",arguments:{ source }}, { timeout: 70000 })
  
  assert.equal(response.content.some(item => item.type === "image"), false, "Form work does not produce screenshots")
  const result = JSON.parse(response.content.filter(item => item.type === "text").at(-1).text)
  evidence.calls.push({ source, result, milliseconds: performance.now() - start })
  if (response.isError || (result.code && result.outcome)) throw Error(JSON.stringify(result))
  return result
}
try {
  const exec = promisify(execFile)
  const digest = async path => createHash("sha256").update(await readFile(path)).digest("hex")
  evidence.runtime = {
    arch: process.arch,
    compositor: (await exec(process.env.MAKO_COMPOSITOR, ["--version"])).stdout.trim(),
    driver: (await exec("/driver/cua-driver", ["--version"])).stdout.trim(),
    driverSha256: await digest("/driver/cua-driver"),
    hostSha256: await digest("/repo/packages/control-runtime/dist/desktop-session-worker.js"),
    probeSha256: await digest(new URL(import.meta.url)),
  }
  const initial = await until(async () => {
    const target = await read("/tmp/target.json")
    const cover = await read("/tmp/user.json")
    return !target.active && cover.active ? { target, cover } : null
  })
  const { target } = initial
  evidence.initial = initial
  await client.start({native:{driver:"/driver/cua-driver",socket:"/tmp/mako-driver.sock"},env:{ ...process.env }})
  evidence.windows = await cell(`return await control.windows(${target.pid});`)
  const windows = evidence.windows.windows ?? evidence.windows
  assert.equal(windows.length, 1, "The pid-scoped target identifies exactly one fixture window")
  const window = windows[0]
  assert.equal(window.pid, target.pid)
  assert.match(window.title, /^Mako target(?: \[fixture\.py\])?$/)
  await cell(`state.window=control.window({pid:${target.pid},window_id:${JSON.stringify(window.window_id ?? window.id)}});return await state.window.observe();`)
  evidence.shallow = await cell("const view=await state.window.observe({maxDepth:1,max:250});return {scope:view.data.scope,coverage:view.coverage,depths:view.nodes.map(node=>node.depth)};")
  assert.equal(evidence.shallow.scope.maxDepth, 1)
  assert.equal(evidence.shallow.coverage.complete, false, "Omitted descendants cannot establish absence")
  assert.ok(evidence.shallow.depths.length > 0 && evidence.shallow.depths.every(depth=>depth<=1))
  for (let index = 0; index < 20; index++) {
    const text = `Background ${index}: 日本語 🧪 é\nExact form values stay in their own process.`
    await cell(`await state.window.locator({role:'TextArea',name:'Exact text'}).setValue(${JSON.stringify(String(index))});await state.window.locator({role:'TextArea',name:'Long text'}).setValue(${JSON.stringify(text)});return await state.window.locator({role:'Button',name:'Save'}).click();`)
    const actual = await until(async () => { const value = await read("/tmp/target.json"); return value.saves === index + 1 ? value : null })
    const cover = await read("/tmp/user.json")
    assert.equal(actual.entry, String(index))
    assert.equal(actual.text, text)
    assert.equal(actual.active, false)
    assert.equal(cover.active, true)
    assert.deepEqual(actual.focus_changes, initial.target.focus_changes, "No target activation notification during background work")
    assert.deepEqual(cover.focus_changes, initial.cover.focus_changes, "No cover deactivation notification during background work")
    assert.equal(cover.saves, 0)
    assert.equal(cover.entry, "")
    assert.equal(cover.text, "")
    evidence.jobs.push({ index, actual, cover })
  }
  evidence.raw = await cell("try {await state.window.raw('type_text',{text:'must not reach either window',delivery_mode:'foreground',foreground:true});return {refused:false};}catch(error){return {refused:true,message:error.message};}")
  assert.equal(evidence.raw.refused, true)
  evidence.capture = await cell("try {await state.window.screenshot();return {refused:false};}catch(error){return {refused:true,message:error.message};}")
  assert.equal(evidence.capture.refused, true, "Unverified window geometry cannot authorize desktop capture")
  evidence.final = { target: await read("/tmp/target.json"), cover: await read("/tmp/user.json") }
  assert.deepEqual(evidence.final.target, evidence.jobs.at(-1).actual)
  assert.deepEqual(evidence.final.cover, evidence.jobs.at(-1).cover)
  evidence.passed = true
} catch (error) {
  evidence.error = error.message
  process.exitCode = 1
} finally {
  await client.close().catch(() => {})
  await writeFile("/tmp/portable-wayland-evidence.json", JSON.stringify(evidence, null, 2) + "\n")
  console.log(JSON.stringify({ passed: evidence.passed, jobs: evidence.jobs.length, error: evidence.error }))
}
