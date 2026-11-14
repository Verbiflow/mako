import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { setTimeout as wait } from "node:timers/promises"
import { AppKeySchema, type AppKey } from "@mako/host/contracts/thread-environments"
import { membersOnly, parseTable, PS_ARGS, type RunLeader } from "@mako/host/workspaces/process-table"
import { ThreadProcesses } from "@mako/host/workspaces/thread-processes"
import { childProcessReader } from "@mako/host/workspaces/watch-backend"

/**
 * The apps' overview reads little on the host's loop. With a window polling `mako:thread-app` every 4 s at load 12–29,
 * main held the loop 2,248 ms a minute against the Nov 8 build's 759, the holds naming "sample thread apps" (64 holds,
 * 10.5 s in 5 minutes; 2026-11-12): each look parsed every app's `runs.json`, read each one's files, and parsed and
 * matched the whole process table on the loop. Now the watcher child matches the table to the runs and sends back
 * only their processes (`members`), a `runs.json` is parsed again only when it changed, and an app whose runs are all
 * over keeps its entry while its records don't change.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-overview-reads-")))
const records = join(root, "records")
const key = (index: number): AppKey => AppKeySchema.parse(`folder-${index.toString(16).padStart(16, "0")}`)
const run = (name: string, pid: number, startedMs: number) => ({ kind: "process", name, command: "sh", cwd: root, pid, startedMs, at: startedMs })
const writeRuns = (app: AppKey, runs: Record<string, ReturnType<typeof run>>) => {
  mkdirSync(join(records, app), { recursive: true })
  writeFileSync(join(records, app, "runs.json"), JSON.stringify({ runs }))
}
const startedOf = (pid: number) => Date.parse(execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim())

async function endedPid(): Promise<number> {
  const child = spawn("/usr/bin/true", [], { detached: true, stdio: "ignore" })
  await new Promise((done) => child.once("exit", done))
  return child.pid!
}

// A signal check can see a live group after its leader ended, or a process we can't signal. Only EPERM counts as
// alive after a failed check; changing how that error is read mustn't hide a group or turn a missing pid into one.
for (const [index, sample] of [
  { group: "alive", process: "ESRCH", alive: true, parent: false },
  { group: "EPERM", process: "ESRCH", alive: true, parent: false },
  { group: "ESRCH", process: "alive", alive: true, parent: true },
  { group: "ESRCH", process: "EPERM", alive: true, parent: true },
  { group: "ESRCH", process: "ESRCH", alive: false, parent: true },
  { group: "EINVAL", process: undefined, alive: false, parent: true },
].entries()) {
  const app = key(1_000 + index)
  const folder = join(root, `signal-${index}`)
  mkdirSync(join(folder, app), { recursive: true })
  writeFileSync(join(folder, app, "runs.json"), JSON.stringify({ runs: { "process-web": run("web", 12345, 1) } }))
  let asked = 0
  const probes: number[] = []
  const kill = mock.method(process, "kill", (pid: number, signal?: number | string) => {
    assert.equal(signal, 0, "a look never signals a run")
    probes.push(pid)
    const code = pid < 0 ? sample.group : sample.process
    if (code === "alive") return true
    throw code === undefined ? null : { code }
  })
  try {
    const look = new ThreadProcesses({ root: folder, listening: async () => false, readMembers: async () => { asked++; return [] } })
    assert.equal((await look.overview()).length, 1, "a signal refusal doesn't drop the app's records")
    assert.equal(asked > 0, sample.alive, `read members only when the group or leader exists: ${sample.group}/${sample.process}`)
    assert.equal(probes.includes(12345), sample.parent, "a live group doesn't require its leader to exist")
  } finally {
    kill.mock.restore()
  }
}

// A run alive in a group of its own, with a child of its own.
const alive = spawn("/bin/sh", ["-c", "/bin/sleep 30 & wait"], { detached: true, stdio: "ignore" })
const reader = childProcessReader()
try {
  await wait(200)
  const leader: RunLeader = { pid: alive.pid!, startedMs: startedOf(alive.pid!) }

  // The child's members are what matching the whole table here finds: the leader and its sleep.
  const fromChild = await reader.members([leader], process.pid)
  const here = membersOnly(parseTable(execFileSync("/bin/ps", [...PS_ARGS], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } })), [leader], process.pid)
  assert.deepEqual(fromChild.map((row) => row.pid).sort(), here.map((row) => row.pid).sort(), "the child finds the run's processes as the host would")
  assert.equal(fromChild.length, 2, "the leader and its child")
  assert.deepEqual(await reader.members([{ pid: leader.pid, startedMs: leader.startedMs - 5_000 }], process.pid), [], "a pid that names another process now has none")

  // A host reading members through the child, and never the whole table, for its looks.
  let asked = 0
  const processes = new ThreadProcesses({
    root: records,
    listening: async () => false,
    readTable: () => Promise.reject(new Error("the whole table isn't read for a look")),
    readMembers: (runs, self) => {
      asked++
      return reader.members(runs, self)
    },
  })
  const live = key(1)
  writeRuns(live, { "process-web": run("web", leader.pid, leader.startedMs) })
  const ended = Array.from({ length: 40 }, (_, index) => key(100 + index))
  const endedPids = await Promise.all(ended.map(() => endedPid()))
  ended.forEach((app, index) => writeRuns(app, { "process-web": run("web", endedPids[index]!, Date.now() - 60_000) }))

  const first = await processes.overview()
  assert.equal(first.length, 41, "every app with records is listed")
  assert.equal(first.find((entry) => entry.app === live)?.runs[0]?.state.kind, "running", "the live run reads as running")
  assert.ok(first.filter((entry) => entry.app !== live).every((entry) => entry.runs[0]!.state.kind !== "running"), "the ended ones read as ended")
  assert.equal(asked, 1, "one members read for the look")
  const shown = await processes.status(live, { shown: true })
  assert.ok((shown[0]?.memoryBytes ?? 0) > 0, "a window's view reads the run's memory from the same members")
  assert.equal(asked, 1, "and shares the look's read")

  // An ended app whose records change reads them; one used here reads its new use at once.
  await wait(1_100)
  const changed = ended[0]!
  writeRuns(changed, { "process-api": run("api", endedPids[0]!, Date.now() - 30_000) })
  const touched = ended[1]!
  await processes.touch(touched)
  const second = await processes.overview()
  assert.equal(second.find((entry) => entry.app === changed)?.runs[0]?.name, "api", "a changed runs.json is read again")
  assert.ok((second.find((entry) => entry.app === touched)?.usedAt ?? 0) > 0, "an app used here says so at once")
  assert.deepEqual(second.find((entry) => entry.app === ended[2]), first.find((entry) => entry.app === ended[2]), "an unchanged ended app reads as it did")

  // The run ends: the next look reads it as over.
  process.kill(-alive.pid!, "SIGKILL")
  await wait(1_100)
  const third = await processes.overview()
  assert.notEqual(third.find((entry) => entry.app === live)?.runs[0]?.state.kind, "running", "a run that ended reads as over")
  console.log("app overview reads: the child sends only a run's processes, matched as the host would; a look reads them once for every app and a window's view; a changed runs.json and a use here are read at once, an unchanged ended app reads as it did, and a run that ends reads as over")
} finally {
  try {
    process.kill(-alive.pid!, "SIGKILL")
  } catch {
    // Already gone.
  }
  rmSync(root, { recursive: true, force: true })
}
