// A shell that stops reading must not wedge the daemon's event loop when a
// client writes more than the terminal's input queue holds.
import assert from "node:assert/strict"
import { spawn } from "@lydell/node-pty"

const pty = spawn("/bin/sh", ["-c", "stty raw -echo && printf ready && sleep 60"], { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env })
const exited = new Promise((resolve) => pty.onExit(resolve))
await new Promise((resolve) => { const listener = pty.onData((data) => { if (data.includes("ready")) { listener.dispose(); resolve() } }) })
let ticks = 0
const timer = setInterval(() => { ticks += 1 }, 50)
let shellExited = false
void exited.then(() => { shellExited = true })
// The loop's pace on this runner, now: the yardstick for the second after the write.
await new Promise((resolve) => setTimeout(resolve, 1000))
const before = ticks
const started = performance.now()
pty.write("x".repeat(200_000))
const returned = performance.now() - started
// The shell reads nothing until it exits, a minute from now: a write that waited for room would return only then.
assert.ok(!shellExited, `pty.write blocked the event loop for ${Math.round(returned)} ms, until the shell had gone`)
await new Promise((resolve) => setTimeout(resolve, 1000))
clearInterval(timer)
const after = ticks - before
assert.ok(after * 2 >= before, `the event loop ran ${after} timer ticks in the second after the write, against ${before} in the second before it`)
pty.kill()
await exited
console.log(`Terminal backpressure: a 200 KB write to a non-reading terminal returned in ${Math.round(returned)} ms and the event loop kept running (${after} ticks in the second after it)`)
