// Run inside the reviewed Linux runtime image; mount this file at /checks.
// MAKO_RUNTIME_EVIDENCE optionally retains results on a mounted output directory.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

assert.equal(process.platform, "linux", "Run this check in the Linux runtime image")
const root = process.env.MAKO_RUNTIME_ROOT ?? "/opt/mako-control"
const require = createRequire(join(root, "package.json"))
const cli = require.resolve("@mako/control-runtime/cli")
const evidence = process.env.MAKO_RUNTIME_EVIDENCE ?? await mkdtemp("/tmp/mako-cli-start-cancel-")
await mkdir(evidence, { recursive: true })
const results = []
const signalProcess = (pid, signal) => {
  try { process.kill(pid, signal) } catch (error) {
    if (error.code !== "ESRCH") throw error
  }
}
const read = async (path) => JSON.parse(await readFile(path, "utf8"))
async function until(probe, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await probe()
    if (value) return value
    assert.ok(Date.now() < deadline, `${label}: deadline exceeded`)
    await delay(30)
  }
}
async function processInfo(pid) {
  const text = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null)
  if (!text) return null
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ")
  return { pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]) }
}
async function groupProcesses(group) {
  const rows = await Promise.all((await readdir("/proc"))
    .filter((name) => /^\d+$/.test(name))
    .map((name) => processInfo(Number(name))))
  return rows.filter((row) => row && row.group === group && row.state !== "Z")
}
const exists = async (path) => Boolean(await stat(path).catch((error) => {
  if (error.code === "ENOENT") return null
  throw error
}))

try {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const directory = await mkdtemp(join(evidence, `${signal.toLowerCase()}-`))
    const marker = join(directory, "browser-started.json")
    const executable = join(directory, "delayed-browser.mjs")
    const output = join(directory, "job")
    const config = join(directory, "config.json")
    // This real child never publishes DevToolsActivePort. Its marker proves the
    // public CLI has launched the supervisor, worker and backend before signal.
    await writeFile(executable, `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const fields = readFileSync("/proc/self/stat", "utf8").split(") ").at(-1).split(" ");
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,parent:process.ppid,group:Number(fields[2]),runtime:process.env.TMPDIR}));
setInterval(() => {}, 1000);
`, { mode: 0o700 })
    await writeFile(config, JSON.stringify({
      output, browser: { executable, sandbox: false }, startupMs: 30000, shutdownMs: 2000,
    }))
    const child = spawn(process.execPath, [cli, "session", "start", "--config", config], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = "", stderr = "", exit
    child.stdout.on("data", (bytes) => { stdout += bytes })
    child.stderr.on("data", (bytes) => { stderr += bytes })
    child.once("error", (error) => { exit = { error: error.message } })
    child.once("close", (code, signal) => { exit = { code, signal } })
    let backend, launcherPid
    try {
      backend = await until(async () => {
        assert.equal(exit, undefined, `CLI exited before backend startup: ${stderr}`)
        return read(marker).catch((error) => {
          if (error.code === "ENOENT") return null
          throw error
        })
      }, `${signal} backend startup`)
      assert.equal(backend.group, backend.parent, "Backend must belong to its worker's group")
      const worker = await processInfo(backend.parent)
      assert.ok(worker)
      launcherPid = worker.parent
      assert.equal((await processInfo(launcherPid))?.parent, child.pid,
        "Only the supervisor launched by this fixture may be signalled")
      assert.equal(await exists(join(output, "session.json")), false, "Cancel before readiness")
      assert.equal(child.kill(signal), true)
      await until(async () => exit, `${signal} CLI exit`)
      const launcher = await until(() => read(join(output, "launcher.json")).catch((error) => {
        if (error.code === "ENOENT") return null
        throw error
      }), `${signal} launcher cleanup`)
      await until(async () => (await groupProcesses(backend.group)).length === 0,
        `${signal} worker process-group cleanup`)
      await until(async () => {
        const info = await processInfo(launcherPid)
        return !info || info.state === "Z"
      }, `${signal} launcher exit`)
      const result = {
        signal, exit, stdout, stderr, fault: JSON.parse(stderr), backend, launcher,
        worker: await read(join(output, "worker.json")),
        groupRemaining: await groupProcesses(backend.group),
        runtimeExists: await exists(backend.runtime),
        sessionExists: await exists(join(output, "session.json")),
      }
      results.push(result)
      assert.equal(launcher.runtimeRemoved, true)
      assert.equal(launcher.ready, false)
      assert.equal(launcher.reason, "SIGTERM")
      assert.equal(launcher.clean, true)
      assert.equal(launcher.workerExit.code, 0)
      assert.equal(result.runtimeExists, false)
      assert.equal(result.sessionExists, false)
      assert.equal(stdout, "", "Cancelled startup must not publish a session")
    } finally {
      // Cleanup is scoped to the exact child and verified worker ancestry above.
      if (!exit) child.kill("SIGTERM")
      if (launcherPid && await processInfo(launcherPid)) {
        signalProcess(launcherPid, "SIGTERM")
      }
      if (backend && (await groupProcesses(backend.group)).length) {
        signalProcess(-backend.group, "SIGKILL")
      }
    }
  }
  // Check the public contract after both scenarios so a regression records both
  // faulty CLI outcomes while still proving their independent cleanup behavior.
  for (const result of results) {
    assert.equal(result.exit.code, 130, `${result.signal}: cancellation exit code; ${result.stderr}`)
    assert.equal(result.exit.signal, null)
    assert.equal(result.fault.code, "cancelled")
    assert.equal(result.fault.outcome, "unknown", "CLI exit alone cannot prove supervisor cleanup")
  }
  console.log(JSON.stringify({ passed: true, evidence, scenarios: results.length }))
} finally {
  await writeFile(join(evidence, "results.json"), JSON.stringify({ cli, results }, null, 2) + "\n")
}
