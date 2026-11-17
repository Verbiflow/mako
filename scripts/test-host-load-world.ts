import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
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
import { environmentTools } from "@mako/host/workspaces/environment-tools"
import { TraceRefresh } from "@mako/host/workspaces/app-probe"
import { HostMethods } from "@mako/host/transport/methods"
import { HostStopping } from "@mako/host/base/host-stopping"
import { unwatchedWork } from "@mako/host/base/event-loop"
import { createMakoBridge } from "@mako/host/contracts/renderer-bridge"
import { decodeRuntimeValue } from "@mako/host/contracts/runtime-value"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { ThreadAppSampler } from "@mako/host/workspaces/app-sampler"
import { AppOutputHints } from "@mako/host/workspaces/app-output-hints"
import { childBackend } from "@mako/host/workspaces/watch-backend"
import { declareThreadAppMethods } from "@mako/host/workspaces/app-methods"
import { ViewHints, declareViewHints } from "@mako/host/workspaces/view-hints"
import { followHostLoadOutputs } from "./lib/host-load-output.ts"

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
    world = await makeWorld(root, { ...TINY, threads: 2 })
    const store = new ThreadStore(join(world.dataRoot, "threads.sqlite"))
    const git = new Git()
    const scope = new HostStopping()
    let outputWatch: AppOutputHints | undefined
    let following: Awaited<ReturnType<typeof followHostLoadOutputs>> | undefined
    try {
      const environments = new ThreadEnvironments({ store, git, dataRoot: join(world.dataRoot, "thread-data") })
      const processes = new ThreadProcesses({ root: join(world.dataRoot, "thread-environments"), listening: async () => false })
      const tools = environmentTools({ git, folder: (cwd, claim) => environments.forFolder(cwd, claim),
        cwd: () => undefined, environment: async () => undefined, launchedWith: () => undefined,
        processes, traces: new TraceRefresh(),
      })
      const events = new Set<(event: HostEvent) => void>()
      const hints = new ViewHints(event => { for (const listener of events) listener(event) })
      const connection = randomUUID(), client = "fixture-window"
      const sampler = new ThreadAppSampler({ connection: id => id === client ? connection : undefined,
        look: () => tools.look(), publish: () => {}, demandChanged: () => outputWatch?.reconcile(true),
      })
      const backend = scope.run(() => childBackend())
      const watchFailures: string[] = []
      outputWatch = new AppOutputHints({ wanted: () => sampler.outputWanted(),
        watch: (app, listener) => scope.run(() => processes.watchOutputFiles(app, backend, listener)),
        changed: fields => hints.changed("output", fields), warn: message => { watchFailures.push(message) },
      })
      const methods = new HostMethods({ stopping: scope, fixtureDesk: false, route: async () => ({ handled: false }),
        presentHistory: value => value, breadcrumb: () => {}, declaring: async () => {}, work: unwatchedWork,
      })
      declareViewHints(methods, hints)
      declareThreadAppMethods(methods, tools.desk, sampler, apps => outputWatch?.ready(apps) ?? false)
      const bridge = createMakoBridge({
        invoke: async <Result>(channel: string, ...args: unknown[]) => {
          // SAFETY: the real method table validates arguments and encodes this bridge method's result.
          return decodeRuntimeValue(await methods.invoke(channel, args, client)) as Result
        },
        onEvent: listener => { events.add(listener); return () => { events.delete(listener) } },
        onTerminalEvent: () => () => {}, pathForFile: () => null, resolveFileUrl: url => url,
      })
      for (const checkout of world.checkouts) {
        const found = await environments.forFolder(checkout.path, false)
        assert.ok(store.environment(found.app), "the fixture registers the app owner the real desk resolver chooses")
        assert.ok(found.environment, "the world's visible app has registered values")
        assert.equal((await readRecipe(git, found.checkout, found.environment)).kind, "ready")
        assert.equal((await processes.status(found.app)).find(run => run.name === "web")?.state.kind, "running")
        const first = await bridge.threadAppOutput(checkout.path, "process:web")
        assert.ok(first.text.length > 0, "the output method over the bridge returns non-empty output")
        assert.equal(first.app, found.app, "the method resolves exactly the fixture's app owner")
        assert.ok(first.cursor.offset > 0)
        const fixtureOutput: World["appOutputs"][number] | undefined = world.appOutputs.find(entry => entry.cwd === checkout.path)
        assert.ok(fixtureOutput)
        assert.equal(fixtureOutput.app, found.app)
        appendFileSync(fixtureOutput.file, "a later fixture line\n")
        const next = await bridge.threadAppOutput(checkout.path, "process:web", first.cursor)
        assert.equal(next.text, "a later fixture line\n", "the method follows its returned cursor")
        assert.equal(next.reset, false)
        for (const repository of checkout.repositories) {
          assert.equal(await git.readOutput(repository, ["status", "--porcelain"]), "", "seeded recipes do not distort worktree summaries")
          assert.equal(await git.readOutput(repository, ["check-ignore", "--no-index", ".mako/recipe.json"]), ".mako/recipe.json", "fixture repositories ignore recipe metadata")
        }
      }
      following = await followHostLoadOutputs(bridge, world.appOutputs)
      await following.ready()
      const marker = "fixture bridge append and hint\n"
      const outputs = world.appOutputs
      await following.appended(marker, () => {
        for (const output of outputs) appendFileSync(output.file, marker)
      })
      const observed = following.readings()
      assert.deepEqual(watchFailures, [])
      assert.ok(observed.hints > 0, "the real watcher emitted the append hint over the bridge")
      assert.ok(observed.outputs.every(output => output.initial && output.followed > 0 && output.heardAppend), "every visible checkout followed its cursor after the hint")

    } finally {
      try { await following?.close() } finally {
        try { await Promise.all([outputWatch?.close(), scope.stop()]) } finally {
          store.close()
          await git.close()
        }
      }
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
console.log("host-load world: its fixtures end with the bench, killed, exited or signalled; explicit release reaps leaders before guarded removal; the reaper and sweep end fixtures alone; visible outputs resolve through the bridge, follow cursors and receive native append hints; recipes leave Git clean")
