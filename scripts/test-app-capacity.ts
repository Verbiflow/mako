import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { parse as parseYaml } from "yaml"
import { FIT_RUNS } from "../electron/contracts/thread-app.js"
import { AppKeySchema, THREAD_PORT_COUNT, type AppKey, type ThreadEnvironment } from "../electron/contracts/thread-environments.js"
import { spareInstalls } from "../electron/checkout-install.js"
import { commandEnvironment, environmentTools } from "../electron/environment-tools.js"
import { spareInstaller } from "../electron/spare-install.js"
import { folderApp, portListening } from "../electron/thread-environment.js"
import { ThreadProcesses } from "../electron/thread-processes.js"
import { inputsDigest, projectRecipe, RecipeSchema, RECIPE_PATH } from "../electron/thread-recipe.js"
import { ThreadStore } from "../electron/thread-store.js"
import { ThreadWorktreeService } from "../electron/thread-worktrees.js"
import type { CheckoutSetup } from "../electron/worktree-carry.js"

/**
 * Capacity: a spare checkout runs its install before a Thread takes it and
 * the record goes with it (a claim mid-install hands the run over, and the
 * Thread's start waits for it); each project's memory peaks are kept across
 * runs and give "about N at once" only after `FIT_RUNS`; the Room lists
 * every app on this Mac and stops them.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-app-capacity-")))
const records = join(root, "thread-environments")
let skew = 0
const now = () => Date.now() + skew
const processes = new ThreadProcesses({ root: records, listening: portListening, now })
const owned: AppKey[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

async function until<T>(what: string, look: () => Promise<T | undefined> | T | undefined, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const found = await look()
    if (found !== undefined && found !== false) return found
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const installs = join(root, "installs.log")
const hold = join(root, "hold")
writeFileSync(join(root, "install.sh"), [
  `echo "$PWD" >> '${installs}'`,
  `while [ -f '${hold}' ]; do sleep 0.05; done`,
  "mkdir -p vendor/dep && echo ok > vendor/dep/index.js",
].join("\n"))
const INSTALL = `sh '${join(root, "install.sh")}'`
const installedIn = () => existsSync(installs) ? readFileSync(installs, "utf8").split("\n").filter(Boolean) : []

function repository(name: string): string {
  const path = join(root, name)
  mkdirSync(join(path, ".mako"), { recursive: true })
  git(path, "init", "-q", "-b", "main")
  git(path, "config", "user.email", "test@example.invalid")
  git(path, "config", "user.name", "Test")
  writeFileSync(join(path, ".gitignore"), "vendor/\n")
  writeFileSync(join(path, "package-lock.json"), "{}\n")
  writeFileSync(join(path, RECIPE_PATH), JSON.stringify({
    prepare: [{ command: INSTALL, inputs: ["package-lock.json"], outputs: ["vendor"] }],
    processes: { idle: { command: "sleep 300" } },
  }))
  git(path, "add", ".")
  git(path, "commit", "-q", "-m", "first")
  return path
}

// What a spare can run before a Thread has it: leading steps that write into the checkout and use no Thread's values.
const split = RecipeSchema.parse({
  values: { PORT: "{port}", MODE: "test" },
  prepare: [
    { command: "npm ci $MODE", inputs: ["package-lock.json"], outputs: ["vendor"] },
    { command: "make db PORT=$PORT", inputs: ["Makefile"], outputs: ["db"] },
    { command: "npm run build", inputs: ["src"], outputs: ["dist"] },
  ],
})
assert.deepEqual(spareInstalls(split, split.prepare.map((step) => ({ step, command: step.command, digest: "d" }))).map((entry) => entry.command), ["npm ci $MODE"],
  "a step using the Thread's port, and everything after it, waits for the Thread")
assert.deepEqual(spareInstalls(split, [{ step: split.prepare[2]!, command: "npm run build", digest: "d" }]).map((entry) => entry.command), ["npm run build"])

const threads = new ThreadStore(join(root, "threads.sqlite"))
const setup: CheckoutSetup = {
  recipe: (checkout) => projectRecipe(checkout, undefined),
  prepared: (checkout) => processes.prepared(checkout),
  savePrepared: (checkout, prepared) => processes.savePrepared(checkout, prepared),
  forgetPrepared: (checkout) => processes.forgetPrepared(checkout),
  spareInstall: spareInstaller({ processes, recipe: (checkout) => projectRecipe(checkout, undefined), env: (values) => ({ ...commandEnvironment(), ...values }), pressure: async () => "normal" }),
}
const worktrees = new ThreadWorktreeService(join(root, "worktrees"), threads, async () => [], async () => [], undefined, setup)
const spareRecords = join(root, "worktrees", "spares")
// SAFETY: the worktree service above writes every record here, with at least these fields.
const spares = () => readdirSync(spareRecords).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(spareRecords, name), "utf8")) as {
  id: string; repoRoot: string; path: string; state: string; install?: { app: AppKey; state: string }
})

// Each checkout's Thread app, as the desk finds it by folder; a port block nothing listens on, since these apps listen nowhere.
const titles = new Map<AppKey, string>()
const appsByCheckout = new Map<string, AppKey>()
const environmentOf = (checkout: string): ThreadEnvironment => {
  let app = appsByCheckout.get(checkout)
  if (!app) {
    app = AppKeySchema.parse(randomUUID())
    appsByCheckout.set(checkout, app)
    owned.push(app)
  }
  return { app, host: "127.0.0.1", port: 29_990, ports: THREAD_PORT_COUNT, dataDir: join(root, "data", app) }
}
const conversations = new Map<string, string>()
let free = { freeBytes: 0, totalBytes: 0 }
const tools = environmentTools({
  cwd: (id) => conversations.get(id),
  environment: async (_id, cwd) => environmentOf(realpathSync(cwd)),
  launchedWith: () => undefined,
  folder: async (cwd) => {
    const checkout = realpathSync(cwd)
    return { app: environmentOf(checkout).app, checkout, project: basename(checkout), root: checkout, environment: environmentOf(checkout) }
  },
  owner: (app) => titles.has(app) ? { id: app, title: titles.get(app)! } : undefined,
  processes,
  pressure: async () => "normal",
  freeMemory: async () => free,
  settleMs: 3_000,
  now,
})
const threadIn = (checkout: string, title: string) => {
  const conversation = randomUUID()
  conversations.set(conversation, checkout)
  titles.set(environmentOf(checkout).app, title)
  return conversation
}

try {
  // A spare's install runs once it's ready, and its record goes with it to the Thread that claims it.
  const shop = repository("shop")
  const digest = await inputsDigest(shop, ["package-lock.json"])
  assert.equal((await worktrees.prepare(randomUUID(), shop, "First")).spare, false)
  await worktrees.settled()
  const ready = spares().filter((spare) => spare.repoRoot === shop)
  assert.equal(ready.length, 2)
  for (const spare of ready) {
    assert.equal(spare.install?.state, "passed", "each spare ran its install")
    assert.deepEqual((await processes.prepared(spare.path)).done, { [INSTALL]: digest })
    assert.equal(readFileSync(join(spare.path, "vendor", "dep", "index.js"), "utf8"), "ok\n")
  }
  assert.deepEqual(installedIn().sort(), ready.map((spare) => spare.path).sort(), "one install in each spare, none anywhere else")
  const second = await worktrees.prepare(randomUUID(), shop, "Second")
  assert.equal(second.spare, true)
  const taken = ready.find((spare) => !spares().some((left) => left.id === spare.id))!
  assert.deepEqual((await processes.prepared(second.path)).done, { [INSTALL]: digest }, "the record moved with the checkout")
  assert.deepEqual(await processes.prepared(taken.path), { done: {} }, "and nothing is left under the spare's old path")
  const secondThread = threadIn(second.path, "Second")
  assert.match(await tools.start(secondThread), /idle: running/)
  assert.equal(installedIn().includes(second.path), false, "the Thread's start installs nothing again")
  assert.equal(readFileSync(join(second.path, "vendor", "dep", "index.js"), "utf8"), "ok\n")
  await tools.stop(secondThread)
  await worktrees.settled()

  // A claim while the spare's install runs hands it over: the Thread's start waits for that run instead of installing again.
  const cart = repository("cart")
  writeFileSync(hold, "")
  await worktrees.prepare(randomUUID(), cart, "Cart first")
  await until("one spare installing and one waiting its turn", () => {
    const made = spares().filter((spare) => spare.repoRoot === cart && spare.state === "ready")
    return made.length === 2 && made.filter((spare) => spare.install?.state === "running").length === 1 && made.some((spare) => !spare.install)
  })
  const installing = spares().find((spare) => spare.repoRoot === cart && spare.install?.state === "running")!
  const room = await tools.desk.room()
  const spareRow = room.apps.find((entry) => entry.app === installing.install!.app)
  assert.deepEqual(spareRow && [spareRow.kind, spareRow.state, spareRow.runs, spareRow.project?.root], ["spare", "starting", ["install"], cart], "the Room lists a spare's install")
  const claimed = await worktrees.prepare(randomUUID(), cart, "Claimed mid-install")
  assert.equal(claimed.spare, true)
  assert.equal(spares().some((spare) => spare.id === installing.id), false, "the claim took the spare that was installing, ahead of one still waiting to")
  const handed = await processes.prepared(claimed.path)
  assert.deepEqual([handed.pending, handed.by, handed.link], [{ [INSTALL]: digest }, installing.install!.app, installing.path])
  assert.equal(lstatSync(installing.path).isSymbolicLink() && readlinkSync(installing.path), claimed.path, "a link where the spare was keeps the run's paths working")
  const claimedThread = threadIn(claimed.path, "Claimed mid-install")
  assert.match(await tools.start(claimedThread), /Preparing this checkout \(.+\); the app starts by itself once it's done/)
  // SAFETY: app_status lists unfinished prepare steps as step → sentence; the assertion below reads it.
  const status = parseYaml(await tools.status(claimedThread)) as { prepare?: Record<string, string> }
  assert.match(status.prepare?.[INSTALL] ?? "", /installing now, in a run that started before this Thread took the checkout/)
  const handedRow = (await tools.desk.room()).apps.find((entry) => entry.app === installing.install!.app)
  assert.deepEqual(handedRow && [handedRow.kind, handedRow.checkout, handedRow.thread?.title], ["spare", claimed.path, "Claimed mid-install"], "the Room names the Thread that took it")
  rmSync(hold)
  const claimedApp = environmentOf(claimed.path).app
  await until("the claimed Thread's app", async () => (await processes.status(claimedApp)).find((entry) => entry.kind === "process" && entry.state.kind === "running"))
  assert.equal(installedIn().filter((path) => path === claimed.path || path === installing.path).length, 1, "one install, in the spare, before the move")
  assert.equal(readFileSync(join(claimed.path, "vendor", "dep", "index.js"), "utf8"), "ok\n", "what it wrote after the move is in the Thread's checkout")
  assert.deepEqual(await processes.prepared(claimed.path), { checkout: claimed.path, done: { [INSTALL]: digest } }, "the run passed, so the Thread's record has it")
  assert.equal(existsSync(installing.path), false, "the link went with the run")
  await tools.stop(claimedThread)
  await worktrees.settled()

  // Memory: each run's peak counts toward its project once it stayed up a minute; the estimate waits for `FIT_RUNS` of them.
  const project = join(root, "memory-project")
  mkdirSync(project)
  const app = AppKeySchema.parse(randomUUID())
  owned.push(app)
  titles.set(app, "Holds memory")
  const holdMb = (mb: number) => `node -e "const b = Buffer.alloc(${mb} * 1024 * 1024, 1); setInterval(() => b[0]++, 1000)"`
  const run = async (mb: number, steady = true) => {
    await processes.ofProject(app, project)
    await processes.touch(app, project)
    await processes.start(app, [{ kind: "process", name: "server", command: holdMb(mb), cwd: project, env: process.env }])
    await until("the process to hold its memory", async () => ((await processes.memory()).apps.get(app)?.bytes ?? 0) > mb * 1024 * 1024)
    if (steady) {
      skew += 61_000
      await processes.memory()
    }
  }
  // SAFETY: ThreadProcesses writes every memory record here, each with its project and runs.
  const recorded = () => readdirSync(join(records, "memory"))
    .map((name) => JSON.parse(readFileSync(join(records, "memory", name), "utf8")) as { project: string; runs: { bytes: number; steady?: boolean }[] })
    .find((entry) => entry.project === project)!.runs
  // A run stopped before it settled doesn't count.
  await run(200, false)
  await processes.stop(app)
  assert.equal(recorded().filter((entry) => !entry.steady).length, 1)
  const sizes = [40, 120, 80]
  for (const [index, mb] of sizes.entries()) {
    assert.deepEqual(await processes.estimate(project), { kind: "learning", runs: index })
    await run(mb)
    assert.ok(recorded().at(-1)!.bytes > mb * 1024 * 1024, "a run's peak holds at least what it allocated")
    if (index < sizes.length - 1) await processes.stop(app)
  }
  const peaks = recorded().filter((entry) => entry.steady).map((entry) => entry.bytes)
  assert.ok(peaks[0]! < peaks[2]! && peaks[2]! < peaks[1]!, `the peaks follow the runs' sizes (${peaks.join(", ")})`)
  const estimate = await new ThreadProcesses({ root: records, listening: portListening, now }).estimate(project)
  assert.deepEqual(estimate, { kind: "ready", runs: FIT_RUNS, peakBytes: peaks[2] }, `${FIT_RUNS} settled runs give the median peak, read by any host`)
  const median = peaks[2]!

  // app_status's room line says how many fit, from the free memory now.
  free = { freeBytes: median * 10 + 1, totalBytes: median * 40 }
  const memoryConversation = randomUUID()
  conversations.set(memoryConversation, project)
  appsByCheckout.set(realpathSync(project), app)
  // SAFETY: String() makes any value a line; the match below fails if app_status left `room` out.
  const line = String((parseYaml(await tools.status(memoryConversation)) as { room: string }).room)
  assert.match(line, /each copy of this app peaks around .+ \(the median of its last 3 runs\); with .+ free, about 11 fit at once, counting the 1 running now/)

  // The Room: every app on this Mac with what it holds, and how many copies of each project's app fit.
  const view = await tools.desk.room()
  const row = view.apps.find((entry) => entry.app === app)!
  assert.deepEqual([row.kind, row.state, row.project?.name, row.thread?.title, row.runs], ["thread", "running", "memory-project", "Holds memory", ["server"]])
  assert.ok((row.memoryBytes ?? 0) > 80 * 1024 * 1024 && row.upAt !== undefined && row.usedAt !== undefined)
  const fit = view.fits.find((entry) => entry.root === project)!
  assert.equal(fit.estimate.kind, "ready")
  if (fit.estimate.kind === "ready" && view.freeBytes !== undefined) assert.equal(fit.estimate.atOnce, 1 + Math.floor(view.freeBytes / fit.estimate.peakBytes))
  assert.ok(view.marks.some((mark) => mark.checkout === realpathSync(project) && mark.state === "running"), "the marks come with it")
  await assert.rejects(tools.desk.stopApps(["not-an-app"]), /isn't an app Mako runs/)
  await tools.desk.stopApps([app])
  assert.equal((await tools.desk.room()).apps.some((entry) => entry.app === app), false, "a stopped app leaves the Room")

  // Containers run outside every process tree, so a project that starts them gets no estimate.
  const docker = join(root, "bin", "docker")
  mkdirSync(join(root, "bin"))
  writeFileSync(docker, "#!/bin/sh\nexec sleep 300\n", { mode: 0o755 })
  const boxed = join(root, "boxed-project")
  mkdirSync(boxed)
  const boxedApp = folderApp(boxed)
  owned.push(boxedApp)
  await processes.ofProject(boxedApp, boxed)
  await processes.start(boxedApp, [{ kind: "process", name: "db", command: `${docker} compose up`, cwd: boxed, env: process.env }])
  await until("the container client", async () => (await processes.memory()).apps.get(boxedApp)?.containers)
  skew += 61_000
  await processes.memory()
  assert.deepEqual(await processes.estimate(boxed), { kind: "containers" })
  await processes.stop(boxedApp)

  console.log(`app capacity: spares run their install in the background and hand the record over on claim (no second install; a claim mid-install hands the run over, the start waits for it, the Room names its Thread); memory peaks kept per project across runs and hosts, "about N at once" only after ${FIT_RUNS} settled runs, containers never estimated; the Room lists apps with project, Thread, memory, up and used times, and stops them`)
} finally {
  rmSync(hold, { force: true })
  const started = readdirSync(records).flatMap((name) => AppKeySchema.safeParse(name).data ?? [])
  for (const app of new Set([...owned, ...started])) await processes.discard(app).catch(() => {})
  await worktrees.settled().catch(() => {})
  threads.close()
  rmSync(root, { recursive: true, force: true })
}
