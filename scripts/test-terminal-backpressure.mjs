// A shell that stops reading must not wedge the daemon's event loop when a
// client writes more than the terminal's input queue holds.
import assert from "node:assert/strict"
import { spawn } from "@lydell/node-pty"

const pty = spawn("/bin/sh", ["-c", "stty raw -echo && printf ready && sleep 3"], { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env })
const exited = new Promise((resolve) => pty.onExit(resolve))
await new Promise((resolve) => { const listener = pty.onData((data) => { if (data.includes("ready")) { listener.dispose(); resolve() } }) })
let ticks = 0
const timer = setInterval(() => { ticks += 1 }, 50)
const started = performance.now()
pty.write("x".repeat(200_000))
const returned = performance.now() - started
await new Promise((resolve) => setTimeout(resolve, 1000))
clearInterval(timer)
assert.ok(returned < 250, `pty.write blocked the event loop for ${Math.round(returned)} ms`)
assert.ok(ticks >= 10, `the event loop ran only ${ticks} timer ticks in one second after the write`)
pty.kill()
await exited
console.log(`Terminal backpressure: a 200 KB write to a non-reading terminal returned in ${Math.round(returned)} ms and the event loop kept running (${ticks} ticks)`)
