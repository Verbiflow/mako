import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, request } from "node:http"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { invokeRuntime, probeRuntime } from "@mako/host/transport/connection"
import { HOST_PROOF_HEADER, HostImpostorError, hostPipeProof } from "@mako/host/transport/pipe"
import { runtimeLocation } from "@mako/host/transport/service"
import { GROK_VERSIONS } from "@mako/host/harnesses/grok/versions"

/**
 * The host on Windows, from a built checkout (`npm run build:control-runtime`): `mako-host` started by hand with no
 * socket named, as on a machine, answers /health on the named pipe its profile keeps, with its proof; another account
 * can't write to that pipe or add an instance of it, and a connection that writes nothing hears nothing; something
 * else answering on a profile's pipe is refused as an impostor. Then both clients: `mako-host inspect` and the
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
  const { socket, directory } = runtimeLocation(dataRoot)
  runtimeFolders.push(directory)
  assert.match(socket, /^\\\\\.\\pipe\\mako-host-[0-9a-f]{16}-[0-9a-f]{32}$/, "the host's pipe is its profile's random name")
  assert.ok(directory.startsWith(process.env.LOCALAPPDATA), `its name is kept in local app data: ${directory}`)
  const ready = await until(async () => {
    assert.equal(host.exitCode, null, `the host exited while starting:\n${hostOutput}`)
    return probeRuntime(socket, { timeoutMs: 2_000 }).catch(() => undefined)
  }, (probe) => probe?.state === "ready", `the host's /health on ${socket}`, 90_000)
  passed("/health on the named pipe", `${Math.round(performance.now() - began)} ms after spawn, ${ready.info.methods.length} methods, pid ${ready.info.pid}`)

  // The proof, as a raw request reads it.
  const proof = hostPipeProof(socket)
  assert.ok(proof, "the profile keeps a proof beside the name")
  const said = await new Promise((done, fail) => {
    const asked = request({ socketPath: socket, path: "/health", agent: false }, (response) => {
      response.resume()
      done(response.headers[HOST_PROOF_HEADER])
    })
    asked.on("error", fail)
    asked.end()
  })
  assert.equal(said, proof, "/health says the profile's proof")
  passed("the host says its profile's proof")

  // A connection that writes nothing hears nothing: what another account may open (to read) gets no byte.
  const silent = connect(socket)
  let heard = 0
  silent.on("data", (chunk) => (heard += chunk.length))
  await once(silent, "connect")
  await delay(2_000)
  silent.destroy()
  assert.equal(heard, 0, "the host writes nothing on a connection before it asks")
  passed("a connection that asks nothing hears nothing")

  // Another account, made for the check: it may open the pipe to read, never to write, and can't add an instance.
  const { stdout: access } = await run("pwsh", ["-NoProfile", "-File", join(repo, "scripts", "windows-host", "pipe-access.ps1"), "-Pipe", socket], { timeout: 60_000 })
  const seen = JSON.parse(access.trim().split("\n").at(-1))
  report.pipeAccess = seen
  for (const key of ["readWrite", "writeOnly", "newInstance"]) assert.match(seen[key], /^denied 5$/, `another account's ${key}: ${seen[key]}`)
  assert.match(seen.sddl, /^O:/, `the pipe's descriptor reads: ${seen.sddl}`)
  // Full control only for SYSTEM, administrators and a user's own SID; everyone and anonymous only read.
  for (const [, rights, sid] of seen.sddl.matchAll(/\(A;[^;]*;([^;]*);[^;]*;[^;]*;([^)]*)\)/g))
    assert.ok(["SY", "BA"].includes(sid) || sid.startsWith("S-1-5-21-") || (["WD", "AN"].includes(sid) && rights === "FR"), `${sid} may ${rights}: ${seen.sddl}`)
  passed("another account can't write to the pipe or take an instance of it", `${seen.sddl}; read-only open ${seen.readOnly}`)

  // Something else on a profile's pipe: refused, never taken for the host.
  const otherRoot = join(scratch, "other-data")
  const other = runtimeLocation(otherRoot)
  runtimeFolders.push(other.directory)
  const impostor = createServer((_, response) => response.writeHead(200, { "content-type": "application/json" }).end("{}"))
  await new Promise((done) => impostor.listen(other.socket, done))
  try {
    await assert.rejects(probeRuntime(other.socket), HostImpostorError, "an answer without the proof is an impostor's")
  } finally {
    impostor.close()
  }
  passed("an answer on a profile's pipe without its proof is refused")

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
} catch (error) {
  report.failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
  console.error(`FAIL ${report.failures.at(-1)}`)
} finally {
  if (host && host.exitCode === null) {
    // Windows has no SIGTERM for a console program: Node ends it outright, and its tree with it here.
    await run("taskkill", ["/PID", String(host.pid), "/T", "/F"]).catch(() => undefined)
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
