import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { invokeRuntime, probeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"
import { GROK_VERSIONS } from "@mako/host/harnesses/grok/versions"

/**
 * The host on Windows, from a built checkout (`npm run build:control-runtime`): `mako-host` started by hand with no
 * socket named, as on a machine, answers /health on the named pipe it drew for this start and published, through the
 * handshake both ends prove themselves with; HTTP without it is answered nothing, and once the host has narrowed the
 * pipe's DACL another account can't open it at all (`scripts/test-windows-pipes.ts` runs every client against an
 * impostor holding the name). Then both clients: `mako-host inspect` and the
 * headless `mako` client, which find the pipe themselves. A conversation on a stand-in for Grok's CLI, an npm-style
 * `grok.cmd` found by PATHEXT and started through ComSpec, streams a turn, is stopped mid-turn, and is closed, which
 * ends the stand-in's whole tree (its grandchild included). A terminal opens on PowerShell and runs a command.
 *
 *   node scripts/windows-host/prove.mjs [--evidence <dir>]
 */
assert.equal(process.platform, "win32", "This proof is the Windows host's")
const run = promisify(execFile)
const repo = resolve(import.meta.dirname, "..", "..")
const evidenceAt = process.argv.indexOf("--evidence")
const evidence = evidenceAt > 0 ? resolve(process.argv[evidenceAt + 1]) : undefined
const scratch = await mkdtemp(join(tmpdir(), "mako-windows-host-"))
const dataRoot = join(scratch, "data")
const project = join(scratch, "project")
const standIn = join(scratch, "bin")
const grandchildFile = join(scratch, "grandchild.pid")
const controlFile = join(scratch, "control.json")
const report = { checks: [], failures: [] }
const passed = (name, note) => {
  report.checks.push({ name, note })
  console.log(`ok   ${name}${note ? `: ${note}` : ""}`)
}
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function until(read, done, label, timeoutMs = 30_000) {
  for (const deadline = Date.now() + timeoutMs; ; await delay(200)) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs / 1000} s: ${label}`)
  }
}

let host
let hostOutput = ""
/** The profiles' folders in local app data, which outlive the scratch folder otherwise. */
const runtimeFolders = []
try {
  await Promise.all([mkdir(dataRoot, { recursive: true }), mkdir(project, { recursive: true }), mkdir(standIn, { recursive: true })])
  // A batch file, though not npm's shim (which is run as Node on its script, `windows-launch.ts`): it goes through
  // ComSpec as any batch file does, and its tree is cmd.exe, Node, and the grandchild the stand-in starts.
  await writeFile(join(standIn, "grok.cmd"), `@echo off\r\n"${process.execPath}" "${join(repo, "scripts", "windows-host", "grok-stand-in.mjs")}" %*\r\n`)
  const env = {
    ...process.env,
    [pathKey]: [standIn, process.env[pathKey]].filter(Boolean).join(delimiter),
    MAKO_DATA_ROOT: dataRoot,
    MAKO_TELEMETRY: "off",
    MAKO_PROD: "1",
    MAKO_PROOF_GRANDCHILD_FILE: grandchildFile,
    MAKO_PROOF_CONTROL_FILE: controlFile,
    MAKO_PROOF_GROK_VERSION: GROK_VERSIONS.tested,
    MEASURE_STREAM_MS: "2500",
    MEASURE_UNTIL_CANCELLED: "Once more",
    MEASURE_CANCEL_ANSWER_MS: "500",
  }
  for (const key of ["ELECTRON_RUN_AS_NODE", "VITE_DEV_SERVER_URL", "NODE_OPTIONS", "MAKO_WEB_SOCKET"]) delete env[key]

  // Started by hand, with no socket named: it listens where every client of this data root looks.
  const began = performance.now()
  host = spawn(process.execPath, [join(repo, "packages", "host", "dist", "mako-host.js")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  host.stdout.on("data", (chunk) => (hostOutput = (hostOutput + chunk).slice(-8_000)))
  host.stderr.on("data", (chunk) => (hostOutput = (hostOutput + chunk).slice(-8_000)))
  // The pipe this start drew for itself, read where it publishes it once it listens.
  const { directory } = runtimeLocation(dataRoot)
  runtimeFolders.push(directory)
  assert.ok(directory.startsWith(process.env.LOCALAPPDATA), `its name is published in local app data: ${directory}`)
  let socket
  const ready = await until(async () => {
    assert.equal(host.exitCode, null, `the host exited while starting:\n${hostOutput}`)
    socket = runtimeLocation(dataRoot).socket
    return probeRuntime(socket, { timeoutMs: 2_000 }).catch(() => undefined)
  }, (probe) => probe?.state === "ready", "the host's /health on its published pipe", 90_000)
  assert.match(socket, /^\\\\\.\\pipe\\mako-host-[0-9a-f]{16}-[0-9a-f]{32}$/, "the host's pipe is a random name")
  passed("/health on the named pipe, through the handshake", `${Math.round(performance.now() - began)} ms after spawn, ${ready.info.methods.length} methods, pid ${ready.info.pid}`)

  // A client that skips the handshake is answered nothing.
  const skipped = await new Promise((done) => {
    const asked = request({ socketPath: socket, path: "/health", agent: false }, (response) => done(`answered ${response.statusCode}`))
    asked.on("error", (error) => done(`refused: ${error.code ?? error.message}`))
    asked.setTimeout(10_000, () => asked.destroy(new Error("no answer")))
    asked.end()
  })
  assert.match(skipped, /^refused/, `HTTP without the handshake: ${skipped}`)
  passed("HTTP without the handshake is answered nothing", skipped)

  // A connection that writes nothing hears nothing.
  const silent = connect(socket)
  let heard = 0
  silent.on("data", (chunk) => (heard += chunk.length))
  await once(silent, "connect")
  await delay(2_000)
  silent.destroy()
  assert.equal(heard, 0, "the host writes nothing on a connection before it asks")
  passed("a connection that asks nothing hears nothing")

  // Another account, made for the check, once the host has narrowed its pipe's DACL: it can't open it at all, and
  // network logons are denied outright.
  await until(() => readFile(join(dataRoot, "logs", "host.log"), "utf8").catch(() => ""), (log) => /pipes (a pipe's DACL is its owner's alone|a pipe keeps Windows' default DACL)[^\n]*host's pipe/.test(log), "the host's pipe DACL", 60_000)
  const { stdout: access } = await run("pwsh", ["-NoProfile", "-File", join(repo, "scripts", "windows-host", "pipe-access.ps1"), "-Pipe", socket], { timeout: 60_000 })
  const seen = JSON.parse(access.trim().split("\n").at(-1))
  report.pipeAccess = seen
  for (const key of ["readWrite", "writeOnly", "readOnly", "newInstance"]) assert.match(seen[key], /^denied 5$/, `another account's ${key}: ${seen[key]}`)
  assert.match(seen.sddl, /D:P\(D;;FA;;;NU\)\(A;;FA;;;SY\)\(A;;FA;;;[^)]+\)$/, `the pipe's DACL is its owner's alone: ${seen.sddl}`)
  passed("another account can't open the pipe at all; network logons are denied", seen.sddl)

  // The host's own CLI, finding the pipe by the data root.
  const { stdout: inspected } = await run(process.execPath, [join(repo, "packages", "host", "dist", "mako-host.js"), "inspect", "--data-root", dataRoot, "--json"], { env, timeout: 30_000 })
  assert.equal(JSON.parse(inspected).health.pid, ready.info.pid)
  passed("mako-host inspect finds and reads the host")

  // The headless client, finding the pipe by the data root too.
  const mako = async (...args) => {
    const { stdout } = await run(process.execPath, [join(repo, "packages", "client", "dist", "cli.js"), "--json", ...args], { env, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 })
    return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  }
  const text = (lines) => lines.flatMap((line) => (line.kind === "text" ? [line.text] : [])).join("")
  const first = await mako("start", "grok", "Measure the host", "--cwd", project)
  const started = first[0]
  assert.equal(started.kind, "started", JSON.stringify(first.slice(0, 3)))
  assert.match(text(first), /the host reads each update/, "the stand-in's words, as they streamed")
  assert.deepEqual(first.at(-1), { kind: "settled", requestId: started.requestId, status: "completed" })
  passed("a conversation on grok.cmd streams a turn to its end")

  // Local Control, end to end: the agent's own `mako-control status`, run by the stand-in from its shell, reached the
  // task's session over its pipe (the handshake, the host's relay to the worker) and was answered.
  const control = JSON.parse(await readFile(controlFile, "utf8"))
  assert.equal(control.code, 0, `mako-control status: ${JSON.stringify(control)}`)
  assert.match(control.sessionFile ?? "", /\\Mako\\control\\mako-cli-\d+-[^\\]+\\session\\session\.json$/, `the session file is in the user's own control folder: ${control.sessionFile}`)
  const answered = JSON.parse(control.stdout)
  assert.ok([true, false].includes(answered.native?.configured), `the session answered its status: ${control.stdout.slice(0, 300)}`)
  const session = JSON.parse(await readFile(control.sessionFile, "utf8"))
  assert.match(session.socket, /^\\\\\.\\pipe\\mako-control-[0-9a-f]{32}$/)
  assert.match(session.proof, /^[0-9a-f]{64}$/)
  // HTTP on the session's pipe without the handshake is answered nothing.
  const bare = await new Promise((done) => {
    const asked = request({ socketPath: session.socket, path: "/request", method: "POST", agent: false }, (response) => done(`answered ${response.statusCode}`))
    asked.on("error", (error) => done(`refused: ${error.code ?? error.message}`))
    asked.end("{}")
  })
  assert.match(bare, /^refused/, `the control pipe without its handshake: ${bare}`)
  passed("Local Control answers the agent's mako-control over its proven pipe", `native configured: ${answered.native.configured}; without the handshake ${bare}`)

  const detached = await mako("send", started.conversationId, "Once more", "--detach")
  const { requestId } = detached[0]
  await delay(400)
  await mako("stop", started.conversationId)
  const stoppedOf = (lines) => lines.find((line) => line.kind === "request" && line.id === requestId)?.status
  const history = await until(() => mako("history", started.conversationId), (lines) => stoppedOf(lines) !== "dispatching", "the stopped turn", 20_000)
  assert.equal(stoppedOf(history), "interrupted", "the stopped turn is interrupted")
  passed("a running turn stops")

  // Closing the conversation ends the stand-in's tree: cmd.exe, the stand-in, and the grandchild it started.
  const grandchild = Number(await readFile(grandchildFile, "utf8"))
  assert.ok(alive(grandchild), "the stand-in's grandchild runs while the conversation is open")
  const client = randomUUID()
  await invokeRuntime(socket, client, "mako:live-close", [started.conversationId], 1, { timeoutMs: 60_000 })
  await until(async () => alive(grandchild), (running) => !running, `the grandchild (pid ${grandchild}) to end with its tree`, 20_000)
  passed("closing the conversation ends the harness's whole tree", `grandchild ${grandchild} gone`)

  // A terminal on PowerShell.
  const terminal = await invokeRuntime(socket, client, "mako:terminal-create", [{ cwd: project, title: "proof", cols: 100, rows: 30 }])
  await invokeRuntime(socket, client, "mako:terminal-write", [terminal.id, "Write-Output \"proof-$(6*7) on $($PSVersionTable.PSEdition)\"\r"])
  const shell = await until(() => invokeRuntime(socket, client, "mako:terminal-attach", [terminal.id]), (attached) => /proof-42 on (Core|Desktop)/.test(JSON.stringify(attached)), "the terminal's echo", 30_000)
  await invokeRuntime(socket, client, "mako:terminal-kill", [terminal.id])
  passed("a terminal runs PowerShell through the terminal daemon", JSON.stringify(shell).match(/proof-42 on \w+/)?.[0])

  // A graceful stop, where Windows has no signal to send: `mako-host stop` asks over the proven pipe, and the host's
  // own stop runs to its end and exits 0. A host started again on the same data reads what the first one wrote.
  const hostCli = join(repo, "packages", "host", "dist", "mako-host.js")
  const firstHost = host
  const { stdout: stoppedSaid } = await run(process.execPath, [hostCli, "stop", "--data-root", dataRoot, "--timeout", "60"], { env, timeout: 90_000 })
  assert.match(stoppedSaid, /stopped/, stoppedSaid)
  if (firstHost.exitCode === null) await Promise.race([once(firstHost, "exit"), delay(10_000)])
  assert.equal(firstHost.exitCode, 0, "the host's own stop ran and it exited 0")
  const firstLog = await readFile(join(dataRoot, "logs", "host.log"), "utf8")
  assert.match(firstLog, /lifecycle stopping reason=quit/)
  assert.match(firstLog, /lifecycle stopped/, "its stop ran to the end")
  host = spawn(process.execPath, [hostCli], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  host.stdout.on("data", (chunk) => (hostOutput = (hostOutput + chunk).slice(-8_000)))
  host.stderr.on("data", (chunk) => (hostOutput = (hostOutput + chunk).slice(-8_000)))
  let again
  const second = await until(async () => {
    assert.equal(host.exitCode, null, `the second host exited while starting:\n${hostOutput}`)
    again = runtimeLocation(dataRoot).socket
    return probeRuntime(again, { timeoutMs: 2_000 }).catch(() => undefined)
  }, (probe) => probe?.state === "ready" && probe.info.pid !== ready.info.pid, "the second host's /health", 90_000)
  assert.notEqual(again, socket, "each start listens on a pipe of its own")
  const kept = await mako("history", started.conversationId)
  assert.equal(kept.filter((line) => line.kind === "user").length, 2, "the second host reads the conversation the first wrote")
  assert.match(text(kept), /the host reads each update/, "its words too")
  passed("mako-host stop runs the host's own stop; a host started again reads what it wrote", `pid ${ready.info.pid} exited 0, pid ${second.info.pid} read ${kept.length} lines back`)
} catch (error) {
  report.failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
  console.error(`FAIL ${report.failures.at(-1)}`)
} finally {
  if (host && host.exitCode === null) {
    // Asked to stop as above; ended outright, with its tree, only if that fails.
    await run(process.execPath, [join(repo, "packages", "host", "dist", "mako-host.js"), "stop", "--data-root", dataRoot, "--now", "--timeout", "30"], { timeout: 60_000 }).catch(() => undefined)
    if (host.exitCode === null) await run("taskkill", ["/PID", String(host.pid), "/T", "/F"]).catch(() => undefined)
    await Promise.race([once(host, "exit"), delay(10_000)])
  }
  const log = await readFile(join(dataRoot, "logs", "host.log"), "utf8").catch(() => "")
  if (evidence) {
    await mkdir(evidence, { recursive: true })
    await writeFile(join(evidence, "host.log"), log)
    await writeFile(join(evidence, "host-output.log"), hostOutput)
    await writeFile(join(evidence, "result.json"), `${JSON.stringify(report, null, 2)}\n`)
  }
  if (report.failures.length) {
    console.log(`--- host output\n${hostOutput}\n--- host.log (last 80 lines)\n${log.split("\n").slice(-80).join("\n")}`)
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }).catch(() => undefined)
  for (const folder of runtimeFolders) await rm(folder, { recursive: true, force: true }).catch(() => undefined)
  console.log(`Windows host proof ${report.failures.length ? "failed" : "passed"}`)
  process.exitCode = report.failures.length ? 1 : 0
}
