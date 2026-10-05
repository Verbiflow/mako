import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { ThreadIdSchema, type Actor } from "../electron/contracts/thread-identity.js"
import type { SetupProgress } from "../electron/contracts/thread-app.js"
import { AppKeySchema, type ThreadEnvironment } from "../electron/contracts/thread-environments.js"
import { startConversationMcp } from "../electron/conversation-mcp.js"
import { environmentTools } from "../electron/environment-tools.js"
import { applyThreadEnvironment, folderApp, portListening, ThreadEnvironments, threadEnvironmentInstructions } from "../electron/thread-environment.js"
import { ThreadProcesses } from "../electron/thread-processes.js"
import { publishDraft, readRecipe, readVersion, recipePath, recipeProblem, RecipeSchema, recipeValues, recipeVersions, RECIPE_PATH, saveDraft, StaleDraftError, type Recipe } from "../electron/thread-recipe.js"
import { ThreadStore } from "../electron/thread-store.js"
import { ThreadWorktreeService } from "../electron/thread-worktrees.js"

/**
 * A Thread's running app against real processes: the recipe and its
 * values, process trees that outlive the host that started them and are
 * stopped whole, the owner of a busy port, the agent's tools on a real
 * project, and a removed worktree taking its app and data with it.
 */

const [mode] = process.argv.slice(2)
if (mode === "host") {
  // A host that starts a process and exits, as the app does when it quits or updates.
  const [, root, thread, port, server] = process.argv.slice(2)
  const processes = new ThreadProcesses({ root: root!, listening: portListening })
  const env = { ...process.env, PORT: port }
  const result = await processes.start(AppKeySchema.parse(thread), [{ kind: "process", name: "api", command: `node ${server}`, cwd: tmpdir(), env, port: Number(port) }])
  assert.deepEqual(result.started, ["api"])
  process.exit(0)
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-thread-processes-")))
const records = join(root, "thread-environments")
const title = new Map<string, string>()
const host = () => new ThreadProcesses({ root: records, listening: portListening, whose: (app) => title.get(app) })
const processes = host()
const settle = 15_000

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function freeBlock(from: number): Promise<number> {
  for (let base = from; base < from + 2_000; base += 10) {
    const busy = await Promise.all(Array.from({ length: 10 }, (_, index) => portListening(base + index)))
    if (!busy.some(Boolean)) return base
  }
  throw new Error("no free ports for the test")
}

async function fetchJson(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/`)
  return z.object({ port: z.number(), api: z.string().optional(), data: z.string().optional(), home: z.string().optional(), cwd: z.string(), pid: z.number() }).parse(await response.json())
}

const server = join(root, "server.mjs")
writeFileSync(server, `
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
const port = Number(process.env.PORT)
if (process.env.GRANDCHILD_FILE) {
  // A descendant in a group of its own, which a process-group stop alone would miss.
  const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" })
  writeFileSync(process.env.GRANDCHILD_FILE, String(child.pid))
}
createServer((_, response) => response.end(JSON.stringify({ port, api: process.env.API_URL, data: process.env.MAKO_THREAD_DATA_DIR, home: process.env.HOME, cwd: process.cwd(), pid: process.pid }))).listen(port, "127.0.0.1")
console.log("listening on", port)
process.on("SIGTERM", () => { console.log("stopping"); process.exit(0) })
`)

const cleanups: (() => Promise<void>)[] = []
try {
  // The recipe: strict, loud, and resolved against the Thread's own values.
  const fixtureThread = ThreadIdSchema.parse(randomUUID())
  const fixture: ThreadEnvironment = { thread: fixtureThread, app: AppKeySchema.parse(fixtureThread), host: "fix-login.thread.localhost", port: 41_000, ports: 10, dataDir: join(root, "data", "fixture") }
  const recipeIn = async (text: string) => {
    const folder = mkdtempSync(join(root, "recipe-"))
    mkdirSync(join(folder, ".mako"))
    writeFileSync(join(folder, RECIPE_PATH), text)
    return readRecipe(folder, fixture)
  }
  assert.equal((await readRecipe(mkdtempSync(join(root, "none-")), fixture)).kind, "none")
  const good = await recipeIn(JSON.stringify({ values: { PORT: "{port}", API_URL: "http://{host}:{port+1}", JSON_TEXT: "{\"a\": 1}" }, processes: { web: { command: "npm run dev", port: "{port}" } }, checks: { quick: "npm test" } }))
  assert.equal(good.kind, "ready")
  if (good.kind === "ready") assert.deepEqual(recipeValues(good.recipe, fixture), { PORT: "41000", API_URL: "http://fix-login.thread.localhost:41001", JSON_TEXT: "{\"a\": 1}" }, "braces that aren't Mako's names are left as written")
  const invalid = async (text: string, pattern: RegExp) => {
    const read = await recipeIn(text)
    assert.equal(read.kind, "invalid", `refused: ${text}`)
    if (read.kind === "invalid") assert.match(read.message, pattern)
  }
  await invalid("{ not json", /not JSON/)
  await invalid(JSON.stringify({ values: {}, extra: true }), /Unrecognized key/)
  await invalid(JSON.stringify({ values: { PORT: "{prot}" } }), /\{prot\} isn't one of Mako's values/)
  await invalid(JSON.stringify({ values: { PORT: "{port+10}" } }), /past this Thread's 10 ports/)
  await invalid(JSON.stringify({ values: { PATH: "/tmp" } }), /agent's own shell needs this one/)
  await invalid(JSON.stringify({ values: { MAKO_THREAD_PORT: "1" } }), /MAKO_THREAD_PORT is Mako's own/)
  assert.equal((await recipeIn(JSON.stringify({ processes: { web: { command: "npm run web", values: { MAKO_PROFILE: "thread-{thread}" } } } }))).kind, "ready", "a project's own MAKO_ names, such as Mako's MAKO_PROFILE, are the project's")
  await invalid(JSON.stringify({ prepare: [{ command: "npm ci", inputs: ["../package-lock.json"] }] }), /outside the checkout/)

  // The recipe Mako keeps for a project comes first; one committed with the project is used when Mako has none.
  const recipes = join(root, "recipes")
  const savedFolder = mkdtempSync(join(root, "saved-"))
  const savedFile = await recipePath(recipes, savedFolder)
  assert.deepEqual(await readRecipe(savedFolder, fixture, recipes), { kind: "none", checkout: savedFolder, saved: savedFile })
  const draft = (recipe: Recipe, environment = fixture) => saveDraft(recipes, savedFolder, recipe, environment, {})
  await assert.rejects(draft(RecipeSchema.parse({ processes: { web: { command: "x", port: "{port+10}" } } })), /^Error: Not saved: \{port\+10\} is past this Thread's 10 ports/)
  await assert.rejects(draft(RecipeSchema.parse({ processes: { web: { command: "x", cwd: "server" } } })), /Not saved: processes\.web\.cwd: server doesn't exist in this checkout/, "a recipe this checkout can't run isn't saved")
  await assert.rejects(draft(RecipeSchema.parse({ processes: { web: { command: "vite --port {port}", port: "{port}" } } })), /^Error: Not saved: processes\.web\.command: \{port\} isn't filled in inside a command; .*"PORT": "\{port\}", and write "\$PORT" in the command$/, "a placeholder in a command would reach the app as written")
  await assert.rejects(draft(RecipeSchema.parse({ checks: { full: "curl {url}/health" } })), /Not saved: checks\.full: \{url\} isn't filled in/)
  await assert.rejects(draft(RecipeSchema.parse({ prepare: [{ command: "mkdir -p {data}/db", inputs: ["package.json"] }] })), /Not saved: prepare\.0\.command: \{data\} isn't filled in/)
  await assert.rejects(draft(RecipeSchema.parse({ processes: { db: { command: "x", ready: "pg_isready -p {port}" } } })), /Not saved: processes\.db\.ready: \{port\} isn't filled in/)
  await assert.rejects(draft(RecipeSchema.parse({ processes: { web: { command: "x" } }, targets: { web: { processes: ["web", "api"] } } })), /Not saved: targets\.web\.processes: the recipe has no process named api/)
  await assert.rejects(draft(RecipeSchema.parse({ verify: { check: "Open {prot}" } })), /Not saved: verify\.check: \{prot\} isn't one of Mako's values/)
  assert.equal(await recipeProblem(RecipeSchema.parse({ processes: { web: { command: "port=1; echo \"${port}\" {a,b}", port: "{port}" } } }), savedFolder, fixture), undefined, "the shell's own ${port} and brace expansion are left alone")
  assert.equal(existsSync(savedFile), false)
  const proof = { at: 1, on: "this Mac", checkout: savedFolder, steps: [{ name: "start", passed: true }] }
  const firstRecipe = RecipeSchema.parse({ processes: { web: { command: "node server.mjs", port: "{port}" } } })
  const firstDraft = await draft(firstRecipe)
  assert.deepEqual([firstDraft.version.version, firstDraft.version.state, firstDraft.version.parent, firstDraft.published], [1, "draft", undefined, undefined], "the first recipe is a draft with nothing before it")
  assert.equal(existsSync(savedFile), false, "a draft isn't published")
  const ownDraft = await readRecipe(savedFolder, fixture, recipes)
  assert.deepEqual(ownDraft.kind === "ready" && [ownDraft.version, ownDraft.draft, ownDraft.from], [1, {}, join(recipeVersions(savedFile), "1.json")], "the app that saved it runs its draft")
  const otherApp = { ...fixture, app: AppKeySchema.parse("folder-0000000000000000") }
  assert.equal((await readRecipe(savedFolder, otherApp, recipes)).kind, "none", "every other app runs what's published: nothing yet")
  await publishDraft(savedFile, fixture.app, 1, proof)
  const fromSaved = await readRecipe(savedFolder, otherApp, recipes)
  assert.deepEqual(fromSaved.kind === "ready" && [fromSaved.from, fromSaved.version, fromSaved.draft, fromSaved.ignored], [savedFile, 1, undefined, undefined], "published, every app runs it")
  assert.deepEqual((await readVersion(savedFile, 1)) && { state: (await readVersion(savedFile, 1))!.state, proof: (await readVersion(savedFile, 1))!.proof }, { state: "published", proof }, "the version keeps its proof")
  mkdirSync(join(savedFolder, ".mako"))
  const committed = { values: { PORT: "{port}" }, processes: { web: { command: "npm run dev", port: "{port}" }, worker: { command: "npm run worker" } }, checks: { quick: "npm test" } }
  writeFileSync(join(savedFolder, RECIPE_PATH), JSON.stringify(committed))
  const both = await readRecipe(savedFolder, fixture, recipes)
  assert.equal(both.kind, "ready")
  if (both.kind === "ready") {
    assert.equal(both.from, savedFile)
    assert.equal(both.ignored, join(savedFolder, RECIPE_PATH), "a committed recipe beside the saved one is named as ignored")
    assert.deepEqual(Object.keys(both.recipe.processes), ["web"], "the saved recipe is whole: nothing of the committed one is mixed in")
    assert.deepEqual(both.recipe.values, {})
  }
  const secondRecipe = { ...firstRecipe, checks: { quick: "npm test" } }
  const secondDraft = await draft(secondRecipe)
  assert.deepEqual([secondDraft.version.version, secondDraft.version.parent], [2, 1], "a draft is made from the published version")
  assert.equal((await draft(secondRecipe)).version.version, 2, "saving the same draft again makes no new version")
  const publishedAgain = await draft(firstRecipe)
  const restoredRecipe = await readRecipe(savedFolder, fixture, recipes)
  assert.deepEqual([publishedAgain.version.state, restoredRecipe.kind === "ready" && restoredRecipe.draft], ["published", undefined], "saving what's published drops the app's draft")
  const mine = await draft(secondRecipe)
  const theirs = await draft({ ...secondRecipe, values: { THEIRS: "1" } }, otherApp)
  await publishDraft(savedFile, otherApp.app, theirs.version.version, proof)
  await assert.rejects(publishDraft(savedFile, fixture.app, mine.version.version, proof), (error: Error) => error instanceof StaleDraftError && /^Version 4 was published after this draft was made from version 1\.$/.test(error.message) && error.published?.recipe.values.THEIRS === "1", "a draft made from an older version can't undo what was published since")
  assert.deepEqual(readdirSync(recipeVersions(savedFile)).filter((name) => /^\d+\.json$/.test(name)).sort(), ["1.json", "2.json", "3.json", "4.json"], "every version is kept")
  const legacyFolder = mkdtempSync(join(root, "legacy-"))
  const legacyFile = await recipePath(recipes, legacyFolder)
  writeFileSync(legacyFile, JSON.stringify(firstRecipe))
  const legacy = await readRecipe(legacyFolder, fixture, recipes)
  assert.deepEqual(legacy.kind === "ready" && [legacy.version, (await readVersion(legacyFile, 1))?.reason], [1, "Published before Mako kept versions"], "a recipe saved before versions becomes the first")
  rmSync(join(recipeVersions(savedFile), "drafts"), { recursive: true, force: true })
  writeFileSync(savedFile, "{ broken")
  const brokenSaved = await readRecipe(savedFolder, fixture, recipes)
  assert.equal(brokenSaved.kind, "invalid", "a broken saved recipe is loud, not replaced by the committed one")
  if (brokenSaved.kind === "invalid") assert.match(brokenSaved.message, /recipes\/saved-\S+\.json: not JSON/)
  rmSync(savedFile)
  const fromCommitted = await readRecipe(savedFolder, fixture, recipes)
  assert.equal(fromCommitted.kind === "ready" && fromCommitted.from, join(savedFolder, RECIPE_PATH), "with nothing saved, the committed recipe is used")
  await invalid(JSON.stringify({ processes: { web: { command: "x", port: "3000" } } }), /processes\.web\.port: 3000 is fixed, so two Threads' copies would fight over it\. Use \{port\} or \{port\+N\}; if the app can't move off it, set "oneAtATime": true/)
  assert.equal((await recipeIn(JSON.stringify({ oneAtATime: true, processes: { db: { command: "x", port: "5432" } } }))).kind, "ready", "one copy at a time may keep its fixed port")
  await invalid(JSON.stringify({ oneAtATime: true, processes: { db: { command: "x", port: "70000" } } }), /70000 isn't a port/)
  await invalid(JSON.stringify({ processes: { web: { command: "x", port: "{port:1}" } } }), /a process's port is \{port\}, \{port\+N\}, or a fixed number when the recipe is oneAtATime/)
  for (const outside of ["../secrets", "/etc/hosts", ".git/config", "a//b", "./env"])
    await invalid(JSON.stringify({ carry: [outside] }), /a path in the checkout, such as \.env or \*\*\/node_modules/)
  await invalid(JSON.stringify({ prepare: [{ command: "npm install", inputs: ["package-lock.json"], outputs: ["../node_modules"] }] }), /a path in the checkout/)
  await invalid(JSON.stringify({ processes: { web: { command: "x", cwd: "../elsewhere" } } }), /doesn't exist in this checkout|outside the checkout/)
  await invalid(JSON.stringify({ processes: { web: { command: "x", cwd: "/tmp" } } }), /relative to the checkout/)
  await invalid(JSON.stringify({ processes: { Web: { command: "x" } } }), /lowercase letters/)

  // The recipe's names reach the agent's shell; a Mako started inside a Thread clears the names its parent set.
  const env: NodeJS.ProcessEnv = { MAKO_THREAD_VALUES: "PORT,STALE", PORT: "1", STALE: "x", KEEP: "y" }
  applyThreadEnvironment(env, { ...fixture, values: { PORT: "41000", API_URL: "http://fix-login.thread.localhost:41001" } })
  assert.equal(env.PORT, "41000")
  assert.equal(env.API_URL, "http://fix-login.thread.localhost:41001")
  assert.equal(env.STALE, undefined, "a name the parent Mako set is cleared")
  assert.equal(env.KEEP, "y")
  assert.equal(env.MAKO_THREAD_VALUES, "PORT,API_URL")
  applyThreadEnvironment(env)
  assert.equal(env.PORT, undefined, "an agent outside any Thread gets none of them")
  assert.equal(env.MAKO_THREAD_VALUES, undefined)

  // Process trees, from real processes.
  const thread = AppKeySchema.parse(randomUUID())
  const other = AppKeySchema.parse(randomUUID())
  title.set(thread, 'the Thread "Fix login"')
  title.set(other, 'the Thread "Tidy settings"')
  cleanups.push(() => processes.discard(thread), () => processes.discard(other))
  const base = await freeBlock(41_000)
  const grandchildFile = join(root, "grandchild.pid")
  const webEnv = { ...process.env, PORT: String(base), GRANDCHILD_FILE: grandchildFile }
  const first = await processes.start(thread, [{ kind: "process", name: "web", command: `node ${server}`, cwd: root, env: webEnv, port: base }])
  assert.deepEqual(first, { started: ["web"], refused: [] })
  const [web] = await processes.settle(thread, ["process-web"], settle)
  assert.equal(web?.state.kind, "running", "running once its port answers")
  const webPid = web.pid
  assert.ok(webPid, "a running process reports its pid")
  assert.equal((await fetchJson(base)).port, base)
  const grandchild = Number(readFileSync(grandchildFile, "utf8"))
  assert.ok(alive(grandchild))
  assert.deepEqual((await processes.start(thread, [{ kind: "process", name: "web", command: `node ${server}`, cwd: root, env: webEnv, port: base }])).started, [], "a running process isn't started twice")

  // Another host (the installed app, a development build, the next version) sees the same process.
  const second = host()
  assert.deepEqual((await second.status(thread)).map((status) => [status.name, status.state.kind, status.pid]), [["web", "running", web!.pid]])

  // A host that quits leaves its processes running, for the next host to adopt.
  const quit = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "host", records, thread, String(base + 1), server], { encoding: "utf8" })
  assert.equal(quit.status, 0, quit.stderr)
  const [api] = (await processes.settle(thread, ["process-api"], settle)).filter((status) => status.name === "api")
  assert.equal(api?.state.kind, "running", "the api outlived the host that started it")
  assert.equal((await fetchJson(base + 1)).port, base + 1)

  // A port something holds is refused, naming the holder, never taken over.
  const refused = await processes.start(other, [{ kind: "process", name: "web", command: `node ${server}`, cwd: root, env: webEnv, port: base }])
  assert.deepEqual(refused.started, [])
  assert.match(refused.refused[0]!.reason, new RegExp(`Port ${base} belongs to the app of the Thread "Fix login": its process web \\(pid \\d+\\)`))
  const owner = await processes.portOwner(base)
  assert.equal(owner?.app, thread)
  assert.deepEqual(owner?.run, { kind: "process", name: "web" })
  const outsider = await import("node:net").then(({ createServer }) => new Promise<import("node:net").Server>((resolve) => {
    const listener = createServer().listen(base + 5, "127.0.0.1", () => resolve(listener))
  }))
  assert.match(await processes.describeHolder(base + 5, thread), new RegExp(`Port ${base + 5} is held by pid ${process.pid} \\(.*\\), which Mako didn't start`))
  outsider.close()

  // Stopped whole, from the other host: the server, the api, and the grandchild that left the group.
  const stopped = await second.stop(thread)
  assert.deepEqual(stopped.sort(), ["api", "web"])
  assert.equal(alive(webPid), false)
  assert.equal(alive(grandchild), false, "a descendant in its own group is stopped too")
  assert.equal(await portListening(base), false)
  assert.deepEqual(await processes.status(thread), [])

  // Crashes keep their exit code and output; something outside Mako killing a process shows as that.
  await processes.start(thread, [{ kind: "process", name: "boom", command: "echo starting; echo broken config >&2; exit 3", cwd: root, env: process.env }])
  const [boom] = await processes.settle(thread, ["process-boom"], settle)
  assert.deepEqual(boom?.state.kind === "exited" && boom.state.code, 3)
  assert.match(await processes.logs(thread, "process-boom", 10), /starting\nbroken config/)
  await processes.start(thread, [{ kind: "process", name: "boom", command: "echo second run", cwd: root, env: process.env }])
  await processes.settle(thread, ["process-boom"], settle)
  assert.match(readFileSync(join(records, thread, "process-boom.log.1"), "utf8"), /broken config/, "the previous run's log is kept once")
  // A command quicker than reading the process table, as on a loaded Mac, is still recorded and run.
  const slowTable = join(root, "slow-process-table")
  mkdirSync(slowTable)
  writeFileSync(join(slowTable, "ps"), '#!/bin/sh\nsleep 0.5\nexec /bin/ps "$@"\n', { mode: 0o755 })
  const searchPath = process.env.PATH
  process.env.PATH = `${slowTable}:${searchPath}`
  try {
    await processes.start(thread, [{ kind: "check", name: "instant", command: "echo done; exit 4", cwd: root, env: { ...process.env, PATH: searchPath } }])
  } finally {
    process.env.PATH = searchPath
  }
  const [instant] = await processes.settle(thread, ["check-instant"], settle)
  assert.deepEqual(instant?.state.kind === "exited" && instant.state.code, 4, "a command that ends before the table is read keeps its exit code")
  assert.match(await processes.logs(thread, "check-instant", 5), /done/)
  const flakyPort = base + 6
  const flaky = `require("node:http").createServer((_, response) => response.end("up")).listen(${flakyPort}, "127.0.0.1", () => setTimeout(() => { console.error("The development renderer must use a loopback URL"); process.exit(1) }, 300))`
  await processes.start(thread, [{ kind: "process", name: "flaky", command: `node -e '${flaky}'`, cwd: root, env: process.env, port: flakyPort }])
  const [flakyStatus] = await processes.settle(thread, ["process-flaky"], settle)
  assert.equal(flakyStatus?.state.kind === "exited" && flakyStatus.state.code, 1, "a server that answers on its port and dies a moment later isn't reported running")
  await processes.start(thread, [{ kind: "process", name: "sleeper", command: "sleep 300", cwd: root, env: process.env }])
  const [sleeper] = await processes.settle(thread, ["process-sleeper"], settle)
  process.kill(-sleeper!.pid!, "SIGKILL")
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal((await processes.status(thread)).find((status) => status.name === "sleeper")?.state.kind, "ended")
  await processes.discard(thread)
  assert.equal(existsSync(join(records, thread)), false)

  // The agent's tools on a real project: a recipe with two processes, both checks, a process-only HOME.
  const project = join(root, "shop")
  mkdirSync(join(project, ".mako"), { recursive: true })
  git(project, "init", "-q", "-b", "main")
  git(project, "config", "user.email", "test@example.invalid")
  git(project, "config", "user.name", "Test")
  writeFileSync(join(project, "server.mjs"), readFileSync(server, "utf8"))
  writeFileSync(join(project, "check.mjs"), `
const response = await fetch(process.env.APP_URL.replace(process.env.MAKO_THREAD_HOST, "127.0.0.1"))
const body = await response.json()
console.log("app answered on", body.port)
process.exit(body.port === Number(process.env.PORT) ? 0 : 1)
`)
  const recipe = {
    values: { PORT: "{port}", APP_URL: "{url}", API_URL: "http://{host}:{port+1}" },
    processes: {
      web: { command: "node server.mjs", port: "{port}" },
      api: { command: "node server.mjs", port: "{port+1}", values: { PORT: "{port+1}", HOME: "{data}/home" } },
    },
    checks: { quick: "node -e \"console.log('quick ok')\"", full: "node check.mjs" },
  }
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify(recipe, null, 2))
  git(project, "add", ".")
  git(project, "commit", "-q", "-m", "first")

  const store = new ThreadStore(join(root, "threads.sqlite"))
  const service: Actor = { kind: "service", name: "migration" }
  const conversation = randomUUID()
  const placed = store.registerJournal({ conversationId: conversation, createdAt: Date.now(), bindings: [], harness: "codex" }, service)
  const toolBase = await freeBlock(base + 10)
  const environments = new ThreadEnvironments({ store, dataRoot: join(root, "thread-data") })
  // The store hands out real ports in the Threads' range; this test runs apps outside it.
  const environment = async (id: string, cwd: string) => {
    const resolved = await environments.forConversation(id, "Fix login", cwd)
    return resolved && { ...resolved, port: toolBase }
  }
  const launched = await environments.forLaunch(conversation, "Fix login", join(project))
  assert.equal(launched?.values?.PORT, String(launched?.port), "the recipe's PORT is the Thread's first port in the agent's shell")
  assert.equal(launched?.values?.APP_URL, `http://${launched?.host}:${launched?.port}`)
  assert.deepEqual(launched?.recipe, { kind: "ready", processes: [{ name: "web", port: launched!.port }, { name: "api", port: launched!.port + 1 }], checks: ["quick", "full"] })
  assert.match(threadEnvironmentInstructions(launched!), /The project's recipe also sets PORT=\d+, APP_URL=http:\/\/\S+, API_URL=\S+ in your shell\. Its processes \(web on \d+, api on \d+\) run through the mako server's app_start/)
  assert.match(threadEnvironmentInstructions(launched!), /If your change alters how the project installs, starts or is checked, update the recipe in the same turn: recipe_save, then recipe_publish once it works\.$/, "every Session is told to keep the recipe current")
  const shopApp = folderApp(realpathSync(project))
  cleanups.push(() => processes.discard(shopApp), () => processes.discard(AppKeySchema.parse(placed.thread)))
  const projectRecipes = join(root, "project-recipes")
  const tools = environmentTools({
    cwd: (id) => id === conversation ? project : undefined,
    environment,
    launchedWith: () => undefined,
    processes,
    recipesRoot: projectRecipes,
    settleMs: settle,
  })
  const before = parseYaml(await tools.status(conversation))
  assert.equal(before.recipe.contents.processes.web.command, recipe.processes.web.command)
  assert.equal(before.recipe.broken, undefined)
  assert.deepEqual(before.values, { PORT: String(toolBase), APP_URL: `http://${launched!.host}:${toolBase}`, API_URL: `http://${launched!.host}:${toolBase + 1}` })
  assert.deepEqual(before.processes, { web: `stopped (port ${toolBase})`, api: `stopped (port ${toolBase + 1})` })

  const started = await tools.start(conversation)
  assert.match(started, new RegExp(`web: running on port ${toolBase}\\napi: running on port ${toolBase + 1}\\nApp: http://${launched!.host}:${toolBase}`))
  const neighbour = randomUUID()
  store.registerJournal({ conversationId: neighbour, createdAt: Date.now(), bindings: [], harness: "claude" }, service)
  const neighbourTools = environmentTools({ cwd: () => project, environment, launchedWith: () => undefined, processes, settleMs: settle })
  assert.match(await neighbourTools.start(neighbour), /web: running on port \d+ \(it was already running\)\napi: running on port \d+ \(it was already running\)/, "another Thread in the same folder shares its app instead of starting a second")
  assert.equal((await environments.forConversation(neighbour, "Other", project))?.app, shopApp)
  const apiBody = await fetchJson(toolBase + 1)
  assert.equal(apiBody.home, join(root, "thread-data", shopApp, "home"), "a process-only HOME points into the app's data folder")
  assert.equal(apiBody.api, `http://${launched!.host}:${toolBase + 1}`, "every process gets the recipe's shared values")
  assert.equal(apiBody.cwd, realpathSync(project))
  assert.match(await tools.check(conversation, "quick"), /^The quick check passed in \d+\.\d s\.$/)
  assert.match(await tools.check(conversation, "full"), /^The full check passed in \d+\.\d s\.$/)
  const checked = parseYaml(await tools.status(conversation))
  assert.match(checked.checks.quick, /^passed \d\d:\d\d:\d\d, \d+ s ago$/)
  assert.match(checked.checks.full, /^passed \d\d:\d\d:\d\d, \d+ s ago$/)
  assert.match(checked.processes.web, new RegExp(`^running on port ${toolBase}; pid \\d+; started \\d\\d:\\d\\d:\\d\\d, \\d+ s ago; \\d+ MB; log \\S+process-web\\.log$`))
  assert.match(await tools.port(conversation, toolBase), new RegExp(`Port ${toolBase} belongs to this Thread: its process web`))
  assert.match(await tools.logs(conversation, { process: "web" }, 5), new RegExp(`listening on ${toolBase}`))
  const restarted = await tools.restart(conversation, ["web"])
  assert.match(restarted, /web: running/)
  assert.notEqual((await fetchJson(toolBase)).pid, apiBody.pid)
  await assert.rejects(tools.start(conversation, ["worker"]), /The recipe has no process named worker; it has web, api\./)

  // Over the same loopback MCP server and per-conversation token every agent gets.
  const grants = await startConversationMcp({ authorizeAgent: () => {} }, async () => null, undefined, tools)
  cleanups.push(async () => grants.close())
  const connect = async (id: string, query = "") => {
    const grant = grants.mint("binding", id)
    const client = new Client({ name: "agent", version: "1" })
    assert.ok(grant.makoUrl)
    await client.connect(new StreamableHTTPClientTransport(new URL(grant.makoUrl + query), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }))
    return client
  }
  const withQuery = await connect(conversation, "?codemode=false")
  assert.ok((await withQuery.listTools()).tools.some((tool) => tool.name === "app_status"), "a client that adds a query to the address, as OpenCode does, still reaches the tools")
  await withQuery.close()
  const agent = await connect(conversation)
  const listedTools = (await agent.listTools()).tools
  assert.deepEqual(listedTools.map((tool) => tool.name), ["app_status", "app_start", "app_stop", "app_restart", "app_logs", "app_probe", "app_own_packages", "app_check", "recipe_guide", "recipe_save", "recipe_publish", "port_holder"])
  for (const tool of listedTools) assert.match(tool.description ?? "", /^(Call|Run|Stop|Read|Save|Publish|Who)\b/, `${tool.name} says when to use it first`)
  assert.match(listedTools.find((tool) => tool.name === "recipe_save")?.description ?? "", /in the same turn as any change of yours that alters how the project installs, starts or is checked/)
  assert.match(JSON.stringify(await agent.callTool({ name: "app_status", arguments: {} })), /running on port/)
  const probed = await agent.callTool({ name: "app_probe", arguments: {} })
  const probeText = z.array(z.object({ text: z.string() })).parse(probed.content)[0]!.text
  assert.doesNotMatch(probeText, /^\s*\{/, "the probe answers in YAML")
  const probe = z.object({ running: z.boolean(), listening: z.record(z.string(), z.string()) }).parse(parseYaml(probeText))
  assert.equal(probe.running, true)
  assert.match(probe.listening[String(toolBase)] ?? "", /^pid \d+$/, "the probe sees the app's own port, inside this Thread's block")
  const guide = JSON.stringify(await agent.callTool({ name: "recipe_guide", arguments: {} }))
  assert.match(guide, /Setting up this project's recipe/)
  assert.match(guide, /verify\.run\): only a command the project already has/, "an agent writes what to see as a check rather than a script of its own for verify")
  assert.match(guide, /A desktop or mobile app beside a web app or a server it loads is such a project/, "a desktop app beside its web app gets targets")
  assert.match(guide, /a recipe that names one needs a cleanup; recipe_save says when it's missing/, "what's kept under a Thread's name gets a cleanup")
  const bothTargets = await agent.callTool({ name: "app_logs", arguments: { process: "web", check: "quick" } })
  assert.equal(bothTargets.isError, true, "logs names one process or one check")
  const refusedSave = await agent.callTool({ name: "recipe_save", arguments: { reason: "test", recipe: { processes: { web: { command: "npm run dev", port: "5173" } } } } })
  assert.equal(refusedSave.isError, true)
  assert.match(JSON.stringify(refusedSave.content), /Not saved: processes\.web\.port/, "a recipe that can't run is refused with the reason")
  assert.equal(existsSync(await recipePath(projectRecipes, project)), false)
  await agent.close()
  const stranger = await connect(randomUUID())
  const refusedStatus = await stranger.callTool({ name: "app_status", arguments: {} })
  assert.equal(refusedStatus.isError, true, "another conversation's token reaches only its own Thread")
  await stranger.close()

  // A broken recipe is loud, and the running app is left as it is.
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify({ ...recipe, extra: 1 }))
  assert.match(parseYaml(await tools.status(conversation)).recipe.broken, /Unrecognized key/)
  await assert.rejects(tools.start(conversation), /The project's recipe is broken, so nothing can start: \S+\/\.mako\/recipe\.json: the file: Unrecognized key/)
  assert.equal(await portListening(toolBase), true)
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify(recipe, null, 2))
  assert.match(await tools.stop(conversation), /Stopped (web, api|api, web)/)
  assert.equal(await portListening(toolBase + 1), false)

  // A process the app leaves running: app_stop waits for it to exit by itself, and names it left behind only if it stays.
  writeFileSync(join(project, "daemon.mjs"), `
import { spawn } from "node:child_process"
const away = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, ' + process.argv[1] + ')'], { detached: true, stdio: 'ignore' }); require('node:fs').writeFileSync(process.argv[2], String(c.pid)); c.unref()"
spawn(process.execPath, ["-e", away, process.env.LINGER_MS, process.env.LINGER_PID], { detached: true, stdio: "ignore" }).unref()
setInterval(() => {}, 1000)
`)
  const lingerPid = join(root, "linger.pid")
  const lingering = async (ms: number, leaveMs: number) => {
    rmSync(lingerPid, { force: true })
    writeFileSync(join(project, RECIPE_PATH), JSON.stringify({ processes: { daemon: { command: "node daemon.mjs", values: { LINGER_MS: String(ms), LINGER_PID: lingerPid } } } }))
    const linger = environmentTools({ cwd: () => project, environment, launchedWith: () => undefined, processes, settleMs: settle, leaveMs })
    assert.match(await linger.start(conversation), /daemon: running/)
    const deadline = Date.now() + settle
    while (!existsSync(lingerPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    const pid = Number(readFileSync(lingerPid, "utf8"))
    const began = Date.now()
    return { pid, text: await linger.stop(conversation), took: Date.now() - began }
  }
  const idles = await lingering(5_000, 20_000)
  assert.match(idles.text, new RegExp(`^Stopped daemon, with every process each had started\\. Still running at first, then gone by itself: pid ${idles.pid} \\(\\S+ -e setTimeout.+\\) after \\d s\\.$`), idles.text)
  assert.ok(idles.took < 15_000, `the stop returns once it's gone, not after the whole wait: ${idles.took} ms`)
  const stays = await lingering(60_000, 1_000)
  cleanups.push(async () => { try { process.kill(stays.pid) } catch {} })
  assert.match(stays.text, new RegExp(`^Stopped daemon, with every process each had started\\. Still running 1 s later, though, and likely left behind by the app: pid ${stays.pid} \\(.+\\)\\. .+ carries the app's mark\\. Stop one yourself`), stays.text)
  process.kill(stays.pid)
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify(recipe, null, 2))

  // Install and catch up: each step runs in a fresh copy and again only when its inputs change.
  const installs = join(root, "installs.txt")
  writeFileSync(join(project, "package-lock.json"), "{\"v\": 1}\n")
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify({ ...recipe, prepare: [{ command: `echo installed >> ${installs}`, inputs: ["package-lock.json"] }] }))
  const count = () => existsSync(installs) ? readFileSync(installs, "utf8").split("\n").filter(Boolean).length : 0
  assert.match(await tools.start(conversation), /web: running/)
  assert.equal(count(), 1, "a fresh copy is prepared before its app starts")
  await tools.stop(conversation)
  await tools.start(conversation)
  assert.equal(count(), 1, "unchanged inputs don't prepare again")
  assert.match(await tools.status(conversation), /\n  echo installed >> \S+installs\.txt: up to date\n/)
  await tools.stop(conversation)
  writeFileSync(join(project, "package-lock.json"), "{\"v\": 2}\n")
  assert.match(await tools.status(conversation), /runs before the next start or check/)
  assert.match(await tools.check(conversation, "quick"), /passed/)
  assert.equal(count(), 2, "a changed lockfile catches up, before a quick check too")
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify({ ...recipe, prepare: [{ command: `echo installed >> ${installs}; echo resolved >> package-lock.json`, inputs: ["package-lock.json"] }] }))
  assert.match(await tools.check(conversation, "quick"), /passed/)
  assert.match(await tools.check(conversation, "quick"), /passed/)
  assert.equal(count(), 3, "an install that rewrites its own lockfile, as npm install can, isn't due again for what it wrote")
  await tools.start(conversation)
  writeFileSync(join(project, "package-lock.json"), "{\"v\": 2.5}\n")
  assert.match(await tools.check(conversation, "quick"), /^This checkout needs preparing \(.+\) because package-lock\.json changed, which can't run while the app does: stop it with app_stop, then call again\.$/)
  assert.equal(count(), 3, "an install isn't run under the running app")
  await tools.stop(conversation)
  writeFileSync(join(project, "package-lock.json"), "{\"v\": 3}\n")
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify({ ...recipe, prepare: [{ command: "echo resolving; echo 'npm ERR! missing peer' >&2; exit 1", inputs: ["package-lock.json"] }] }))
  const failedPrepare = await tools.start(conversation)
  assert.match(failedPrepare, /^Preparing this checkout failed \(exit 1\) in [\d.]+ s, so nothing started; it runs again on the next start\. It ran: .+\n\nresolving\nnpm ERR! missing peer/)
  assert.equal(await portListening(toolBase), false)

  // The desk: the same app by folder, for the strip and the terminal dock.
  const deskFolder = async (cwd: string, claim: boolean) => {
    const found = await environments.forFolder(cwd, claim)
    return found.environment ? { ...found, environment: { ...found.environment, port: toolBase } } : found
  }
  const setupConversation = randomUUID()
  store.registerJournal({ conversationId: setupConversation, createdAt: Date.now(), bindings: [], harness: "codex" }, service)
  const bare = realpathSync(mkdtempSync(join(root, "bare-")))
  let setupLive = true
  let setupWorking = true
  const deskTools = environmentTools({
    cwd: (id) => id === setupConversation ? bare : undefined,
    environment,
    launchedWith: () => undefined,
    conversation: (id) => id === setupConversation && setupLive ? { title: "Set up the app", harness: "codex", working: setupWorking } : undefined,
    folder: deskFolder,
    processes,
    recipesRoot: projectRecipes,
    settleMs: settle,
  })
  const { desk } = deskTools
  const projectApp = (await deskFolder(project, false)).app
  const markHere = async (on = desk) => {
    const mark = (await on.marks()).find((entry) => entry.checkout === processes.checkoutOf(projectApp))
    return mark && { state: mark.state, port: mark.port }
  }
  const failedView = await desk.view(project)
  assert.equal(failedView.kind === "ready" && failedView.phase, "crashed", "a failed install shows as the app failing")
  assert.deepEqual(await markHere(), { state: "crashed", port: undefined }, "the sidebar marks it the same way")
  assert.deepEqual(failedView.kind === "ready" && failedView.prepare && [failedView.prepare.reason, failedView.prepare.exit?.code], ["the recipe's install step changed", 1])
  assert.match((await desk.output(project, "prepare")).text, /resolving\nnpm ERR! missing peer/)
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify(recipe, null, 2))
  assert.deepEqual(await desk.start(project), { problems: [] })
  const up = await desk.view(project)
  assert.equal(up.kind === "ready" && up.phase, "running", "a start after the recipe's repair leaves the old failure behind")
  assert.deepEqual(await markHere(), { state: "running", port: toolBase }, "the sidebar marks it running, with where it listens")
  assert.deepEqual(up.kind === "ready" && up.address, { host: launched!.host, port: toolBase }, "the desk shows the folder's own address, shared with its agents")
  assert.deepEqual(up.kind === "ready" && up.processes.map((entry) => [entry.name, entry.state, entry.port]), [["web", "running", toolBase], ["api", "running", toolBase + 1]])
  assert.equal(up.kind === "ready" && up.prepare, undefined)
  // A recipe edit must not make Open in browser point at a port the running process never took.
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify({ ...recipe, processes: { ...recipe.processes, web: { ...recipe.processes.web, port: "{port+2}" } } }))
  const stillUp = await desk.view(project)
  assert.deepEqual(stillUp.kind === "ready" && stillUp.address, { host: launched!.host, port: toolBase }, "the address follows the actual running process until a restart")
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify({ ...recipe, processes: { api: recipe.processes.api } }))
  const offset = await desk.view(project)
  assert.deepEqual(offset.kind === "ready" && offset.address, { host: launched!.host, port: toolBase + 1 }, "a sole process on an offset port is the browser target")
  assert.equal(parseYaml(await tools.status(conversation)).app, `http://${launched!.host}:${toolBase + 1}`, "the agent reports the same offset address as the desk")
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify(recipe))
  await tools.stop(conversation, ["web"])
  const apiOnly = await desk.view(project)
  assert.deepEqual(apiOnly.kind === "ready" && apiOnly.address, { host: launched!.host, port: toolBase + 1 }, "the browser follows the running API while web is stopped")
  assert.equal(parseYaml(await tools.status(conversation)).app, `http://${launched!.host}:${toolBase + 1}`)
  assert.match(await tools.start(conversation, ["api"]), new RegExp(`App: http://${launched!.host}:${toolBase + 1}`), "a partial start reports the running port too")
  await tools.start(conversation, ["web"])
  const firstRead = await desk.output(project, "process:web")
  assert.equal(firstRead.reset, true)
  assert.match(firstRead.text, new RegExp(`listening on ${toolBase}`))
  assert.deepEqual(await desk.output(project, "process:web", firstRead.cursor), { text: "", cursor: firstRead.cursor, reset: false }, "a read from where the last one ended has only what's new")
  assert.deepEqual(await desk.restart(project), { problems: [] })
  const afterRestart = await desk.output(project, "process:web", firstRead.cursor)
  assert.equal(afterRestart.reset, true, "a new run's output starts over")
  assert.match(afterRestart.text, /^listening on/)
  assert.deepEqual(await desk.check(project, "quick"), { problems: [] })
  const checkedView = await desk.view(project)
  assert.deepEqual(checkedView.kind === "ready" && checkedView.checks.map((check) => [check.tier, check.state]), [["quick", "passed"], ["full", "passed"]], "the full check the agent ran earlier shows too")
  assert.match((await desk.output(project, "check:quick")).text, /quick ok/)
  // Joining an older in-flight check must identify what actually ran after a recipe edit.
  const checkGate = join(root, "check-gate")
  const earlierCommand = `while [ ! -f '${checkGate}' ]; do sleep 0.05; done; echo earlier-check`
  await processes.start(projectApp, [{ kind: "check", name: "quick", command: earlierCommand, cwd: project, env: process.env }])
  const newerCommand = "echo newer-check; exit 4"
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify({ ...recipe, checks: { ...recipe.checks, quick: newerCommand } }))
  const shortWait = environmentTools({ cwd: () => project, environment, launchedWith: () => undefined, processes, settleMs: 50 })
  const waitingOnEarlier = await shortWait.check(conversation, "quick")
  assert.ok(waitingOnEarlier.includes(earlierCommand) && !waitingOnEarlier.includes(`(${newerCommand})`), "the running check names its recorded command")
  assert.match(waitingOnEarlier, /this run doesn't prove it/)
  assert.match(waitingOnEarlier, /This call joined a run already under way/)
  assert.match(waitingOnEarlier, /Your next app_check with tier "quick" waits for this same run/)
  writeFileSync(checkGate, "go")
  await processes.settle(projectApp, ["check-quick"], settle)
  const obsolete = await desk.view(project)
  assert.equal(obsolete.kind === "ready" && obsolete.checks.find((check) => check.tier === "quick")?.state, "never", "a passed earlier command isn't a pass for the current recipe")
  const owedEarlier = await shortWait.check(conversation, "quick")
  assert.match(owedEarlier, /earlier-check/, "calling again after the run ended returns that run's result instead of starting another")
  assert.match(owedEarlier, /passed in [\d.]+ s\. It ran .*earlier-check, and the recipe now names a different quick check/)
  assert.match(owedEarlier, /This is the run your last app_check left running/)
  assert.match(await shortWait.check(conversation, "quick"), /^The quick check failed \(exit 4\) in [\d.]+ s\. It ran: echo newer-check; exit 4\n\nnewer-check$/, "the call after that runs the current recipe, and a failure comes with its whole output")
  // Another Thread's newer run keeps the result for whoever was still waiting on the older one.
  const countFile = join(root, "check-count")
  const slowGate = join(root, "slow-gate")
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify({ ...recipe, checks: { ...recipe.checks, quick: `n=$(($(cat '${countFile}' 2>/dev/null || echo 0) + 1)); echo $n > '${countFile}'; while [ ! -f '${slowGate}' ]; do sleep 0.05; done; echo run-$n; exit 1` } }))
  assert.match(await shortWait.check(conversation, "quick"), /is still running/)
  writeFileSync(slowGate, "go")
  await processes.settle(projectApp, ["check-quick"], settle)
  assert.match(await shortWait.check(neighbour, "quick"), /run-2/, "a Thread that wasn't waiting gets a run of its own")
  const keptForFirst = await shortWait.check(conversation, "quick")
  assert.match(keptForFirst, /run-1/, "the Thread still waiting gets the run it was waiting on, though a newer one replaced it")
  assert.match(keptForFirst, /This is the run your last app_check left running/)
  assert.match(await shortWait.check(conversation, "quick"), /run-3/)
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify(recipe))
  await desk.check(project, "quick")
  await desk.stop(project)
  const stoppedView = await desk.view(project)
  assert.equal(stoppedView.kind === "ready" && stoppedView.phase, "stopped")
  assert.equal(await markHere(), undefined, "a stopped app has no mark")
  assert.equal(stoppedView.kind === "ready" && stoppedView.checks[0]?.state, "passed", "stopping keeps what the checks found")
  assert.equal(await portListening(toolBase), false)
  const fresh = realpathSync(mkdtempSync(join(root, "fresh-")))
  mkdirSync(join(fresh, ".mako"))
  writeFileSync(join(fresh, RECIPE_PATH), JSON.stringify(recipe))
  const freshView = await desk.view(fresh)
  assert.equal(freshView.kind === "ready" && freshView.phase, "stopped")
  assert.equal(freshView.kind === "ready" && freshView.address, undefined, "an app that never ran has no address yet")
  assert.equal(store.environment(folderApp(fresh)), undefined, "looking claims no ports")
  const broken = realpathSync(mkdtempSync(join(root, "broken-")))
  mkdirSync(join(broken, ".mako"))
  writeFileSync(join(broken, RECIPE_PATH), "{ not json")
  const brokenView = await desk.view(broken)
  assert.equal(brokenView.kind, "invalid")
  assert.match(brokenView.kind === "invalid" ? brokenView.message : "", /not JSON/)
  assert.deepEqual(await desk.view(bare), { kind: "none", project: basename(bare), root: bare })
  // Setting up: the steps are read from what Mako ran for the setup conversation's Thread, not from the agent.
  const settingUp = (progress: SetupProgress) =>
    ({ kind: "setting-up", project: basename(bare), root: bare, thread: { title: "Set up the app", harness: "codex", conversation: setupConversation }, progress })
  const setupApp = (await environment(setupConversation, bare))!.app
  cleanups.push(() => processes.discard(setupApp))
  await deskTools.guide(setupConversation)
  assert.deepEqual(await desk.view(bare), settingUp({ recipe: "running", app: "waiting", checks: "waiting" }), "reading the guide marks the project as being set up")
  setupWorking = false
  const stoppedSetup = { kind: "none", project: basename(bare), root: bare, stopped: { title: "Set up the app", conversation: setupConversation } }
  assert.deepEqual(await desk.view(bare), stoppedSetup, "a turn that ends before a recipe is saved ends the setup; the menu offers that Thread, which may be asking something")
  setupWorking = true
  assert.deepEqual(await desk.view(bare), stoppedSetup, "the same conversation working on something else doesn't read as setting up again")
  setupLive = false
  assert.deepEqual(await desk.view(bare), { kind: "none", project: basename(bare), root: bare }, "once that conversation ends, there's no Thread to go back to")
  setupLive = true
  await deskTools.guide(setupConversation)
  writeFileSync(join(bare, "server.mjs"), readFileSync(server, "utf8"))
  const setupRecipe = (quick: string) =>
    RecipeSchema.parse({ values: { PORT: "{port}" }, processes: { web: { command: "node server.mjs", port: "{port}" } }, checks: { quick } })
  // What the desk shows while app_start is still waiting for the app to come up.
  const appStepsDuring = async (start: Promise<string>) => {
    const seen = new Set<string | undefined>()
    let settled: string | undefined
    void start.then((text) => { settled = text })
    while (settled === undefined) {
      const view = await desk.view(bare)
      if (settled === undefined) seen.add(view.kind === "setting-up" ? view.progress?.app : view.kind)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return { seen: [...seen], said: settled }
  }
  await deskTools.save(setupConversation, setupRecipe("node -e \"process.exit(1)\""))
  assert.deepEqual(await desk.view(bare), settingUp({ recipe: "done", app: "waiting", checks: "waiting" }), "a saved recipe ticks the first step; the setup goes on while its turn does")
  writeFileSync(join(bare, "dies.mjs"), `import { createServer } from "node:http"\ncreateServer((_, response) => response.end("up")).listen(Number(process.env.PORT), "127.0.0.1", () => setTimeout(() => process.exit(3), 600))\n`)
  await deskTools.save(setupConversation, RecipeSchema.parse({ values: { PORT: "{port}" }, processes: { web: { command: "node dies.mjs", port: "{port}" } }, checks: { quick: "true" } }))
  const dying = await appStepsDuring(deskTools.start(setupConversation))
  assert.match(dying.said, /web: crashed \(exit 3\)/)
  assert.ok(dying.seen.includes("running") && !dying.seen.includes("done"), `a server that answers its port and dies a moment later never ticks the app step (saw ${dying.seen.join(", ")})`)
  const crashedSetup = await desk.view(bare)
  assert.equal(crashedSetup.kind === "setting-up" && crashedSetup.progress?.app, "failed")
  await deskTools.save(setupConversation, setupRecipe("node -e \"process.exit(1)\""))
  const coming = await appStepsDuring(deskTools.start(setupConversation))
  assert.match(coming.said, /web: running/)
  assert.ok(coming.seen.includes("running") && !coming.seen.includes("done"), `the app step ticks when app_start says the app is up, not when its port first answers (saw ${coming.seen.join(", ")})`)
  assert.deepEqual(await desk.view(bare), settingUp({ recipe: "done", app: "done", checks: "waiting" }), "its app coming up ticks the second")
  await deskTools.stop(setupConversation)
  const stoppedSetupApp = await desk.view(bare)
  assert.equal(stoppedSetupApp.kind === "setting-up" && stoppedSetupApp.progress?.app, "done", "stopping the app again leaves that step ticked")
  await deskTools.check(setupConversation, "quick")
  assert.deepEqual(await desk.view(bare), settingUp({ recipe: "done", app: "done", checks: "failed" }), "a failing check shows as failed")
  await deskTools.save(setupConversation, setupRecipe("node -e \"process.exit(0)\""))
  await deskTools.check(setupConversation, "quick")
  assert.equal((await desk.view(bare)).kind, "ready", "its checks passing ends the setup")
  await deskTools.guide(setupConversation)
  assert.equal((await desk.view(bare)).kind, "ready", "reading the guide to change a recipe that works leaves every Thread seeing the app as it is")
  // An install stopped before it finished runs again on the next start instead of reading as failed.
  const install = `echo installed >> ${installs}`
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify({ ...recipe, prepare: [{ command: install, inputs: ["package-lock.json"] }] }))
  const interrupted = await processes.prepared(realpathSync(project))
  await processes.savePrepared(realpathSync(project), { done: interrupted.done, pending: { [install]: "stopped mid-way" } })
  const installsBefore = count()
  assert.deepEqual(await desk.start(project), { problems: [] })
  assert.equal(count(), installsBefore + 1)
  const reinstalled = await desk.view(project)
  assert.equal(reinstalled.kind === "ready" && reinstalled.phase, "running")
  await desk.stop(project)
  // An install that outlasts the wait: the start goes ahead by itself once it's done, unless the app is stopped first.
  const slowInstall = `sleep 1.5 && echo installed >> ${installs}`
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify({ ...recipe, prepare: [{ command: slowInstall, inputs: ["package-lock.json"] }] }))
  const brief = environmentTools({ cwd: () => project, environment, launchedWith: () => undefined, folder: deskFolder, processes, settleMs: 300 })
  const beforeSlow = count()
  assert.deepEqual(await brief.desk.start(project), { problems: [] })
  const slowPreparing = await brief.desk.view(project)
  assert.equal(slowPreparing.kind === "ready" && slowPreparing.phase, "preparing")
  const slowDeadline = Date.now() + settle
  while (!(await portListening(toolBase)) && Date.now() < slowDeadline) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(await portListening(toolBase), true, "Run app during a long install starts the app once the install is done")
  assert.equal(count(), beforeSlow + 1)
  await brief.desk.stop(project)
  writeFileSync(join(project, "package-lock.json"), "{\"v\": 5}\n")
  assert.match(await brief.start(conversation), /^Preparing this checkout \(sleep 1\.5 && echo installed >> \S+\); the app starts by itself once it's done/)
  await brief.stop(conversation)
  await new Promise((resolve) => setTimeout(resolve, 2_500))
  assert.equal(await portListening(toolBase), false, "stopping during the install takes the start back too")
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify(recipe, null, 2))

  // Room: under memory pressure another Thread's quiet app goes first; a Mac that stays critical makes the start wait.
  const quietThread = AppKeySchema.parse(randomUUID())
  title.set(quietThread, 'the Thread "Old experiment"')
  cleanups.push(() => processes.discard(quietThread))
  await processes.start(quietThread, [{ kind: "process", name: "idle", command: "sleep 300", cwd: root, env: process.env }])
  await processes.touch(quietThread)
  writeFileSync(join(records, quietThread, "used"), String(Date.now() - 60 * 60 * 1000))
  // Short of memory until the quiet app is gone.
  const roomTools = environmentTools({ cwd: () => project, environment, launchedWith: () => undefined, processes, settleMs: settle, whose: (id) => title.get(id), pressure: async () =>
    (await processes.active()).some((entry) => entry.app === quietThread) ? "warning" : "normal" })
  const roomy = await roomTools.start(conversation)
  assert.match(roomy, /Stopped the quiet app of the Thread "Old experiment" \(\d+ MB, unused for 1 hour\) to make room\.\nweb: running/)
  assert.equal((await processes.active()).some((entry) => entry.app === quietThread), false)
  const measured = parseYaml(await roomTools.status(conversation))
  assert.match(measured.processes.web, /; \d+ MB; log /, "each running process's memory is measured")
  assert.equal(measured.room, "memory normal; 1 app running on this Mac")
  await roomTools.stop(conversation)
  const critical = environmentTools({ cwd: () => project, environment, launchedWith: () => undefined, processes, settleMs: settle, pressure: async () => "critical" })
  await processes.start(quietThread, [{ kind: "process", name: "busy", command: "sleep 300", cwd: root, env: process.env }])
  await processes.touch(quietThread)
  assert.match(await critical.start(conversation), /^Waiting in line for memory: this Mac is critically short of memory, with these apps running: \S+ \(\d+ MB, used 0 min ago\)\. Nothing has started yet; Mako starts it by itself once there's room/)
  assert.equal(await portListening(toolBase), false)
  assert.match(parseYaml(await critical.status(conversation)).room, /^memory critical; \d+ apps? running on this Mac; waiting in line for memory since 0 min ago; it starts by itself once there's room$/)
  assert.equal(await critical.stop(conversation), "Nothing was running; the start waiting for memory was taken out of the line.")
  assert.doesNotMatch(parseYaml(await critical.status(conversation)).room, /waiting in line/)

  // A start waiting in line goes ahead by itself once memory frees up.
  let short = true
  const lineTools = environmentTools({ cwd: () => project, environment, launchedWith: () => undefined, folder: deskFolder, processes, settleMs: settle, lineMs: 100, pressure: async () => short ? "critical" : "normal" })
  assert.match(await lineTools.start(conversation), /^Waiting in line for memory/)
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(await portListening(toolBase), false, "nothing starts while memory stays critical")
  const lineWaiting = await lineTools.desk.view(project)
  assert.equal(lineWaiting.kind === "ready" && lineWaiting.phase, "waiting")
  assert.deepEqual(await markHere(lineTools.desk), { state: "waiting", port: undefined }, "a start waiting in line is marked waiting")
  short = false
  const deadline = Date.now() + settle
  while (!(await portListening(toolBase)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(await portListening(toolBase), true, "the start went ahead once there was room")
  const startedView = await lineTools.desk.view(project)
  assert.ok(startedView.kind === "ready" && (startedView.phase === "running" || startedView.phase === "starting"))
  assert.doesNotMatch(parseYaml(await lineTools.status(conversation)).room, /waiting in line/)
  await lineTools.stop(conversation)
  const criticalDesk = environmentTools({ cwd: () => undefined, environment, launchedWith: () => undefined, folder: deskFolder, processes, settleMs: settle, pressure: async () => "critical" }).desk
  assert.deepEqual(await criticalDesk.start(project), { problems: [] })
  const waitingView = await criticalDesk.view(project)
  assert.equal(waitingView.kind === "ready" && waitingView.phase, "waiting", "the desk shows the start waiting for memory")
  assert.equal(waitingView.kind === "ready" && waitingView.room?.apps, 1)
  assert.ok(waitingView.kind === "ready" && (waitingView.room?.bytes ?? 0) > 0)
  assert.deepEqual(await criticalDesk.makeRoom(project), { problems: [] })
  assert.equal((await processes.active()).some((entry) => entry.app === quietThread), false, "making room stops the other apps")
  const roomMade = await criticalDesk.view(project)
  assert.equal(roomMade.kind === "ready" && roomMade.phase, "running", "and starts this one whatever the memory")
  await criticalDesk.stop(project)
  await processes.start(quietThread, [{ kind: "process", name: "busy", command: "sleep 300", cwd: root, env: process.env }])

  // After a long quiet an app stops by itself; its files and data stay.
  writeFileSync(join(records, quietThread, "used"), String(Date.now() - 7 * 60 * 60 * 1000))
  assert.deepEqual(await processes.stopIdle(6 * 60 * 60 * 1000), [quietThread])
  assert.deepEqual(await processes.active(), [])

  // Removing the Thread's worktree stops its app first and deletes its data after.
  let cleanedWhile: boolean | undefined
  const worktrees = new ThreadWorktreeService(join(root, "worktrees"), store, async () => [], async () => [], {
    stop: async (id) => { await processes.stop(AppKeySchema.parse(id)) },
    cleanup: async (id, path) => { cleanedWhile = existsSync(join(path, "server.mjs")) && !(await processes.status(AppKeySchema.parse(id))).some((run) => run.state.kind === "running") },
    discard: async (id) => {
      const app = AppKeySchema.parse(id)
      await processes.discard(app)
      rmSync(environments.dataDir(app), { recursive: true, force: true })
    },
  })
  const prepared = await worktrees.prepare(conversation, project, "Fix login")
  await worktrees.attach(conversation)
  const inWorktree = await environments.forConversation(conversation, "Fix login", prepared.cwd)
  assert.ok(inWorktree && existsSync(inWorktree.dataDir))
  writeFileSync(join(inWorktree.dataDir, "app.db"), "rows\n")
  const worktreeTools = environmentTools({ cwd: () => prepared.cwd, environment, launchedWith: () => undefined, processes, settleMs: settle })
  assert.match(await worktreeTools.start(conversation), /web: running/)
  assert.equal((await fetchJson(toolBase)).cwd, realpathSync(prepared.path), "a worktree Thread's processes run in its own checkout, from its own recipe")
  await worktreeTools.stop(conversation)

  // One copy at a time: a fixed port, and a start refused while another checkout of the project runs it, naming whose it is.
  const turnRecipes = join(root, "turn-recipes")
  const fixedPort = toolBase + 5
  const turnRecipe = await saveDraft(turnRecipes, project, RecipeSchema.parse({
    oneAtATime: true,
    processes: { web: { command: "node server.mjs", port: String(fixedPort), values: { PORT: String(fixedPort) } } },
    checks: { quick: "node -e \"console.log('quick ok')\"" },
  }), fixture, {})
  await publishDraft(await recipePath(turnRecipes, project), fixture.app, turnRecipe.version.version, { at: 1, on: "this Mac", checkout: project, steps: [] })
  title.set(AppKeySchema.parse(placed.thread), "the Thread “Fix login”")
  const turnDeps = { environment, launchedWith: () => undefined, folder: deskFolder, processes, recipesRoot: turnRecipes, settleMs: settle, whose: (id: string) => title.get(id) }
  const inWorktreeTurn = environmentTools({ ...turnDeps, cwd: () => prepared.cwd })
  const inMainTurn = environmentTools({ ...turnDeps, cwd: () => project })
  assert.match(await inWorktreeTurn.start(conversation), new RegExp(`web: running on port ${fixedPort}`))
  assert.equal(await inMainTurn.start(neighbour), "Only one copy of this project's app runs at a time on this Mac (the recipe sets oneAtATime), and the Thread “Fix login” has it running, so nothing started here. Ask the user whether to stop that copy; never stop it yourself.")
  assert.equal((await fetchJson(fixedPort)).cwd, realpathSync(prepared.path), "the running copy is left alone")
  const elsewhere = await inMainTurn.desk.view(project)
  assert.deepEqual(elsewhere.kind === "ready" && [elsewhere.phase, elsewhere.elsewhere], ["stopped", "the Thread “Fix login”"], "a checkout that isn't running reads as stopped; whose copy runs waits for someone asking to run this one")
  assert.deepEqual(await inMainTurn.desk.start(project), { problems: ["Only one copy of this app runs at a time, and the Thread “Fix login” has it."] }, "a start that raced the other copy says why nothing started")
  assert.match(await inMainTurn.check(neighbour, "quick"), /^The quick check passed in /, "a check without the app isn't held up")
  assert.deepEqual(await inMainTurn.desk.takeTurn(project), { problems: [] })
  assert.equal((await fetchJson(fixedPort)).cwd, realpathSync(project), "taking a turn stops the other copy and starts this one")
  assert.match(parseYaml(await inWorktreeTurn.status(conversation)).processes.web, /^stopped/)
  assert.match(await inWorktreeTurn.start(conversation), /^Only one copy of this project's app runs at a time on this Mac \(the recipe sets oneAtATime\), and \S+ has it running/)
  const held = await inWorktreeTurn.desk.view(prepared.cwd)
  assert.ok(held.kind === "ready" && held.elsewhere, "the other way round too")
  await inMainTurn.stop(neighbour)
  const free = await inWorktreeTurn.desk.view(prepared.cwd)
  assert.deepEqual(free.kind === "ready" && [free.phase, free.elsewhere], ["stopped", undefined], "once it stops, the turn is free")
  assert.match(await worktreeTools.start(conversation), /web: running/)
  // Saved from a worktree, the recipe is a draft only that Thread runs; published, it reaches the main checkout and every other worktree at once.
  const saving = environmentTools({ cwd: () => prepared.cwd, environment, launchedWith: () => undefined, processes, recipesRoot: projectRecipes, settleMs: settle })
  const savedRecipe = (saved: string) => RecipeSchema.parse({ ...recipe, values: { ...recipe.values, SAVED: saved }, carry: ["config.local.json"], verify: { run: "node check.mjs" } })
  const savedNote = await saving.save(conversation, savedRecipe("yes"), "Mark it saved")
  assert.ok(savedNote.includes(`carry: nothing Git ignores in the main checkout (${realpathSync(project)}) matches config.local.json yet; files Git tracks come with every checkout anyway.`), "saving says what carry finds in the main checkout")
  assert.match(savedNote, /^Saved as draft version 1, the project's first recipe\. Only this Thread runs it; every other Thread keeps the committed \.mako\/recipe\.json until it's published\.\nChanged from what this Thread ran:\n  values\.SAVED: added, "yes"\n  carry\["config\.local\.json"\]: added, "copied"\n  verify\.run: added, "node check\.mjs"\nThis checkout also has/, "saving says what changed, field by field, not the whole recipe")
  assert.match(await saving.save(conversation, savedRecipe("no"), "Unmark it"), /^Saved as draft version 2, the project's first recipe\.[^\n]*\nChanged from what this Thread ran:\n  values\.SAVED: was "yes", now "no"\n/)
  assert.match(await saving.save(conversation, savedRecipe("yes"), "Mark it again"), /\n  values\.SAVED: was "no", now "yes"\n/)
  assert.match(await saving.save(conversation, savedRecipe("yes"), "Again"), /^That's this Thread's draft already, version 3; nothing changed\./)
  assert.match(savedNote, /also has a committed \.mako\/recipe\.json; once this is published, Mako's recipe comes first/)
  assert.match(savedNote, /This Thread's processes still run as they were started; app_restart runs them with the draft\./)
  const mainRecipe = await readRecipe(project, fixture, projectRecipes)
  assert.equal(mainRecipe.kind === "ready" && mainRecipe.from, join(project, RECIPE_PATH), "the main checkout still runs the committed recipe while it's a draft")
  assert.match(parseYaml(await saving.status(conversation)).recipe.version, /^3, this Thread's draft; only this Thread runs it until recipe_publish proves and publishes it$/)
  const publishedNote = await saving.publish(conversation)
  assert.match(publishedNote, /^Published version 3 in [\d.]+ s: start passed in [\d.]+ s, verify passed in [\d.]+ s\. Every Thread of this project uses it from its next app start; apps already running keep the version they started with until then\.$/, "Mako proves the draft by starting it and running its verify, then publishes it")
  assert.match(await saving.publish(conversation), /^This Thread has no draft to publish; it runs version 3, the published one\./)
  const sharedFile = await recipePath(projectRecipes, project)
  assert.equal(await recipePath(projectRecipes, prepared.path), sharedFile, "the main checkout and its worktrees share one saved recipe")
  const mainRead = await readRecipe(project, fixture, projectRecipes)
  assert.equal(mainRead.kind === "ready" && mainRead.recipe.values.SAVED, "yes")
  const savedStatus = parseYaml(await saving.status(conversation))
  assert.equal(savedStatus.recipe.file, sharedFile)
  assert.equal(savedStatus.recipe.savedIn, undefined, "where recipe_save writes is said only when it isn't the file in use")
  assert.equal(savedStatus.recipe.contents.values.SAVED, "yes", "status shows what the recipe says, to repair from")
  assert.match(savedStatus.recipe.ignored, /\.mako\/recipe\.json: committed with the project, but the recipe saved in Mako comes first/)
  assert.equal(savedStatus.values.SAVED, "yes")
  assert.equal(savedStatus.credentials, undefined, "a recipe that carries no credentials says nothing about them")

  appendFileSync(join(project, ".git", "info", "exclude"), "config.local.json\n")
  writeFileSync(join(project, "config.local.json"), "main config")
  await saving.check(conversation, "quick")
  assert.equal(readFileSync(join(prepared.path, "config.local.json"), "utf8"), "main config", "an existing worktree catches up with carry at its next check")
  writeFileSync(join(prepared.path, "config.local.json"), "worktree config")
  await saving.start(conversation)
  assert.equal(readFileSync(join(prepared.path, "config.local.json"), "utf8"), "worktree config", "starting again preserves this worktree's own file")

  // Credentials are carried as copies like any other file; the save and app_status name them, so nobody opens one.
  appendFileSync(join(project, ".git", "info", "exclude"), ".env\n")
  writeFileSync(join(project, ".env"), "TOKEN=main\n")
  const withCredentials = RecipeSchema.parse({ ...recipe, values: { ...recipe.values, SAVED: "yes" }, carry: ["config.local.json", ".env"] })
  assert.match(await saving.save(conversation, withCredentials), /\n\.env holds credentials by its name: Mako brings it as it is\. Never open, print or copy it yourself, and never ask the user to paste a value\./)
  const settings = environmentTools({ cwd: () => prepared.cwd, environment, launchedWith: () => undefined, folder: deskFolder, processes, recipesRoot: projectRecipes, settleMs: settle }).desk
  const shown = await settings.setup(prepared.cwd)
  assert.deepEqual(shown.recipe.kind === "ready" && [shown.recipe.source, shown.recipe.file, shown.recipe.earlier > 0, shown.recipe.version, shown.recipe.draft], ["mako", join(recipeVersions(sharedFile), "4.json"), true, 4, true], "Settings shows the draft this folder's app runs")
  assert.deepEqual(shown.recipe.kind === "ready" && shown.recipe.recipe.processes.map((entry) => [entry.name, entry.command, entry.port]), [["web", "node server.mjs", "{port}"], ["api", "node server.mjs", "{port+1}"]], "the recipe as written, placeholders and all")
  assert.deepEqual(shown.recipe.kind === "ready" && shown.recipe.recipe.carry, [{ path: "config.local.json", link: false, credentials: false }, { path: ".env", link: false, credentials: true }], "Settings lists what's copied, credentials by name")
  assert.equal(parseYaml(await saving.status(conversation)).credentials, ".env holds credentials: Mako brings it into each worktree as the recipe's carry says. Never open, print or copy it yourself.")
  await saving.stop(conversation)
  assert.match(await saving.start(conversation), /web: running/)
  assert.equal(readFileSync(join(prepared.path, ".env"), "utf8"), "TOKEN=main\n", "an existing worktree gets them at its next start")
  assert.equal(git(prepared.path, "status", "--porcelain"), "", "and Git still ignores them there")
  const running = (await processes.status(AppKeySchema.parse(placed.thread))).map((entry) => entry.pid!)
  await worktrees.remove(prepared.path)
  assert.equal(cleanedWhile, true, "the recipe's cleanup runs once the app has stopped, while the worktree is still there")
  assert.equal(existsSync(prepared.path), false)
  assert.ok(running.every((pid) => !alive(pid)), "its processes stopped")
  assert.equal(await portListening(toolBase), false)
  assert.equal(existsSync(inWorktree.dataDir), false, "its data folder is deleted")
  assert.equal(existsSync(join(records, placed.thread)), false, "and its records")
  store.close()

  console.log("thread processes: one app per folder, shared by the Threads in it, and the same app from the desk (its view, start, restart, checks, stop, output followed across runs, a look that claims nothing, broken and being set up, an install stopped mid-way run again, a long install starting the app by itself once done unless stopped, waiting in line for memory and making room); recipe checked and resolved, the project's recipe saved in Mako first and shared by its worktrees, the committed one otherwise, credentials carried as copies and named in the save, app_status and Settings, install and catch-up only when inputs change, room made from quiet apps or the start waits in line and goes ahead by itself, idle apps stopped; one copy at a time (a fixed port, a start refused naming whose copy runs, the desk taking a turn); process trees started detached, adopted by another host, surviving the host that started them, stopped whole; what an app leaves running given time to exit by itself, and named left behind only when it stays; busy ports named; the agent's tools ran the app and both checks; removing the worktree stopped the app and deleted its data")
} finally {
  for (const cleanup of cleanups) await cleanup().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
