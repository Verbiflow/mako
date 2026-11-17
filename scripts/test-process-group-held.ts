import assert from "node:assert/strict"
import { processRunner } from "@mako/git/process-runner"

/**
 * Ending a command's process group while the event loop is held. The group's check reads the process table with a
 * 1.5 s `ps`; a loop held past that, outside the timers phase, fires the timeout after `ps` exited but before its exit
 * was heard, and the read comes back empty with no error. That threw "The owned command's process group could not be
 * checked" before the SIGKILL: an isolated host's stop failed in update-checks (#900's run 43956163890), its loop held
 * 2.7 s, and a command that outlasted SIGTERM was left running. `node scripts/test-process-group-held.ts`.
 */
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

for (const hold of [0, 2_500]) {
  // A command that outlasts SIGTERM, so its end reads the process table and needs the SIGKILL.
  const child = processRunner.spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })
  const pid = child.pid
  assert.ok(pid, "the command started")
  await new Promise((done) => setTimeout(done, 300))
  const closing = processRunner.close(child)
  // Held from an immediate, as the host's own work holds it, while the first read of the table is out.
  setTimeout(() => setImmediate(() => { const end = Date.now() + hold; while (Date.now() < end); }), 25)
  try {
    await closing
  } finally {
    if (alive(pid)) process.kill(-pid, "SIGKILL")
  }
  assert.equal(alive(pid), false, `a command that outlasts SIGTERM is gone once its end returns, the loop held ${hold} ms`)
}
console.log("Process groups: a command that outlasts SIGTERM ends by SIGKILL, with the event loop held past the process table's read")
