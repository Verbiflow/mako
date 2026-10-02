import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { z } from "zod"
import { ThreadIdSchema, type Actor } from "../electron/contracts/thread-identity.js"
import type { SetupProgress } from "../electron/contracts/thread-app.js"
import { AppKeySchema, type ThreadEnvironment } from "../electron/contracts/thread-environments.js"
import { startConversationMcp } from "../electron/conversation-mcp.js"
import { environmentTools } from "../electron/environment-tools.js"
import { applyThreadEnvironment, folderApp, portListening, ThreadEnvironments, threadEnvironmentInstructions } from "../electron/thread-environment.js"
import { ThreadProcesses } from "../electron/thread-processes.js"
import { readRecipe, recipeHistory, recipePath, RecipeSchema, recipeValues, RECIPE_PATH, saveRecipe } from "../electron/thread-recipe.js"
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
  await assert.rejects(saveRecipe(recipes, savedFolder, RecipeSchema.parse({ processes: { web: { command: "x", port: "{port+10}" } } }), fixture), /^Error: Not saved: \{port\+10\} is past this Thread's 10 ports/)
  await assert.rejects(saveRecipe(recipes, savedFolder, RecipeSchema.parse({ processes: { web: { command: "x", cwd: "server" } } }), fixture), /Not saved: processes\.web\.cwd: server doesn't exist in this checkout/, "a recipe this checkout can't run isn't saved")
  assert.equal(existsSync(savedFile), false)
  const firstRecipe = RecipeSchema.parse({ processes: { web: { command: "node server.mjs", port: "{port}" } } })
  assert.deepEqual(await saveRecipe(recipes, savedFolder, firstRecipe, fixture), { file: savedFile }, "the first recipe replaces nothing")
  const fromSaved = await readRecipe(savedFolder, fixture, recipes)
  assert.equal(fromSaved.kind === "ready" && fromSaved.from, savedFile)
  assert.equal(fromSaved.kind === "ready" && fromSaved.ignored, undefined)
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
  const replaced = await saveRecipe(recipes, savedFolder, secondRecipe, fixture, new Date("2026-09-29T12:00:00.000Z"))
  assert.equal(replaced.previous, join(recipeHistory(savedFile), "2026-09-29T12-00-00-000Z.json"))
  assert.deepEqual(JSON.parse(readFileSync(replaced.previous!, "utf8")), firstRecipe, "the version it replaced is kept")
  assert.deepEqual(await saveRecipe(recipes, savedFolder, secondRecipe, fixture), { file: savedFile }, "saving the same recipe again keeps no copy")
  for (let index = 0; index < 22; index += 1)
    await saveRecipe(recipes, savedFolder, { ...secondRecipe, values: { RUN: String(index) } }, fixture, new Date(Date.UTC(2026, 8, 30, 0, 0, index)))
  assert.equal(readdirSync(recipeHistory(savedFile)).length, 20, "the last 20 versions are kept")
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
  assert.equal(alive(web!.pid), false)
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
  assert.match(threadEnvironmentInstructions(launched!), /If your change alters how the project installs, starts or is checked, update the recipe in the same turn with recipe_save\.$/, "every Session is told to keep the recipe current")
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
  const before = JSON.parse(await tools.status(conversation))
  assert.equal(before.recipe.state, "ready")
  assert.deepEqual(before.values, { PORT: String(toolBase), APP_URL: `http://${launched!.host}:${toolBase}`, API_URL: `http://${launched!.host}:${toolBase + 1}` })
  assert.deepEqual(before.processes.map((entry: { name: string; state: string }) => [entry.name, entry.state]), [["web", "stopped"], ["api", "stopped"]])

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
  assert.match(await tools.check(conversation, "quick"), /The quick check \(.*\) passed\.\nquick ok/)
  assert.match(await tools.check(conversation, "full"), /The full check \(node check\.mjs\) passed\.\napp answered on \d+/)
  const checked = JSON.parse(await tools.status(conversation))
  assert.deepEqual(checked.checks.map((entry: { tier: string; result: string }) => [entry.tier, entry.result]), [["quick", "passed"], ["full", "passed"]])
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
  assert.deepEqual(listedTools.map((tool) => tool.name), ["app_status", "app_start", "app_stop", "app_restart", "app_logs", "app_probe", "app_own_packages", "app_check", "recipe_guide", "recipe_save", "port_holder"])
  for (const tool of listedTools) assert.match(tool.description ?? "", /^(Call|Run|Stop|Read|Prove|Replace|Who)\b/, `${tool.name} says when to use it first`)
  assert.match(listedTools.find((tool) => tool.name === "recipe_save")?.description ?? "", /in the same turn as any change of yours that alters how the project installs, starts or is checked/)
  assert.match(JSON.stringify(await agent.callTool({ name: "app_status", arguments: {} })), /running on port/)
  const probed = await agent.callTool({ name: "app_probe", arguments: {} })
  const probe = z.object({ running: z.boolean(), listening: z.array(z.object({ port: z.number(), note: z.string().optional() })) })
    .parse(JSON.parse(z.array(z.object({ text: z.string() })).parse(probed.content)[0]!.text))
  assert.equal(probe.running, true)
  assert.ok(probe.listening.some((entry) => entry.port === toolBase && !entry.note), "the probe sees the app's own port, inside this Thread's block")
  assert.match(JSON.stringify(await agent.callTool({ name: "recipe_guide", arguments: {} })), /Setting up this project's recipe/)
  const bothTargets = await agent.callTool({ name: "app_logs", arguments: { process: "web", check: "quick" } })
  assert.equal(bothTargets.isError, true, "logs names one process or one check")
  const refusedSave = await agent.callTool({ name: "recipe_save", arguments: { recipe: { processes: { web: { command: "npm run dev", port: "5173" } } } } })
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
  assert.equal(JSON.parse(await tools.status(conversation)).recipe.state, "broken")
  await assert.rejects(tools.start(conversation), /The project's recipe is broken, so nothing can start: \S+\/\.mako\/environment\.json: the file: Unrecognized key/)
  assert.equal(await portListening(toolBase), true)
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify(recipe, null, 2))
  assert.match(await tools.stop(conversation), /Stopped (web, api|api, web)/)
  assert.equal(await portListening(toolBase + 1), false)

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
  assert.match(await tools.status(conversation), /"state": "up to date"/)
  await tools.stop(conversation)
  writeFileSync(join(project, "package-lock.json"), "{\"v\": 2}\n")
  assert.match(await tools.status(conversation), /runs before the next start or check/)
  assert.match(await tools.check(conversation, "quick"), /passed/)
  assert.equal(count(), 2, "a changed lockfile catches up, before a quick check too")
  writeFileSync(join(project, "package-lock.json"), "{\"v\": 3}\n")
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify({ ...recipe, prepare: [{ command: "echo resolving; echo 'npm ERR! missing peer' >&2; exit 1", inputs: ["package-lock.json"] }] }))
  const failedPrepare = await tools.start(conversation)
  assert.match(failedPrepare, /Preparing this checkout failed \(crashed \(exit 1\)\), so nothing started\. It runs again on the next start\.\nLast lines of its log:\nresolving\nnpm ERR! missing peer/)
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
  assert.equal((await desk.view(bare)).kind === "setting-up" && (await desk.view(bare)).progress?.app, "failed")
  await deskTools.save(setupConversation, setupRecipe("node -e \"process.exit(1)\""))
  const coming = await appStepsDuring(deskTools.start(setupConversation))
  assert.match(coming.said, /web: running/)
  assert.ok(coming.seen.includes("running") && !coming.seen.includes("done"), `the app step ticks when app_start says the app is up, not when its port first answers (saw ${coming.seen.join(", ")})`)
  assert.deepEqual(await desk.view(bare), settingUp({ recipe: "done", app: "done", checks: "waiting" }), "its app coming up ticks the second")
  await deskTools.stop(setupConversation)
  assert.equal((await desk.view(bare)).kind === "setting-up" && (await desk.view(bare)).progress?.app, "done", "stopping the app again leaves that step ticked")
  await deskTools.check(setupConversation, "quick")
  assert.deepEqual(await desk.view(bare), settingUp({ recipe: "done", app: "done", checks: "failed" }), "a failing check shows as failed")
  await deskTools.save(setupConversation, setupRecipe("node -e \"process.exit(0)\""))
  await deskTools.check(setupConversation, "quick")
  assert.equal((await desk.view(bare)).kind, "ready", "its checks passing ends the setup")
  await deskTools.guide(setupConversation)
  assert.equal((await desk.view(bare)).kind, "setting-up", "reading the guide again, to change the recipe, sets it up again")
  setupWorking = false
  assert.equal((await desk.view(bare)).kind, "ready", "and its turn ending with a recipe saved ends that")
  setupWorking = true
  // An install stopped before it finished runs again on the next start instead of reading as failed.
  const install = `echo installed >> ${installs}`
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify({ ...recipe, prepare: [{ command: install, inputs: ["package-lock.json"] }] }))
  const interrupted = await processes.prepared(realpathSync(project))
  await processes.savePrepared(realpathSync(project), { done: interrupted.done, pending: { [install]: "stopped mid-way" } })
  const installsBefore = count()
  assert.deepEqual(await desk.start(project), { problems: [] })
  assert.equal(count(), installsBefore + 1)
  assert.equal((await desk.view(project)).kind === "ready" && (await desk.view(project)).phase, "running")
  await desk.stop(project)
  // An install that outlasts the wait: the start goes ahead by itself once it's done, unless the app is stopped first.
  const slowInstall = `sleep 1.5 && echo installed >> ${installs}`
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify({ ...recipe, prepare: [{ command: slowInstall, inputs: ["package-lock.json"] }] }))
  const brief = environmentTools({ cwd: () => project, environment, launchedWith: () => undefined, folder: deskFolder, processes, settleMs: 300 })
  const beforeSlow = count()
  assert.deepEqual(await brief.desk.start(project), { problems: [] })
  assert.equal((await brief.desk.view(project)).kind === "ready" && (await brief.desk.view(project)).phase, "preparing")
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
  const measured = JSON.parse(await roomTools.status(conversation))
  assert.match(measured.processes[0].memory, /^\d+ MB$/, "each running process's memory is measured")
  await roomTools.stop(conversation)
  const critical = environmentTools({ cwd: () => project, environment, launchedWith: () => undefined, processes, settleMs: settle, pressure: async () => "critical" })
  await processes.start(quietThread, [{ kind: "process", name: "busy", command: "sleep 300", cwd: root, env: process.env }])
  await processes.touch(quietThread)
  assert.match(await critical.start(conversation), /^Waiting in line for memory: this Mac is critically short of memory, with these apps running: \S+ \(\d+ MB, used 0 min ago\)\. Nothing has started yet; Mako starts it by itself once there's room/)
  assert.equal(await portListening(toolBase), false)
  assert.match(JSON.parse(await critical.status(conversation)).room.waitingInLine, /^since 0 min ago; it starts by itself once there's room$/)
  assert.equal(await critical.stop(conversation), "Nothing was running; the start waiting for memory was taken out of the line.")
  assert.equal(JSON.parse(await critical.status(conversation)).room.waitingInLine, undefined)

  // A start waiting in line goes ahead by itself once memory frees up.
  let short = true
  const lineTools = environmentTools({ cwd: () => project, environment, launchedWith: () => undefined, folder: deskFolder, processes, settleMs: settle, lineMs: 100, pressure: async () => short ? "critical" : "normal" })
  assert.match(await lineTools.start(conversation), /^Waiting in line for memory/)
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(await portListening(toolBase), false, "nothing starts while memory stays critical")
  assert.equal((await lineTools.desk.view(project)).kind === "ready" && (await lineTools.desk.view(project)).phase, "waiting")
  assert.deepEqual(await markHere(lineTools.desk), { state: "waiting", port: undefined }, "a start waiting in line is marked waiting")
  short = false
  const deadline = Date.now() + settle
  while (!(await portListening(toolBase)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(await portListening(toolBase), true, "the start went ahead once there was room")
  const startedView = await lineTools.desk.view(project)
  assert.ok(startedView.kind === "ready" && (startedView.phase === "running" || startedView.phase === "starting"))
  assert.equal(JSON.parse(await lineTools.status(conversation)).room.waitingInLine, undefined)
  await lineTools.stop(conversation)
  const criticalDesk = environmentTools({ cwd: () => undefined, environment, launchedWith: () => undefined, folder: deskFolder, processes, settleMs: settle, pressure: async () => "critical" }).desk
  assert.deepEqual(await criticalDesk.start(project), { problems: [] })
  const waitingView = await criticalDesk.view(project)
  assert.equal(waitingView.kind === "ready" && waitingView.phase, "waiting", "the desk shows the start waiting for memory")
  assert.equal(waitingView.kind === "ready" && waitingView.room?.apps, 1)
  assert.ok(waitingView.kind === "ready" && (waitingView.room?.bytes ?? 0) > 0)
  assert.deepEqual(await criticalDesk.makeRoom(project), { problems: [] })
  assert.equal((await processes.active()).some((entry) => entry.app === quietThread), false, "making room stops the other apps")
  assert.equal((await criticalDesk.view(project)).kind === "ready" && (await criticalDesk.view(project)).phase, "running", "and starts this one whatever the memory")
  await criticalDesk.stop(project)
  await processes.start(quietThread, [{ kind: "process", name: "busy", command: "sleep 300", cwd: root, env: process.env }])

  // After a long quiet an app stops by itself; its files and data stay.
  writeFileSync(join(records, quietThread, "used"), String(Date.now() - 7 * 60 * 60 * 1000))
  assert.deepEqual(await processes.stopIdle(6 * 60 * 60 * 1000), [quietThread])
  assert.deepEqual(await processes.active(), [])

  // Removing the Thread's worktree stops its app first and deletes its data after.
  const worktrees = new ThreadWorktreeService(join(root, "worktrees"), store, async () => [], async () => [], {
    stop: async (id) => { await processes.stop(id) },
    discard: async (id) => {
      await processes.discard(id)
      rmSync(environments.dataDir(id), { recursive: true, force: true })
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
  await saveRecipe(turnRecipes, project, RecipeSchema.parse({
    oneAtATime: true,
    processes: { web: { command: "node server.mjs", port: String(fixedPort), values: { PORT: String(fixedPort) } } },
    checks: { quick: "node -e \"console.log('quick ok')\"" },
  }), fixture)
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
  assert.match(await inMainTurn.check(neighbour, "quick"), /^The quick check .* passed\./, "a check without the app isn't held up")
  assert.deepEqual(await inMainTurn.desk.takeTurn(project), { problems: [] })
  assert.equal((await fetchJson(fixedPort)).cwd, realpathSync(project), "taking a turn stops the other copy and starts this one")
  assert.equal(JSON.parse(await inWorktreeTurn.status(conversation)).processes[0].state, "stopped")
  assert.match(await inWorktreeTurn.start(conversation), /^Only one copy of this project's app runs at a time on this Mac \(the recipe sets oneAtATime\), and \S+ has it running/)
  const held = await inWorktreeTurn.desk.view(prepared.cwd)
  assert.ok(held.kind === "ready" && held.elsewhere, "the other way round too")
  await inMainTurn.stop(neighbour)
  const free = await inWorktreeTurn.desk.view(prepared.cwd)
  assert.deepEqual(free.kind === "ready" && [free.phase, free.elsewhere], ["stopped", undefined], "once it stops, the turn is free")
  assert.match(await worktreeTools.start(conversation), /web: running/)
  // Saved from a worktree, the recipe reaches the main checkout and every other worktree at once.
  const saving = environmentTools({ cwd: () => prepared.cwd, environment, launchedWith: () => undefined, processes, recipesRoot: projectRecipes, settleMs: settle })
  const savedNote = await saving.save(conversation, RecipeSchema.parse({ ...recipe, values: { ...recipe.values, SAVED: "yes" }, carry: ["config.local.json"] }))
  assert.ok(savedNote.includes(`carry: nothing Git ignores in the main checkout (${realpathSync(project)}) matches config.local.json yet; files Git tracks come with every checkout anyway.`), "saving says what carry finds in the main checkout")
  assert.match(savedNote, /^Saved as this project's recipe in Mako, \S+project-recipes\/\S+\.json\. Every Thread of this project uses it from now on, on every branch; nothing needs committing or merging for that\.\nThis checkout also has/)
  assert.match(savedNote, /also has a committed \.mako\/environment\.json; Mako's saved recipe comes first/)
  assert.match(savedNote, /This Thread's processes are still running as they were started; app_restart runs them with this recipe\./)
  const sharedFile = await recipePath(projectRecipes, project)
  assert.equal(await recipePath(projectRecipes, prepared.path), sharedFile, "the main checkout and its worktrees share one saved recipe")
  const mainRead = await readRecipe(project, fixture, projectRecipes)
  assert.equal(mainRead.kind === "ready" && mainRead.recipe.values.SAVED, "yes")
  const savedStatus = JSON.parse(await saving.status(conversation))
  assert.equal(savedStatus.recipe.from, sharedFile)
  assert.equal(savedStatus.recipe.contents.values.SAVED, "yes", "status shows what the recipe says, to repair from")
  assert.match(savedStatus.recipe.ignored, /\.mako\/environment\.json: committed with the project, but the recipe saved in Mako comes first/)
  assert.equal(savedStatus.values.SAVED, "yes")
  assert.equal(savedStatus.credentials, undefined, "a recipe without secrets says nothing about them")

  // Credentials: never carried; listed under secrets, they reach a checkout only once the person allows them in Settings.
  appendFileSync(join(project, ".git", "info", "exclude"), ".env\n")
  writeFileSync(join(project, ".env"), "TOKEN=main\n")
  await assert.rejects(saving.save(conversation, RecipeSchema.parse({ ...recipe, carry: [".env"] })), /Not saved: \.env holds credentials by its name, so it goes under "secrets", not "carry"/)
  const withSecrets = RecipeSchema.parse({ ...recipe, values: { ...recipe.values, SAVED: "yes" }, secrets: [".env"] })
  assert.match(await saving.save(conversation, withSecrets), /These hold credentials: \.env\. A new checkout gets them only once the user allows it in Mako/)
  const settings = environmentTools({ cwd: () => prepared.cwd, environment, launchedWith: () => undefined, folder: deskFolder, processes, recipesRoot: projectRecipes, settleMs: settle }).desk
  const notYet = await settings.setup(prepared.cwd)
  assert.deepEqual(notYet.secrets, { patterns: [".env"], files: [".env"], allowed: false }, "Settings lists the files by name, found in the main checkout")
  assert.deepEqual(notYet.recipe.kind === "ready" && [notYet.recipe.source, notYet.recipe.file, notYet.recipe.earlier > 0], ["mako", sharedFile, true])
  assert.deepEqual(notYet.recipe.kind === "ready" && notYet.recipe.recipe.processes.map((entry) => [entry.name, entry.command, entry.port]), [["web", "node server.mjs", "{port}"], ["api", "node server.mjs", "{port+1}"]], "the recipe as written, placeholders and all")
  assert.equal((await settings.view(prepared.cwd)).kind === "ready" && (await settings.view(prepared.cwd)).credentialsWaiting, true, "the strip says credentials are waiting")
  assert.match(JSON.parse(await saving.status(conversation)).credentials, /hasn't allowed new checkouts to have them yet/)
  await saving.stop(conversation)
  assert.match(await saving.start(conversation), /web: running/)
  assert.equal(existsSync(join(prepared.path, ".env")), false, "a start before the person allows them goes without")
  const allowed = await settings.allowSecrets(prepared.cwd, true)
  assert.deepEqual(allowed.secrets && [allowed.secrets.allowed, allowed.secrets.allowedAt !== undefined], [true, true])
  assert.equal((await settings.view(prepared.cwd)).kind === "ready" && (await settings.view(prepared.cwd)).credentialsWaiting, undefined)
  assert.match(JSON.parse(await saving.status(conversation)).credentials, /^The user allows \.env, so new checkouts get them/)
  await saving.stop(conversation)
  assert.match(await saving.start(conversation), /web: running/)
  assert.equal(readFileSync(join(prepared.path, ".env"), "utf8"), "TOKEN=main\n", "a checkout made before they were allowed gets them at its next start")
  assert.equal(git(prepared.path, "status", "--porcelain"), "", "and Git still ignores them there")
  assert.equal((await settings.allowSecrets(prepared.cwd, false)).secrets?.allowed, false, "the person can take it back")
  assert.equal(existsSync((await recipePath(projectRecipes, project)).replace(/\.json$/, ".allowed.json")), false)
  await assert.rejects(settings.allowSecrets(bare, true), /names no credentials files/)
  const running = (await processes.status(AppKeySchema.parse(placed.thread))).map((entry) => entry.pid!)
  await worktrees.remove(prepared.path)
  assert.equal(existsSync(prepared.path), false)
  assert.ok(running.every((pid) => !alive(pid)), "its processes stopped")
  assert.equal(await portListening(toolBase), false)
  assert.equal(existsSync(inWorktree.dataDir), false, "its data folder is deleted")
  assert.equal(existsSync(join(records, placed.thread)), false, "and its records")
  store.close()

  console.log("thread processes: one app per folder, shared by the Threads in it, and the same app from the desk (its view, start, restart, checks, stop, output followed across runs, a look that claims nothing, broken and being set up, an install stopped mid-way run again, a long install starting the app by itself once done unless stopped, waiting in line for memory and making room); recipe checked and resolved, the project's recipe saved in Mako first and shared by its worktrees, the committed one otherwise, credentials refused in carry and copied from secrets only once allowed in Settings, install and catch-up only when inputs change, room made from quiet apps or the start waits in line and goes ahead by itself, idle apps stopped; one copy at a time (a fixed port, a start refused naming whose copy runs, the desk taking a turn); process trees started detached, adopted by another host, surviving the host that started them, stopped whole; busy ports named; the agent's tools ran the app and both checks; removing the worktree stopped the app and deleted its data")
} finally {
  for (const cleanup of cleanups) await cleanup().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
