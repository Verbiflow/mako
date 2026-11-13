import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as wait } from "node:timers/promises"
import { childProcessReader } from "@mako/host/workspaces/watch-backend"

/**
 * The probe child's two edges, after #609's lessons. A reply that came in while the host's loop was held is read
 * before its deadline ends the child: a timer due during the stall fires before the loop reads the channel, and
 * ended a child that had answered in time. And no probe outlives its child: on SIGTERM, and when the host goes
 * without stopping it (`disconnect`), the child ends every probe it runs before it exits.
 *
 * `ps` is a wrapper first on PATH: it notes its pid and, while `slow` exists, sleeps in place of answering.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-probe-edges-")))
const bin = join(root, "bin")
const slow = join(root, "slow")
const pids = join(root, "pids")
mkdirSync(bin)
writeFileSync(join(bin, "ps"), `#!/bin/sh\necho $$ >> '${pids}'\nif [ -e '${slow}' ]; then exec /bin/sleep 60; fi\nexec /bin/ps "$@"\n`)
chmodSync(join(bin, "ps"), 0o755)
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`
const script = join(import.meta.dirname, "../packages/host/src/workspaces/watcher-child-main.ts")
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const slowPids = async () => {
  for (let tries = 0; tries < 100 && !existsSync(pids); tries++) await wait(50)
  return readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number)
}
const holdLoop = (ms: number) => {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // The host's loop held, as a stall holds it.
  }
}

try {
  // A reply that lands while the loop is held, its deadline passing meanwhile, is still the answer.
  const reader = childProcessReader(script, 3_000)
  // Warm: a child starting under load (tsx compiling it) can miss the short deadline; a later one answers within it.
  for (let tries = 0; ; tries++) {
    const warm = await reader.table().then(() => true, () => false)
    if (warm) break
    assert.ok(tries < 5, "the probe child answers once it's up")
  }
  const asked = reader.table()
  // The ask goes out, then the loop is held past its deadline while the child answers. Held from the loop's check
  // phase, the next turn runs its timers before it reads the channel, as after a stall anywhere but in a read.
  await wait(1)
  await new Promise((done) => setImmediate(done))
  holdLoop(8_000)
  const text = await asked
  assert.match(text, /\d/, "the reply read after the stall answers the ask")
  assert.ok(await reader.table(), "and the child it came from still answers")

  for (const how of ["SIGTERM", "disconnect"] as const) {
    rmSync(pids, { force: true })
    writeFileSync(slow, "")
    const child = fork(script, [], { execArgv: process.execArgv, stdio: ["ignore", "ignore", "inherit", "ipc"] })
    child.send({ t: "run", id: 1, file: "ps", args: ["-A"] })
    const [probe] = await slowPids()
    assert.ok(probe && alive(probe), "the probe runs")
    const exited = new Promise((done) => child.once("exit", done))
    if (how === "SIGTERM") child.kill("SIGTERM")
    else child.disconnect()
    await exited
    for (let tries = 0; tries < 40 && alive(probe!); tries++) await wait(50)
    assert.ok(!alive(probe!), `a probe under way ends with its child on ${how}`)
    rmSync(slow, { force: true })
  }
  console.log("probe child edges: a reply read after a stall that passed its deadline still answers and keeps the child, and a probe under way ends with its child on SIGTERM and on disconnect")
} finally {
  rmSync(root, { recursive: true, force: true })
}
