import assert from "node:assert/strict"
import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { acquireHostLock } from "@mako/host/base/host-lock"
import { invokeRuntime } from "@mako/host/transport/connection"
import { ensureRuntime } from "@mako/host/transport/service"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * A host that quits lets go of its data root as it finishes, not when its process is gone: on macOS a process has stayed
 * seconds after its exit, every thread already ended (15 s on a CI runner, 2026-11-13, in test:node-host-secrets), and
 * the next host, a restart's or an update's, waited on the lock all that while. `MAKO_EXIT_HOLD_MS` keeps the exiting
 * process alive as that one was; the data root must be free well before it's gone.
 *
 *   npm run build:electron && node scripts/test-host-exit-hold.mjs
 */
const HOLD_MS = 5_000
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const root = testScratch("mako-host-exit-hold-")
const home = join(root, "home")
const dataRoot = join(root, "data")
await mkdir(home, { recursive: true })
let host
try {
  host = await ensureRuntime({
    dataRoot,
    executable: resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
    args: [resolve(".")],
    cwd: resolve("."),
    env: { ...process.env, HOME: home, MAKO_EXIT_HOLD_MS: String(HOLD_MS) },
  })
  const asked = Date.now()
  await invokeRuntime(host.socket, crypto.randomUUID(), "mako:lifecycle-command", [{ kind: "wait", action: "quit" }]).catch(() => undefined)
  let freedAt
  for (const deadline = asked + HOLD_MS + 15_000; Date.now() < deadline; await delay(50)) {
    const lock = await acquireHostLock(dataRoot)
    if (lock.kind === "held") {
      freedAt = Date.now() - asked
      await lock.release()
      break
    }
  }
  assert.ok(freedAt !== undefined, "the data root is let go")
  const stillThere = alive(host.info.pid)
  for (const deadline = asked + HOLD_MS + 15_000; alive(host.info.pid) && Date.now() < deadline; ) await delay(50)
  const goneAt = Date.now() - asked
  assert.ok(!alive(host.info.pid), "and the process goes too, once its exit is done")
  assert.ok(stillThere, `the data root was free while the exiting process was still there (freed ${freedAt} ms, gone ${goneAt} ms)`)
  assert.ok(freedAt < HOLD_MS - 1_000, `the data root was free ${freedAt} ms after the quit, not once the process went (${goneAt} ms)`)
  console.log(JSON.stringify({ freedMs: freedAt, goneMs: goneAt }))
  console.log("host exit hold: a quitting host lets go of its data root as it finishes, whatever its process's exit takes after")
} finally {
  if (host && alive(host.info.pid)) process.kill(host.info.pid, "SIGKILL")
  await rm(root, { recursive: true, force: true })
}
