import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppKeySchema } from "@mako/host/contracts/thread-environments"
import { ThreadProcesses } from "@mako/host/workspaces/thread-processes"
import { childProcessReader } from "@mako/host/workspaces/watch-backend"

/**
 * An idle host's app marks read no process table. Every window asks for the marks every few seconds, and each look
 * spawned `ps -A` whether or not any app ran: on t3-efficiency's scratch host (2026-11-12), with no app running, two
 * marks held the loop 2,088 ms and 1,676 ms, the spawn being all they did. A look with apps whose runs have all ended
 * spawns no `ps`; one with a run alive still reads the table and sees it.
 *
 * `ps` is counted through a wrapper first on PATH, which notes each call and runs the real one.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-idle-marks-")))
const bin = join(root, "bin")
const calls = join(root, "ps-calls")
mkdirSync(bin)
writeFileSync(join(bin, "ps"), `#!/bin/sh\necho $PPID >> '${calls}'\nexec /bin/ps "$@"\n`)
chmodSync(join(bin, "ps"), 0o755)
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`
/** Who ran each `ps`, by its parent's pid. */
const parents = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).map(Number) : [])
const spawned = () => parents().length

const records = join(root, "records")
const processes = new ThreadProcesses({ root: records, listening: async () => false })
const app = AppKeySchema.parse("folder-0123456789abcdef")
const folder = join(records, app)
mkdirSync(folder, { recursive: true })
const run = (pid: number, at: number) => ({ kind: "process", name: "web", command: "sleep 30", cwd: root, pid, startedMs: at, at })

/** A process that has ended: its pid names nothing now (a group of its own, already reaped). */
async function endedPid(): Promise<number> {
  const child = spawn("/usr/bin/true", [], { detached: true, stdio: "ignore" })
  await new Promise((done) => child.once("exit", done))
  return child.pid!
}

let alive: ReturnType<typeof spawn> | undefined
try {
  // Records only of runs that have ended: the look answers from them alone.
  writeFileSync(join(folder, "runs.json"), JSON.stringify({ runs: { "process-web": run(await endedPid(), Date.now() - 60_000) } }))
  const idle = await processes.overview()
  const active = await processes.active()
  assert.equal(spawned(), 0, "no ps for a look with no run alive")
  assert.equal(idle.length, 1, "the app with records is still listed")
  assert.notEqual(idle[0]!.runs[0]!.state.kind, "running", "its ended run reads as ended")
  assert.equal(active.length, 0, "nothing is active")

  // A run alive in a group of its own: the table is read and the run seen.
  alive = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" })
  // As the table gives it, read past the wrapper so the count stays the look's own.
  const startedMs = Date.parse(execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(alive.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim())
  writeFileSync(join(folder, "runs.json"), JSON.stringify({ runs: { "process-web": run(alive.pid!, startedMs) } }))
  const busy = await processes.active()
  assert.ok(spawned() >= 1, "a look with a run alive reads the table")
  assert.equal(busy.length, 1, "the live run is seen")

  // Read through the watcher child (`childProcessReader`): the same run is seen, and `ps` ran in the child, not here.
  const reader = childProcessReader()
  const viaChild = new ThreadProcesses({ root: records, listening: async () => false, readTable: () => reader.table(), readMembers: (runs, self) => reader.members(runs, self) })
  const spawnedBefore = spawned()
  const seen = await viaChild.active()
  assert.equal(seen.length, 1, "the live run is seen through the child's table")
  const fresh = parents().slice(spawnedBefore)
  assert.ok(fresh.length >= 1, "ps ran")
  assert.ok(fresh.every((parent) => parent !== process.pid), "ps ran in the child, not in this process")
  console.log("idle app marks: a look with every run ended spawns no ps and still lists the app; one with a run alive reads the table and finds it")
} finally {
  if (alive?.pid) process.kill(alive.pid, "SIGKILL")
  rmSync(root, { recursive: true, force: true })
}
