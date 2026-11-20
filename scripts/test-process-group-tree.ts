import assert from "node:assert/strict"
import { runProcessGroup } from "@mako/host/application/process-group"

/**
 * A stopped build step ends with everything it started, on every system: by its process group on macOS and Linux, by
 * its process tree (`taskkill /T /F`) on Windows, where `kill(-pid)` named no process and the step ran on. The step and
 * the process it starts both outlast SIGTERM. `npx tsx scripts/test-process-group-tree.ts`.
 */
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

const grandchild = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
const step = `
const { spawn } = require("node:child_process")
process.on("SIGTERM", () => {})
const started = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" })
console.log("pids " + process.pid + " " + started.pid)
setInterval(() => {}, 1000)
`
const stop = new AbortController()
let text = ""
let pids: number[] = []
const settled = runProcessGroup(process.execPath, ["-e", step], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "pipe",
  signal: stop.signal,
  graceMs: 300,
  output: (stream, chunk) => {
    if (stream !== "stdout") return
    text += chunk
    const found = /pids (\d+) (\d+)/.exec(text)
    if (found && !pids.length) {
      pids = [Number(found[1]), Number(found[2])]
      stop.abort()
    }
  },
})
const deadline = setTimeout(() => stop.abort(), 15_000)
try {
  const result = await settled
  assert.equal(result.stopped, "aborted")
  assert.equal(pids.length, 2, "the step said which processes it is")
  // The tree's end is waited for by the step's own end; the grandchild gets a moment for the system to take it.
  for (let tries = 0; tries < 40 && pids.some(alive); tries++) await new Promise((done) => setTimeout(done, 50))
  assert.deepEqual(pids.filter(alive), [], "the step and what it started are gone")
} finally {
  clearTimeout(deadline)
  for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL")
}
console.log("Process groups: a stopped step ends with the process it started, both outlasting SIGTERM")
