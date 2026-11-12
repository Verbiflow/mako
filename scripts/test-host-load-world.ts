import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { makeWorld, sweepLeftFixtures, type WorldScale } from "./lib/host-load-world.ts"

/**
 * bench:host-load's fixtures (a running app's `sh` and its `sleep`s, the busy Mac's) end with the bench however it
 * ends: killed outright, exiting without releasing them, or stopped by a signal. On 2026-11-12, 3,300 of them, left by
 * runs that ended early, held this Mac past its per-user process limit for hours.
 *
 *   npx tsx scripts/test-host-load-world.ts
 */
const TINY: WorldScale = { threads: 1, fins: [], files: [20, 20], apps: 2, running: 2, processes: 6, sessions: 2 }

if (process.argv[2] === "child") {
  // A bench: makes its world, says its fixture groups, then ends as it's told, never releasing them itself.
  const root = process.argv[4]!
  const world = await makeWorld(root, TINY)
  process.stdout.write(`${JSON.stringify(world.fixtures)}\n`)
  const how = process.argv[3]
  if (how === "killed") process.kill(process.pid, "SIGKILL")
  else if (how === "signalled") process.kill(process.pid, "SIGTERM")
  else process.exit(0)
  // Busy as a bench is, until the signal lands.
  await new Promise((resolve) => setTimeout(resolve, 30_000))
  throw new Error(`the ${how} bench is still running`)
}

const alive = (pgid: number) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

async function benchEnding(how: "killed" | "exited" | "signalled"): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "mako-host-load-world-"))
  try {
    const child = spawn(process.execPath, [...process.execArgv, import.meta.filename, "child", how, root], { stdio: ["ignore", "pipe", "inherit"] })
    let said = ""
    child.stdout.on("data", (chunk: Buffer) => (said += chunk.toString()))
    const [code, signal] = await new Promise<[number | null, string | null]>((resolve) => child.once("exit", (...ended) => resolve(ended)))
    const expected = { killed: [null, "SIGKILL"], exited: [0, null], signalled: [143, null] }[how]
    assert.deepEqual([code, signal], expected, `the ${how} bench ended as it was told`)
    const groups = z.array(z.number().int()).parse(JSON.parse(said.trim().split("\n").at(-1) ?? "[]"))
    assert.equal(groups.length, TINY.running + TINY.processes / 2, `the ${how} bench made its fixtures`)
    for (const deadline = Date.now() + 10_000; groups.some(alive); await new Promise((resolve) => setTimeout(resolve, 200)))
      assert.ok(Date.now() < deadline, `a bench ${how}: its fixtures outlived it (${groups.filter(alive).length} groups)`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await benchEnding("killed")
await benchEnding("exited")
await benchEnding("signalled")

// A run whose reaper was killed too: the next run's sweep ends its fixtures by its record, and nothing else.
{
  const records = mkdtempSync(join(tmpdir(), "mako-host-load-runs-"))
  const fixture = spawn("/bin/sh", ["-c", "sleep 60 & wait", "mako-load-busy-99", "--port", "3000", "--watch", "--config", "vite.config.ts"], { detached: true, stdio: "ignore" })
  const stranger = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" })
  fixture.unref()
  stranger.unref()
  await new Promise((resolve) => setTimeout(resolve, 200))
  // An owner that's gone: a process that already exited.
  const gone = spawn("/usr/bin/true")
  await new Promise((resolve) => gone.once("exit", resolve))
  mkdirSync(records, { recursive: true })
  writeFileSync(join(records, "left.json"), JSON.stringify({ owner: gone.pid, groups: [fixture.pid, stranger.pid] }))
  assert.equal(sweepLeftFixtures(records), 1, "the left fixture's group is ended")
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(alive(fixture.pid!), false, "the fixture is gone")
  assert.equal(alive(stranger.pid!), true, "a process that isn't a fixture, whatever the record says, is left alone")
  process.kill(-stranger.pid!, "SIGKILL")
  rmSync(records, { recursive: true, force: true })
}

console.log("host-load world: its fixtures end with the bench, killed, exited or signalled, and a left run is swept by its record alone")
