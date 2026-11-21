import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { platform, tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { promisify } from "node:util"
import { GROK_VERSIONS } from "@mako/host/harnesses/grok/versions"
import { PREVIEW_MEDIA_TYPE } from "@mako/control-runtime/preview-contracts"
import { setTimeout as delay } from "node:timers/promises"
import { encodeRuntimeCall } from "@mako/host/contracts/runtime"

/**
 * Browser and computer use is a domain of its own, which a host without the desktop app loads at its first use
 * (`create-host.ts`): the host's own program, started as a joined device runs it, has its core ready and none of
 * control loaded. An agent launched there, with its Local Control session listening and its servers granted, and its
 * turn run, loads none either; nor does a window asking what a conversation shows. The first call to one of
 * control's methods loads it, declares its methods and is answered. A Mac reads its simulators as it says what it can
 * serve, which is a use: there only the answers are checked.
 */
const scratch = await mkdtemp(join(tmpdir(), "mako-control-on-demand-"))
const socket = join(scratch, "h.sock")
// Grok's program, standing in: its version, and an ACP agent that streams a turn (as measure-host's does).
const standIn = join(scratch, "bin")
const launched = join(scratch, "launched")
const quoted = (text) => `'${text.replaceAll("'", "'\\''")}'`
await mkdir(standIn)
await writeFile(join(standIn, "grok"), `#!/bin/sh
case " $* " in
  *" --version "*) echo "grok ${GROK_VERSIONS.tested} (stand-in)"; exit 0 ;;
  *" stdio "*) echo "$$" >> ${quoted(launched)}; ELECTRON_RUN_AS_NODE=1 exec ${quoted(process.execPath)} ${quoted(resolve("scripts/fixtures/acp-stream-agent.mjs"))} ;;
esac
exit 2
`, { mode: 0o755 })
const project = join(scratch, "project")
await mkdir(project)
await promisify(execFile)("git", ["init", "-q", project])
const env = { ...process.env, MAKO_PROD: "1", MAKO_TELEMETRY: "off", MAKO_DATA_ROOT: join(scratch, "data"), MAKO_WEB_SOCKET: socket, HOME: scratch, PATH: [standIn, process.env.PATH].join(delimiter), MEASURE_STREAM_MS: "1500" }
for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "VITE_DEV_SERVER_URL"]) delete env[key]
const host = spawn(process.execPath, [resolve("packages/host/dist/mako-host.js")], { env, stdio: ["ignore", "ignore", "pipe"] })
let said = ""
host.stderr.on("data", (data) => { said = (said + data).slice(-4000) })
const client = randomUUID()

function call(path, body, headers = {}) {
  return new Promise((done, fail) => {
    const req = request({ socketPath: socket, path, method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-mako-window": client, ...headers } }, (response) => {
      const chunks = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () => done({ status: response.statusCode, body: Buffer.concat(chunks).toString() }))
      response.on("error", fail)
    })
    req.on("error", fail)
    req.end(body)
  })
}
const domains = async () => Object.fromEntries(JSON.parse((await call("/health")).body).domains.map((domain) => [domain.name, domain]))
async function until(what, done) {
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await delay(200)) {
    const value = await done().catch(() => undefined)
    if (value) return value
  }
  assert.fail(`${what} within 60 s. The host said: ${said}`)
}

try {
  await until("The host's core loaded", async () => (await domains()).core?.state === "ready")
  const mac = platform() === "darwin"
  if (!mac) {
    // Long enough for what the host starts once its core is ready: none of it is a use of control.
    await delay(5_000)
    const before = (await domains()).control
    assert.equal(before.load, "on-demand", "a host without the desktop app loads control on demand")
    assert.equal(before.state, "unloaded", `nothing loads control on an idle host, but it loaded for ${before.reason}`)
  }
  // What a window asks as it opens, and as `/` is typed in its composer (`test-control-unasked.ts`): the simulators
  // there are for the person, none off a Mac, and the MCP servers.
  if (!mac) {
    const listed = JSON.parse((await call("/rpc", encodeRuntimeCall("mako:simulators-list", [{ kind: "person" }], 1))).body)
    assert.deepEqual(listed.ok && listed.value, { hosts: [], simulators: [], consent: "allowed" }, "a window hears there are no simulators here")
    const servers = JSON.parse((await call("/rpc", encodeRuntimeCall("mako:mcp-discover", [], 1))).body)
    assert.equal(servers.ok, true, `the MCP servers are read: ${servers.error}`)
    assert.equal((await domains()).control.state, "unloaded", "a window opening and its composer's menu load none of control")
  }
  // An agent's launch: its session's folder and socket, its grant on Mako's servers, and a turn streamed.
  const conversationId = randomUUID()
  const started = JSON.parse((await call("/rpc", encodeRuntimeCall("mako:live-start", ["grok", project, { conversationId, title: "Launched", initialRequest: { id: randomUUID(), text: "stream", attachments: [] } }], 1))).body)
  assert.equal(started.ok, true, `the agent launched: ${started.error}`)
  await until("The stand-in agent ran", async () => (await readFile(launched, "utf8")).trim().length > 0)
  await delay(4_000)
  // And a window asking what the conversation shows: nothing, which it hears without control being asked.
  const shown = await call("/rpc", encodeRuntimeCall("mako:control-preview", [conversationId, true, randomUUID()], 1), { accept: PREVIEW_MEDIA_TYPE })
  assert.equal(shown.status, 200, `the preview is answered: ${shown.body.slice(0, 200)}`)
  if (!mac) {
    const launchedWith = (await domains()).control
    assert.equal(launchedWith.state, "unloaded", `an agent's launch, its turn and a preview asked for load none of control, but it loaded for ${launchedWith.reason}`)
  }
  const reply = JSON.parse((await call("/rpc", encodeRuntimeCall("mako:browser-control-status", [], 1))).body)
  assert.equal(reply.ok, true, `control's first call is answered: ${reply.error}`)
  const after = (await domains()).control
  assert.equal(after.state, "ready")
  if (!mac) {
    assert.match(after.reason, /mako:browser-control-status/, "the call that loaded it is its reason")
    assert.ok(after.modules > 50, `control's own modules load with it, not before (${after.modules})`)
  }
  console.log(`control on demand: ${mac ? "answered on a Mac, which loads it to read its simulators" : `unloaded on an idle host and through an agent's launch and turn, loaded in ${after.loadMs} ms (${after.modules} modules) for its first call`}`)
} finally {
  host.kill("SIGTERM")
  await Promise.race([once(host, "exit"), delay(10_000)])
  host.kill("SIGKILL")
  await rm(scratch, { recursive: true, force: true })
}
