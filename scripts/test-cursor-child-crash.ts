import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { resolve } from "node:path"
import { CURSOR_SDK_EXIT, cursorSdkExitReason } from "../electron/providers/cursor/sdk/wire.ts"

// An uncaught failure inside the child reaches the host as one bounded log
// line before exit, naming where it was thrown and not what it said.
const secret = "fixture provider input that must stay out of logs"
const inject = `let chunks = 0; process.stdin.on("data", () => { if (++chunks === 2) setImmediate(() => { throw new TypeError(${JSON.stringify(secret)}) }) })`
const crashing = spawn(process.execPath, [
  "--import", `data:text/javascript,${encodeURIComponent(inject)}`,
  resolve("dist-electron/providers/cursor/sdk/child.js"),
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
// the tool call; that one cannot end the turn, and any other rejection still does.
const rejecting = spawn(process.execPath, [
  "--import", `data:text/javascript,${encodeURIComponent(`let chunks = 0; process.stdin.on("data", () => { chunks += 1; if (chunks === 2) Promise.reject(Object.assign(new Error(${JSON.stringify(secret)}), { code: "ENOENT", syscall: "spawn /bin/zsh" })); if (chunks === 4) Promise.reject(new TypeError(${JSON.stringify(secret)})) })`)}`,
  resolve("dist-electron/providers/cursor/sdk/child.js"),
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
rejecting.stdin.write(`${JSON.stringify({ id: 2, method: "hello" })}\n`)
await replied(/"id":2/)
rejecting.stdin.write("\n")
const [rejectingCode] = await rejectingExit
await rejectingEnded
assert.equal(rejectingCode, CURSOR_SDK_EXIT.fatal, "an ordinary rejection stays fatal")
assert.match(rejected, /fatal rejection: TypeError/)
assert.ok(!rejected.includes(secret), "neither report carries the error message")
rejecting.stdin.destroy()

// A broken protocol pipe cannot carry a report, so the exit code names it.
const brokenPipe = spawn(process.execPath, [
  "--import", `data:text/javascript,${encodeURIComponent(`process.stdin.once("data", () => setImmediate(() => process.stdout.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }))))`)}`,
  resolve("dist-electron/providers/cursor/sdk/child.js"),
], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH } })
const brokenExit = once(brokenPipe, "exit")
brokenPipe.stdin.write(`${JSON.stringify({ id: 1, method: "hello" })}\n`)
const [brokenCode] = await brokenExit
assert.equal(brokenCode, CURSOR_SDK_EXIT.stdoutError)
assert.match(cursorSdkExitReason(brokenCode) ?? "", /protocol pipe/)
brokenPipe.stdin.destroy()
console.log("Cursor child crash: fatal exception reported once without its message; a failed spawn's rejection is contained while any other stays fatal; a broken pipe exits with its own code passed")
