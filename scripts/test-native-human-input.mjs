import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, writeFile, mkdir, cp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { ensureCuaEmbedded, stopCuaEmbedded } from "../dist-electron/cua-embedded.js"
import { resolveExecutable } from "../dist-electron/executable.js"

// Interactive acceptance: the runner NEVER writes to the human's text field.
// A timeout is incomplete evidence, not a pass. Only scratch processes are stopped.
const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-human-input-"))
const evidence = { status: "preparing", root, jobs: [] }
const processes = []
const fixturePids = []
const client = new Client({ name: "physical-input-acceptance", version: "1" })
const read = async name => JSON.parse(await readFile(join(root, name + ".json"), "utf8"))
async function until(fn, timeout = 10000) {
  const end = Date.now() + timeout
  do { const result = await fn().catch(() => null); if (result) return result; await delay(50) } while (Date.now() < end)
  throw Error("Timed out waiting for scratch fixture")
}
async function cell(source) {
  let output = await client.callTool({ name: "mako_control_exec", arguments: { source } }, undefined, { timeout: 70000 })
  for (;;) {
    const receipt = JSON.parse(output.content.find(block => block.type === "text")?.text ?? "{}")
    if (receipt.status !== "running") break
    output = await client.callTool({ name: "mako_control_exec", arguments: { cell: receipt.cell } }, undefined, { timeout: 70000 })
  }
  const result = JSON.parse(output.content.filter(block => block.type === "text").at(-1).text)
  if (output.isError || (result.code && result.outcome)) throw Error(JSON.stringify(result))
  return result
}
try {
  for (const [name, source] of [["target", "native-settling-fixture.swift"], ["human", "native-human-input-fixture.swift"]]) {
    await run("xcrun", ["swiftc", "-O", "-o", join(root, name), resolve("scripts/lib", source)], { timeout: 180000 })
    if (name === "human") {
      const bundle = join(root, "Mako Human Typing.app")
      await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true })
      await cp(join(root, name), join(bundle, "Contents", "MacOS", "fixture"))
      await writeFile(join(bundle, "Contents", "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleIdentifier</key><string>dev.mako.human-input-fixture</string><key>CFBundleName</key><string>Mako Human Typing</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
      await run("codesign", ["--force", "--sign", "-", bundle])
      processes.push(spawn("open", ["-n", "-g", bundle, "--args", join(root, name + ".json")], { stdio: "ignore" }))
    } else processes.push(spawn(join(root, name), [join(root, name + ".json")], { stdio: "ignore" }))
    fixturePids.push((await until(() => read(name))).pid)
  }
  const target = await read("target")
  const driver = resolveExecutable("cua-driver")
  evidence.driver = (await run(driver, ["--version"])).stdout.trim()
  const socket = await ensureCuaEmbedded(join(root, "driver"), "dev.mako.human-input")
  assert.ok(socket)
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve("packages/control-runtime/dist/computer-tools-main.js"), "--driver", driver, "--socket", socket], env: { ...process.env }, stderr: "inherit" }))
  await cell(`state.window=control.window({pid:${target.pid},window_id:${target.window}});return await state.window.observe();`)
  evidence.status = "waiting-for-human"
  console.log(JSON.stringify({ status: evidence.status, root }))
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2))
  await until(async () => (await read("human")).phase === "running", 15 * 60 * 1000)
  evidence.status = "running"
  const deadline = Date.now() + 120000
  while ((await read("human")).phase === "running" && Date.now() < deadline) {
    const value = `Agent only ${evidence.jobs.length} — 東京 🧪 é`
    const startedAt = Date.now() / 1000
    await cell(`return await state.window.locator({role:'TextArea',name:'Evidence text'}).setValue(${JSON.stringify(value)});`)
    await cell("return await state.window.locator({role:'Button',name:'Save fixture'}).click();")
    const actual = await until(async () => { const state = await read("target"); return state.saved === value ? state : null })
    evidence.jobs.push({ startedAt, finishedAt: Date.now() / 1000, value: actual.text, saved: actual.saved })
    await delay(200)
  }
  evidence.human = await read("human")
  const human = evidence.human
  assert.equal(human.phase, "finished", "Human must finish the physical test")
  assert.equal(human.text.trim(), "日本語の入力テストです。\nHuman typing stays here 12345.")
  assert.equal(human.marked, false, "Composition must be committed")
  assert.ok(human.events.some(event => event.kind === "composition"), "Actual IME marked-text delivery is required")
  const overlapping = human.events.filter(event => event.kind === "keyDown" && evidence.jobs.some(job => event.at >= job.startedAt && event.at <= job.finishedAt))
  assert.ok(overlapping.length >= 5, "At least five human keydowns must overlap background operations")
  assert.ok(evidence.jobs.length >= 5, "At least five complete background writes and saves")
  const lost = human.foreground.filter(event => event.at >= human.startedAt && event.at <= human.finishedAt && event.pid !== human.pid)
  assert.deepEqual(lost, [], "Human scratch window must retain foreground throughout the test")
  evidence.overlappingKeydowns = overlapping.length
  evidence.status = "passed-awaiting-human-attestation"
} catch (error) { evidence.status = "incomplete-or-failed"; evidence.error = error.message; process.exitCode = 1 }
finally {
  await client.close().catch(() => {})
  await stopCuaEmbedded()
  for (const child of processes) child.kill()
  for (const pid of fixturePids) { try { process.kill(pid, "SIGTERM") } catch {} }
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n")
  console.log(JSON.stringify({ status: evidence.status, root, error: evidence.error, jobs: evidence.jobs.length }))
}
