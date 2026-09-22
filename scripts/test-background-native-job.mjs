import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { mkdtemp, readFile, writeFile, realpath } from "node:fs/promises"
import { join, resolve, dirname, delimiter } from "node:path"
import { promisify } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  ensureCuaEmbedded,
  stopCuaEmbedded,
} from "../dist-electron/cua-embedded.js"
import { frontmostPid, sampleFrontmost } from "./lib/control-fixture.mjs"

const driver = process.env.MAKO_TEST_DRIVER
assert.ok(driver, "Set MAKO_TEST_DRIVER to the exact candidate executable")
const root = await mkdtemp("/private/tmp/mako-native-job-")
const run = promisify(execFile)
if (!process.env.MAKO_TEST_NATIVE_FIXTURE)
  await run(
    "xcrun",
    [
      "swiftc",
      "-O",
      "scripts/lib/background-job-fixture.swift",
      "-o",
      join(root, "fixture"),
    ],
    { timeout: 180000 }
  )
const fixture = spawn(
  process.env.MAKO_TEST_NATIVE_FIXTURE ?? join(root, "fixture"),
  [root],
  { stdio: "ignore" }
)
const client = new Client({ name: "background-native-job", version: "1" })
const evidence = {
  driver,
  executable: await realpath(driver),
  version: (await run(driver, ["--version"])).stdout.trim(),
  rounds: [],
  refusals: [],
}
const read = async () =>
  JSON.parse(await readFile(join(root, "state.json"), "utf8"))
async function until(check) {
  const end = Date.now() + 8000
  while (Date.now() < end) {
    try {
      const value = await check()
      if (value) return value
    } catch {}
    await new Promise((r) => setTimeout(r, 40))
  }
  throw Error("Independent fixture condition timed out")
}
async function cell(source) {
  let result = await client.callTool(
    { name: "mako_control_exec", arguments: { source } },
    undefined,
    { timeout: 70000 }
  )
  for (;;) {
    let receipt
    try {
      receipt = JSON.parse(result.content.find((b) => b.type === "text")?.text)
    } catch {}
    if (receipt?.status !== "running") break
    result = await client.callTool(
      { name: "mako_control_exec", arguments: { cell: receipt.cell } },
      undefined,
      { timeout: 70000 }
    )
  }
  assert.ok(!result.isError, JSON.stringify(result))
  return JSON.parse(result.content.filter((b) => b.type === "text").at(-1).text)
}
let samples
try {
  const initial = await until(read)
  const socket = await ensureCuaEmbedded(
    join(root, "driver"),
    "dev.mako.background-job",
    { ...process.env, PATH: dirname(driver) + delimiter + process.env.PATH }
  )
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve("dist-electron/computer-tools-main.js"),
        "--driver",
        driver,
        "--socket",
        socket,
      ],
      env: process.env,
      stderr: "pipe",
    })
  )
  const baseline = await frontmostPid()
  samples = sampleFrontmost()
  await cell(
    `state.windows=${JSON.stringify(initial.forms.map((f) => ({ pid: initial.pid, window_id: f.window })))}.map(t=>control.window(t));return true`
  )
  for (let round = 0; round < 6; round++) {
    const index = round % 2,
      other = 1 - index,
      value = ["", "  ", "  東京 🐟  ", "00123", "\tline\n", "job-5-東京"][
        round
      ],
      before = await read()
    await cell(
      `const w=state.windows[${index}];let view=await w.observe();await w.setValue(view.get({role:'TextField',name:'Proof'}).ref,${JSON.stringify(value)});return await w.expect({role:'TextField',name:'Proof',value:${JSON.stringify(value)}})`
    )
    await until(async () => (await read()).forms[index].input === value)
    // Raw escape is intentional until public Command capability acceptance passes.
    await cell(
      `return await state.windows[${index}].raw('press_key',{key:'a',modifiers:['cmd'],force:true})`
    )
    await until(
      async () => (await read()).forms[index].selection === value.length
    )
    await cell(
      `return await state.windows[${index}].raw('press_key',{key:'x'})`
    )
    await until(async () => (await read()).forms[index].input === "x")
    await cell(
      `const w=state.windows[${index}];const view=await w.observe();await w.click(view.get({role:'Button',name:'Save'}).ref);return await w.observe()`
    )
    const after = await until(async () => {
      const s = await read()
      return s.forms[index].saved === "x" &&
        s.forms[index].saves === before.forms[index].saves + 1
        ? s
        : null
    })
    assert.equal(
      after.forms[other].input,
      before.forms[other].input,
      "Other window must not receive input"
    )
    assert.equal(
      after.forms[other].saves,
      before.forms[other].saves,
      "No duplicate or wrong-window save"
    )
    evidence.rounds.push({ round, index, after })
  }
  await writeFile(join(root, "scenario"), "popup")
  await until(async () => (await read()).popup.visible)
  const beforePopup = await read()
  const popupRefusal = await cell(
    `let error;try{await state.windows[0].raw('press_key',{key:'x'})}catch(e){error=e.message}return {error:error??null}`
  )
  const afterPopup = await read()
  evidence.popup = { before: beforePopup, after: afterPopup, ...popupRefusal }
  assert.ok(
    popupRefusal.error,
    "Parent-window input must refuse while a sheet owns its keyboard"
  )
  assert.equal(
    afterPopup.popup.input,
    beforePopup.popup.input,
    "A parent-targeted key must not type into its popup"
  )
  assert.deepEqual(
    afterPopup.forms.map((f) => f.input),
    beforePopup.forms.map((f) => f.input)
  )
  await writeFile(join(root, "scenario"), "dismiss-popup")
  await until(async () => !(await read()).popup.visible)
  for (const scenario of ["minimize", "hide", "close"]) {
    await writeFile(join(root, "scenario"), scenario)
    await until(async () => {
      const s = await read()
      return scenario === "minimize"
        ? s.forms[1].minimized
        : !s.forms[1].visible
    })
    const before = await read()
    const refusal = await cell(
      `let error;try{await state.windows[1].raw('press_key',{key:'x'})}catch(e){error=e.message}return {error:error??null}`
    )
    assert.ok(
      refusal.error,
      scenario + " must refuse inaccessible window input"
    )
    assert.deepEqual(
      (await read()).forms.map((f) => f.input),
      before.forms.map((f) => f.input)
    )
    evidence.refusals.push({ scenario, ...refusal })
    if (scenario !== "close") {
      await writeFile(
        join(root, "scenario"),
        scenario === "minimize" ? "restore" : "show"
      )
      await until(async () => {
        const s = await read()
        return s.forms[1].visible && !s.forms[1].minimized
      })
    }
  }
  const seen = await samples.stop()
  samples = null
  assert.ok(!seen.has(initial.pid), "Native job must never become foreground")
  assert.notEqual(
    await frontmostPid(),
    initial.pid,
    "Native fixture is not foreground at completion"
  )
  evidence.foreground = { baseline, seen: [...seen] }
  evidence.status = "passed"
  console.log(
    "PASS: six complete two-window native jobs, exact values, Command selection, real key replacement, one save each, inaccessible-window refusal, no sampled foreground takeover"
  )
} catch (error) {
  evidence.status = "failed"
  evidence.error = String(error)
  throw error
} finally {
  if (samples) await samples.stop()
  await client.close()
  stopCuaEmbedded()
  fixture.kill()
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2)
  )
  console.log("Evidence:", root)
}
