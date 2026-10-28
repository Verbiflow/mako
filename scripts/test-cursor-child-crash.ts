import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { CursorSdkClient } from "@mako/host/harnesses/cursor/sdk/client"
import { CURSOR_SDK_EXIT, cursorSdkExitReason } from "@mako/host/harnesses/cursor/sdk/wire"

// An uncaught failure inside the child reaches the host as one bounded log
// line before exit, naming where it was thrown and not what it said.
const secret = "fixture provider input that must stay out of logs"
const inject = `let chunks = 0; process.stdin.on("data", () => { if (++chunks === 2) setImmediate(() => { throw new TypeError(${JSON.stringify(secret)}) }) })`
const crashing = spawn(process.execPath, [
  "--import", `data:text/javascript,${encodeURIComponent(inject)}`,
  resolve("packages/host/dist/harnesses/cursor/sdk/child.js"),
], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH } })
let output = ""
const exited = once(crashing, "exit")
const answered = new Promise<void>((settle) => crashing.stdout.on("data", (chunk: Buffer) => {
  output += chunk.toString()
  if (output.includes("\"id\":1")) settle()
}))
crashing.stdin.write(`${JSON.stringify({ id: 1, method: "hello" })}\n`)
await answered
crashing.stdin.write("\n")
const [code] = await exited
assert.equal(code, CURSOR_SDK_EXIT.fatal)
assert.match(cursorSdkExitReason(code) ?? "", /uncaught error/)
const fatal = output.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((line) => line.event === "log" && String(line.message).startsWith("fatal exception: TypeError"))
assert.ok(fatal, `the child reported its fatal error: ${output}`)
assert.ok(!output.includes(secret), "the crash report omits the error message")
crashing.stdin.destroy()

// The SDK leaves a failed spawn's rejection unobserved after reporting it to
// the tool call, and a failed exec's write to its already closed stream
// (named as the SDK names it); neither can end the turn. An unowned
// connection rejection still does, even if it carries the obsolete
// RPC-specific marker.
const sdkModules = join(dirname(createRequire(import.meta.url).resolve("@cursor/sdk")), "..", "esm")
const sdkBundle = readdirSync(sdkModules).filter((file) => file.endsWith(".js")).map((file) => readFileSync(join(sdkModules, file), "utf8"))
assert.ok(sdkBundle.some((source) => source.includes(`this.name="WriteIterableClosedError"`)),
  "the SDK no longer names its closed-stream error WriteIterableClosedError; find what its unawaited exec writes reject with now")
const closedStream = `class ClosedStream extends Error { constructor(message) { super(message); this.name = "WriteIterableClosedError" } }`
const rejecting = spawn(process.execPath, [
  "--import", `data:text/javascript,${encodeURIComponent(`${closedStream}; let chunks = 0; process.stdin.on("data", () => { chunks += 1; if (chunks === 2) { Promise.reject(Object.assign(new Error(${JSON.stringify(secret)}), { code: "ENOENT", syscall: "spawn /bin/zsh" })); Promise.reject(new ClosedStream(${JSON.stringify(secret)})) } if (chunks === 4) { const error = Object.assign(new Error(${JSON.stringify(secret)}), { name: "ConnectError", code: 14 }); Object.defineProperty(error, Symbol.for("mako.cursor-sdk.team-repos-unavailable"), { value: true }); Promise.reject(error) } })`)}`,
  resolve("packages/host/dist/harnesses/cursor/sdk/child.js"),
], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH } })
let rejected = ""
const rejectingExit = once(rejecting, "exit")
const rejectingEnded = once(rejecting.stdout, "end")
rejecting.stdout.on("data", (chunk: Buffer) => { rejected += chunk.toString() })
function replied(pattern: RegExp) {
  return new Promise<void>((settle) => {
    const check = () => { if (pattern.test(rejected)) { rejecting.stdout.off("data", check); settle() } }
    rejecting.stdout.on("data", check)
    check()
  })
}
rejecting.stdin.write(`${JSON.stringify({ id: 1, method: "hello" })}\n`)
await replied(/"id":1/)
rejecting.stdin.write("\n")
await replied(/ignored an unobserved SDK rejection: Error ENOENT spawn \/bin\/zsh/)
await replied(/ignored an unobserved SDK rejection: WriteIterableClosedError/)
rejecting.stdin.write(`${JSON.stringify({ id: 2, method: "hello" })}\n`)
await replied(/"id":2/)
rejecting.stdin.write("\n")
const [rejectingCode] = await rejectingExit
await rejectingEnded
assert.equal(rejectingCode, CURSOR_SDK_EXIT.fatal, "an unowned rejection stays fatal")
assert.match(rejected, /fatal rejection: ConnectError unavailable/)
assert.ok(!rejected.includes(secret), "neither report carries the error message")
rejecting.stdin.destroy()

// A broken protocol pipe cannot carry a report, so the exit code names it.
const brokenPipe = spawn(process.execPath, [
  "--import", `data:text/javascript,${encodeURIComponent(`process.stdin.once("data", () => setImmediate(() => process.stdout.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }))))`)}`,
  resolve("packages/host/dist/harnesses/cursor/sdk/child.js"),
], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH } })
const brokenExit = once(brokenPipe, "exit")
brokenPipe.stdin.write(`${JSON.stringify({ id: 1, method: "hello" })}\n`)
const [brokenCode] = await brokenExit
assert.equal(brokenCode, CURSOR_SDK_EXIT.stdoutError)
assert.match(cursorSdkExitReason(brokenCode) ?? "", /protocol pipe/)
brokenPipe.stdin.destroy()

// A child that exhausts its V8 heap names that on exit, through the real
// client, and nothing else from its stderr reaches the host.
const oomRoot = mkdtempSync(join(tmpdir(), "mako-cursor-oom-"))
try {
  const allocate = join(oomRoot, "allocate.mjs")
  writeFileSync(allocate, `process.stdin.once("data", () => setTimeout(() => { process.stderr.write(${JSON.stringify(secret)}); const kept = []; for (;;) kept.push("x".repeat(100_000) + kept.length) }, 20))`)
  const node = join(oomRoot, "node")
  writeFileSync(node, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --max-old-space-size=24 --import ${JSON.stringify(pathToFileURL(allocate).href)} "$@"\n`)
  chmodSync(node, 0o755)
  const client = new CursorSdkClient({ owner: "oom-fixture", cwd: oomRoot, env: { PATH: process.env.PATH }, onEvent: () => {}, execPath: node, entry: resolve("packages/host/dist/harnesses/cursor/sdk/child.js") })
  await client.hello().catch(() => {})
  const exit = await client.exited
  assert.equal(exit.fatal, "it ran out of JavaScript heap", `a heap exhaustion is named on exit: ${JSON.stringify(exit)}`)
  assert.ok(!JSON.stringify(exit).includes(secret), "the exit carries only the marker's meaning")
} finally {
  rmSync(oomRoot, { recursive: true, force: true })
}
console.log("Cursor child crash: fatal exception reported once without its message; a failed spawn's rejection and a closed exec stream's write are contained while any other stays fatal; a broken pipe exits with its own code; a heap exhaustion is named on exit without stderr content passed")
