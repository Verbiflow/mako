import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { invokeRuntime, probeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"
import { GROK_VERSIONS } from "@mako/host/harnesses/grok/versions"

/**
 * Computer use on a Windows host, end to end, from a built checkout (`npm run build:control-runtime`): `mako-host`
 * started by hand finds Mako's driver (`cua-driver.exe`, in a folder of this user's on PATH) through its trusted
 * lookup and starts it on a named pipe. Then the two ways a person and an agent reach it:
 *
 * - an Appshot of a window through the host (`mako:appshot-windows`, `mako:appshot-capture`), and
 * - a Thread on a stand-in for Grok's CLI (`computer-stand-in.mjs`) which, with the control session Mako put in its
 *   environment, observes a fixture window, sets its field, clicks its button and takes an Appshot through the
 *   control CLI; the window's own state file says the field and the click arrived.
 *
 * The Thread's half runs with `--thread`: it needs a task's control session on Windows (a proven named pipe, and the
 * `mako-control.cmd` launcher beside the session file, which the stand-in runs as an agent's shell would).
 *
 *   node scripts/windows-host/prove-computer-use.mjs --driver <cua-driver.exe> [--video-helper <mako-video.exe>] [--thread] [--evidence <dir>]
 */
assert.equal(process.platform, "win32", "This proof is the Windows host's")
const run = promisify(execFile)
const repo = resolve(import.meta.dirname, "..", "..")
const option = (name) => {
  const at = process.argv.indexOf(name)
  return at > 0 ? resolve(process.argv[at + 1]) : undefined
}
const driver = option("--driver")
assert.ok(driver, "--driver <path to cua-driver.exe>")
const videoHelper = option("--video-helper")
const evidence = option("--evidence")
// In this user's profile, where the host's lookup trusts a program it finds by searching.
const scratch = await realpath(await mkdtemp(join(tmpdir(), "mako-windows-computer-")))
const dataRoot = join(scratch, "data")
const project = join(scratch, "project")
const bin = join(scratch, "bin")
const fixtureState = join(scratch, "fixture.json")
const computerResult = join(scratch, "computer-result.json")
const program = join(scratch, "computer-program.js")
const report = { checks: [], failures: [] }
const passed = (name, note) => {
  report.checks.push({ name, note })
  console.log(`ok   ${name}${note ? `: ${note}` : ""}`)
}
const step = async (name, body) => {
  try {
    passed(name, await body())
  } catch (error) {
    report.failures.push(`${name}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    console.error(`FAIL ${report.failures.at(-1)}`)
  }
}
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
async function until(read, done, label, timeoutMs = 30_000) {
  for (const deadline = Date.now() + timeoutMs; ; await delay(200)) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs / 1000} s: ${label}`)
  }
}
const fixtureRead = async () => JSON.parse(await readFile(fixtureState, "utf8").catch(() => "null"))

let host
let fixture
let hostOutput = ""
const runtimeFolders = []
try {
  await Promise.all([mkdir(dataRoot, { recursive: true }), mkdir(project, { recursive: true }), mkdir(bin, { recursive: true })])
  await copyFile(driver, join(bin, "cua-driver.exe"))
  await writeFile(join(bin, "grok.cmd"), `@echo off\r\n"${process.execPath}" "${join(repo, "scripts", "windows-host", "computer-stand-in.mjs")}" %*\r\n`)
  fixture = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(repo, "scripts", "fixtures", "win-control-fixture.ps1"), "-Title", "Mako control fixture", "-State", fixtureState], { stdio: "ignore" })
  const window = await until(fixtureRead, (state) => state?.hwnd, "the fixture window", 60_000)
  // What the agent runs: discover the window by its pid, observe, set the field, press the button, take an Appshot.
  await writeFile(program, `const win = control.window({pid: ${window.pid}, window_id: ${window.hwnd}});
const view = await win.observe();
const field = view.nodes.find(n => n.role === 'TextField' && n.name === 'Proof');
await win.setValue(field.ref, 'thread-proof');
const again = await win.observe();
await win.click(again.nodes.find(n => n.role === 'Button' && n.name === 'Verify proof').ref);
await win.expect({role: 'TextField', name: 'Proof', value: 'thread-proof'}, {timeoutMs: 5000});
const shot = await win.appshot();
return {observed: view.nodes.length, field: field.ref, appshot: Object.keys(shot)};
`)
  const env = {
    ...process.env,
    [pathKey]: [bin, process.env[pathKey]].filter(Boolean).join(delimiter),
    MAKO_DATA_ROOT: dataRoot,
    MAKO_TELEMETRY: "off",
    MAKO_PROD: "1",
    MAKO_PROOF_GROK_VERSION: GROK_VERSIONS.tested,
    MAKO_PROOF_COMPUTER_PROGRAM: program,
    MAKO_PROOF_COMPUTER_RESULT: computerResult,
    MAKO_PROOF_CONTROL_CLI: join(repo, "packages", "control-runtime", "dist", "control-cli.js"),
    ...(videoHelper && { MAKO_VIDEO_HELPER: videoHelper }),
  }
  for (const key of ["ELECTRON_RUN_AS_NODE", "VITE_DEV_SERVER_URL", "NODE_OPTIONS", "MAKO_WEB_SOCKET"]) delete env[key]

  host = spawn(process.execPath, [join(repo, "packages", "host", "dist", "mako-host.js")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  host.stdout.on("data", (chunk) => (hostOutput = (hostOutput + chunk).slice(-8_000)))
  host.stderr.on("data", (chunk) => (hostOutput = (hostOutput + chunk).slice(-8_000)))
  runtimeFolders.push(runtimeLocation(dataRoot).directory)
  let socket
  await until(async () => {
    assert.equal(host.exitCode, null, `the host exited while starting:\n${hostOutput}`)
    socket = runtimeLocation(dataRoot).socket
    return probeRuntime(socket, { timeoutMs: 2_000 }).catch(() => undefined)
  }, (probe) => probe?.state === "ready", "the host's /health on its published pipe", 90_000)
  const client = randomUUID()
  const call = (method, args = [], timeoutMs = 60_000) => invokeRuntime(socket, client, method, args, 1, { timeoutMs })

  await step("the host finds Mako's driver through its trusted lookup, needs no grant, and won't run upstream's updater over it", async () => {
    const status = await call("mako:computer-driver")
    assert.equal(status.executable?.toLowerCase(), join(bin, "cua-driver.exe").toLowerCase(), `found in this user's folder on PATH: ${JSON.stringify(status)}`)
    assert.match(status.version ?? "", /\+mako\./, `Mako's build: ${status.detail}`)
    const permissions = await call("mako:computer-permissions")
    assert.deepEqual([permissions.accessibility, permissions.screenRecording], [true, "granted"])
    const update = await call("mako:computer-driver-update").then(() => "ran", (error) => error.message)
    assert.match(update, /signed Mako driver package/, `the updater is refused: ${update}`)
    return status.detail
  })

  await step("an Appshot of the fixture window through the host", async () => {
    const windows = await call("mako:appshot-windows")
    const listed = windows.find((entry) => entry.windowId === window.hwnd)
    assert.ok(listed, `the fixture is among the host's windows: ${JSON.stringify(windows.map((entry) => entry.title))}`)
    const shot = await call("mako:appshot-capture", [{ pid: window.pid, windowId: window.hwnd }])
    assert.ok(shot.image.data.length > 1000, "the Appshot has a picture")
    assert.match(shot.text, /Verify proof/, "and the window's outline")
    return `${shot.image.data.length} bytes, ${shot.text.split("\n").length} lines`
  })

  if (process.argv.includes("--thread")) await step("a Thread's agent observes the window, sets its field, clicks and takes an Appshot", async () => {
    const mako = async (...args) => {
      const { stdout } = await run(process.execPath, [join(repo, "packages", "client", "dist", "cli.js"), "--json", ...args], { env, maxBuffer: 64 * 1024 * 1024, timeout: 180_000 })
      return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    }
    const lines = await mako("start", "grok", "Use the computer", "--cwd", project)
    assert.equal(lines[0].kind, "started", JSON.stringify(lines.slice(0, 3)))
    const outcome = JSON.parse(await readFile(computerResult, "utf8").catch(() => '{"error":"the stand-in harness wrote no result"}'))
    report.computer = outcome
    assert.equal(outcome.error, undefined, `the agent's control program ran: ${JSON.stringify(outcome).slice(0, 1500)}`)
    const state = await until(fixtureRead, (read) => read?.verified === "thread-proof", "the window received the field's value and the click", 10_000)
    await call("mako:live-close", [lines[0].conversationId]).catch(() => undefined)
    assert.ok(outcome.launcher, "the agent ran Mako's own mako-control.cmd launcher")
    const connections = await call("mako:computer-driver-connections")
    return `the window verified "${state.verified}" after ${state.presses} press; broker ${JSON.stringify(connections).slice(0, 160)}; ${String(outcome.stdout).slice(0, 200)}`
  })
} catch (error) {
  report.failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
  console.error(`FAIL ${report.failures.at(-1)}`)
} finally {
  fixture?.kill()
  if (host && host.exitCode === null) {
    await run("taskkill", ["/PID", String(host.pid), "/T", "/F"]).catch(() => undefined)
    await Promise.race([once(host, "exit"), delay(10_000)])
  }
  const log = await readFile(join(dataRoot, "logs", "host.log"), "utf8").catch(() => "")
  if (evidence) {
    await mkdir(evidence, { recursive: true })
    await writeFile(join(evidence, "computer-host.log"), log)
    await writeFile(join(evidence, "computer-result.json"), `${JSON.stringify(report, null, 2)}\n`)
  }
  if (report.failures.length) console.log(`--- host output\n${hostOutput}\n--- host.log (last 60 lines)\n${log.split("\n").slice(-60).join("\n")}`)
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }).catch(() => undefined)
  for (const folder of runtimeFolders) await rm(folder, { recursive: true, force: true }).catch(() => undefined)
  console.log(`Windows computer-use proof ${report.failures.length ? "failed" : "passed"}`)
  process.exitCode = report.failures.length ? 1 : 0
}
