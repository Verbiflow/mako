// A modified key must keep its addressed field, even when a sibling owns focus.
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { parseArgs, promisify } from "node:util"
import { pathToFileURL } from "node:url"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { ControlCliProbe } from "./lib/control-cli-probe.mjs"
import { snapshotControlRuntime } from "./lib/control-runtime-snapshot.mjs"
const { values } = parseArgs({ options: { app: { type: "string" } } })
const archive = values.app
  ? resolve(values.app, "Contents/Resources/app.asar")
  : undefined
const hostRoot = archive
  ? join(archive, "dist-electron")
  : resolve("dist-electron")
const { ensureCuaEmbedded, stopCuaEmbedded } = await import(
  pathToFileURL(join(hostRoot, "cua-embedded.js")).href
)
const { environmentForExecutable, resolveExecutable } = await import(
  pathToFileURL(join(hostRoot, "executable.js")).href
)

const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-keyboard-target-"))
const evidence = { passed: false, root, calls: [] }
const client = new ControlCliProbe({ name: "native-keyboard-target" })
let fixture
const read = async () =>
  JSON.parse(await readFile(join(root, "state.json"), "utf8"))
async function until(predicate) {
  const deadline = Date.now() + 10000
  do {
    const value = await read().catch(() => null)
    if (value && predicate(value)) return value
    await delay(25)
  } while (Date.now() < deadline)
  throw new Error("Keyboard fixture did not reach the expected state")
}
async function cell(source) {
  const started = performance.now()
  const response = await client.request({
    method: "exec",
    arguments: { source },
  })
  assert.equal(
    response.content.some((block) => block.type === "image"),
    false
  )
  const result = JSON.parse(
    response.content.filter((block) => block.type === "text").at(-1).text
  )
  evidence.calls.push({
    source,
    result,
    elapsedMs: performance.now() - started,
  })
  assert.equal(response.isError, undefined, JSON.stringify(result))
  return result
}
try {
  const binary = join(root, "fixture")
  await run(
    "xcrun",
    [
      "swiftc",
      "-O",
      resolve("scripts/lib/native-settling-fixture.swift"),
      "-o",
      binary,
    ],
    { timeout: 180000 }
  )
  fixture = spawn(binary, [join(root, "state.json"), "--keyboard-routing"], {
    stdio: "ignore",
  })
  const initial = await until((value) => value.focusedField === "decoy")
  evidence.initial = initial
  assert.notEqual(initial.frontmostPid, initial.pid)
  const requested = process.env.MAKO_TEST_DRIVER
  if (requested) assert.ok(isAbsolute(requested))
  const driver = resolveExecutable(requested ?? "cua-driver")
  assert.ok(driver, "The requested native driver must exist; no fallback")
  const env = environmentForExecutable(driver, process.env)
  evidence.driver = (await run(driver, ["--version"])).stdout.trim()
  const requestedRuntime = archive
    ? join(archive, "node_modules/@mako/control-runtime/dist")
    : process.env.MAKO_TEST_RUNTIME
  if (requestedRuntime) assert.ok(isAbsolute(requestedRuntime))
  else await snapshotControlRuntime(root)
  const runtimeRoot =
    requestedRuntime ??
    join(
      root,
      "control-runtime-snapshot/node_modules/@mako/control-runtime/dist"
    )
  evidence.runtimeRoot = runtimeRoot
  if (archive)
    evidence.build = JSON.parse(
      await readFile(join(archive, "package.json"), "utf8")
    ).makoBuild
  const socket = await ensureCuaEmbedded(
    join(root, "driver"),
    "dev.mako.keyboard-target",
    env
  )
  await client.start({ native: { driver, socket }, env, runtimeRoot })
  await cell(
    `state.window=control.window({pid:${initial.pid},window_id:${initial.window}});return await state.window.observe()`
  )
  evidence.rounds = []
  for (let round = 0; round < 3; round++) {
    await cell(
      "return await state.window.locator({role:'TextArea',name:'Decoy text'}).pressKey('End')"
    )
    const before = await until((value) => value.focusedField === "decoy")
    const receipt = await cell(
      "return await state.window.locator({role:'TextArea',name:'Evidence text'}).pressKey('Left',{modifiers:['Shift']})"
    )
    assert.equal(receipt.status, "dispatched")
    const after = await until(
      (value) =>
        value.focusedField === "target" && value.selection.length === round + 1
    )
    assert.deepEqual(after.selection, {
      location: 5 - round,
      length: round + 1,
    })
    assert.deepEqual(
      after.decoy,
      before.decoy,
      "A modified key must not reach the previously focused sibling"
    )
    assert.equal(after.text, "abcdef")
    assert.equal(after.decoy.text, "leave this untouched")
    assert.deepEqual(after.foregroundEvents, initial.foregroundEvents)
    assert.equal(after.frontmostPid, initial.frontmostPid)
    evidence.rounds.push({ before, receipt, after })
  }
  evidence.final = await read()
  evidence.passed = true
} catch (error) {
  evidence.error = error.message
  evidence.final = await read().catch(() => null)
  process.exitCode = 1
} finally {
  await client.close().catch(() => {})
  await stopCuaEmbedded()
  fixture?.kill()
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n"
  )
  console.log(
    JSON.stringify({ passed: evidence.passed, root, error: evidence.error })
  )
}
