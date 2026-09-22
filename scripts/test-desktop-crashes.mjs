import { build } from "esbuild"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { startWebHost } from "../dist-electron/web-host.js"
import { runtimeLocation } from "../dist-electron/runtime-service.js"
import { z } from "zod"

const root = await mkdtemp(join(tmpdir(), "mako-desktop-crashes-"))
await symlink(resolve("node_modules"), join(root, "node_modules"))
await copyFile(resolve("dist-electron/preload.cjs"), join(root, "preload.cjs"))
await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-crash-fixture", version: "0.0.1", type: "module", main: "check.mjs" }))
await build({ entryPoints: ["scripts/desktop-crash-check.ts"], bundle: true, platform: "node", format: "esm", packages: "external", outfile: join(root, "check.mjs") })
const dataRoot = join(root, "profile")
const location = runtimeLocation(dataRoot)
await mkdir(location.directory, { recursive: true, mode: 0o700 })
const forwarded = []
const startHost = () => startWebHost(location.socket, async (channel) => {
  forwarded.push(channel)
  return "{}"
}, async () => new Response(null, { status: 404 }), undefined, {
  protocol: 1, instanceId: randomUUID(), pid: process.pid, version: "fixture", methods: ["mako:boot"],
})
let host = await startHost()
const page = createServer((request, response) => {
  void (async () => {
    if (request.method === "POST" && request.url === "/offline") {
      host.close()
      response.end("offline")
    } else if (request.method === "POST" && request.url === "/online") {
      host = await startHost()
      response.end("online")
    } else if (request.method === "POST" && request.url === "/complete") {
      for (let run = 0; run < 20; run++) {
        for (const status of ["running", "ready"])
          host.event({ type: "live-session", session: { id: "fixture", harness: "fixture", cwd: root, status, modes: [], currentMode: null, configOptions: [] } })
      }
      response.end("completed")
    } else if (request.url === "/status") {
      response.end(JSON.stringify({ clients: host.clients(), forwarded }))
    } else response.end(`<!doctype html><title>Crash fixture</title><script>
      window.finished = 0;
      window.mako.onEvent(event => {
        if (event.type === 'live-session' && event.session.status === 'ready') window.finished++;
      });
      document.title = 'Ready';
    </script>`)
  })().catch((error) => { response.writeHead(500).end(String(error)) })
})
page.listen(0, "127.0.0.1")
await once(page, "listening")
const address = z.object({ port: z.number() }).parse(page.address())
const env = { ...process.env, MAKO_DATA_ROOT: dataRoot, MAKO_CLIENT_ID: "crash-test", VITE_DEV_SERVER_URL: `http://127.0.0.1:${address.port}` }
for (const key of ["ELECTRON_RUN_AS_NODE", "MAKO_HOST_ONLY", "MAKO_STANDALONE", "MAKO_PROD", "MAKO_PROFILE"]) delete env[key]
const child = spawn(resolve("node_modules/.bin/electron"), [root, "--background"], { env, stdio: "inherit" })
const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
try {
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
} finally {
  clearTimeout(timer)
  host.close()
  page.close()
  await rm(location.directory, { recursive: true, force: true })
}
console.log(`Desktop crash evidence: ${root}`)
