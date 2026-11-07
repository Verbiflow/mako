// A shell that stops reading must not wedge the daemon's event loop when a
// client writes more than the terminal's input queue holds.
import assert from "node:assert/strict"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { spawn } from "@lydell/node-pty"

const pty = spawn("/bin/sh", ["-c", "stty raw -echo && printf ready && sleep 3"], { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env })
const exited = new Promise((resolve) => pty.onExit(resolve))
await new Promise((resolve) => { const listener = pty.onData((data) => { if (data.includes("ready")) { listener.dispose(); resolve() } }) })
/** The longest the event loop went without a turn while `work` and the second after it ran, by its own delay histogram. */
const longestStall = async (work) => {
  const delay = monitorEventLoopDelay({ resolution: 5 })
  delay.enable()
  // Its first samples taken, so a stall from the very next line is a gap between two of them.
  await new Promise((resolve) => setTimeout(resolve, 20))
  work()
  await new Promise((resolve) => setTimeout(resolve, 1000))
  delay.disable()
  return delay.max / 1e6
}
// The loop's stalls on this runner, now, in a second with nothing written: what a runner's own pauses look like.
const quiet = await longestStall(() => {})
let returned = 0
const writing = await longestStall(() => {
  const started = performance.now()
  pty.write("x".repeat(200_000))
  returned = performance.now() - started
})
// A write that waits for room the shell never makes holds the loop until the shell exits; any freeze in that second
// shows the same way. The bound is the old quarter second, or more on a runner whose own pauses run longer.
const limit = Math.max(250, quiet * 5)
assert.ok(writing < limit, `pty.write stalled the event loop for ${Math.round(writing)} ms (the write itself ${Math.round(returned)} ms), against at most ${Math.round(limit)} ms; ${Math.round(quiet)} ms with nothing written`)
pty.kill()
await exited
console.log(`Terminal backpressure: a 200 KB write to a non-reading terminal returned in ${Math.round(returned)} ms, and the event loop's longest stall around it was ${Math.round(writing)} ms (${Math.round(quiet)} ms with nothing written)`)
