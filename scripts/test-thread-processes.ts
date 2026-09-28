import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { z } from "zod"
import { ThreadIdSchema, type Actor } from "../electron/contracts/thread-identity.js"
import type { ThreadEnvironment } from "../electron/contracts/thread-environments.js"
import { startConversationMcp } from "../electron/conversation-mcp.js"
import { environmentTools } from "../electron/environment-tools.js"
import { applyThreadEnvironment, portListening, ThreadEnvironments, threadEnvironmentInstructions } from "../electron/thread-environment.js"
import { ThreadProcesses } from "../electron/thread-processes.js"
import { readRecipe, recipeValues, RECIPE_PATH } from "../electron/thread-recipe.js"
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
  const result = await processes.start(ThreadIdSchema.parse(thread), [{ kind: "process", name: "api", command: `node ${server}`, cwd: tmpdir(), env, port: Number(port) }])
  assert.deepEqual(result.started, ["api"])
  process.exit(0)
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-thread-processes-")))
const records = join(root, "thread-environments")
const title = new Map<string, string>()
const host = () => new ThreadProcesses({ root: records, listening: portListening, title: (thread) => title.get(thread) })
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
  const fixture: ThreadEnvironment = { thread: ThreadIdSchema.parse(randomUUID()), host: "fix-login.thread.localhost", port: 41_000, ports: 10, dataDir: join(root, "data", "fixture") }
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
  await invalid(JSON.stringify({ values: { MAKO_THREAD_PORT: "1" } }), /MAKO_ names are Mako's own/)
  await invalid(JSON.stringify({ processes: { web: { command: "x", port: "3000" } } }), /a process's port is \{port\} or \{port\+N\}/)
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
  const thread = ThreadIdSchema.parse(randomUUID())
  const other = ThreadIdSchema.parse(randomUUID())
  title.set(thread, "Fix login")
  title.set(other, "Tidy settings")
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
  assert.match(refused.refused[0]!.reason, new RegExp(`Port ${base} belongs to the Thread "Fix login": its process web \\(pid \\d+\\)`))
  const owner = await processes.portOwner(base)
  assert.equal(owner?.thread, thread)
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
  assert.match(threadEnvironmentInstructions(launched!), /The project's recipe also sets PORT=\d+, APP_URL=http:\/\/\S+, API_URL=\S+ in your shell\. Its processes \(web on \d+, api on \d+\) run through the environment_start/)
  cleanups.push(() => processes.discard(placed.thread))
  const tools = environmentTools({
    cwd: (id) => id === conversation ? project : undefined,
    environment,
    launchedWith: () => undefined,
    processes,
    settleMs: settle,
  })
  const before = JSON.parse(await tools.status(conversation))
  assert.equal(before.recipe.state, "ready")
  assert.deepEqual(before.values, { PORT: String(toolBase), APP_URL: `http://${launched!.host}:${toolBase}`, API_URL: `http://${launched!.host}:${toolBase + 1}` })
  assert.deepEqual(before.processes.map((entry: { name: string; state: string }) => [entry.name, entry.state]), [["web", "stopped"], ["api", "stopped"]])

  const started = await tools.start(conversation)
  assert.match(started, new RegExp(`web: running on port ${toolBase}\\napi: running on port ${toolBase + 1}\\nApp: http://${launched!.host}:${toolBase}`))
  const apiBody = await fetchJson(toolBase + 1)
  assert.equal(apiBody.home, join(root, "thread-data", placed.thread, "home"), "a process-only HOME points into the Thread's data folder")
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
  const connect = async (id: string) => {
    const grant = grants.mint("binding", id)
    const client = new Client({ name: "agent", version: "1" })
    await client.connect(new StreamableHTTPClientTransport(new URL(grant.controlUrl), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }))
    return client
  }
  const agent = await connect(conversation)
  const listed = (await agent.listTools()).tools.map((tool) => tool.name)
  assert.deepEqual(listed.filter((name) => name.startsWith("environment_")), ["environment_status", "environment_start", "environment_stop", "environment_restart", "environment_logs", "environment_check", "environment_port"])
  assert.match(JSON.stringify(await agent.callTool({ name: "environment_status", arguments: {} })), /running on port/)
  const both = await agent.callTool({ name: "environment_logs", arguments: { process: "web", check: "quick" } })
  assert.equal(both.isError, true, "logs names one process or one check")
  await agent.close()
  const stranger = await connect(randomUUID())
  const refusedStatus = await stranger.callTool({ name: "environment_status", arguments: {} })
  assert.equal(refusedStatus.isError, true, "another conversation's token reaches only its own Thread")
  await stranger.close()

  // A broken recipe is loud, and the running app is left as it is.
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify({ ...recipe, extra: 1 }))
  assert.equal(JSON.parse(await tools.status(conversation)).recipe.state, "broken")
  await assert.rejects(tools.start(conversation), /The project's recipe is broken, so nothing can start: \.mako\/environment\.json: the file: Unrecognized key/)
  assert.equal(await portListening(toolBase), true)
  writeFileSync(join(project, RECIPE_PATH), JSON.stringify(recipe, null, 2))
  assert.match(await tools.stop(conversation), /Stopped (web, api|api, web)/)
  assert.equal(await portListening(toolBase + 1), false)

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
  const running = (await processes.status(placed.thread)).map((entry) => entry.pid!)
  await worktrees.remove(prepared.path)
  assert.equal(existsSync(prepared.path), false)
  assert.ok(running.every((pid) => !alive(pid)), "its processes stopped")
  assert.equal(await portListening(toolBase), false)
  assert.equal(existsSync(inWorktree.dataDir), false, "its data folder is deleted")
  assert.equal(existsSync(join(records, placed.thread)), false, "and its records")
  store.close()

  console.log("thread processes: recipe checked and resolved; process trees started detached, adopted by another host, surviving the host that started them, stopped whole; busy ports named; the agent's tools ran the app and both checks; removing the worktree stopped the app and deleted its data")
} finally {
  for (const cleanup of cleanups) await cleanup().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
