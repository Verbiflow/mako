import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { AppKeySchema, type ThreadEnvironment } from "@mako/host/contracts/thread-environments"
import { environmentTools } from "@mako/host/workspaces/environment-tools"
import { portListening } from "@mako/host/workspaces/thread-environment"
import { ThreadProcesses } from "@mako/host/workspaces/thread-processes"
import { TraceRefresh } from "@mako/host/workspaces/app-probe"
import { placedProofs, publishedVersion, readRecipe, readVersion, recipeIn, recipePath, RecipeSchema, type Recipe, type RecipeWhere } from "@mako/host/workspaces/thread-recipe"

/**
 * One recipe in two places (cloud plan 1.10): what differs by place written inside it, a place's values and patches
 * applied where it runs and nowhere else, what a place can't run named as such, named secrets said before a cloud
 * start that would lack one, a base install step kept free of Thread values, and each version's proofs kept per
 * place, with a cloud start of a version proved only on a Mac saying so.
 */

const MAC: RecipeWhere = { place: "local", platform: "mac" }
const CLOUD: RecipeWhere = { place: "cloud", platform: "linux" }

// The recipe: what a place may change, and what it may not.
{
  const base = { processes: { web: { command: "node server.mjs", port: "{port}" } } }
  assert.equal(RecipeSchema.safeParse({ ...base, places: { cloud: { processes: { api: { command: "x" } } } } }).success, false, "a place patches a process; it never adds one")
  const refused = RecipeSchema.safeParse({ ...base, prepare: [{ command: "createdb app_{thread}", inputs: ["package.json"] }] })
  assert.equal(refused.success, false)
  assert.match(JSON.stringify(refused.error?.issues), /a base step gets no Thread values/)
  assert.equal(RecipeSchema.safeParse({ ...base, prepare: [{ command: "createdb app_{thread}", inputs: ["package.json"], phase: "thread" }] }).success, true, "a Thread step may use them")
  assert.equal(RecipeSchema.safeParse({ ...base, secretNames: ["not a name"] }).success, false)

  const recipe = RecipeSchema.parse({
    values: { PORT: "{port}", APP_URL: "http://localhost:{port}" },
    processes: { web: { command: "npm run web", port: "{port}" }, desktop: { command: "npm run desktop", platform: "mac" }, worker: { command: "make run", platform: "linux" } },
    targets: { web: { processes: ["web"] }, desktop: { processes: ["web", "desktop"] } },
    places: { cloud: { values: { APP_URL: "https://{thread}.preview" }, processes: { web: { command: "npm run web -- --host 0.0.0.0" } } } },
  })
  const here = recipeIn(recipe, MAC)
  assert.equal(here.recipe.values.APP_URL, "http://localhost:{port}")
  assert.deepEqual(Object.keys(here.recipe.processes), ["web", "desktop"], "this Mac runs the desktop app, not the Linux worker")
  assert.deepEqual(here.absent, { processes: [{ name: "worker", needs: "linux" }], targets: [] })
  const there = recipeIn(recipe, CLOUD)
  assert.equal(there.recipe.values.APP_URL, "https://{thread}.preview", "the cloud's value replaces the shared one")
  assert.equal(there.recipe.values.PORT, "{port}", "the rest stay shared")
  assert.equal(there.recipe.processes.web?.command, "npm run web -- --host 0.0.0.0", "its patch, applied")
  assert.equal(there.recipe.processes.web?.port, "{port}", "the fields it doesn't patch stay")
  assert.deepEqual(there.absent, { processes: [{ name: "desktop", needs: "mac" }], targets: ["desktop"] })
  assert.deepEqual(Object.keys(there.recipe.targets ?? {}), ["web"])
  assert.equal("places" in there.recipe, false, "the recipe as it runs has no places left")
  assert.deepEqual(recipe.checks, there.recipe.checks, "the same checks in every place")
}

// Two hosts, one project and one recipe store: this Mac's and a cloud machine's.
const git = new Git()
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-recipe-places-")))
const project = join(root, "app")
mkdirSync(project)
writeFileSync(join(project, "server.mjs"), `
import { createServer } from "node:http"
import { writeFileSync } from "node:fs"
const port = Number(process.env.PORT)
writeFileSync(process.env.MAKO_THREAD_DATA_DIR + "/greeting", process.env.GREETING ?? "")
createServer((_, response) => response.end(process.env.GREETING)).listen(port, "127.0.0.1")
process.on("SIGTERM", () => process.exit(0))
`)
const processes = new ThreadProcesses({ root: join(root, "records"), listening: portListening })
const traces = new TraceRefresh()
const recipesRoot = join(root, "recipes")
async function freeBlock(from: number): Promise<number> {
  for (let base = from; base < from + 2_000; base += 10) {
    const busy = await Promise.all(Array.from({ length: 10 }, (_, index) => portListening(base + index)))
    if (!busy.some(Boolean)) return base
  }
  throw new Error("no free ports for the test")
}
const thread = async (name: string, from: number): Promise<ThreadEnvironment> => {
  const id = ThreadIdSchema.parse(randomUUID())
  const dataDir = join(root, "data", name)
  mkdirSync(dataDir, { recursive: true })
  return { thread: id, app: AppKeySchema.parse(id), host: `${name}.thread.localhost`, port: await freeBlock(from), ports: 10, dataDir }
}
const secrets = new Set<string>()
const hostIn = (environment: ThreadEnvironment, where: RecipeWhere) => environmentTools({
  git,
  cwd: () => project,
  environment: async () => environment,
  launchedWith: () => undefined,
  folder: async () => ({ app: environment.app, checkout: project, project: "app", root: project, environment }),
  processes,
  traces,
  recipesRoot,
  where,
  hasSecret: (name) => secrets.has(name),
  settleMs: 10_000,
  pressure: async () => "normal",
})
const mac = await thread("mac", 44_000)
const machine = await thread("machine", mac.port + 10)
const local = hostIn(mac, MAC)
const cloud = hostIn(machine, CLOUD)
const recipe: Recipe = RecipeSchema.parse({
  values: { PORT: "{port}", GREETING: "hello from the Mac" },
  processes: { web: { command: "node server.mjs", port: "{port}" }, desktop: { command: "sleep 60", platform: "mac" } },
  targets: { web: { processes: ["web"] } },
  secretNames: ["SERVICE_KEY"],
  places: { cloud: { values: { GREETING: "hello from the cloud" } } },
})
const file = await recipePath(git, recipesRoot, project)

try {
  // Published on this Mac: proved here, by a start.
  await local.save("on-mac", recipe, "The app, with its cloud part")
  const publishing = await local.publish("on-mac")
  assert.match(publishing, /Published version \d+/i, publishing)
  const version = await publishedVersion(file)
  assert.ok(version !== undefined)
  const proved = await readVersion(file, version)
  assert.ok(proved)
  assert.deepEqual(Object.keys(placedProofs(proved)), ["local"])
  assert.equal(placedProofs(proved).local?.on, "this Mac")
  assert.equal(await readFile(join(mac.dataDir, "greeting")), "hello from the Mac")
  await local.stop("on-mac")

  // The same version read on a cloud machine: its place's values, what it can't run named, the file as written.
  const read = await readRecipe(git, project, machine, recipesRoot, CLOUD)
  assert.equal(read.kind, "ready")
  assert.equal(read.kind === "ready" && read.version, version, "the same version number in both places")
  assert.equal(read.kind === "ready" && read.recipe.values.GREETING, "hello from the cloud")
  assert.deepEqual(read.kind === "ready" && read.absent, { processes: [{ name: "desktop", needs: "mac" }], targets: [] })
  assert.ok(JSON.parse(readFileSync(file, "utf8")).places, "the saved recipe keeps its places")

  // A cloud start that would lack a named secret says which, and starts nothing.
  await assert.rejects(cloud.start("in-cloud", ["web"]), /no value for SERVICE_KEY, which the recipe names as a secret/)
  assert.equal(await portListening(machine.port), false)
  // What only a Mac runs is named as such on a machine.
  secrets.add("SERVICE_KEY")
  await assert.rejects(cloud.start("in-cloud", ["desktop"]), /desktop needs a Mac with its screen, so it doesn't run on this cloud machine/)
  // With the secret, it starts with the cloud's values, and says the version was never proved on a cloud machine.
  const started = await cloud.start("in-cloud", ["web"])
  assert.match(started, /was proved on a Mac but never on a cloud machine/, started)
  await waitFor(() => readFile(join(machine.dataDir, "greeting")).then((text) => text === "hello from the cloud"))
  await cloud.stop("in-cloud")

  // A version proved on the machine is proved there: its proof kept beside the Mac's.
  await cloud.save("in-cloud", RecipeSchema.parse({ ...recipe, places: { cloud: { values: { GREETING: "hello again from the cloud" } } } }), "Proved on the machine")
  const cloudPublish = await cloud.publish("in-cloud")
  assert.match(cloudPublish, /Published version \d+/i, cloudPublish)
  const cloudVersion = await publishedVersion(file)
  assert.ok(cloudVersion !== undefined && cloudVersion !== version)
  const both = await readVersion(file, cloudVersion)
  assert.ok(both)
  assert.equal(placedProofs(both).cloud?.on, "a cloud machine")
  const again = await cloud.start("in-cloud", ["web"])
  assert.doesNotMatch(again, /never on a cloud machine/, "a version proved here starts without the note")
  await cloud.stop("in-cloud")
  console.log("PASS: one recipe in two places: each place's values and patches where it runs, what it can't run named, named secrets said before a cloud start, base steps without Thread values, and proofs kept per place")
} finally {
  await local.stop("on-mac").catch(() => undefined)
  await cloud.stop("in-cloud").catch(() => undefined)
  rmSync(root, { recursive: true, force: true })
}

async function readFile(path: string): Promise<string> {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

async function waitFor(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(50)) if (await check()) return
  assert.fail("timed out")
}
