import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  ensureCuaEmbedded,
  stopCuaEmbedded,
} from "../dist-electron/cua-embedded.js"
import { resolveExecutable } from "../dist-electron/executable.js"
import { frontmostPid, sampleFrontmost } from "./lib/control-fixture.mjs"

// Run with the installed Mako executable and ELECTRON_RUN_AS_NODE=1. This
// creates only its own scratch Terminal window and never requests activation.
const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-native-terminal-"))
const directory = resolve(process.argv[2] ?? root)
await mkdir(directory, { recursive: true })
const client = new Client({ name: "native-terminal-acceptance", version: "1" })
const evidence = { status: "running", root, directory, cells: [] }
let scratchId
let terminalPid
let sampler
async function cell(source) {
  let result = await client.callTool(
    { name: "mako_control_exec", arguments: { source } },
    undefined,
    { timeout: 70000 }
  )
  for (;;) {
    const receipt = JSON.parse(
      result.content.find((part) => part.type === "text")?.text ?? "{}"
    )
    if (receipt.status !== "running") break
    result = await client.callTool(
      { name: "mako_control_exec", arguments: { cell: receipt.cell } },
      undefined,
      { timeout: 70000 }
    )
  }
  evidence.cells.push({ at: new Date().toISOString(), source, result })
  assert.ok(!result.isError, JSON.stringify(result))
  return JSON.parse(
    result.content.filter((part) => part.type === "text").at(-1).text
  )
}
async function script(source) {
  const reply = await cell(
    `return await control.command({language:'applescript',source:${JSON.stringify(source)}})`
  )
  assert.equal(reply.result.exit_code, 0, JSON.stringify(reply.result))
  return reply.result.stdout.trim()
}
try {
  evidence.frontmostBefore = await frontmostPid()
  sampler = sampleFrontmost()
  const driver = resolveExecutable("cua-driver")
  evidence.driver = (await run(driver, ["--version"])).stdout.trim()
  const socket = await ensureCuaEmbedded(
    join(root, "driver"),
    "dev.mako.native-terminal-acceptance"
  )
  assert.ok(socket)
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve("packages/control-runtime/dist/computer-tools-main.js"),
        "--driver",
        driver,
        "--socket",
        socket,
      ],
      env: { ...process.env },
      stderr: "inherit",
    })
  )
  const existing = await cell(
    "return (await control.apps()).apps.find(a=>a.bundle_id==='com.apple.Terminal') ?? null"
  )
  if (existing?.running) {
    terminalPid = existing.pid
  } else {
    const launch = await cell(
      "return await control.native('launch_app',{bundle_id:'com.apple.Terminal'})"
    )
    terminalPid = launch.pid
  }
  // Launch can restore user windows. Only this explicit new empty shell is ours.
  scratchId = Number(
    await script(
      'tell application "Terminal"\nset scratchTab to do script ""\nreturn id of window 1\nend tell'
    )
  )
  evidence.terminalPid = terminalPid
  assert.ok(Number.isSafeInteger(scratchId) && scratchId > 0)
  evidence.windowId = scratchId
  await cell(
    `state.freshTerminalSource=control.window({pid:${terminalPid},window_id:${scratchId}});return await state.freshTerminalSource.observe()`
  )
  const marker = `MAKO_SOURCE_TERMINAL_${scratchId}`
  const command = `echo '${marker}'`
  evidence.marker = marker
  evidence.typing = await cell(
    `return await state.freshTerminalSource.raw('type_text',{text:${JSON.stringify(command)},delivery_mode:'background'})`
  )
  evidence.beforeReturn = await script(
    `tell application "Terminal" to return contents of selected tab of window id ${scratchId}`
  )
  assert.ok(
    evidence.beforeReturn.includes(command),
    "Independent Terminal contents must show the full pending command"
  )
  evidence.windowsBeforeReturn = await cell(
    `return await control.windows(${terminalPid})`
  )
  evidence.returnReceipt = await cell(
    "return await state.freshTerminalSource.pressKey('return')"
  )
  evidence.afterReturn = await script(
    `tell application "Terminal" to return contents of selected tab of window id ${scratchId}`
  )
  assert.ok(
    evidence.afterReturn.split(/\r?\n/).includes(marker),
    "Marker must appear as actual output, not just command echo"
  )
  await cell(
    `await state.freshTerminalSource.screenshot({screenshot_out_file:${JSON.stringify(join(directory, "source-output.png"))}});return {captured:true}`
  )
  evidence.status = "passed"
} catch (error) {
  evidence.status = "failed"
  evidence.error = error.message
  process.exitCode = 1
} finally {
  if (scratchId) {
    try {
      evidence.cleanup = await script(
        `tell application "Terminal"\nif exists window id ${scratchId} then close window id ${scratchId} saving no\nreturn {visible of window id ${scratchId}, count of tabs of window id ${scratchId}}\nend tell`
      )
      assert.equal(
        evidence.cleanup,
        "false, 0",
        "Owned window must be invisible with zero tabs"
      )
    } catch (error) {
      evidence.cleanupError = error.message
      evidence.status = "failed"
      process.exitCode = 1
    }
  }
  await client.close().catch(() => {})
  await stopCuaEmbedded()
  evidence.frontmostAfter = await frontmostPid()
  if (sampler) evidence.focusSamples = Object.fromEntries(await sampler.stop())
  if (terminalPid && evidence.focusSamples?.[terminalPid]) {
    evidence.status = "failed"
    evidence.focusError = "Terminal became frontmost during the sampled trial"
    process.exitCode = 1
  }
  await writeFile(
    join(directory, "source-evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n"
  )
  console.log(
    JSON.stringify({
      status: evidence.status,
      directory,
      error: evidence.error,
      cleanupError: evidence.cleanupError,
      focusSamples: evidence.focusSamples,
    })
  )
}
