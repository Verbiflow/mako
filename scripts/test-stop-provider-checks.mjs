import assert from "node:assert/strict"
import { chmod, cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { startHost } from "./linux-host/host-process.mjs"
import { KEPT, testScratch } from "./lib/test-scratch.mjs"

/*
 * A host stops promptly while a harness's sign-in check waits on a child that never answers
 * (`npm run test:stop-provider-checks`).
 *
 * On 2026-11-08 CI's update checks killed a host still stopping 15 s after it was asked to: it waits for the calls it's
 * answering, and Settings' `mako:provider-connections` waited on Cursor's sign-in check, a child of the Cursor SDK's
 * that hadn't answered (`authStatus` waits up to a minute). Locally the same wait took a stop from 0.25 s to 1–5 s.
 * Now a connection's check under way ends as the host begins to stop (`ProviderConnectionCapability.stop`).
 *
 * Cursor's child here (`CURSOR_SDK_CHILD`) answers its hello and nothing after, and ignores its stdin closing. The
 * host is stopped twice in this run: once with nothing under way (the yardstick), once while Settings' check waits on
 * that child. The second must exit cleanly within `TIMES` times the first, leave the child gone, and log no failure.
 *
 * Needs the built host: `npx tsgo -b packages/host`.
 */
const TIMES = 5
const scratch = testScratch("mako-stop-provider-checks-")
const bin = join(scratch, "bin")
await mkdir(bin)
const program = resolve("packages/host/dist/mako-host.js")
await chmod(program, 0o755)
await symlink(program, join(bin, "mako-host"))

// Cursor's SDK child, as one wedged after its hello: every request after it goes unanswered, and its stdin closing
// changes nothing. It notes each request and its pid.
const loginAsked = join(scratch, "login-asked.log")
const asked = join(scratch, "cursor-asked.log")
const child = join(scratch, "cursor-child.mjs")
await writeFile(child, `import { appendFileSync } from "node:fs"
let buffered = ""
process.stdin.on("data", (chunk) => {
  buffered += chunk
  for (let at = buffered.indexOf("\\n"); at >= 0; at = buffered.indexOf("\\n")) {
    const line = buffered.slice(0, at)
    buffered = buffered.slice(at + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    appendFileSync(${JSON.stringify(asked)}, \`\${process.pid} \${request.method}\\n\`)
    if (request.method === "hello") process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { wire: 6, sdkVersion: "0.0.0-wedged", node: process.version } }) + "\\n")
  }
})
process.stdin.on("end", () => {})
setInterval(() => {}, 1_000)
`)

// A real provider-login process, with a page but no eventual sign-in.
const loginChild = join(bin, "claude-login")
await writeFile(loginChild, `#!${process.execPath}
import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(loginAsked)}, String(process.pid) + "\\n")
process.stdout.write("https://example.com/sign-in\\n")
process.stdin.resume()
process.stdin.on("end", () => {})
setInterval(() => {}, 1_000)
`, { mode: 0o700 })

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MAKO_") && !key.startsWith("CURSOR_"))),
  PATH: `${bin}:${process.env.PATH}`,
  CURSOR_SDK_CHILD: child,
  CLAUDE_CODE_EXECUTABLE: loginChild,
}

/** A host on its own home and data root, stopped after `meanwhile`: how its stop went, and its log. */
async function stopAfter(name, meanwhile) {
  const home = join(scratch, name, "home")
  const dataRoot = join(scratch, name, "data")
  await mkdir(home, { recursive: true })
  const host = await startHost({ dataRoot, output: join(scratch, name, "host-output.log"), env: { ...env, HOME: home } })
  let stopped
  try {
    assert.ok((await host.call("mako:harness-descriptors")).length > 0, "the host answers")
    await meanwhile(host)
  } finally {
    stopped = await host.stop()
  }
  const log = await readFile(join(dataRoot, "logs", "host.log"), "utf8").catch(() => "")
  return { stopped, log, dataRoot }
}

/** Every pid Cursor's child noted, with what it was asked. */
async function childrenAsked() {
  const lines = existsSync(asked) ? (await readFile(asked, "utf8")).trim().split("\n").filter(Boolean) : []
  return lines.map((line) => ({ pid: Number(line.split(" ")[0]), method: line.split(" ")[1] }))
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const idle = await stopAfter("idle", async () => {})
let connections
const waiting = await stopAfter("waiting", async (host) => {
  connections = host.call("mako:provider-connections", true).catch(() => undefined)
  // Until Cursor's check has asked its child more than its hello.
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; await delay(50))
    if ((await childrenAsked()).some(({ method }) => method === "authStatus" || method === "me")) break
  assert.ok((await childrenAsked()).some(({ method }) => method === "authStatus" || method === "me"), `Cursor's check asked its child: ${JSON.stringify(await childrenAsked())}`)
})
await connections

const limit = idle.stopped.stopMs * TIMES
console.log(`stopped with nothing under way in ${Math.round(idle.stopped.stopMs)} ms; with Cursor's check waiting on a child that never answers, in ${Math.round(waiting.stopped.stopMs)} ms (limit ${Math.round(limit)} ms, ${TIMES} times the first)`)
const slow = waiting.stopped.code !== 0 || waiting.stopped.stopMs >= limit
if (slow) {
  // What it waited on is in its own log, which goes with the scratch folder: kept for the job's artifacts.
  const into = join(process.env.MAKO_TEST_EVIDENCE ?? KEPT, "stop-provider-checks")
  await mkdir(into, { recursive: true })
  await cp(join(waiting.dataRoot, "logs"), into, { recursive: true }).catch(() => undefined)
  console.error(`Its logs are in ${into}. The end of its log:\n${waiting.log.split("\n").slice(-60).join("\n")}`)
}
assert.equal(waiting.stopped.code, 0, `the host stopped cleanly: ${JSON.stringify(waiting.stopped)}`)
assert.ok(waiting.stopped.stopMs < limit, `the host took ${Math.round(waiting.stopped.stopMs)} ms to stop, not under ${Math.round(limit)} ms`)
// A child killed as the host stopped may take a moment to be reaped.
const pids = [...new Set((await childrenAsked()).map(({ pid }) => pid))]
for (const deadline = Date.now() + limit; Date.now() < deadline && pids.some(alive); ) await delay(20)
assert.deepEqual(pids.filter(alive), [], "no Cursor child is left running")
assert.doesNotMatch(waiting.log, /auth probe failed/, "the check its stop ended isn't logged as a failure")
assert.doesNotMatch(waiting.log, /stopping is slow/, "nor is the stop slow")
let loginWait
const signingIn = await stopAfter("login", async (host) => {
  const login = await host.call("mako:account-login-start", "claude")
  assert.equal(login.url, "https://example.com/sign-in")
  loginWait = assert.rejects(host.call("mako:account-login-wait", login.id), /Mako quit before sign-in finished; sign in again/)
  // The call must reach the host before SIGTERM: a later call is only an admission test.
  for (const deadline = Date.now() + 5_000; ; await delay(20)) {
    const log = await readFile(host.log, "utf8")
    if (log.includes("waiting for sign-in")) break
    assert.ok(Date.now() < deadline, "the host admitted the login waiter before SIGTERM")
  }
})
await loginWait
assert.equal(signingIn.stopped.code, 0, `the host stopped cleanly with a login pending: ${JSON.stringify(signingIn.stopped)}`)
assert.ok(signingIn.stopped.stopMs < limit, `a login pending took ${Math.round(signingIn.stopped.stopMs)} ms, limit ${Math.round(limit)} ms`)
const loginPids = (await readFile(loginAsked, "utf8")).trim().split("\n").map(Number)
for (const deadline = Date.now() + limit; Date.now() < deadline && loginPids.some(alive); ) await delay(20)
assert.deepEqual(loginPids.filter(alive), [], "no login child survives the host")
assert.doesNotMatch(signingIn.log, /stopping is slow|auth probe failed/)
console.log(`stop provider checks: a wedged auth check and a pending login both end before the call drain (login ${Math.round(signingIn.stopped.stopMs)} ms)`)
