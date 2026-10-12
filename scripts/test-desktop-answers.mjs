import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { startWebHost } from "@mako/host/transport/server"
import { runtimeLocation } from "@mako/host/transport/service"
import { z } from "zod"

// The real desktop, main process and preload, against a host that answers a
// few channels: a window gets each answer as the host meant it, though main
// forwards the host's encoding unread and only the preload decodes it.

const root = await mkdtemp(join(tmpdir(), "mako-desktop-answers-"))
const location = runtimeLocation(root)
await mkdir(location.directory, { recursive: true, mode: 0o700 })

// Spaced, escaped and large, as no re-encoding would leave it.
const status = `{ "branch" : "main", "price": 1.50, "e": "\\u00e9", "files": ${JSON.stringify(Array.from({ length: 20_000 }, (_, index) => ({ path: `src/${index}.ts`, staged: index % 2 === 0 })))} }`
const answers = {
  "mako:boot": async () => JSON.stringify({ fixture: "boot" }),
  "mako:git-status": async () => status,
  "mako:git-commit": async () => { throw new Error("Nothing to commit") },
  "mako:git-stage-all": async () => undefined,
}
const host = await startWebHost(location.socket, async (channel) => {
  const answer = answers[channel]
  if (!answer) throw new Error(`The fixture host doesn't answer ${channel}`)
  return answer()
}, async () => new Response(null, { status: 404 }), undefined, {
  protocol: 1, instanceId: randomUUID(), pid: process.pid, version: "fixture", methods: Object.keys(answers),
})

let reported
const result = new Promise((resolve) => { reported = resolve })
const page = createServer((request, response) => {
  if (request.method === "POST" && request.url === "/result") {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => { reported(JSON.parse(Buffer.concat(chunks).toString("utf8"))); response.end() })
    return
  }
  response.end(`<!doctype html><title>Answers</title><script type="module">
    const outcome = async (call) => {
      try { const value = await call(); return { type: typeof value, value } }
      catch (error) { return { error: String(error?.message ?? error) } }
    }
    const results = {
      boot: await outcome(() => window.mako.boot()),
      status: await outcome(() => window.mako.gitStatus()),
      commit: await outcome(() => window.mako.gitCommit("fixture")),
      staged: await outcome(() => window.mako.gitStageAll()),
      crashesDir: await outcome(() => window.mako.crashesDir()),
      badge: await outcome(() => window.mako.setBadgeCount(0)),
    }
    await fetch("/result", { method: "POST", body: JSON.stringify(results) })
  </script>`)
})
page.listen(0, "127.0.0.1")
await once(page, "listening")
const address = z.object({ port: z.number() }).parse(page.address())

const env = { ...process.env, MAKO_DATA_ROOT: root, VITE_DEV_SERVER_URL: `http://127.0.0.1:${address.port}` }
for (const key of ["ELECTRON_RUN_AS_NODE", "MAKO_PROD", "MAKO_PROFILE", "MAKO_WEB_SOCKET", "MAKO_AUTOMATION"]) delete env[key]
const child = spawn(resolve("node_modules/.bin/electron"), [resolve("."), "--background"], { env, stdio: ["ignore", "inherit", "inherit"] })
const exited = once(child, "exit")
let deadline
try {
  const results = await Promise.race([
    result,
    exited.then(([code]) => { throw new Error(`The desktop quit (${code}) before its window reported`) }),
    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("The desktop's window didn't report within 60 seconds")), 60_000) }),
  ])

  assert.deepEqual(results.status, { type: "object", value: JSON.parse(status) }, "a large value the host encoded its own way decodes as the host meant it")
  assert.equal(results.boot.type, "object")
  assert.equal(results.boot.value.fixture, "boot", "boot keeps the host's fields")
  assert.equal(results.boot.value.machine.chooseFolder, true, "boot carries this app's folder chooser")
  assert.equal(results.boot.value.sourceRoot, resolve("."))
  assert.match(results.commit.error ?? "", /Nothing to commit/, "a host failure reaches the window as one")
  assert.deepEqual(results.staged, { type: "undefined" }, "a call that answers nothing answers undefined")
  assert.deepEqual(results.crashesDir, { type: "string", value: join(root, "crashes") }, "main's own answers cross encoded too")
  assert.deepEqual(results.badge, { type: "undefined" }, "a client call that answers nothing answers undefined")
  console.log("Desktop answers: the window decodes main's forwarded and own answers as their senders meant them")
} finally {
  clearTimeout(deadline)
  child.kill("SIGTERM")
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  host.close()
  page.close()
  await rm(root, { recursive: true, force: true })
}
