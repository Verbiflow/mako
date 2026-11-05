import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
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
  assert.equal(a.held(), false, "nothing is granted before what the last host left is counted")
  const left = slots.recover({ key: "left", label: "the check the last host left" })!
  slots.recovered()
  assert.equal(a.held(), false, "a check the last host left running holds the only slot")
  assert.equal(slots.recover({ key: "a", label: "a's check" }), undefined, "once they're counted, a key this host has is its own, not a survivor")
  left.release()
  assert.equal(a.held(), true, "its exit frees it for the next")
  assert.equal(slots.take({ key: "a", label: "a's check" }), a, "the same run asking again is the same ticket")
  assert.equal(a.survivor(), false)
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

/** Two apps' checks under one slot, in a fresh records folder: `host()` is a new host's tools over the same records and slots. */
function bench(name: string, slotsOf: () => BuildSlots) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `mako-build-slots-${name}-`)))
  const records = join(root, "records")
  const apps = ["one", "two"].map((app, at) => {
    const folder = join(root, app)
    const dataDir = join(root, `${app}-data`)
    mkdirSync(folder)
    mkdirSync(dataDir)
    const id = ThreadIdSchema.parse(randomUUID())
    const environment: ThreadEnvironment = { thread: id, app: AppKeySchema.parse(id), host: `${app}.thread.localhost`, port: 20050 + at, ports: 1, dataDir }
    return { name: app, folder, environment, conversation: `conversation-${app}` }
  })
  const of = (conversation: string) => apps.find((app) => app.conversation === conversation)!
  /** How long a call waits for its check; a test makes it longer to wait for a result. */
  const wait = { ms: 100 }
  const host = (processes: ThreadProcesses, slots: BuildSlots) => environmentTools({
    git: new Git(),
    cwd: (conversation) => of(conversation).folder,
    environment: async (conversation) => of(conversation).environment,
    launchedWith: () => undefined,
    conversation: (conversation) => ({ title: of(conversation).name, harness: "claude", working: true }),
    processes,
    buildSlots: slots,
    traces: new TraceRefresh(),
    recipesRoot: join(root, "recipes"),
    get settleMs() {
      return wait.ms
    },
  })
  const processes = new ThreadProcesses({ root: records, listening: portListening })
  return { root, records, wait, one: apps[0]!, two: apps[1]!, processes, host: () => host(processes, slotsOf()), hostOver: host }
}

// ── Two calls for one app's check at once, while another holds the slot: one run, started once, its result for both.
{
  const slots = new BuildSlots(() => 1)
  const b = bench("same-key", () => slots)
  const starts = new Map<string, number>()
  const start = b.processes.start.bind(b.processes)
  b.processes.start = (app, specs) => {
    if (specs.some((spec) => spec.kind === "check")) starts.set(app, (starts.get(app) ?? 0) + 1)
    return start(app, specs)
  }
  try {
    const tools = b.host()
    for (const app of [b.one, b.two]) await tools.save(app.conversation, RecipeSchema.parse({ values: {}, processes: {}, checks: { quick: app === b.one ? "sleep 1" : "echo ran >> count" } }), "A check")
    assert.match(await tools.check(b.one.conversation, "quick"), /still running/)
    const both = await Promise.all([tools.check(b.two.conversation, "quick"), tools.check(b.two.conversation, "quick")])
    assert.ok(both.every((reply) => /waits for a build slot/.test(reply)), JSON.stringify(both))
    b.wait.ms = 10_000
    assert.match(await tools.check(b.two.conversation, "quick"), /passed/)
    await b.processes.settle(b.two.environment.app, [runKey("check", "quick")], 5_000)
    assert.equal(starts.get(b.two.environment.app), 1, "the run both asked for started once")
    assert.equal(readFileSync(join(b.two.folder, "count"), "utf8").trim().split("\n").length, 1, "and ran once")
  } finally {
    for (const app of [b.one, b.two]) await b.processes.stop(app.environment.app)
    rmSync(b.root, { recursive: true, force: true })
  }
}

// ── A new host over the same records: a check the last one left running holds the only slot until it exits.
{
  const b = bench("recovery", () => new BuildSlots(() => 1))
  try {
    const first = b.host()
    for (const app of [b.one, b.two]) await first.save(app.conversation, RecipeSchema.parse({ values: {}, processes: {}, checks: { quick: app === b.one ? "sleep 1.5" : "echo second finished" } }), "A check")
    assert.match(await first.check(b.one.conversation, "quick"), /still running/)
    const processes = new ThreadProcesses({ root: b.records, listening: portListening })
    const slots = new BuildSlots(() => 1)
    const next = b.hostOver(processes, slots)
    assert.equal((await processes.status(b.one.environment.app)).find((run) => run.name === "quick")?.state.kind, "running", "the first check outlived its host")
    const waiting = await next.check(b.two.conversation, "quick")
    assert.match(waiting, /waits for a build slot: 1 of 1 in use \(the quick check of /, waiting)
    assert.notEqual((await processes.status(b.two.environment.app)).find((run) => run.name === "quick")?.state.kind, "running", "nothing starts beside it")
    b.wait.ms = 10_000
    assert.match(await next.check(b.two.conversation, "quick"), /passed/, "once it exits, the next goes")
    assert.deepEqual(slots.reading(), { slots: 1, holders: [], waiting: 0 }, "and both slots are given back")
  } finally {
    for (const app of [b.one, b.two]) await b.processes.stop(app.environment.app)
    rmSync(b.root, { recursive: true, force: true })
  }
}

// ── A place in line for a run that turns out to have survived becomes that run's, and a second look counts it once.
{
  const slots = new BuildSlots(() => 1)
  const waiting = slots.take({ key: "left", label: "a caller's check" })
  const other = slots.take({ key: "other", label: "another check" })
  const left = slots.recover({ key: "left", label: "the check the last host left" })
  assert.equal(left, waiting, "the caller's place is the survivor's")
  assert.deepEqual([waiting.held(), waiting.survivor()], [true, true])
  assert.equal(slots.recover({ key: "left", label: "the check the last host left" }), undefined, "a second look counts it once")
  slots.recovered()
  assert.equal(other.held(), false, "it holds the only slot")
  assert.deepEqual(slots.reading().waiting, 1, "and has left the line")
  waiting.release()
  assert.equal(other.held(), true)
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8_000
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A check of app one still running from a host that's gone, and a new host's processes over its records. */
async function survivor(name: string, seconds: number) {
  const b = bench(name, () => new BuildSlots(() => 1))
  const first = b.host()
  for (const app of [b.one, b.two]) await first.save(app.conversation, RecipeSchema.parse({ values: {}, processes: {}, checks: { quick: app === b.one ? `sleep ${seconds}` : "echo second finished" } }), "A check")
  assert.match(await first.check(b.one.conversation, "quick"), /still running/)
  const processes = new ThreadProcesses({ root: b.records, listening: portListening })
  const slots = new BuildSlots(() => 1)
  const check = (app: { environment: ThreadEnvironment }) => processes.status(app.environment.app).then((runs) => runs.find((run) => run.name === "quick")?.state.kind)
  const done = async () => {
    for (const app of [b.one, b.two]) await b.processes.stop(app.environment.app)
    rmSync(b.root, { recursive: true, force: true })
  }
  return { b, processes, slots, check, done }
}

// ── A read of what the last host left that fails says nothing of what runs: no slot goes out until one succeeds.
{
  const { b, processes, slots, check, done } = await survivor("failed-scan", 2)
  try {
    let fails = true
    const reads = { active: processes.active.bind(processes), activeRead: processes.activeRead.bind(processes) }
    processes.active = () => fails ? Promise.reject(new Error("the records can't be read")) : reads.active()
    processes.activeRead = () => fails ? Promise.reject(new Error("the records can't be read")) : reads.activeRead()
    const next = b.hostOver(processes, slots)
    const waiting = await next.check(b.two.conversation, "quick")
    assert.match(waiting, /waits for a build slot: none goes out until the checks the last host left running can be read \(the records can't be read\)/, waiting)
    assert.notEqual(await check(b.two), "running", "nothing starts over a check it can't see")
    fails = false
    b.wait.ms = 10_000
    assert.match(await next.check(b.two.conversation, "quick"), /passed/, "a read that works counts it, and the next goes once it exits")
    assert.equal(await check(b.one), "exited", "and not before")
  } finally {
    await done()
  }
}

// ── A record that can't be read isn't an empty one.
{
  const { b, processes, slots, check, done } = await survivor("unreadable-record", 2)
  const record = join(b.records, b.one.environment.app, "runs.json")
  try {
    chmodSync(record, 0)
    const next = b.hostOver(processes, slots)
    const waiting = await next.check(b.two.conversation, "quick")
    assert.match(waiting, /none goes out until the checks the last host left running can be read/, waiting)
    assert.notEqual(await check(b.two), "running", "nothing starts over a check whose record can't be read")
    await assert.rejects(processes.activeRead(), /EACCES/)
    assert.deepEqual(await processes.active().then((apps) => apps.map(({ app }) => app)), [], "active reads on past it for what only reports")
    chmodSync(record, 0o600)
    b.wait.ms = 10_000
    assert.match(await next.check(b.two.conversation, "quick"), /passed/)
    assert.equal(await check(b.one), "exited")
  } finally {
    chmodSync(record, 0o600)
    await done()
  }
}

// ── A look at a recovered run that fails isn't its exit: its slot stays held.
{
  const { b, processes, slots, check, done } = await survivor("failed-look", 2)
  try {
    let fails = true
    const settle = processes.settle.bind(processes)
    processes.settle = (app, keys, ...rest) => fails && app === b.one.environment.app ? Promise.reject(new Error("the table can't be read")) : settle(app, keys, ...rest)
    const next = b.hostOver(processes, slots)
    await until(() => slots.reading().holders.length === 1, "the survivor to be counted")
    assert.match(await next.check(b.two.conversation, "quick"), /waits for a build slot: 1 of 1 in use/)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.notEqual(await check(b.two), "running", "a failed look frees nothing")
    assert.equal(slots.reading().holders.length, 1)
    fails = false
    b.wait.ms = 10_000
    assert.match(await next.check(b.two.conversation, "quick"), /passed/)
    assert.equal(await check(b.one), "exited")
  } finally {
    await done()
  }
}

// ── The survivor's own caller, there while it's being counted: it joins the run, and the slot stays the run's.
{
  const { b, processes, slots, check, done } = await survivor("same-key-recovery", 2)
  try {
    let open!: () => void
    const scan = new Promise<void>((resolve) => (open = resolve))
    const reads = { active: processes.active.bind(processes), activeRead: processes.activeRead.bind(processes) }
    processes.active = () => scan.then(() => reads.active())
    processes.activeRead = () => scan.then(() => reads.activeRead())
    const next = b.hostOver(processes, slots)
    const asked = next.check(b.one.conversation, "quick")
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.ok(slots.has(`${b.one.environment.app}\0quick`), "it waits in line while the scan is held")
    open()
    await asked
    await until(() => slots.reading().holders.length === 1, "the survivor to be counted")
    assert.equal(await check(b.one), "running", "its run outlives the call")
    assert.match(await next.check(b.two.conversation, "quick"), /waits for a build slot: 1 of 1 in use/, "the survivor keeps the slot")
    assert.notEqual(await check(b.two), "running", "nothing starts beside it")
    b.wait.ms = 10_000
    assert.match(await next.check(b.two.conversation, "quick"), /passed/)
    assert.equal(await check(b.one), "exited")
  } finally {
    await done()
  }
}

// ── A survivor that ends as its caller's run starts: that run takes a slot of its own.
{
  const { b, processes, slots, check, done } = await survivor("survivor-ends", 1)
  try {
    let open!: () => void
    const scan = new Promise<void>((resolve) => (open = resolve))
    const reads = { active: processes.active.bind(processes), activeRead: processes.activeRead.bind(processes) }
    processes.active = () => scan.then(() => reads.active())
    processes.activeRead = () => scan.then(() => reads.activeRead())
    const start = processes.start.bind(processes)
    processes.start = async (app, specs) => {
      while (slots.has(`${app}\0quick`)) await new Promise((resolve) => setTimeout(resolve, 20))
      return start(app, specs)
    }
    const next = b.hostOver(processes, slots)
    const asked = next.check(b.one.conversation, "quick")
    await until(() => slots.has(`${b.one.environment.app}\0quick`), "its place in line")
    open()
    await asked
    await until(() => slots.reading().holders.length === 1, "the survivor to be counted")
    await until(() => slots.reading().holders.length === 0, "the survivor's end")
    await until(() => slots.reading().holders.length === 1, "the run after it to take its slot")
    assert.equal(await check(b.one), "running", "a run of its own started")
    processes.start = start
    assert.match(await next.check(b.two.conversation, "quick"), /waits for a build slot: 1 of 1 in use/)
    b.wait.ms = 10_000
    assert.match(await next.check(b.two.conversation, "quick"), /passed/)
  } finally {
    await done()
  }
}

console.log("build slots: one per check run, first come first served, handed on the moment one frees")
