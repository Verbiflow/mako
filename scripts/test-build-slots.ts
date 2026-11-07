import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * Build slots (`npm run test:build-slots`): every check run holds one while it runs and the rest wait their turn,
 * first come first served; a slot that frees goes to the next in line in the same tick, never by a timer; a waiter
 * that leaves never holds up the rest; the count is capacity's, with one more while the machine is idle; and a heavy
 * suite run from a shell while every slot is in use hears so.
 */
const GB = 1024 ** 3

/** A check that runs until its folder holds `file`: a test's order, however busy the machine. */
const heldUntil = (file: string) => `until [ -e ${file} ]; do sleep 0.05; done`
const release = (folder: string, file = "go") => writeFileSync(join(folder, file), "")

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
  let reading: MacReading = { cores: 14, memoryBytes: 36 * GB, busyCores: 2 }
  let now = 0
  const capacity = new FinCapacity({ read: async () => reading, costs: new FinCostModel(), own: () => undefined, hardware: () => ({ cores: 14, memoryBytes: 36 * GB }), now: () => now })
  let heard = 0
  capacity.subscribe(() => (heard += 1))
  assert.equal(capacity.builds(), 1, "before a reading, the room capacity keeps")
  await capacity.observe(0, {})
  assert.equal(capacity.builds(), 2, "an idle Mac takes one more")
  assert.equal(heard, 1, "and says so, so what waits goes")
  reading = { ...reading, busyCores: 9 }
  now += 10_000
  await capacity.observe(0, {})
  assert.equal(capacity.builds(), 1, "a busy one doesn't")
  reading = { ...reading, busyCores: 2, memoryPressure: true }
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
const root = realpathSync(testScratch("mako-build-slots-"))
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
  for (const app of apps) await quick.save(app.conversation, RecipeSchema.parse({ values: {}, processes: {}, checks: { quick: app === one ? heldUntil("go") : "echo two fine" } }), "A check")
  await quick.check(one.conversation, "quick")
  await until(async () => (await processes.status(one.environment.app)).find((run) => run.name === "quick")?.state.kind === "running", "the first check to run")
  const waiting = await quick.check(two.conversation, "quick")
  assert.match(waiting, /^The quick check waits for a build slot: 1 of 1 in use \(the quick check of one\), and it's next\. It starts on its own the moment one frees/, waiting)
  const shown = await quick.status(two.conversation)
  assert.match(shown, /waits for a build slot: 1 of 1 in use \(the quick check of one\), and it's next; before it, not run yet/, shown)
  const patient = tools(10_000)
  release(one.folder)
  const result = await patient.check(two.conversation, "quick")
  assert.match(result, /^The quick check passed in [\d.]+ s\./, result)
  assert.ok(starting.get(two.environment.app)! >= exited.get(`${one.environment.app} ${runKey("check", "quick")}`)!, "the second check starts only once the first has gone")
  assert.match(await patient.check(one.conversation, "quick"), /passed/, "the first's result is kept for it")
  await until(() => !slots.reading().holders.length, "both slots given back")
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
function bench(name: string, slotsOf: () => BuildSlots, stopGraceMs?: number) {
  const root = realpathSync(testScratch(`mako-build-slots-${name}-`))
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
  const processes = new ThreadProcesses({ root: records, listening: portListening, ...(stopGraceMs !== undefined && { stopGraceMs }) })
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
    for (const app of [b.one, b.two]) await tools.save(app.conversation, RecipeSchema.parse({ values: {}, processes: {}, checks: { quick: app === b.one ? heldUntil("go") : "echo ran >> count" } }), "A check")
    await tools.check(b.one.conversation, "quick")
    await until(async () => (await b.processes.status(b.one.environment.app)).find((run) => run.name === "quick")?.state.kind === "running", "the first check to run")
    const both = await Promise.all([tools.check(b.two.conversation, "quick"), tools.check(b.two.conversation, "quick")])
    assert.ok(both.every((reply) => /waits for a build slot/.test(reply)), JSON.stringify(both))
    b.wait.ms = 10_000
    release(b.one.folder)
    assert.match(await tools.check(b.two.conversation, "quick"), /passed/)
    await b.processes.settle(b.two.environment.app, [runKey("check", "quick")], 5_000)
    assert.equal(starts.get(b.two.environment.app), 1, "the run both asked for started once")
    assert.equal(readFileSync(join(b.two.folder, "count"), "utf8").trim().split("\n").length, 1, "and ran once")
  } finally {
    for (const app of [b.one, b.two]) await b.processes.stop(app.environment.app)
    rmSync(b.root, { recursive: true, force: true })
  }
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!await check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A check of app one still running from a host that's gone, until `release(b.one.folder)`, and a new host's processes over its records. */
async function survivor(name: string, command = heldUntil("go"), stopGraceMs?: number, files: Record<string, string> = {}) {
  const b = bench(name, () => new BuildSlots(() => 1), stopGraceMs)
  for (const [file, text] of Object.entries(files)) writeFileSync(join(b.one.folder, file), text)
  const first = b.host()
  for (const app of [b.one, b.two]) await first.save(app.conversation, RecipeSchema.parse({ values: {}, processes: {}, checks: { quick: app === b.one ? command : "echo second finished" } }), "A check")
  await first.check(b.one.conversation, "quick")
  const check = (app: { environment: ThreadEnvironment }, processes = b.processes) => processes.status(app.environment.app).then((runs) => runs.find((run) => run.name === "quick")?.state.kind)
  await until(async () => await check(b.one) === "running", "the first check to run")
  const processes = new ThreadProcesses({ root: b.records, listening: portListening, ...(stopGraceMs !== undefined && { stopGraceMs }) })
  const slots = new BuildSlots(() => 1)
  const done = async () => {
    for (const app of [b.one, b.two]) await b.processes.stop(app.environment.app)
    rmSync(b.root, { recursive: true, force: true })
  }
  return { b, processes, slots, check: (app: { environment: ThreadEnvironment }) => check(app, processes), done }
}

/** Holds both of `processes`' reads of what's running until the function it returns is called. */
function heldReads(processes: ThreadProcesses) {
  const reads = { active: processes.active.bind(processes), activeRead: processes.activeRead.bind(processes) }
  let open!: () => void
  const scan = new Promise<void>((resolve) => (open = resolve))
  processes.active = () => scan.then(() => reads.active())
  processes.activeRead = () => scan.then(() => reads.activeRead())
  return open
}

// ── A new host over the same records: a check the last one left running holds the only slot until it exits.
{
  const { b, processes, slots, check, done } = await survivor("recovery")
  try {
    const next = b.hostOver(processes, slots)
    assert.equal(await check(b.one), "running", "the first check outlived its host")
    await until(() => slots.reading().holders.length === 1, "the survivor to be counted")
    const waiting = await next.check(b.two.conversation, "quick")
    assert.match(waiting, /waits for a build slot: 1 of 1 in use \(the quick check of /, waiting)
    assert.notEqual(await check(b.two), "running", "nothing starts beside it")
    b.wait.ms = 10_000
    release(b.one.folder)
    assert.match(await next.check(b.two.conversation, "quick"), /passed/, "once it exits, the next goes")
    await until(() => !slots.reading().holders.length && !slots.reading().waiting, "both slots to be given back")
  } finally {
    await done()
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

// ── A read of what the last host left that fails says nothing of what runs: no slot goes out until one succeeds.
{
  const { b, processes, slots, check, done } = await survivor("failed-scan")
  try {
    let fails = true
    const reads = { active: processes.active.bind(processes), activeRead: processes.activeRead.bind(processes) }
    processes.active = () => fails ? Promise.reject(new Error("the records can't be read")) : reads.active()
    processes.activeRead = () => fails ? Promise.reject(new Error("the records can't be read")) : reads.activeRead()
    const next = b.hostOver(processes, slots)
    b.wait.ms = 1_000
    const waiting = await next.check(b.two.conversation, "quick")
    assert.match(waiting, /waits for a build slot: none goes out until the checks the last host left running can be read \(the records can't be read\)/, waiting)
    assert.notEqual(await check(b.two), "running", "nothing starts over a check it can't see")
    fails = false
    await until(() => slots.reading().holders.length === 1, "a read that works to count it")
    assert.notEqual(await check(b.two), "running", "and it holds the only slot")
    b.wait.ms = 10_000
    release(b.one.folder)
    assert.match(await next.check(b.two.conversation, "quick"), /passed/, "the next goes once it exits")
  } finally {
    await done()
  }
}

// ── A record that can't be read isn't an empty one.
{
  const { b, processes, slots, check, done } = await survivor("unreadable-record")
  const record = join(b.records, b.one.environment.app, "runs.json")
  try {
    chmodSync(record, 0)
    const next = b.hostOver(processes, slots)
    b.wait.ms = 1_000
    const waiting = await next.check(b.two.conversation, "quick")
    assert.match(waiting, /none goes out until the checks the last host left running can be read/, waiting)
    assert.notEqual(await check(b.two), "running", "nothing starts over a check whose record can't be read")
    await assert.rejects(processes.activeRead(), /EACCES/)
    assert.deepEqual(await processes.active().then((apps) => apps.map(({ app }) => app)), [], "active reads on past it for what only reports")
    chmodSync(record, 0o600)
    await until(() => slots.reading().holders.length === 1, "a read that works to count it")
    b.wait.ms = 10_000
    release(b.one.folder)
    assert.match(await next.check(b.two.conversation, "quick"), /passed/)
  } finally {
    chmodSync(record, 0o600)
    await done()
  }
}

// ── A look at a recovered run that fails isn't its exit: its slot stays held.
{
  const { b, processes, slots, check, done } = await survivor("failed-look")
  try {
    let fails = true
    let looked = 0
    const settle = processes.settle.bind(processes)
    processes.settle = (app, keys, ...rest) => {
      if (app !== b.one.environment.app || !fails) return settle(app, keys, ...rest)
      looked++
      return Promise.reject(new Error("the table can't be read"))
    }
    const next = b.hostOver(processes, slots)
    await until(() => looked > 0, "a look that fails")
    assert.equal(slots.reading().holders.length, 1, "a failed look frees nothing")
    assert.match(await next.check(b.two.conversation, "quick"), /waits for a build slot: 1 of 1 in use/)
    assert.notEqual(await check(b.two), "running")
    fails = false
    b.wait.ms = 10_000
    release(b.one.folder)
    assert.match(await next.check(b.two.conversation, "quick"), /passed/, "a look that works sees it exit")
  } finally {
    await done()
  }
}

// ── The survivor's own caller, there while it's being counted: it joins the run, and the slot stays the run's.
{
  const { b, processes, slots, check, done } = await survivor("same-key-recovery")
  try {
    const open = heldReads(processes)
    const next = b.hostOver(processes, slots)
    const asked = next.check(b.one.conversation, "quick")
    await until(() => slots.has(`${b.one.environment.app}\0quick`), "its place in line while the scan is held")
    open()
    await asked
    await until(() => slots.reading().holders.length === 1, "the survivor to be counted")
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(await check(b.one), "running", "its run outlives the call")
    assert.equal(slots.reading().holders.length, 1, "and it keeps the slot")
    assert.match(await next.check(b.two.conversation, "quick"), /waits for a build slot: 1 of 1 in use/, "the survivor keeps the slot")
    assert.notEqual(await check(b.two), "running", "nothing starts beside it")
    b.wait.ms = 10_000
    release(b.one.folder)
    assert.match(await next.check(b.two.conversation, "quick"), /passed/)
  } finally {
    await done()
  }
}

// ── A survivor that ends as its caller's run starts: the slot goes on to that run, and is free when it ends.
{
  // The first run waits for go, the one after it for again.
  const { b, processes, slots, check, done } = await survivor("survivor-ends", `if [ -e ran ]; then ${heldUntil("again")}; else touch ran; ${heldUntil("go")}; fi`)
  try {
    const open = heldReads(processes)
    const start = processes.start.bind(processes)
    processes.start = async (app, specs) => {
      await until(async () => await check(b.one) !== "running", "the survivor's end")
      await new Promise((resolve) => setTimeout(resolve, 600))
      return start(app, specs)
    }
    const next = b.hostOver(processes, slots)
    const asked = next.check(b.one.conversation, "quick")
    await until(() => slots.has(`${b.one.environment.app}\0quick`), "its place in line")
    open()
    await until(() => slots.reading().holders.length === 1, "the survivor to be counted")
    release(b.one.folder)
    await asked
    await until(async () => await check(b.one) === "running", "a run of its own")
    processes.start = start
    assert.equal(slots.reading().holders.length, 1, "the slot went on to it")
    assert.match(await next.check(b.two.conversation, "quick"), /waits for a build slot: 1 of 1 in use/)
    assert.notEqual(await check(b.two), "running", "nothing starts beside it")
    b.wait.ms = 10_000
    release(b.one.folder, "again")
    assert.match(await next.check(b.two.conversation, "quick"), /passed/)
    await until(() => !slots.reading().holders.length && !slots.reading().waiting, "the slot to be free")
  } finally {
    await done()
  }
}

/** A check's process that outlives its wrapper: says it's up, notes a SIGTERM without ending, and goes when `file` appears. */
const stubborn = (file: string) => `process.on("SIGTERM",()=>fs.writeFileSync("termed",""));fs.writeFileSync("up","");setInterval(()=>{if(fs.existsSync("${file}"))process.exit(0)},20)`

// ── A slot frees with a run's whole process tree, not its wrapper: a stop's SIGTERM can leave a child still running.
{
  const slots = new BuildSlots(() => 1)
  const b = bench("stopping", () => slots)
  try {
    const tools = b.host()
    for (const app of [b.one, b.two]) await tools.save(app.conversation, RecipeSchema.parse({ values: {}, processes: {}, checks: { quick: app === b.one ? `node -e '${stubborn("go")}'` : "echo second finished" } }), "A check")
    await tools.check(b.one.conversation, "quick")
    await until(() => existsSync(join(b.one.folder, "up")), "the first check's child")
    assert.match(await tools.check(b.two.conversation, "quick"), /waits for a build slot: 1 of 1 in use/)
    const [run] = await b.processes.status(b.one.environment.app)
    const stopping = b.processes.stop(b.one.environment.app)
    await until(() => existsSync(join(b.one.folder, "termed")), "the child to hear SIGTERM")
    await until(() => {
      try {
        return !process.kill(run!.pid!, 0)
      } catch {
        return true
      }
    }, "the wrapper to exit")
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(slots.reading().waiting, 1, "the second still waits while the stop goes on")
    assert.notEqual((await b.processes.status(b.two.environment.app)).find((each) => each.name === "quick")?.state.kind, "running", "nothing starts beside what's left of it")
    release(b.one.folder)
    await stopping
    b.wait.ms = 10_000
    assert.match(await tools.check(b.two.conversation, "quick"), /passed/, "once it's gone, the next goes")
  } finally {
    for (const app of [b.one, b.two]) await b.processes.stop(app.environment.app)
    rmSync(b.root, { recursive: true, force: true })
  }
}

// ── So does a check that ends and leaves a child behind: it reads as running, and holds its slot, until that's gone.
{
  const slots = new BuildSlots(() => 1)
  const b = bench("left-behind", () => slots)
  try {
    const tools = b.host()
    await tools.save(b.one.conversation, RecipeSchema.parse({ values: {}, processes: {}, checks: { quick: `node -e '${stubborn("go")}' & exit 0` } }), "A check")
    await tools.check(b.one.conversation, "quick")
    await until(() => existsSync(join(b.one.folder, "up")), "the child it left")
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(slots.reading().holders.length, 1, "its slot stays held")
    release(b.one.folder)
    await until(() => !slots.reading().holders.length, "the slot to free once it's gone")
  } finally {
    await b.processes.stop(b.one.environment.app)
    rmSync(b.root, { recursive: true, force: true })
  }
}

/** A process of a check that detaches, ignores SIGTERM and says its pid: reparented, it's out of the check's tree. */
const detached = (saidIn: string) => `const child=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(`process.on("SIGTERM",()=>{});require("node:fs").writeFileSync("${saidIn}",String(process.pid));setInterval(()=>{},1000)`)}],{detached:true,stdio:"ignore"});child.unref();`
/** The same with none of the run's marks: a process it's seen to own, and no mark can find. */
const unmarked = (saidIn: string) => detached(saidIn).replace(`{detached:true,stdio:"ignore"}`, `{detached:true,stdio:"ignore",env:{PATH:process.env.PATH}}`)
const alive = (pid: number) => {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}
const pidIn = (folder: string, file: string) => Number(readFileSync(join(folder, file), "utf8"))

// ── A stopped check's detached child, out of its tree and ignoring SIGTERM: the slot waits for it to be gone.
{
  const slots = new BuildSlots(() => 1)
  const b = bench("detached-stop", () => slots, 300)
  try {
    const tools = b.host()
    writeFileSync(join(b.one.folder, "parent.cjs"), `${detached("child-pid")}setInterval(()=>{},1000)`)
    for (const app of [b.one, b.two]) await tools.save(app.conversation, RecipeSchema.parse({ values: {}, processes: {}, checks: { quick: app === b.one ? `"${process.execPath}" parent.cjs` : "echo second finished" } }), "A check")
    await tools.check(b.one.conversation, "quick")
    await until(() => existsSync(join(b.one.folder, "child-pid")), "the detached child")
    const child = pidIn(b.one.folder, "child-pid")
    assert.ok((await b.processes.footprint(b.one.environment.app, [b.one.folder])).pids.includes(child), "it's the run's before the stop")
    assert.match(await tools.check(b.two.conversation, "quick"), /waits for a build slot: 1 of 1 in use/)
    const start = b.processes.start.bind(b.processes)
    let aliveAtStart: boolean | undefined
    b.processes.start = (app, specs) => {
      aliveAtStart ??= alive(child)
      return start(app, specs)
    }
    await b.processes.stop(b.one.environment.app)
    assert.equal(alive(child), false, "a stop ends it, by what it was seen to be")
    b.wait.ms = 10_000
    assert.match(await tools.check(b.two.conversation, "quick"), /passed/)
    assert.equal(aliveAtStart, false, "the next check started only once it was gone")
  } finally {
    for (const app of [b.one, b.two]) await b.processes.stop(app.environment.app)
    rmSync(b.root, { recursive: true, force: true })
  }
}

// ── A check that finishes and leaves one behind: nobody asked for it to die, so it lives and the slot frees. A stop ends it.
{
  const slots = new BuildSlots(() => 1)
  const b = bench("detached-end", () => slots, 300)
  try {
    const tools = b.host()
    writeFileSync(join(b.one.folder, "parent.cjs"), detached("child-pid"))
    await tools.save(b.one.conversation, RecipeSchema.parse({ values: {}, processes: {}, checks: { quick: `"${process.execPath}" parent.cjs` } }), "A check")
    await tools.check(b.one.conversation, "quick")
    await until(() => existsSync(join(b.one.folder, "child-pid")), "the detached child")
    const child = pidIn(b.one.folder, "child-pid")
    await until(() => !slots.reading().holders.length, "the slot to free")
    assert.equal(alive(child), true, "the daemon outlives the check that finished")
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(alive(child), true, "and goes on")
    assert.deepEqual(b.processes.unending(), [], "and nothing calls it stuck")
    await b.processes.stop(b.one.environment.app)
    assert.equal(alive(child), false, "a stop of that check is asked for, and ends it")
  } finally {
    await b.processes.stop(b.one.environment.app)
    rmSync(b.root, { recursive: true, force: true })
  }
}

// ── One a stop can't end: the slot stays held, and a check waiting on it says why.
{
  const slots = new BuildSlots(() => 1)
  const b = bench("unending", () => slots, 100)
  const kill = process.kill.bind(process)
  let child = 0
  try {
    const tools = b.host()
    writeFileSync(join(b.one.folder, "parent.cjs"), `${detached("child-pid")}setInterval(()=>{},1000)`)
    for (const app of [b.one, b.two]) await tools.save(app.conversation, RecipeSchema.parse({ values: {}, processes: {}, checks: { quick: app === b.one ? `"${process.execPath}" parent.cjs` : "echo second finished" } }), "A check")
    await tools.check(b.one.conversation, "quick")
    await until(() => existsSync(join(b.one.folder, "child-pid")), "the detached child")
    child = pidIn(b.one.folder, "child-pid")
    process.kill = (pid, signal) => (pid === child && signal !== 0 ? true : kill(pid, signal))
    await assert.rejects(b.processes.stop(b.one.environment.app), /after SIGKILL/)
    await until(() => b.processes.unending().length === 1, "it to be said")
    assert.equal(slots.reading().holders.length, 1, "its slot stays held")
    b.wait.ms = 1_000
    assert.match(await tools.check(b.two.conversation, "quick"), new RegExp(`waits for a build slot: 1 of 1 in use \\(.*process ${child} .* won't end\\)`))
    assert.notEqual((await b.processes.status(b.two.environment.app)).find((run) => run.name === "quick")?.state.kind, "running", "nothing starts over it")
    process.kill = kill
    await until(() => !alive(child), "it to go once it can be ended")
    b.wait.ms = 10_000
    assert.match(await tools.check(b.two.conversation, "quick"), /passed/)
    assert.deepEqual(b.processes.unending(), [])
  } finally {
    process.kill = kill
    if (child && alive(child)) process.kill(child, "SIGKILL")
    for (const app of [b.one, b.two]) await b.processes.stop(app.environment.app)
    rmSync(b.root, { recursive: true, force: true })
  }
}

// ── One that clears its marks and can't be ended: the stop saw it, so its slot stays held though no mark finds it.
{
  const slots = new BuildSlots(() => 1)
  const b = bench("unmarked", () => slots, 100)
  const kill = process.kill.bind(process)
  let child = 0
  try {
    const tools = b.host()
    writeFileSync(join(b.one.folder, "parent.cjs"), `${unmarked("child-pid")}setInterval(()=>{},1000)`)
    for (const app of [b.one, b.two]) await tools.save(app.conversation, RecipeSchema.parse({ values: {}, processes: {}, checks: { quick: app === b.one ? `"${process.execPath}" parent.cjs` : "echo second finished" } }), "A check")
    await tools.check(b.one.conversation, "quick")
    await until(() => existsSync(join(b.one.folder, "child-pid")), "the detached child")
    child = pidIn(b.one.folder, "child-pid")
    process.kill = (pid, signal) => (pid === child && signal !== 0 ? true : kill(pid, signal))
    await assert.rejects(b.processes.stop(b.one.environment.app), /after SIGKILL/)
    await until(() => b.processes.unending().length === 1, "it to be said")
    assert.equal(slots.reading().holders.length, 1, "its slot stays held")
    b.wait.ms = 1_000
    assert.match(await tools.check(b.two.conversation, "quick"), new RegExp(`process ${child} .* won't end`))
    process.kill = kill
    await until(() => !alive(child), "it to go once it can be ended")
    b.wait.ms = 10_000
    assert.match(await tools.check(b.two.conversation, "quick"), /passed/)
  } finally {
    process.kill = kill
    if (child && alive(child)) process.kill(child, "SIGKILL")
    for (const app of [b.one, b.two]) await b.processes.stop(app.environment.app)
    rmSync(b.root, { recursive: true, force: true })
  }
}

// ── A stop that didn't finish, and a host gone: the next host counts what it saw, goes on with it, and frees the slot after.
{
  const stoppedOn = new BuildSlots(() => 1)
  const b = bench("unfinished-stop", () => stoppedOn, 100)
  const kill = process.kill.bind(process)
  let child = 0
  try {
    const tools = b.host()
    writeFileSync(join(b.one.folder, "parent.cjs"), `${unmarked("child-pid")}setInterval(()=>{},1000)`)
    for (const app of [b.one, b.two]) await tools.save(app.conversation, RecipeSchema.parse({ values: {}, processes: {}, checks: { quick: app === b.one ? `"${process.execPath}" parent.cjs` : "echo second finished" } }), "A check")
    await tools.check(b.one.conversation, "quick")
    await until(() => existsSync(join(b.one.folder, "child-pid")), "the detached child")
    child = pidIn(b.one.folder, "child-pid")
    process.kill = (pid, signal) => (pid === child && signal !== 0 ? true : kill(pid, signal))
    await assert.rejects(b.processes.stop(b.one.environment.app), /after SIGKILL/)
    const processes = new ThreadProcesses({ root: b.records, listening: portListening, stopGraceMs: 100 })
    const slots = new BuildSlots(() => 1)
    const next = b.hostOver(processes, slots)
    await until(() => slots.reading().holders.length === 1, "what the stop saw to be counted")
    await until(() => processes.unending().length === 1, "the next host to say it won't end")
    b.wait.ms = 1_000
    assert.match(await next.check(b.two.conversation, "quick"), new RegExp(`process ${child} .* won't end`))
    assert.notEqual((await processes.status(b.two.environment.app)).find((run) => run.name === "quick")?.state.kind, "running", "nothing starts over it")
    process.kill = kill
    await until(() => !alive(child), "it to go once it can be ended")
    b.wait.ms = 10_000
    assert.match(await next.check(b.two.conversation, "quick"), /passed/)
    await until(() => !slots.reading().holders.length && !slots.reading().waiting, "the slot to be free")
  } finally {
    process.kill = kill
    if (child && alive(child)) process.kill(child, "SIGKILL")
    for (const app of [b.one, b.two]) await b.processes.stop(app.environment.app)
    rmSync(b.root, { recursive: true, force: true })
  }
}

// ── What the last host left runs by the same two rules, and finding it ends nothing: it finishes, and its daemon lives.
const leavesDaemon = `${detached("child-pid")}setInterval(()=>{if(require("node:fs").existsSync("go"))process.exit(0)},20)`
{
  const { b, processes, slots, done } = await survivor("survivor-finishes", `"${process.execPath}" parent.cjs`, 300, { "parent.cjs": leavesDaemon })
  try {
    await until(() => existsSync(join(b.one.folder, "child-pid")), "the detached child")
    const child = pidIn(b.one.folder, "child-pid")
    b.hostOver(processes, slots)
    await until(() => slots.reading().holders.length === 1, "the survivor to be counted")
    assert.equal(alive(child), true, "finding a survivor ends nothing of it")
    release(b.one.folder)
    await until(() => !slots.reading().holders.length, "the slot to free as it finishes")
    assert.equal(alive(child), true, "and its daemon lives on, as any finished check's does")
  } finally {
    await done()
  }
}

// ── And a stop of one is asked for: the slot waits for its daemon, as for any stopped check.
{
  const { b, processes, slots, check, done } = await survivor("survivor-stopped", `"${process.execPath}" parent.cjs`, 300, { "parent.cjs": leavesDaemon })
  try {
    await until(() => existsSync(join(b.one.folder, "child-pid")), "the detached child")
    const child = pidIn(b.one.folder, "child-pid")
    const next = b.hostOver(processes, slots)
    await until(() => slots.reading().holders.length === 1, "the survivor to be counted")
    assert.match(await next.check(b.two.conversation, "quick"), /waits for a build slot: 1 of 1 in use/)
    const start = processes.start.bind(processes)
    let aliveAtStart: boolean | undefined
    processes.start = (app, specs) => {
      aliveAtStart ??= alive(child)
      return start(app, specs)
    }
    await processes.stop(b.one.environment.app)
    assert.equal(alive(child), false, "the stop ended it")
    b.wait.ms = 10_000
    assert.match(await next.check(b.two.conversation, "quick"), /passed/)
    assert.equal(aliveAtStart, false, "and the next check started only once it was gone")
    assert.notEqual(await check(b.one), "running")
  } finally {
    await done()
  }
}

// ── A survivor's slot waits on the rules a run ends by, not only its status.
{
  const { b, processes, slots, check, done } = await survivor("survivor-footprint")
  try {
    let gone!: () => void
    const left = new Promise<void>((resolve) => (gone = resolve))
    const whenGone = processes.whenGone.bind(processes)
    processes.whenGone = (app, key) => left.then(() => whenGone(app, key))
    const next = b.hostOver(processes, slots)
    await until(() => slots.reading().holders.length === 1, "the survivor to be counted")
    release(b.one.folder)
    await until(async () => await check(b.one) === "exited", "its tree to end")
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(slots.reading().holders.length, 1, "its slot waits for its run to be over")
    gone()
    b.wait.ms = 10_000
    assert.match(await next.check(b.two.conversation, "quick"), /passed/)
  } finally {
    await done()
  }
}

console.log("build slots: one per check run, first come first served, handed on the moment one frees")
