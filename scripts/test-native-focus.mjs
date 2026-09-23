import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { ensureCuaEmbedded, stopCuaEmbedded } from "../dist-electron/cua-embedded.js"
import { resolveExecutable } from "../dist-electron/executable.js"

const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-native-focus-"))
const bundle = join(root, "Mako Focus Fixture.app")
const binary = join(bundle, "Contents/MacOS/fixture")
const status = join(root, "state.json")
await mkdir(join(bundle, "Contents/MacOS"), { recursive: true })
await exec("xcrun", ["swiftc", "-O", "scripts/lib/native-focus-fixture.swift", "-o", binary], { timeout: 180000 })
await writeFile(join(bundle, "Contents/Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleIdentifier</key><string>dev.mako.focus-fixture</string><key>CFBundleName</key><string>Mako Focus Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
await exec("codesign", ["--force", "--sign", "-", bundle])
const client = new Client({ name: "native-focus-regression", version: "1" })
const evidence = { passed: false, root, calls: [], trials: [] }
let pid
const read = async () => JSON.parse(await readFile(status, "utf8"))
async function until(fn) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const value = await fn().catch(() => null)
    if (value) return value
    await delay(25)
  }
  throw Error("Focus fixture did not reach expected state")
}
async function cell(source) {
  const start = performance.now()
  let response = await client.callTool({ name: "mako_control_exec", arguments: { source } }, undefined, { timeout: 70000 })
  for (;;) {
    const data = JSON.parse(response.content.find(item => item.type === "text").text)
    if (data.status !== "running") break
    response = await client.callTool({ name: "mako_control_exec", arguments: { cell: data.cell } }, undefined, { timeout: 70000 })
  }
  const result = JSON.parse(response.content.filter(item => item.type === "text").at(-1).text)
  evidence.calls.push({ source, result, milliseconds: performance.now() - start })
  if (response.isError || (result.code && result.outcome)) throw Error(JSON.stringify(result))
  return result
}
try {
  await exec("open", ["-n", "-g", bundle, "--args", status])
  const initial = await until(read)
  pid = initial.pid
  evidence.initial = initial
  assert.ok(initial.original > 0 && initial.original !== pid)
  const driver = resolveExecutable("cua-driver")
  evidence.driver = { path: driver, version: (await exec(driver, ["--version"])).stdout.trim() }
  const socket = await ensureCuaEmbedded(join(root, "driver"), "dev.mako.audit")
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("dist-electron/computer-tools-main.js"), "--driver", driver, "--socket", socket], env: { ...process.env }, stderr: "inherit" }))
  await cell(`state.window=control.window({pid:${pid},window_id:${initial.window}});return await state.window.observe();`)
  for (let index = 0; index < 3; index++) {
    const receipt = await cell("state.view=await state.window.observe();state.ref=state.view.nodes.find(n=>n.role==='Button' && n.name==='Attempt system activation').ref;return await state.window.click(state.ref);")
    const actual = await until(async () => { const state = await read(); return state.clicks === index + 1 ? state : null })
    evidence.trials.push({ receipt, actual })
    assert.ok(actual.events.some(event => event.pid === pid && event.clicks === index + 1), "Independent observer confirms the scratch app attempted activation")
    assert.ok(receipt.focus_change, "Public receipt retains even a restored focus interruption")
    assert.equal(receipt.focus_change.previous_pid, initial.original)
    assert.equal(receipt.focus_change.input_activity_observed, false, "Intervening input makes this trial inconclusive; do not override it")
    assert.equal(receipt.focus_change.restoration_attempted, true)
    assert.equal(receipt.focus_change.current_pid, initial.original)
    await until(async () => (await read()).frontmost === initial.original)
    const refused = await cell("try {await state.window.click(state.ref);return {refused:false};}catch(error){return {refused:true,code:error.code,message:error.message};}")
    assert.equal(refused.code, "observation-required", "An interrupted action cannot continue without a fresh observation")
    assert.equal((await read()).clicks, index + 1, "Refusal did not replay the action")
  }
  evidence.final = await read()
  evidence.passed = true
} catch (error) {
  evidence.error = error.message
  evidence.failureState = await read().catch(() => null)
  process.exitCode = 1
} finally {
  await client.close().catch(() => {})
  await stopCuaEmbedded()
  if (pid) {
    const command = await exec("ps", ["-p", String(pid), "-o", "command="]).catch(() => null)
    if (command?.stdout.includes(binary)) process.kill(pid, "SIGTERM")
  }
  await writeFile(join(root, "result.json"), JSON.stringify(evidence, null, 2) + "\n")
  console.log(JSON.stringify({ passed: evidence.passed, error: evidence.error, root }))
}
