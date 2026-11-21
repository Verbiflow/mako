import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { probeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"

/**
 * A host that stops takes away what it made and nothing else. Its socket named in a folder that holds other things
 * (`MAKO_WEB_SOCKET=/tmp/h.sock`): the socket goes, and the folder and everything in it stay. It once deleted that
 * folder whole, whatever it was. A host with no socket named listens in its profile's own runtime folder
 * (`runtimeLocation`), which goes with it once it is empty, on every platform.
 */
const run = promisify(execFile)
const windows = process.platform === "win32"
const scratch = await mkdtemp(join(tmpdir(), "mako-socket-folder-"))
const hostCli = resolve("packages/host/dist/mako-host.js")

async function host(name, socket) {
  const dataRoot = join(scratch, name, "data")
  const env = { ...process.env, MAKO_PROD: "1", MAKO_TELEMETRY: "off", MAKO_DATA_ROOT: dataRoot }
  for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "VITE_DEV_SERVER_URL", "MAKO_WEB_SOCKET"]) delete env[key]
  if (!windows) env.HOME = join(scratch, name, "home")
  if (socket) env.MAKO_WEB_SOCKET = socket
  await mkdir(join(scratch, name, "home"), { recursive: true })
  const child = spawn(process.execPath, [hostCli], { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
  let said = ""
  child.stderr.on("data", (data) => { said = (said + data).slice(-4000) })
  const at = () => socket ?? runtimeLocation(dataRoot).socket
  for (const deadline = Date.now() + 90_000; ; await delay(200)) {
    assert.ok(Date.now() < deadline, `The host answered within 90 s. It said: ${said}`)
    assert.equal(child.exitCode, null, `The host exited as it started: ${said}`)
    if ((await probeRuntime(at(), { timeoutMs: 2_000 }).catch(() => undefined))?.state === "ready") break
  }
  return {
    dataRoot,
    env,
    child,
    /** Its own stop, run to the end: asked over its socket where there's a way to find it, by signal otherwise. */
    async stop() {
      if (socket) child.kill("SIGTERM")
      else await run(process.execPath, [hostCli, "stop", "--data-root", dataRoot, "--timeout", "60"], { env, timeout: 90_000 })
      if (child.exitCode === null) await Promise.race([once(child, "exit"), delay(30_000)])
      assert.equal(child.exitCode, 0, `the host's own stop ran and it exited 0: ${said}`)
      assert.match(await readFile(join(dataRoot, "logs", "host.log"), "utf8"), /lifecycle stopped/, "its stop ran to the end")
    },
  }
}

const started = []
try {
  if (!windows) {
    // A folder of someone's, with their things in it, and the host's socket named there.
    const given = join(scratch, "given")
    await mkdir(join(given, "theirs"), { recursive: true })
    await writeFile(join(given, "notes.txt"), "kept")
    await writeFile(join(given, "theirs", "file"), "kept")
    const named = await host("named", join(given, "h.sock"))
    started.push(named)
    assert.ok(existsSync(join(given, "h.sock")), "the host listens on the socket it was given")
    await named.stop()
    assert.deepEqual((await readdir(given)).sort(), ["notes.txt", "theirs"], "the socket is gone, and the folder it was named in keeps everything else")
    assert.equal(await readFile(join(given, "theirs", "file"), "utf8"), "kept")

    // A folder that wasn't there: the host made it, so it is the host's to remove once empty.
    const made = join(scratch, "made", "run")
    const maker = await host("maker", join(made, "h.sock"))
    started.push(maker)
    await maker.stop()
    assert.equal(existsSync(made), false, "a folder the host made for its socket goes with it")
    assert.ok(existsSync(join(scratch, "made")), "and only that folder")
  }

  // No socket named: the profile's own runtime folder, on every platform.
  const own = await host("own")
  started.push(own)
  const { directory } = runtimeLocation(own.dataRoot)
  assert.ok(existsSync(directory), `the host's runtime folder is there while it runs: ${directory}`)
  await own.stop()
  assert.equal(existsSync(directory), false, "the profile's own runtime folder goes with its host")
  console.log(`host socket folder: a stop removes the host's socket and its own empty folder, never a folder it was given or what's in it (${process.platform})`)
} finally {
  for (const one of started) {
    if (one.child.exitCode !== null) continue
    if (windows) await run("taskkill", ["/PID", String(one.child.pid), "/T", "/F"]).catch(() => undefined)
    else one.child.kill("SIGKILL")
    await Promise.race([once(one.child, "exit"), delay(10_000)])
    if (windows) await rm(runtimeLocation(one.dataRoot).directory, { recursive: true, force: true }).catch(() => undefined)
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }).catch(() => undefined)
}
