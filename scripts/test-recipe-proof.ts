import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import { ThreadIdSchema } from "../electron/contracts/thread-identity.js"
import { AppKeySchema, type ThreadEnvironment } from "../electron/contracts/thread-environments.js"
import { environmentTools } from "../electron/environment-tools.js"
import { portListening } from "../electron/thread-environment.js"
import { ThreadProcesses } from "../electron/thread-processes.js"
import { readRecipe, readVersion, recipePath, RecipeSchema, type Recipe } from "../electron/thread-recipe.js"

/**
 * A recipe version's life on real processes: a draft only its Thread runs,
 * proven by Mako (start, ready, verify commands) and by the agent's own
 * checks before it's published; a failed proof leaving it a draft; a draft
 * made from an older version refused; a running app keeping the version it
 * started with; targets choosing processes; and a worktree's cleanup.
 */

async function freeBlock(from: number): Promise<number> {
  for (let base = from; base < from + 2_000; base += 10) {
    const busy = await Promise.all(Array.from({ length: 10 }, (_, index) => portListening(base + index)))
    if (!busy.some(Boolean)) return base
  }
  throw new Error("no free ports for the test")
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-recipe-proof-")))
const project = join(root, "app")
mkdirSync(project)
writeFileSync(join(project, "server.mjs"), `
import { createServer } from "node:http"
import { writeFileSync } from "node:fs"
const port = Number(process.env.PORT)
createServer((_, response) => response.end(String(port))).listen(port, "127.0.0.1")
setTimeout(() => writeFileSync(process.env.MAKO_THREAD_DATA_DIR + "/ready-" + port, ""), Number(process.env.READY_AFTER_MS ?? 0))
process.on("SIGTERM", () => process.exit(0))
`)
const processes = new ThreadProcesses({ root: join(root, "records"), listening: portListening })
const recipesRoot = join(root, "recipes")
const thread = async (name: string, from: number): Promise<ThreadEnvironment> => {
  const id = ThreadIdSchema.parse(randomUUID())
  const dataDir = join(root, "data", name)
  mkdirSync(dataDir, { recursive: true })
  return { thread: id, app: AppKeySchema.parse(id), host: `${name}.thread.localhost`, port: await freeBlock(from), ports: 10, dataDir }
}
const mine = await thread("mine", 43_000)
const theirs = await thread("theirs", mine.port + 10)
const toolsFor = (environment: ThreadEnvironment, settleMs = 10_000) => environmentTools({
  cwd: () => project,
  environment: async () => environment,
  launchedWith: () => undefined,
  folder: async () => ({ app: environment.app, checkout: project, project: "app", root: project, environment }),
  processes,
  recipesRoot,
  settleMs,
})
const tools = toolsFor(mine)
const other = toolsFor(theirs)
const conversation = "conversation"
const web = { command: "node server.mjs", port: "{port}" }
const recipe = (extra: Partial<Recipe> = {}) => RecipeSchema.parse({ values: { PORT: "{port}" }, processes: { web }, ...extra })
const file = await recipePath(recipesRoot, project)

try {
  // A process with a ready command counts as running once it passes, not once its port answers.
  await tools.save(conversation, recipe({ processes: { web: { ...web, values: { READY_AFTER_MS: "1500" }, ready: "test -f \"$MAKO_THREAD_DATA_DIR/ready-$PORT\"" } } }), "Wait for the server")
  const began = Date.now()
  assert.match(await tools.start(conversation), new RegExp(`^web: running on port ${mine.port}`))
  assert.ok(Date.now() - began >= 1_400 && existsSync(join(mine.dataDir, `ready-${mine.port}`)), "the start waited for the ready command, past the port answering")
  await tools.stop(conversation)
  const waiting = toolsFor(mine, 2_000)
  await waiting.save(conversation, recipe({ processes: { web: { ...web, ready: "exit 1" } } }), "Never ready")
  assert.match(await waiting.start(conversation), /^web: starting; its ready command \(exit 1\) hasn't passed yet/)
  await waiting.stop(conversation)

  // Targets: a start without one runs the first target's processes; a target runs its own.
  await tools.save(conversation, recipe({
    processes: { api: { command: "node server.mjs", port: "{port+1}", values: { PORT: "{port+1}" } }, web, desktop: { command: "node -e \"setInterval(() => {}, 1000)\"" } },
    targets: { web: { processes: ["api", "web"] }, desktop: { processes: ["api", "desktop"], full: "exit 0" } },
  }), "Two targets")
  const firstTarget = await tools.start(conversation)
  assert.match(firstTarget, /^api: running/m)
  assert.match(firstTarget, /^web: running/m)
  assert.doesNotMatch(firstTarget, /desktop/, "the first target is the default")
  assert.match(await tools.start(conversation, undefined, "desktop"), /^desktop: running/m)
  await assert.rejects(tools.start(conversation, undefined, "ios"), /The recipe has no target named ios; it has web, desktop\./)
  await assert.rejects(tools.start(conversation, ["web"], "desktop"), /Name processes or a target, not both\./)
  assert.match(await tools.check(conversation, "full", "desktop"), /^The full check passed in /, "a target's own full check")
  await tools.stop(conversation)

  // A verify command that fails leaves the version a draft, with its output; nobody else gets it.
  await tools.save(conversation, recipe({ verify: { run: "echo the home page was blank; exit 3" } }), "Verify by command")
  const refused = await tools.publish(conversation)
  assert.match(refused, /^Draft \d+ wasn't published: verify \(echo the home page was blank; exit 3\) failed \(exit 3\) in [\d.]+ s\.\n\nthe home page was blank\n\nIt stays this Thread's draft/)
  assert.equal((await readRecipe(project, theirs, recipesRoot)).kind, "none", "a failed proof publishes nothing")

  // A check the agent makes: Mako starts the draft and says what to see, and publishes once the agent says how it went.
  await tools.save(conversation, recipe({ verify: { check: "Open {url} and see the port number." } }), "Verify by looking")
  await assert.rejects(tools.publish(conversation, [{ passed: true, how: "looked" }]), /hasn't started draft \d+ for your checks yet/)
  const asked = await tools.publish(conversation)
  assert.match(asked, new RegExp(`^Draft \\d+ is up for your checks: start passed in [\\d.]+ s, at http://mine\\.thread\\.localhost:${mine.port}\\. Now check what the recipe asks, yourself:\\n- Open http://mine\\.thread\\.localhost:${mine.port} and see the port number\\.\\n`))
  assert.match(await tools.publish(conversation), /^Draft \d+ is up for your checks/, "asking again while it waits on the checks says the same")
  await tools.restart(conversation)
  await assert.rejects(tools.publish(conversation, [{ passed: true, how: "looked" }]), /web stopped or restarted after Mako started draft \d+/)
  await tools.publish(conversation)
  await assert.rejects(tools.publish(conversation, [{ target: "web", passed: true, how: "looked" }]), /The recipe asks for no check web/)
  assert.match(await tools.publish(conversation, [{ passed: false, how: "The page was blank" }]), /^Draft \d+ wasn't published: the check didn't pass\./)
  await tools.publish(conversation)
  const published = await tools.publish(conversation, [{ passed: true, how: `Fetched it; it said ${mine.port}` }])
  const first = Number(/^Published version (\d+) in /.exec(published)?.[1])
  assert.ok(first > 0, published)
  const record = await readVersion(file, first)
  assert.deepEqual(record && [record.state, record.reason, record.proof?.on, record.proof?.steps.map((step) => [step.name, step.passed, step.how])], [
    "published", "Verify by looking", "this Mac", [["start", true, undefined], ["check", true, `Fetched it; it said ${mine.port}`]],
  ], "the version keeps who proved it, how, and why it was saved")
  const theirRead = await readRecipe(project, theirs, recipesRoot)
  assert.equal(theirRead.kind === "ready" && theirRead.version, first, "every Thread gets it once it's published")

  // A running app keeps the version it started with; a whole restart takes the new one.
  assert.match(await tools.start(conversation), /^web: running/)
  await other.save(conversation, recipe({ values: { PORT: "{port}", THEIRS: "1" } }), "Their change")
  assert.match(await other.publish(conversation), /^Published version \d+ in /, "a recipe without verify is published once it starts")
  const second = first + 1
  assert.equal(parseYaml(await tools.status(conversation)).recipe.version, `${first}, which this app's processes started with; version ${second} is published, and app_restart of the whole app runs it`)
  await tools.restart(conversation)
  assert.equal(parseYaml(await tools.status(conversation)).recipe.version, `${second}, published`)

  // A draft made from a version that's since been replaced isn't published over it.
  await tools.save(conversation, recipe({ values: { PORT: "{port}", MINE: "1" } }), "My change")
  await other.save(conversation, recipe({ values: { PORT: "{port}", THEIRS: "2" } }), "Their second change")
  await other.publish(conversation)
  const stale = await tools.publish(conversation)
  assert.match(stale, new RegExp(`^Draft \\d+ passed its proof but wasn't published: Version ${second + 2} was published after this draft was made from version ${second}\\. Publishing it would undo that version's changes\\.\\nWhat it changed:\\n  values\\.THEIRS: was "1", now "2"\\nMake your change on top of it`))
  await tools.stop(conversation)
  await other.stop(conversation)

  // A worktree's cleanup runs with its Thread's values.
  await tools.save(conversation, recipe({ cleanup: "touch \"$MAKO_THREAD_DATA_DIR/cleaned\"" }), "Clean up")
  assert.match(await tools.cleanup(project) ?? "", /^cleanup \(touch "\$MAKO_THREAD_DATA_DIR\/cleaned"\) passed in [\d.]+ s$/)
  assert.ok(existsSync(join(mine.dataDir, "cleaned")))
  await tools.save(conversation, recipe({ cleanup: "echo volume in use; exit 2" }), "Clean up badly")
  assert.match(await tools.cleanup(project) ?? "", /^cleanup \(echo volume in use; exit 2\) failed \(exit 2\) in [\d.]+ s: volume in use$/)
  await tools.save(conversation, recipe(), "No cleanup")
  assert.equal(await tools.cleanup(project), undefined, "nothing to run, nothing said")

  console.log("recipe proof: a ready command decides when a process runs; targets pick processes and full checks; a failed verify keeps the draft; the agent's own check publishes once it says how it went, refused after a restart; a running app keeps its version until a whole restart; a draft from a replaced version is refused with what changed; cleanup runs with the Thread's values")
} finally {
  await processes.stop(mine.app).catch(() => {})
  await processes.stop(theirs.app).catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
