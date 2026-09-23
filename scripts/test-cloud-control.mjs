// Runs inside the prepared runtime image, with this file mounted at /checks.
import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
const root = process.env.MAKO_RUNTIME_ROOT ?? "/opt/mako-control"
const require = createRequire(join(root, "package.json"))
const { Client } = require("@modelcontextprotocol/sdk/client/index.js")
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js")
const run = promisify(execFile)
const evidence = process.env.MAKO_RUNTIME_EVIDENCE ?? await mkdtemp("/tmp/mako-runtime-proof-")
await mkdir(evidence, { recursive: true })
const results = []
const active = new Set()
async function until(read, timeout = 45000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read().catch(() => undefined)
    if (value) return value
    await delay(40)
  }
  throw new Error("Acceptance deadline exceeded")
}
const read = async path => JSON.parse(await readFile(path, "utf8"))
async function alive(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8")
    return !/\) Z /.test(stat)
  } catch { return false }
}
async function groupProcesses(group) {
  const rows = await Promise.all((await readdir("/proc")).filter(name => /^\d+$/.test(name)).map(async name => {
    try {
      const stat = await readFile(`/proc/${name}/stat`, "utf8")
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      return fields[0] !== "Z" && Number(fields[2]) === group ? Number(name) : null
    } catch { return null }
  }))
  return rows.filter(pid => pid !== null)
}
async function start(name, options = {}) {
  const output = join(evidence, name)
  const path = join(evidence, `${name}.json`)
  await writeFile(path, JSON.stringify({ output, browser: { executable: "/usr/bin/chromium", sandbox: false }, startupMs: 15000, shutdownMs: 10000, ...options }))
  const child = spawn(process.execPath, [join(root, "dist-electron/cloud-control-main.js"), "--config", path], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MAKO_CREDENTIAL_CANARY: "must-not-reach-worker" } })
  active.add(child)
  const exited = new Promise(resolve => child.once("exit", (code, signal) => { active.delete(child); resolve({ code, signal }) }))
  let log = ""
  child.stderr.on("data", data => { log += data.toString() })
  const client = new Client({ name: "standalone-acceptance", version: "1" })
  const transport = new StdioServerTransport(child.stdout, child.stdin)
  const connecting = client.connect(transport).catch(error => { throw new Error(`${name}: ${error.message}: ${log}`) })
  // If startup fails the transport doesn't own the child; tell the client.
  child.once("exit", () => transport.onclose?.())
  await connecting
  const ready = await until(() => read(join(output, "ready.json")))
  async function cell(source, signal) {
    let reply = await client.callTool({ name: "mako_control_exec", arguments: { source } }, undefined, { timeout: 45000, signal })
    while (true) {
      const receipt = JSON.parse(reply.content.find(b => b.type === "text")?.text ?? "{}")
      if (receipt.status !== "running") break
      reply = await client.callTool({ name: "mako_control_exec", arguments: { cell: receipt.cell } }, undefined, { timeout: 45000, signal })
    }
    assert.ok(!reply.isError, JSON.stringify(reply))
    const images = reply.content.filter(b => b.type === "image")
    for (const [i, image] of images.entries()) await writeFile(join(output, `capture-${i}.png`), Buffer.from(image.data, "base64"))
    return JSON.parse(reply.content.filter(b => b.type === "text").at(-1)?.text ?? "null")
  }
  return { output, child, client, ready, cell, exited, async end(kind = "eof") {
    if (kind === "eof") child.stdin.end()
    else if (kind === "worker-crash") process.kill(ready.pid, "SIGKILL")
    else if (kind === "backend-crash") process.kill(ready.backends.find(b => b.name === "browser").pid, "SIGKILL")
    else if (kind === "driver-crash") process.kill(ready.backends.find(b => b.name === "driver").pid, "SIGKILL")
    else if (kind !== "none") child.kill(kind)
    const exit = await Promise.race([exited, delay(20000).then(() => { throw new Error(`${name}: launcher did not exit`) })])
    await until(async () => (await Promise.all([ready.pid, ...ready.backends.map(b => b.pid)].map(alive))).every(v => !v) && (await groupProcesses(ready.pid)).length === 0)
    await client.close()
    const worker = await read(join(output, "worker.json")).catch(() => null)
    const launcher = await read(join(output, "launcher.json")).catch(() => null)
    if (kind !== "SIGKILL") assert.ok(launcher.runtimeRemoved)
    results.push({ name, kind, exit, worker, launcher })
    return { worker, launcher, exit }
  } }
}
const html = 'data:text/html,' + encodeURIComponent(`<!doctype html><title>Cloud fixture</title><label>Name<input aria-label="Name"></label><button>Save</button><output>0</output><script>window.saves=0;document.querySelector('button').onclick=()=>{document.querySelector('output').textContent=++window.saves};setInterval(()=>document.body.style.backgroundColor=window.saves%2?'#f7f7f7':'#ffffff',100)</script>`)
async function form(job, value) {
  await job.cell(`state.tab=await control.openTab({disposition:'window',url:${JSON.stringify(html)}});await state.tab.locator({role:'textbox',name:'Name'}).setValue(${JSON.stringify(value)});await state.tab.locator({role:'button',name:'Save'}).click();return await state.tab.expect({role:'textbox',name:'Name',value:${JSON.stringify(value)}});`)
  assert.equal((await job.cell("return await state.tab.cdp('Runtime.evaluate',{expression:'window.saves'})")).result.value, 1)
  assert.equal((await job.cell("return await control.command({language:'shell',source:'test -z \"$MAKO_CREDENTIAL_CANARY\"'})")).result.exit_code, 0)
}
try {
  const a = await start("browser-a")
  const b = await start("browser-b")
  assert.deepEqual(a.ready.backends.map(b => b.name), ["browser"])
  await form(a, "東京 🧪 exact")
  await form(b, "untouched sibling")
  const oldTarget = await a.cell("return state.tab.target")
  await a.cell("state.recording=await state.tab.record({name:'Cloud cleanup'});return state.recording")
  await a.cell("await state.tab.locator({role:'button',name:'Save'}).click();emitImage(await state.tab.screenshot());")
  await delay(400)
  await a.end()
  const recordings = await readdir(join(a.output, "recordings"))
  const video = join(a.output, "recordings", recordings[0], "recording.mp4")
  const media = JSON.parse((await run("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", video])).stdout)
  assert.ok(Number(media.format.duration) > 0)
  assert.equal((await b.cell("return await state.tab.cdp('Runtime.evaluate',{expression:'window.saves'})")).result.value, 1)
  await assert.rejects(b.cell(`return await control.tab(${JSON.stringify(oldTarget)}).observe()`), /earlier browser connection|generation|stale/)
  await b.end("SIGTERM")
  for (const kind of ["worker-crash", "backend-crash", "SIGKILL"]) {
    const job = await start(kind)
    await form(job, kind)
    const result = await job.end(kind)
    if (kind !== "SIGKILL") assert.notEqual(result.exit.code, 0)
    else assert.equal(result.worker.reason, "launcher-disconnected")
  }
  const cancelled = await start("cancelled")
  await form(cancelled, "one write")
  const cancel = new AbortController()
  const waiting = cancelled.cell("await state.tab.cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Shift',code:'ShiftLeft',windowsVirtualKeyCode:16});return await state.tab.expect({role:'button',name:'Never exists'},{timeoutMs:55000});", cancel.signal).catch(() => null)
  await delay(250)
  cancel.abort()
  await waiting
  await cancelled.end("none")
  const deadline = await start("deadline", { timeoutMs: 2500 })
  const timed = await deadline.end("none")
  assert.equal(timed.exit.code, 124)
  const native = await start("native", { browser: undefined, native: { driver: join(root, "native/cua-driver") } })
  assert.ok(!native.ready.backends.some(b => b.name === "browser"))
  assert.ok((await native.cell("return await control.native('list_windows',{})")).windows)
  const nativeStatus = join(native.output, "fixture.json")
  await native.cell(`return await control.command({language:'shell',source:${JSON.stringify(`python3 /tmp/fixture.py 'Cloud native fixture' '${nativeStatus}' >'${native.output}/fixture.log' 2>&1 &`)}});`)
  const oracle = await until(() => read(nativeStatus))
  const windows = await until(async () => {
    const value = await native.cell(`return await control.windows(${oracle.pid})`)
    return value.windows.find(w => w.title === "Cloud native fixture")
  })
  await native.cell(`state.window=control.window({pid:${oracle.pid},window_id:${windows.window_id}});state.recording=await state.window.record({name:'Native cleanup'});return state.recording;`)
  for (let i = 0; i < 5; i++) {
    const value = `Native ${i}: 東京 🧪 é`
    await native.cell(`await state.window.locator({role:'TextArea',name:'Exact text'}).setValue(${JSON.stringify(value)});await state.window.locator({role:'TextArea',name:'Long text'}).setValue(${JSON.stringify(value + '\nsecond line')});await state.window.locator({role:'Button',name:'Save'}).click();return await state.window.expect({role:'TextArea',name:'Exact text',value:${JSON.stringify(value)}});`)
    const verified = await until(async () => { const current=await read(nativeStatus);return current.saves===i+1?current:undefined })
    assert.equal(verified.entry, value)
    assert.equal(verified.text, value + "\nsecond line")
  }
  await native.end()
  const nativeRecordings = await readdir(join(native.output, "recordings"))
  const nativeVideo = join(native.output,"recordings",nativeRecordings[0],"recording.mp4")
  assert.ok(Number(JSON.parse((await run("ffprobe",["-v","error","-show_format","-of","json",nativeVideo])).stdout).format.duration)>0)

  const mixed = await start("mixed", { native: { driver: join(root, "native/cua-driver") } })
  await form(mixed, "mixed services")
  assert.ok((await mixed.cell("return await control.native('list_windows',{})")).windows)
  await mixed.end("driver-crash")
  const delayedBrowser = join(evidence, "delayed-browser.mjs")
  const startupMarker = join(evidence, "startup-marker")
  await writeFile(delayedBrowser, "#!" + process.execPath + "\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(" + JSON.stringify(startupMarker) + ", 'ready'); setTimeout(() => {}, 60000);\n", { mode: 0o700 })
  for (const [name, executable, signal] of [["startup-failure", "/missing/chromium", null], ["startup-cancel", delayedBrowser, "SIGTERM"]]) {
    const output=join(evidence,name)
    const config=join(evidence,`${name}.json`)
    await writeFile(config,JSON.stringify({output,browser:{executable,sandbox:false},startupMs:2000,shutdownMs:2000}))
    const child=spawn(process.execPath,[join(root,"dist-electron/cloud-control-main.js"),"--config",config],{stdio:["pipe","ignore","ignore"]})
    const exit=new Promise(resolve=>child.once("exit",(code,signal)=>resolve({code,signal})))
    if(signal){await until(async()=>Boolean(await readFile(startupMarker,"utf8")), 2000);child.kill(signal)}
    const exited=await Promise.race([exit,delay(8000).then(()=>{child.kill("SIGKILL");throw new Error(`${name} did not stop`)})])
    const receipt=await read(join(output,"launcher.json"))
    assert.equal(receipt.runtimeRemoved,true)
    assert.equal(receipt.ready,false)
    assert.notEqual(exited.code,0)
    results.push({name,exit:exited,launcher:receipt})
  }
  // Existing output is a refusal, never permission to remove another job's files.
  await assert.rejects(run(process.execPath, [join(root, "dist-electron/cloud-control-main.js"), "--config", join(evidence, "browser-a.json")]), /EEXIST/)
  console.log(JSON.stringify({ passed: true, evidence, scenarios: results.length, video, duration: media.format.duration }))
} finally {
  for (const child of active) child.kill("SIGTERM")
  await writeFile(join(evidence, "results.json"), JSON.stringify(results, null, 2))
}
