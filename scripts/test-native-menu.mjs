import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { ControlCliProbe } from "./lib/control-cli-probe.mjs"
import { snapshotControlRuntime } from "./lib/control-runtime-snapshot.mjs"

assert.ok(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === "--app"), "Use --app <exact bundle>, running its executable with ELECTRON_RUN_AS_NODE=1")
const archive = process.argv[3] ? resolve(process.argv[3], "Contents/Resources/app.asar") : undefined
const hostRoot = archive ? join(archive, "dist-electron") : resolve("dist-electron")
const { ensureCuaEmbedded, stopCuaEmbedded } = await import(pathToFileURL(join(hostRoot, "cua-embedded.js")).href)
const { environmentForExecutable, resolveExecutable } = await import(pathToFileURL(join(hostRoot, "executable.js")).href)

const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-native-menu-"))
const client = new ControlCliProbe({ name: "native-menu-acceptance" })
const evidence = { passed: false, root, calls: [] }
let fixture
const read = async () => JSON.parse(await readFile(join(root, "state.json"), "utf8"))
async function until(fn) {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    const result = await fn().catch(() => null)
    if (result) return result
    await delay(25)
  }
  throw new Error("Menu fixture did not reach the expected state")
}
async function cell(source) {
  const response = await client.request({ method: "exec", arguments: { source } })
  assert.equal(response.content.some(block => block.type === "image"), false)
  const result = JSON.parse(response.content.filter(block => block.type === "text").at(-1).text)
  evidence.calls.push({ source, result })
  assert.equal(response.isError, undefined, JSON.stringify(result))
  return result
}
try {
  const binary = join(root, "fixture")
  await run("xcrun", ["swiftc", "-O", resolve("scripts/lib/native-settling-fixture.swift"), "-o", binary], { timeout: 180000 })
  fixture = spawn(binary, [join(root, "state.json")], { stdio: "ignore" })
  const initial = await until(read)
  evidence.initial = initial
  assert.notEqual(initial.frontmostPid, initial.pid)
  const requestedDriver = process.env.MAKO_TEST_DRIVER
  if (requestedDriver) assert.ok(isAbsolute(requestedDriver))
  const driver = resolveExecutable(requestedDriver ?? "cua-driver")
  assert.ok(driver, "The requested driver must exist; no fallback")
  const driverEnv = environmentForExecutable(driver, process.env)
  evidence.driver = (await run(driver, ["--version"])).stdout.trim()
  if (archive) evidence.build = JSON.parse(await readFile(join(archive, "package.json"), "utf8")).makoBuild
  else await snapshotControlRuntime(root)
  const socket = await ensureCuaEmbedded(join(root, "driver"), "dev.mako.menu-acceptance", driverEnv)
  await client.start({
    runtimeRoot: archive ? join(archive, "node_modules/@mako/control-runtime/dist") : join(root, "control-runtime-snapshot/node_modules/@mako/control-runtime/dist"),
    native: { driver, socket },
    env: driverEnv,
  })
  await cell(`state.window=control.window({pid:${initial.pid},window_id:${initial.window}});return await state.window.observe()`)
  for (const choice of ["Second choice", "Third choice", "First choice"]) {
    await cell("return await state.window.locator({role:'PopUpButton',name:'Test menu'}).click()")
    await cell(`return await state.window.expect({role:'MenuItem',name:${JSON.stringify(choice)}})`)
    const menu = await cell("return await state.window.locator({role:'PopUpButton',name:'Test menu'}).read()")
    assert.ok(menu.lines.some(line => line.includes(`MenuItem ${JSON.stringify(choice)}`)))
    assert.ok(menu.lines.every(line => !line.includes("MenuBar")))
    await cell(`return await state.window.locator({role:'PopUpButton',name:'Test menu'}).locator({role:'MenuItem',name:${JSON.stringify(choice)}}).click()`)
    evidence.final = await until(async () => {
      const actual = await read()
      return actual.choice === choice ? actual : null
    })
    assert.equal(evidence.final.frontmostPid, initial.frontmostPid)
    assert.deepEqual(evidence.final.foregroundEvents, initial.foregroundEvents, "No application activation during the background menu workflow")
  }
  assert.equal(evidence.final.menuEvents.filter(event => event.kind === "open").length, 3)
  assert.equal(evidence.final.menuEvents.filter(event => event.kind === "close").length, 3)
  evidence.passed = true
} catch (error) {
  evidence.error = error.message
  evidence.final = await read().catch(() => null)
  process.exitCode = 1
} finally {
  await client.close().catch(() => {})
  await stopCuaEmbedded()
  fixture?.kill()
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n")
  console.log(JSON.stringify({ passed: evidence.passed, error: evidence.error, root }))
}
