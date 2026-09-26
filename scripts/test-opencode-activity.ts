import { spawn } from "node:child_process"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { openCodeProcessProbeFor } from "../electron/providers/opencode/process-probe.js"

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
  const probe = openCodeProcessProbeFor(root)
  const poll = () => probe.probe(AbortSignal.timeout(1000))
  assert.deepEqual(await poll(), { kind: "available", sessions: [] })
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
    "OpenCode v2 activity: authenticated identity, active/idle transitions, dead registration alongside live owner, live PID mismatch, malformed and oversized responses passed"
  )
} finally {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  await rm(root, { recursive: true, force: true })
}
