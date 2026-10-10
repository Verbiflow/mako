import { spawn } from "node:child_process"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { openCodeProcessProbeFor } from "../electron/providers/opencode/process-probe.js"
import { OpenCodeServers } from "../electron/providers/opencode/servers.js"

const root = await mkdtemp(join(tmpdir(), "mako-opencode-activity-"))
let mode = "active"
let activeReads = 0
let healthReads = 0
const server = createServer((request, response) => {
  if (
    request.headers.authorization !==
    `Basic ${Buffer.from("opencode:fixture").toString("base64")}`
  ) {
    response.writeHead(401).end()
    return
  }
  response.setHeader("content-type", "application/json")
  if (request.url === "/api/health") {
    healthReads++
    response.end(
      JSON.stringify({
        healthy: true,
        pid: mode === "stale" ? 999 : process.pid,
        version: "fixture-v2",
      })
    )
    return
  }
  activeReads++
  if (mode === "unauthorized") {
    response.writeHead(401).end()
    return
  }
  if (mode === "malformed") {
    response.end("not json")
    return
  }
  if (mode === "oversized") {
    response.end(" ".repeat(600 * 1024))
    return
  }
  response.end(
    JSON.stringify({
      data: mode === "idle" ? {} : { ses_fixture: { type: "running" } },
    })
  )
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const { port } = z.object({ port: z.number() }).parse(server.address())
try {
  const servers = new OpenCodeServers()
  const probe = openCodeProcessProbeFor(servers, { stateRoot: root })
  const poll = () => probe.probe(AbortSignal.timeout(1000))
  assert.deepEqual(await poll(), { kind: "available", sessions: [] })
  if (process.platform !== "win32") {
    const command = join(root, "opencode")
    await copyFile("/bin/sleep", command)
    const unregistered = spawn(command, ["300"], { stdio: "ignore" })
    try {
      await new Promise<void>((resolve, reject) => { unregistered.once("spawn", resolve); unregistered.once("error", reject) })
      const observed = await probe.probe(AbortSignal.timeout(2000), { nativeId: "ses_fixture", path: "/fixture/native.db#ses_fixture" })
      assert.deepEqual(observed, { kind: "unavailable", reason: "incomplete" }, "a live unregistered stdio server cannot be cleared by absent service registration")
      // The same process as one of this host's own servers answers for itself.
      // Only it runs here, whatever else OpenCode runs on this Mac.
      const pid = unregistered.pid!
      const own = servers.add(pid)
      const alone = openCodeProcessProbeFor(servers, { stateRoot: root, processes: async () => ({ kind: "available", paths: [], processFound: true, pids: [pid] }) })
      const target = { nativeId: "ses_fixture", path: "/fixture/native.db#ses_fixture" }
      assert.deepEqual(await alone.probe(AbortSignal.timeout(2000), target), { kind: "available", sessions: [] },
        "an own server whose API isn't up yet has opened no session")
      const runs = (sessions: string[]) => ({ session: { active: async () => Object.fromEntries(sessions.map((id) => [id, { type: "running" as const }])) } })
      own.answers(runs([]))
      assert.deepEqual(await alone.probe(AbortSignal.timeout(2000), target), { kind: "available", sessions: [] },
        "an own server running another session leaves this one free to wake")
      own.answers(runs(["ses_fixture"]))
      assert.deepEqual(await alone.probe(AbortSignal.timeout(2000), target), { kind: "available", sessions: [{ nativeId: "ses_fixture", status: "active" }] })
      own.answers({ session: { active: async () => { throw new Error("closing") } } })
      assert.deepEqual(await alone.probe(AbortSignal.timeout(2000), target), { kind: "unavailable", reason: "incomplete" },
        "an own server that doesn't say what it runs counts as unknown")
      own.exited()
    } finally {
      if (unregistered.exitCode === null && unregistered.signalCode === null) {
        const closed = new Promise<void>(resolve => unregistered.once("exit", () => resolve()))
        unregistered.kill("SIGTERM")
        await closed
      }
    }
  }
  await writeFile(
    join(root, "service.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${port}`,
      pid: process.pid,
      version: "fixture-v2",
      password: "fixture",
    })
  )
  assert.deepEqual(await poll(), {
    kind: "available",
    sessions: [{ nativeId: "ses_fixture", status: "active" }],
  })
  const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
  const exitedPid = exited.pid
  assert.ok(exitedPid)
  await new Promise<void>((resolve, reject) => {
    exited.once("error", reject)
    exited.once("exit", () => resolve())
  })
  await writeFile(join(root, "service-stale.json"), JSON.stringify({
    url: `http://127.0.0.1:${port}`, pid: exitedPid, version: "fixture-v2",
  }))
  const beforeStalePoll = healthReads
  assert.deepEqual(await poll(), {
    kind: "available", sessions: [{ nativeId: "ses_fixture", status: "active" }],
  }, "a dead registration cannot hide a genuinely active service")
  assert.equal(healthReads, beforeStalePoll + 1, "a dead PID is not contacted")
  await rm(join(root, "service.json"))
  const beforeDeadOnly = healthReads
  assert.deepEqual(await poll(), { kind: "available", sessions: [] })
  assert.equal(healthReads, beforeDeadOnly)
  await rm(join(root, "service-stale.json"))
  await writeFile(join(root, "service.json"), JSON.stringify({
    url: `http://127.0.0.1:${port}`, pid: process.pid, version: "fixture-v2", password: "fixture",
  }))
  mode = "idle"
  assert.deepEqual(await poll(), { kind: "available", sessions: [] })
  const reads = activeReads
  mode = "stale"
  assert.equal((await poll()).kind, "unavailable")
  assert.equal(activeReads, reads)
  for (const failure of ["unauthorized", "malformed", "oversized"]) {
    mode = failure
    assert.equal((await poll()).kind, "unavailable")
  }
  await writeFile(join(root, "service.json"), " ".repeat(70 * 1024))
  assert.equal((await poll()).kind, "unavailable")
  console.log(
    "OpenCode v2 activity: authenticated identity, active/idle transitions, dead registration alongside live owner, live PID mismatch, malformed and oversized responses, and this host's own unregistered servers passed"
  )
} finally {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  await rm(root, { recursive: true, force: true })
}
