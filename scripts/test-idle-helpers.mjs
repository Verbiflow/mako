import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { request } from "node:http"
import { platform, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

/**
 * A host nobody is using keeps no helper process: with no window subscribed and no project open, the file watcher's
 * child has nothing to watch (the plugins folder is followed only while a window hears of it) and goes after its idle
 * wait, and no Git helper runs. Each is some 25 MB that an idle host held for nothing. On a Mac the same child also
 * reads the process table for the harness probes, which ask every half minute, so one stays there: only the Git
 * helper is checked.
 */
const scratch = await mkdtemp(join(tmpdir(), "mako-idle-helpers-"))
const socket = join(scratch, "h.sock")
const env = { ...process.env, MAKO_PROD: "1", MAKO_TELEMETRY: "off", MAKO_DATA_ROOT: join(scratch, "data"), MAKO_WEB_SOCKET: socket, HOME: scratch }
for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "VITE_DEV_SERVER_URL"]) delete env[key]
const host = spawn(process.execPath, [resolve("packages/host/dist/mako-host.js")], { env, stdio: ["ignore", "ignore", "pipe"] })
let said = ""
host.stderr.on("data", (data) => { said = (said + data).slice(-4000) })
const client = randomUUID()

function health() {
  return new Promise((done, fail) => {
    const req = request({ socketPath: socket, path: "/health", method: "GET", headers: { "x-mako-window": client } }, (response) => {
      const chunks = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () => done(JSON.parse(Buffer.concat(chunks).toString())))
      response.on("error", fail)
    })
    req.on("error", fail)
    req.end()
  })
}
/** The host's helper processes running now, by their entry's name. */
const helpers = () => execFileSync("ps", ["-Ao", "ppid=,args="]).toString().split("\n")
  .filter((line) => Number(line.trim().split(/\s+/)[0]) === host.pid && /(watcher-child-main|git-helper-main)\.js/.test(line))
  .map((line) => /(watcher-child-main|git-helper-main)/.exec(line)?.[1])
  .filter((name) => platform() !== "darwin" || name === "git-helper-main")

try {
  for (const deadline = Date.now() + 60_000; ; await delay(200)) {
    assert.ok(Date.now() < deadline, `The host's core loaded within 60 s. The host said: ${said}`)
    const core = await health().then((answer) => answer.domains.find((domain) => domain.name === "core"), () => undefined)
    if (core?.state === "ready") break
  }
  // What the host does once its core is ready may start either (a `git` in the folder it was started in, a watch
  // made and let go): each then goes 30 s after its last work.
  await delay(10_000)
  for (const deadline = Date.now() + 75_000; helpers().length; await delay(1_000))
    assert.ok(Date.now() < deadline, `An idle host with no window keeps no helper process, but ${helpers().join(" and ")} still ran after 75 s`)
  await delay(5_000)
  await delay(5_000)
  assert.deepEqual(helpers(), [], "and starts none while it idles")
  console.log("idle helpers: a host with no window and no project runs neither the watcher's child nor the Git helper")
} finally {
  host.kill("SIGTERM")
  await Promise.race([once(host, "exit"), delay(10_000)])
  host.kill("SIGKILL")
  await rm(scratch, { recursive: true, force: true })
}
