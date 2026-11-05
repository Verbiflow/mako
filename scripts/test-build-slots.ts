import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { routeShellCall } from "@mako/host/contracts/native-calls"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { AppKeySchema, type ThreadEnvironment } from "@mako/host/contracts/thread-environments"
import { FinCapacity } from "@mako/host/conversations/fin-capacity-host"
import { FinCostModel } from "@mako/host/conversations/fin-cost"
import type { MacReading } from "@mako/host/conversations/mac-capacity"
import { TraceRefresh } from "@mako/host/workspaces/app-probe"
import { BuildSlots } from "@mako/host/workspaces/build-slots"
import { environmentTools } from "@mako/host/workspaces/environment-tools"
import { portListening } from "@mako/host/workspaces/thread-environment"
import { runKey, ThreadProcesses } from "@mako/host/workspaces/thread-processes"
import { RecipeSchema } from "@mako/host/workspaces/thread-recipe"

/**
 * Build slots (`npm run test:build-slots`): every check run holds one while it runs and the rest wait their turn,
 * first come first served; a slot that frees goes to the next in line in the same tick, never by a timer; a waiter
 * that leaves never holds up the rest; the count is capacity's, with one more while the machine is idle; and a heavy
 * suite run from a shell while every slot is in use hears so.
 */
const GB = 1024 ** 3

// ── The line itself.
{
  let size = 1
  const slots = new BuildSlots(() => size)
  const a = slots.take({ key: "a", label: "a's check" })
  assert.equal(a.held(), true, "a free slot is taken at once")
  assert.equal(slots.take({ key: "a", label: "a's check" }), a, "the same run asking again is the same ticket")
  const b = slots.take({ key: "b", label: "b's check" })
  const c = slots.take({ key: "c", label: "c's check" })
  const d = slots.take({ key: "d", label: "d's check" })
  assert.deepEqual([b.held(), b.ahead(), c.ahead(), d.ahead()], [false, 0, 1, 2], "the rest wait in line")
  assert.deepEqual(slots.reading(), { slots: 1, holders: ["a's check"], waiting: 3 })
  // A waiter that leaves holds up nobody.
  c.release()
  assert.equal(d.ahead(), 1)
  // The slot goes in the same tick it frees.
  slots.release("a")
  assert.equal(b.held(), true, "the next in line holds it before anything else runs")
  let came = false
  void b.granted.then(() => (came = true))
  await Promise.resolve()
  assert.equal(came, true)
  // More slots go at once too.
  size = 2
  slots.changed()
  assert.equal(d.held(), true, "one more slot is the next waiter's at once")
  slots.release("b")
  slots.release("d")
  assert.deepEqual(slots.reading(), { slots: 2, holders: [], waiting: 0 })
}

// ── How many: the builds capacity keeps room for, and one more while the machine is idle.
{
  let reading: MacReading = { cores: 14, memoryBytes: 36 * GB, load: 2 }
  let now = 0
  const capacity = new FinCapacity({ read: async () => reading, costs: new FinCostModel(), own: () => undefined, hardware: () => ({ cores: 14, memoryBytes: 36 * GB }), now: () => now })
  let heard = 0
  capacity.subscribe(() => (heard += 1))
  assert.equal(capacity.builds(), 1, "before a reading, the room capacity keeps")
  await capacity.observe(0, {})
  assert.equal(capacity.builds(), 2, "an idle Mac takes one more")
  assert.equal(heard, 1, "and says so, so what waits goes")
  reading = { ...reading, load: 9 }
  now += 10_000
  await capacity.observe(0, {})
  assert.equal(capacity.builds(), 1, "a busy one doesn't")
  reading = { ...reading, load: 2, memoryPressure: true }
  now += 10_000
  await capacity.observe(0, {})
  assert.equal(capacity.builds(), 1, "nor one under pressure, from the first reading of it")
  assert.equal(new FinCapacity({ read: async () => reading, costs: new FinCostModel(), own: () => undefined, hardware: () => ({ cores: 64, memoryBytes: 256 * GB, headless: true }) }).builds(), 4, "a big box keeps room for four")
}

// ── A heavy suite from a shell, while every slot is in use.
{
  const full = { folder: "/w", builds: { slots: 1, holders: ["the full check of Deploy"] } }
  const warned = routeShellCall(full, { command: "npm test" })
  assert.ok(warned.kind === "warn" && warned.rule === "build-slots-full" && warned.message.includes("the full check of Deploy"), JSON.stringify(warned))
  for (const command of ["pnpm run typecheck", "npx vitest run", "cargo test", "tsc -b", "yarn build"]) {
    const route = routeShellCall(full, { command })
    assert.equal("rule" in route ? route.rule : undefined, "build-slots-full", command)
  }
  for (const command of ["npm install", "git status", "tsc --version", "go version"])
    assert.equal(routeShellCall(full, { command }).kind, "allow", command)
  assert.equal(routeShellCall({ folder: "/w", builds: { slots: 2, holders: ["one"] } }, { command: "npm test" }).kind, "allow", "a slot free: nothing to say")
}

// ── Real checks of two apps on one slot: the second waits, starts the moment the first ends, and its result comes.
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-build-slots-")))
try {
  const processes = new ThreadProcesses({ root: join(root, "records"), listening: portListening })
  const exited = new Map<string, number>()
  processes.onExit((app, key) => exited.set(`${app} ${key}`, performance.now()))
  // When each app's check run begins to start, the moment its slot is its own: spawning it is the run's own time.
  const starting = new Map<string, number>()
  const start = processes.start.bind(processes)
  processes.start = (app, specs) => {
    if (specs.some((spec) => spec.kind === "check") && !starting.has(app)) starting.set(app, performance.now())
    return start(app, specs)
  }
  const slots = new BuildSlots(() => 1)
  const apps = ["one", "two"].map((name, at) => {
    const folder = join(root, name)
    mkdirSync(folder)
    const id = ThreadIdSchema.parse(randomUUID())
    const dataDir = join(root, `${name}-data`)
    mkdirSync(dataDir)
    const environment: ThreadEnvironment = { thread: id, app: AppKeySchema.parse(id), host: `${name}.thread.localhost`, port: 20040 + at, ports: 1, dataDir }
    return { name, folder, environment, conversation: `conversation-${name}` }
  })
  const of = (conversation: string) => apps.find((app) => app.conversation === conversation)!
  const tools = (settleMs: number) => environmentTools({
    git: new Git(),
    cwd: (conversation) => of(conversation).folder,
    environment: async (conversation) => of(conversation).environment,
    launchedWith: () => undefined,
    conversation: (conversation) => ({ title: of(conversation).name, harness: "claude", working: true }),
    processes,
    buildSlots: slots,
    traces: new TraceRefresh(),
    recipesRoot: join(root, "recipes"),
    settleMs,
  })
  const quick = tools(200)
  const one = apps[0]!
  const two = apps[1]!
  for (const app of apps) await quick.save(app.conversation, RecipeSchema.parse({ values: {}, processes: {}, checks: { quick: app === one ? "sleep 1.5" : "echo two fine" } }), "A check")
  const first = await quick.check(one.conversation, "quick")
  assert.match(first, /still running/, first)
  const waiting = await quick.check(two.conversation, "quick")
  assert.match(waiting, /^The quick check waits for a build slot: 1 of 1 in use \(the quick check of one\), and it's next\. It starts on its own the moment one frees/, waiting)
  const shown = await quick.status(two.conversation)
  assert.match(shown, /waits for a build slot: 1 of 1 in use \(the quick check of one\), and it's next; before it, not run yet/, shown)
  const patient = tools(10_000)
  const result = await patient.check(two.conversation, "quick")
  assert.match(result, /^The quick check passed in [\d.]+ s\./, result)
  const handoff = starting.get(two.environment.app)! - exited.get(`${one.environment.app} ${runKey("check", "quick")}`)!
  console.log(`build slot handoff: ${handoff.toFixed(1)} ms`)
  assert.ok(handoff < 100, `the second check starts within 100 ms of the first ending: ${handoff.toFixed(1)} ms`)
  assert.match(await patient.check(one.conversation, "quick"), /passed/, "the first's result is kept for it")
  assert.deepEqual(slots.reading(), { slots: 1, holders: [], waiting: 0 }, "both slots given back")
  // A run that can't be started gives its slot back, or every check after it would wait forever.
  processes.start = () => Promise.reject(new Error("spawn failed"))
  // The run its last call left is said first, however it ended; the call after it starts a run.
  await quick.check(two.conversation, "quick")
  await assert.rejects(quick.check(two.conversation, "quick"), /spawn failed/)
  assert.deepEqual(slots.reading(), { slots: 1, holders: [], waiting: 0 }, "a run that never started holds no slot")
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log("build slots: one per check run, first come first served, handed on the moment one frees")
