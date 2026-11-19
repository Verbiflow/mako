import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { connectDaemon } from "../dist/daemon.js"

/**
 * A request's timeout counts only time the host could hear the daemon. With the host's thread held past a request's
 * deadline, the daemon's answer waits in the socket, and Node runs the overdue timer before it reads the socket: the
 * answer that came was said to have timed out. On the person's Mac, 110 of 218 "The sync daemon request timed out"
 * in 45 minutes were said within 50 ms of the host's loop coming free, 45 of them after a hold of 3 s or more.
 */
const root = await mkdtemp(join(tmpdir(), "mako-daemon-held-"))
const socketPath = join(root, "d.sock")
const worker = new Worker(new URL("./daemon-held-worker.mjs", import.meta.url), { workerData: { socketPath } })
const said = (word) => new Promise((resolve) => worker.on("message", (message) => message === word && resolve()))
try {
  await said("ready")
  const client = await connectDaemon(socketPath, 200)

  // The daemon answers at once, while this thread is held for three times the timeout: the answer is taken.
  const asked = client.refresh()
  const until = performance.now() + 600
  while (performance.now() < until) {}
  const stats = await asked
  assert.equal(typeof stats.pid, "number", "the answer that came while the host was held")

  // A daemon that doesn't answer still times out, at its deadline, while this thread is free.
  const holding = said("held")
  worker.postMessage("hold")
  await new Promise((resolve) => setTimeout(resolve, 50))
  const started = performance.now()
  await assert.rejects(client.refresh(), /timed out/)
  const waited = performance.now() - started
  assert.ok(waited < 600, `a silent daemon timed out after ${Math.round(waited)} ms, near its 200 ms`)
  await holding
  client.close()
  console.log(`daemon deadline: an answer that came while the host was held 600 ms is taken; a silent daemon times out in ${Math.round(waited)} ms of a 200 ms timeout`)
} finally {
  await worker.terminate()
  await rm(root, { recursive: true, force: true })
}
