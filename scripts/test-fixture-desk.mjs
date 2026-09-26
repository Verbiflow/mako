import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { request } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createServer } from "vite"
import { runtimeLocation } from "../dist-electron/runtime-service.js"
import { runtimeInfo } from "../dist-electron/runtime-connection.js"
import { hostCallInputs } from "../dist-electron/contracts/host-call-inputs.js"
import { readOnlyHostCalls, replayableHostCalls } from "../dist-electron/contracts/host-call-policy.js"
import { fixtureDeskHostCalls, fixtureDeskRefusal } from "../dist-electron/contracts/fixture-desk-policy.js"
import { publishDevRendererRegistration } from "../dist-electron/dev-renderer-registration.js"
import { registeredDeskBrowsers } from "../packages/control-runtime/dist/desk-browser-registration.js"
import { webHostProxy } from "../electron/web-dev-proxy.mjs"

for (const channel of fixtureDeskHostCalls) {
  assert.ok(channel in hostCallInputs, `${channel} is a host call`)
  // Boot builds the provider-free workspace shell, which is state, so it is not replay-safe.
  assert.ok(readOnlyHostCalls.has(channel) || channel === "mako:boot", `${channel} is a read`)
  assert.ok(!replayableHostCalls.has(channel), `${channel} is not a replayed mutation`)
}
for (const channel of ["mako:live-start", "mako:list-models", "mako:git-status", "mako:terminal-create", "mako:live-read", "mako:browser-control-status", "mako:control-preview"])
  assert.ok(fixtureDeskRefusal(channel), `${channel} is refused`)
assert.ok(fixtureDeskRefusal("mako:lifecycle-command"), "Pages never stop the fixture host")
assert.equal(fixtureDeskRefusal("mako:lifecycle-command", "socket"), undefined, "The launcher may replace an outdated fixture host")

const root = resolve(".")
const scratch = await mkdtemp(join(tmpdir(), "mako-fixture-desk-"))
const dataRoot = join(scratch, "fixture-host")
const location = runtimeLocation(dataRoot)
await mkdir(location.directory, { recursive: true, mode: 0o700 })
const profile = `fixture-test-${process.pid}`
const server = await createServer({
  cacheDir: join(scratch, "vite"),
  logLevel: "silent",
  define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true", "import.meta.env.MAKO_SHARED_RUNTIME": "true", "import.meta.env.MAKO_CLIENT_PROFILE": JSON.stringify(profile), "import.meta.env.MAKO_SOURCE_ROOT": JSON.stringify(root) },
  plugins: [webHostProxy(location.socket, { refuse: fixtureDeskRefusal })],
  server: { host: "127.0.0.1", port: 0 },
})
await server.listen()
const url = server.resolvedUrls.local[0]
const origin = new URL(url).origin
const env = { ...process.env, MAKO_DATA_ROOT: dataRoot, MAKO_PROFILE: profile, MAKO_FIXTURE_DESK: "1", MAKO_HOST_ONLY: "1", MAKO_WEB_ONLY: "1", MAKO_WEB_SOCKET: location.socket, MAKO_BACKEND_URL: "http://127.0.0.1:9/api/mcp", MAKO_BACKEND_TOKEN: "" }
for (const key of ["ELECTRON_RUN_AS_NODE", "MAKO_PROD", "MAKO_STANDALONE", "VITE_DEV_SERVER_URL", "MAKO_RELAY"]) delete env[key]
const electron = createRequire(import.meta.url)("electron")
let host
let removeRenderer = () => {}
let cdp

const until = async (read, label, ms = 90_000) => {
  const end = Date.now() + ms
  for (;;) {
    const value = await read().catch(() => undefined)
    if (value) return value
    if (Date.now() > end) throw new Error(`Timed out: ${label}`)
    await new Promise((done) => setTimeout(done, 100))
  }
}
const post = (options, body) => new Promise((done, fail) => {
  const outgoing = request({ method: "POST", ...options }, (response) => {
    const chunks = []
    response.on("data", (chunk) => chunks.push(chunk))
    response.on("end", () => done({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }))
  })
  outgoing.on("error", fail)
  outgoing.setTimeout(15_000, () => outgoing.destroy(new Error(`No reply to ${body.slice(0, 120)}`)))
  outgoing.end(body)
})
const call = (channel, ...args) => JSON.stringify({ channel, args: args.map((value) => ({ kind: "value", value })) })
const socketCall = async (body) => JSON.parse((await post({ socketPath: location.socket, path: "/rpc", headers: { "content-type": "application/json" } }, body)).body)
const pageCall = async (body) => {
  const target = new URL("/__mako/rpc", url)
  const reply = await post({ host: target.hostname, port: target.port, path: target.pathname, headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin", "x-mako-client": "web" } }, body)
  return { status: reply.status, reply: reply.status === 200 ? JSON.parse(reply.body) : reply.body }
}

try {
  host = spawn(electron, [root, "--background"], { env, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  const trace = process.env.MAKO_TEST_TRACE === "1"
  host.stdout.on("data", (chunk) => { output += chunk; if (trace) process.stdout.write(chunk) })
  host.stderr.on("data", (chunk) => { output += chunk; if (trace) process.stderr.write(chunk) })
  const info = await until(() => runtimeInfo(location.socket), "fixture host")
  console.log(`Fixture host ${info.pid} is ready`)
  assert.equal(info.pid, host.pid)
  assert.equal(info.fixture, true, "The host reports that it is a fixture desk")

  // Garbage arguments: a refusal here, not a validation error, shows the check
  // ran before the handler's schema and so before the handler.
  const automations = (await socketCall(call("mako:automations"))).value
  for (const channel of ["mako:live-start", "mako:list-models", "mako:git-status", "mako:terminal-create", "mako:save-automations", "mako:relaunch", "mako:thread-archive", "mako:not-a-channel"]) {
    const reply = await socketCall(call(channel, { garbage: true }, 7))
    assert.equal(reply.ok, false, channel)
    assert.equal(reply.code, "fixture-refused", `${channel} on the socket: ${JSON.stringify(reply)}`)
  }
  assert.deepEqual((await socketCall(call("mako:terminal-list"))).value, [], "A refused terminal-create started no process")
  assert.deepEqual((await socketCall(call("mako:automations"))).value, automations, "A refused save wrote nothing")
  assert.equal((await socketCall(call("mako:threads"))).ok, true, "Allowed reads run")
  assert.equal((await socketCall(call("mako:boot"))).ok, true, "The interface can boot")
  const lifecycle = await socketCall(call("mako:lifecycle-command", { kind: "cancel" }))
  assert.notEqual(lifecycle.code, "fixture-refused", "The launcher can still replace the fixture host")
  const malformed = await socketCall("{\"channel\":")
  assert.equal(malformed.ok, false, "A malformed call is not run")

  for (const channel of ["mako:live-start", "mako:lifecycle-command", "mako:list-models", "mako:not-a-channel"]) {
    const { reply } = await pageCall(call(channel, { kind: "cancel" }))
    assert.equal(reply.code, "fixture-refused", `${channel} through the page proxy: ${JSON.stringify(reply)}`)
  }
  assert.equal((await pageCall("not json")).reply.code, "fixture-refused", "A body that names no call is refused at the proxy")
  assert.equal((await pageCall(JSON.stringify({ args: [] }))).reply.code, "fixture-refused")
  const read = await pageCall(call("mako:threads"))
  assert.equal(read.reply.ok, true, `Allowed reads pass the proxy byte for byte: ${JSON.stringify(read)}`)
  console.log("Socket and page proxy refusals hold")

  // Hidden desk windows live inside the host and call its handlers over IPC,
  // never through the socket or the proxy.
  removeRenderer = publishDevRendererRegistration(dirname(location.socket), { profile, sourceRoot: root, url })
  const desk = await until(async () => registeredDeskBrowsers().find((browser) => browser.profile === profile), "desk registration")
  assert.equal(desk.fixture, true, "Agents discovering the desk see a fixture desk")
  console.log("Desk registered as a fixture")
  cdp = new WebSocket(await desk.endpoint())
  await new Promise((done, fail) => { cdp.onopen = done; cdp.onerror = fail })
  let sequence = 0
  const pending = new Map()
  cdp.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const held = pending.get(message.id)
    if (!held) return
    pending.delete(message.id)
    if (message.error) held.fail(new Error(message.error.message))
    else held.done(message.result)
  }
  const send = (method, params = {}, sessionId) => new Promise((done, fail) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${method} timed out`)) }, 30_000)
    pending.set(id, { done: (value) => { clearTimeout(timer); done(value) }, fail: (error) => { clearTimeout(timer); fail(error) } })
    cdp.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const { targetId } = await send("Target.createTarget", {})
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true })
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  console.log(`Hidden desk window ${targetId} attached`)
  await until(() => evaluate("Boolean(window.mako)"), "desk bridge")
  const outcome = (expression) => evaluate(`${expression}.then(() => "ran", (error) => String(error?.message ?? error))`)
  for (const [label, expression] of [
    ["live-start", `window.mako.liveStart("codex", "/tmp", { conversationId: crypto.randomUUID() })`],
    ["terminal-create", `window.mako.terminalCreate({ cwd: "/tmp" })`],
    ["list-models", `window.mako.listModels()`],
    ["lifecycle-command", `window.mako.lifecycleCommand({ kind: "cancel" })`],
    ["save-automations", `window.mako.saveAutomations([])`],
  ]) assert.match(await outcome(expression), /fixture desk refused/, `A hidden desk window's ${label} is refused`)
  assert.deepEqual((await socketCall(call("mako:automations"))).value, automations, "No desk window wrote automations")
  assert.equal(await outcome("window.mako.threads()"), "ran", "A hidden desk window can read")
  assert.deepEqual((await socketCall(call("mako:terminal-list"))).value, [], "No desk window started a terminal")
  await send("Target.closeTarget", { targetId })
  assert.equal(host.exitCode, null, `The fixture host stayed up: ${output.slice(-2000)}`)
  console.log("PASS: a fixture desk host refuses writes, provider, git, process and unknown calls from its socket, its page proxy and its own hidden desk windows before any handler runs; allowed reads and boot still work; the desk is registered as a fixture")
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  cdp?.close()
  removeRenderer()
  if (host && host.exitCode === null) {
    const exited = once(host, "exit")
    const within = (ms) => Promise.race([exited.then(() => true), new Promise((done) => setTimeout(() => done(false), ms))])
    // The launcher's own path: the host quits once it has nothing running.
    const quit = await socketCall(call("mako:lifecycle-command", { kind: "wait", action: "quit" })).catch((error) => ({ ok: false, error: error.message }))
    if (!(await within(20_000))) {
      console.error(`Fixture host ${host.pid} did not quit through its lifecycle: ${JSON.stringify(quit)}`)
      process.exitCode = 1
      host.kill("SIGTERM")
      if (!(await within(3_000))) host.kill("SIGKILL")
      await exited
    }
  }
  await server.close()
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  await rm(location.directory, { recursive: true, force: true })
  process.exit(process.exitCode ?? 0)
}
