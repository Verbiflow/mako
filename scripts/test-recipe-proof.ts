import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { parse as parseYaml } from "yaml"
import { ThreadIdSchema } from "../electron/contracts/thread-identity.js"
import { AppKeySchema, type ThreadEnvironment } from "../electron/contracts/thread-environments.js"
import { environmentTools, reachLine } from "../electron/environment-tools.js"
import { portListening } from "../electron/thread-environment.js"
import { ThreadProcesses } from "../electron/thread-processes.js"
import { readRecipe, readVersion, recipePath, RecipeSchema, recipeVersions, versionHistory, type Recipe } from "../electron/thread-recipe.js"

/**
 * A recipe version's life on real processes: a draft only its Thread runs,
 * proven by Mako (start, ready, verify commands) and by the agent's own
 * checks before it's published; a failed proof leaving it a draft; a draft
 * made from an older version refused; a running app keeping the version it
 * started with; targets choosing processes; going back to an earlier
 * version through the same proof; and a worktree's cleanup.
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
  pressure: async () => "normal",
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
  const tries = join(mine.dataDir, "ready-tries")
  await waiting.save(conversation, recipe({ processes: { web: { ...web, ready: "echo >> \"$MAKO_THREAD_DATA_DIR/ready-tries\"; echo \"window not open at $PORT\" >&2; exit 3" } } }), "Never ready")
  assert.match(
    await waiting.start(conversation),
    new RegExp(`^web: starting; its ready command \\(.+\\) hasn't passed yet: its latest try exited 3\\n\\nIts ready command's latest try printed:\\nwindow not open at ${mine.port}$`, "m"),
    "a start still waiting says what its ready command printed, so the agent sees why",
  )
  await waiting.stop(conversation)
  const triedBy = readFileSync(tries, "utf8").length
  await sleep(1_500)
  assert.equal(readFileSync(tries, "utf8").length, triedBy, "a stopped process's ready command isn't tried again")

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
  const deskView = await tools.desk!.view(project, "desktop")
  assert.deepEqual(deskView.kind === "ready" && [deskView.targets, deskView.checks.find((check) => check.tier === "full")?.command], [["web", "desktop"], "exit 0"], "the desk sees the targets, and the picked one's full check")
  const firstView = await tools.desk!.view(project, "gone")
  assert.equal(firstView.kind === "ready" && firstView.checks.find((check) => check.tier === "full"), undefined, "a target the recipe doesn't have reads as its first")
  assert.deepEqual((await tools.desk!.start(project, "desktop")).problems, [])
  const deskStarted = parseYaml(await tools.status(conversation)).processes
  assert.ok(deskStarted.desktop?.startsWith("running") && !deskStarted.web?.startsWith("running"), "the desk starts the picked target's processes")
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
  await tools.stop(conversation)
  await other.save(conversation, recipe({ values: { PORT: "{port}", THEIRS: "1", AGAIN: "1" } }), "Published while stopped")
  await other.publish(conversation)
  const third = second + 1
  assert.equal(parseYaml(await tools.status(conversation)).recipe.version, `${third}, published`, "a stopped app runs what's published")
  assert.ok(!existsSync(join(recipeVersions(file), "running", `${mine.app}.json`)), "and forgets the version it last ran, so later reads don't look for running processes")

  // A draft made from a version that's since been replaced isn't published over it.
  await tools.save(conversation, recipe({ values: { PORT: "{port}", MINE: "1" } }), "My change")
  await other.save(conversation, recipe({ values: { PORT: "{port}", THEIRS: "2", AGAIN: "1" } }), "Their second change")
  await other.publish(conversation)
  const stale = await tools.publish(conversation)
  assert.match(stale, new RegExp(`^Draft \\d+ passed its proof but wasn't published: Version ${third + 2} was published after this draft was made from version ${third}\\. Publishing it would undo that version's changes\\.\\nWhat it changed:\\n  values\\.THEIRS: was "1", now "2"\\nMake your change on top of it`))
  await tools.stop(conversation)
  await other.stop(conversation)

  // Going back: app_status lists this Thread's draft and the newest published versions, newest first.
  const latest = third + 2
  const history = parseYaml(await tools.status(conversation)).recipe
  assert.match(history.versions[1], new RegExp(`^${third + 1}: this Thread's draft, saved \\d+ (?:s|min) ago, made from ${third}; passed its proof, but wasn't published\\. My change$`))
  assert.match(history.versions[0], new RegExp(`^${latest}: published \\d+ (?:s|min) ago, what every Thread runs; proved\\. Their second change$`))
  assert.match(history.versions.at(-1), new RegExp(`^${first}: published \\d+ (?:s|min) ago; proved\\. Verify by looking$`))
  assert.equal(history.versions.length, 5, "the draft and the four published versions")
  assert.match(history.goBack, new RegExp(`^${latest} versions kept; listed are this Thread's draft and the newest published\\. recipe_save with a version number instead of a recipe`))
  assert.ok(Object.keys(history).indexOf("goBack") < Object.keys(history).indexOf("contents"), "before the recipe itself")

  // recipe_save with a version brings its recipe back as a new draft made from the published version, proved again before anyone gets it.
  await assert.rejects(tools.restore(conversation, 999, "Wrong number"), { message: `Not saved: the project has no version 999; it keeps versions 1 to ${latest}, and app_status lists the newest.` })
  const prefix = `Back to version ${first}: `.length
  await assert.rejects(tools.restore(conversation, first, "x".repeat(500)), { message: `Not saved: the history keeps this reason after "Back to version ${first}: ", so it can be at most ${500 - prefix} characters; it's 500.` })
  const back = await tools.restore(conversation, first, "Their values broke the start")
  assert.match(back, new RegExp(`^Brought back version ${first} \\(published [\\d:]+, \\d+ (?:s|min) ago: Verify by looking\\) as a new draft; the history keeps every version as it was\\.\\nSaved as draft version ${latest + 1}, made from version ${latest}\\. Only this Thread runs it; every other Thread keeps version ${latest} until it's published\\.\\nChanged from what this Thread ran:\\n`))
  assert.match(back, /\n {2}values\.MINE: removed, was "1"\n/)
  const theirsBefore = await readRecipe(project, theirs, recipesRoot)
  assert.equal(theirsBefore.kind === "ready" && theirsBefore.version, latest, "nobody else has it before it's proved")
  assert.match(await tools.publish(conversation), new RegExp(`^Draft ${latest + 1} is up for your checks`), "proved like any other draft, its verify included")
  assert.match(await tools.publish(conversation, [{ passed: true, how: "Fetched it again" }]), new RegExp(`^Published version ${latest + 1} in `))
  const restored = await readVersion(file, latest + 1)
  assert.deepEqual(restored && [restored.state, restored.parent, restored.reason], ["published", latest, `Back to version ${first}: Their values broke the start`])
  assert.deepEqual(restored?.recipe, (await readVersion(file, first))?.recipe, "the earlier version's recipe as it was")
  assert.equal((await readVersion(file, first))?.reason, "Verify by looking", "history isn't rewritten")
  const theirsNow = await readRecipe(project, theirs, recipesRoot)
  assert.equal(theirsNow.kind === "ready" && theirsNow.version, latest + 1)
  await tools.stop(conversation)

  // Going back to what's published already only drops this Thread's draft; a reason that says where it goes back to isn't said twice.
  assert.equal(await tools.restore(conversation, latest + 1, "Already there"), `Version ${latest + 1} is the published version already, so there's nothing to go back to. That's version ${latest + 1}, the published recipe, so this Thread has no draft any more and runs version ${latest + 1} like every other Thread.`)
  await tools.restore(conversation, second, `Back to version ${second}, for its values`)
  assert.equal((await readVersion(file, latest + 2))?.reason, `Back to version ${second}, for its values`)

  // Settings lists the same versions for a person, read-only.
  const setup = await tools.desk!.setup(project)
  assert.ok(setup.recipe.kind === "ready")
  assert.deepEqual(setup.recipe.versions.map((entry) => [entry.version, entry.state, entry.current, entry.proof?.passed]), [
    [latest + 2, "draft", false, undefined],
    [latest + 1, "published", true, true],
    [latest, "published", false, true],
    [third, "published", false, true],
    [second, "published", false, true],
    [first, "published", false, true],
  ], "this folder's draft and the five newest published")
  assert.deepEqual((await versionHistory(file, mine.app, 2)).entries.map((entry) => entry.version), [latest + 2, latest + 1, latest], "only as many published as asked for")
  assert.deepEqual((await versionHistory(file, theirs.app, 1)).entries.map((entry) => entry.version), [latest + 1], "another Thread's draft isn't listed")

  // A version whose recipe this checkout can't run any more is refused with why, and where to start from it.
  mkdirSync(join(project, "site"))
  await tools.save(conversation, recipe({ processes: { web: { ...web, cwd: "site" } } }), "Serve from site")
  rmSync(join(project, "site"), { recursive: true })
  await assert.rejects(tools.restore(conversation, latest + 3, "Serve from site again"), {
    message: `Not saved: version ${latest + 3}'s recipe can't run in this checkout as it was: processes.web.cwd: site doesn't exist in this checkout. To start from it anyway, take its "recipe" from ${join(recipeVersions(file), `${latest + 3}.json`)}, fix that, and pass it to recipe_save as recipe.`,
  })

  // A worktree's cleanup runs with its Thread's values.
  await tools.save(conversation, recipe({ cleanup: "touch \"$MAKO_THREAD_DATA_DIR/cleaned\"" }), "Clean up")
  assert.match(await tools.cleanup(project) ?? "", /^cleanup \(touch "\$MAKO_THREAD_DATA_DIR\/cleaned"\) passed in [\d.]+ s$/)
  assert.ok(existsSync(join(mine.dataDir, "cleaned")))
  await tools.save(conversation, recipe({ cleanup: "echo volume in use; exit 2" }), "Clean up badly")
  assert.match(await tools.cleanup(project) ?? "", /^cleanup \(echo volume in use; exit 2\) failed \(exit 2\) in [\d.]+ s: volume in use$/)
  await tools.save(conversation, recipe({
    processes: {
      web: { ...web, values: { PROFILE: "app-{thread}", SIDE: "web" } },
      worker: { command: "node -e \"setInterval(() => {}, 1000)\"", values: { PROFILE: "app-{thread}", SIDE: "worker" } },
    },
    cleanup: "printf '%s,%s' \"$PROFILE\" \"${SIDE-unset}\" > \"$MAKO_THREAD_DATA_DIR/cleaned-values\"",
  }), "Clean up what a process names")
  assert.match(await tools.cleanup(project) ?? "", /passed/)
  assert.equal(readFileSync(join(mine.dataDir, "cleaned-values"), "utf8"), `app-${mine.app},unset`, "cleanup sees a value its processes set alike, and not one they set differently")
  await tools.save(conversation, recipe(), "No cleanup")
  assert.equal(await tools.cleanup(project), undefined, "nothing to run, nothing said")

  // A value named for the Thread asks for a cleanup, where worktrees can be removed.
  const unasked = /DB \(app_\{thread\}\) names something for each Thread, and the recipe has no cleanup/
  assert.doesNotMatch(await tools.save(conversation, recipe({ values: { PORT: "{port}", DB: "app_{thread}" } }), "Name a database"), unasked, "a folder without Git has no worktrees to clean up after")
  mkdirSync(join(project, ".git"))
  assert.match(await tools.save(conversation, recipe({ values: { PORT: "{port}", DB: "app_{thread}", MORE: "1" } }), "Name a database"), unasked)
  assert.doesNotMatch(await tools.save(conversation, recipe({ values: { PORT: "{port}", DB: "app_{thread}" }, cleanup: "dropdb --if-exists \"$DB\"" }), "Drop it"), /no cleanup/)

  // A save says whom publishing reaches, and what those running now keep.
  assert.equal(reachLine({ others: 0, up: 0, versions: [] }), "No other checkout of this project has run its app on this Mac, so once it's published the next ones start with it.")
  assert.equal(reachLine({ others: 1, up: 1, versions: [4] }), "Published, it reaches the other checkout of this project that has run its app on this Mac. It runs now and keeps the version it started with (version 4) until app_restart.")
  assert.equal(reachLine({ others: 3, up: 3, versions: [3, 4] }), "Published, it reaches the 3 other checkouts of this project that have run its app on this Mac. All run now and keep the version they started with (version 3, version 4) until app_restart.")
  assert.equal(reachLine({ others: 3, up: 1, versions: [4] }), "Published, it reaches the 3 other checkouts of this project that have run its app on this Mac. One running now keeps the version it started with (version 4) until app_restart; the rest take it at their next start.")
  assert.equal(reachLine({ others: 3, up: 2, versions: [] }), "Published, it reaches the 3 other checkouts of this project that have run its app on this Mac. 2 running now keep the version they started with until app_restart; the rest take it at their next start.")
  assert.equal(reachLine({ others: 2, up: 0, versions: [] }), "Published, it reaches the 2 other checkouts of this project that have run its app on this Mac. None runs now, so each takes it at its next start.")

  console.log("recipe proof: a ready command decides when a process runs; targets pick processes and full checks; a failed verify keeps the draft; the agent's own check publishes once it says how it went, refused after a restart; a running app keeps its version until a whole restart; a draft from a replaced version is refused with what changed; app_status and Settings list the versions, and going back to one saves it as a new draft that's proved and published like any other, refused with why when it can't run here; cleanup runs with the Thread's values and its processes' own, and a save asks for one when a value names something for each Thread, and says whom publishing reaches")
} finally {
  await processes.stop(mine.app).catch(() => {})
  await processes.stop(theirs.app).catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
