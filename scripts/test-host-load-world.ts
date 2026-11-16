import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { makeWorld, reapWhenGone, sweepLeftFixtures, type World, type WorldScale } from "./lib/host-load-world.ts"
import { processesLeftIn } from "./lib/scratch-processes.mjs"
import { Git } from "@mako/git"
import { ThreadStore } from "@mako/host/threads/store"
import { ThreadEnvironments } from "@mako/host/workspaces/thread-environment"
import { ThreadProcesses } from "@mako/host/workspaces/thread-processes"
import { readRecipe } from "@mako/host/workspaces/thread-recipe"

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

const settle = () => new Promise((resolve) => setTimeout(resolve, 200))
/** A process group as a fixture is, and one of another program's, each its own leader. */
const groupsOfBoth = async () => {
  const fixture = spawn("/bin/sh", ["-c", "sleep 60 & wait", "mako-load-busy-99", "--port", "3000", "--watch", "--config", "vite.config.ts"], { detached: true, stdio: "ignore" })
  const stranger = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" })
  fixture.unref()
  stranger.unref()
  await settle()
  return { fixture: fixture.pid!, stranger: stranger.pid! }
}
const end = (...pgids: number[]) => {
  for (const pgid of pgids) {
    try {
      process.kill(-pgid, "SIGKILL")
    } catch { /* gone */ }
  }
}
const until = async (what: () => boolean, ms: number) => {
  for (const deadline = Date.now() + ms; !what() && Date.now() < deadline; ) await settle()
  return what()
}

// The reaper kills only a group whose leader is still a fixture, whatever IDs it was handed.
{
  const { fixture, stranger } = await groupsOfBoth()
  const owner = spawn("/bin/sleep", ["60"], { stdio: "ignore" })
  const reaper = reapWhenGone(owner.pid!, [fixture, stranger])
  owner.kill("SIGKILL")
  assert.ok(await until(() => !alive(fixture), 10_000), "the reaper ends the fixture once its owner is gone")
  assert.ok(await until(() => !alive(reaper.pid!), 5_000), "and then exits")
  assert.equal(alive(stranger), true, "a group that isn't a fixture, whatever the reaper was told, is left alone")
  end(stranger)
}

// The reaper gives up after its time with its owner still there, when the fixtures' sleeps have ended anyway.
{
  const { fixture, stranger } = await groupsOfBoth()
  const owner = spawn("/bin/sleep", ["60"], { stdio: "ignore" })
  const reaper = reapWhenGone(owner.pid!, [fixture], 1)
  assert.ok(await until(() => !alive(reaper.pid!), 6_000), "the reaper exits after its time")
  owner.kill("SIGKILL")
  await settle()
  assert.equal(alive(fixture), true, "and kills nothing then")
  end(fixture, stranger)
}

// A run whose reaper was killed too: the next run's sweep ends its fixtures by its record, and nothing else.
{
  const records = mkdtempSync(join(tmpdir(), "mako-host-load-runs-"))
  const { fixture, stranger } = await groupsOfBoth()
  // An owner that's gone: a process that already exited.
  const gone = spawn("/usr/bin/true")
  await new Promise((resolve) => gone.once("exit", resolve))
  mkdirSync(records, { recursive: true })
  writeFileSync(join(records, "left.json"), JSON.stringify({ owner: gone.pid, groups: [fixture, stranger] }))
  assert.equal(sweepLeftFixtures(records), 1, "the left fixture's group is ended")
  await settle()
  assert.equal(alive(fixture), false, "the fixture is gone")
  assert.equal(alive(stranger), true, "a process that isn't a fixture, whatever the record says, is left alone")
  end(stranger)
  rmSync(records, { recursive: true, force: true })
}

{
  const root = mkdtempSync(join(tmpdir(), "mako-host-load-release-"))
  let world: World | undefined
  try {
    world = await makeWorld(root, TINY)
    const store = new ThreadStore(join(world.dataRoot, "threads.sqlite"))
    const git = new Git()
    try {
      const environments = new ThreadEnvironments({ store, git, dataRoot: join(world.dataRoot, "thread-data") })
      const processes = new ThreadProcesses({ root: join(world.dataRoot, "thread-environments"), listening: async () => false })
      for (const checkout of world.checkouts) {
        const found = await environments.forFolder(checkout.path, false)
        assert.ok(store.environment(found.app), "the fixture registers the app owner the real desk resolver chooses")
        assert.ok(found.environment, "the world's visible app has registered values; a look must not silently read an empty app")
        assert.equal((await readRecipe(git, found.checkout, found.environment)).kind, "ready", "the desk can read the fixture's recipe")
        assert.equal((await processes.status(found.app)).find(run => run.name === "web")?.state.kind, "running", "the visible app's process record belongs to that owner too")
        const first = await processes.readLog(found.app, "process-web")
        assert.ok(first.text.length > 0, "the actual log reader finds output under that same owner")
        assert.ok(first.cursor.offset > 0, "the fixture exercises a non-empty output cursor")
        const fixtureOutput: World["appOutputs"][number] | undefined = world.appOutputs.find((entry) => entry.cwd === checkout.path)
        assert.equal(fixtureOutput?.app, found.app, "the controlled output writer uses the resolved owner")
        assert.ok(fixtureOutput)
        appendFileSync(fixtureOutput.file, "a later fixture line\n")
        assert.equal((await processes.readLog(found.app, "process-web", first.cursor)).text, "a later fixture line\n", "a new write reaches the real cursor reader without replaying old output")
      }
    } finally {
      store.close()
      await git.close()
    }
    const released = world.release()
    assert.equal(world.release(), released, "reentry joins the same release, without repeating signals")
    await released
    assert.deepEqual(await processesLeftIn(root), [], "the unchanged guard proves the released world unused")
  } finally {
    await world?.release()
    rmSync(root, { recursive: true, force: true })
  }
}
console.log("host-load world: its fixtures end with the bench, killed, exited or signalled; explicit release reaps leaders before guarded removal; the reaper and sweep end fixtures alone")
