import assert from "node:assert/strict"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, copyFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { verifyLocalStartup } from "../electron/local-update-startup.js"

const root = await mkdtemp(join(tmpdir(), "mako-startup-probe-"))
const socket = join(root, "host.sock")
const build = "123456789abc"
let mode = "ready"
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json")
  if (mode === "closing") { res.writeHead(503).end(); return }
  if (mode === "malformed") { res.end('{}'); return }
  if (req.url === "/health") {
    res.end(JSON.stringify({ protocol: 1, instanceId: randomUUID(), pid: mode === "old" ? 10 : 20, version: "0.0.1", methods: ["mako:installation-state"] }))
  } else {
    assert.equal(req.url, "/rpc")
    assert.match(String(req.headers["x-mako-window"]), /^[a-f0-9-]{36}$/)
    let body = ""
    req.on("data", (chunk) => { body += chunk })
    req.on("end", () => {
      assert.deepEqual(JSON.parse(body), { channel: "mako:installation-state", args: [] })
      res.end(JSON.stringify({ ok: true, value: { build: { id: mode === "wrong" ? "abcdef123456" : build, builtAt: new Date().toISOString(), revision: null, dirty: false } } }))
    })
  }
})
try {
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  const input = { socket, build, previousPid: 10, timeoutMs: 80 }
  await verifyLocalStartup(input)
  for (const failure of ["old", "wrong", "closing", "malformed"]) {
    mode = failure
    await assert.rejects(verifyLocalStartup(input), /startup was not verified/)
  }
  mode = "closing"
  const timer = setTimeout(() => { mode = "ready" }, 30)
  await verifyLocalStartup({ ...input, timeoutMs: 1000 })
  clearTimeout(timer)
  // The actual detached artifact must work after moving away from node_modules.
  await copyFile("dist-electron/local-update-startup.mjs", join(root, "probe.mjs"))
  // SAFETY: this is the exact startup module built above, copied without modification.
  const detached = await import(pathToFileURL(join(root, "probe.mjs")).href) as typeof import("../electron/local-update-startup.js")
  await detached.verifyLocalStartup(input)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await assert.rejects(verifyLocalStartup(input), /startup was not verified/)
  console.log("Settings startup verification: expected build, old host, wrong build, closing host, malformed reply, absent host and standalone staged artifact passed")
} finally {
  server.closeAllConnections()
  server.close()
  await rm(root, { recursive: true, force: true })
}
