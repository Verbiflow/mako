/**
 * A real agent sets a project up through Mako's own setup flow, in a packaged
 * Mako on an isolated profile, and this watches it: the agent's tool calls,
 * the recipe store's versions and the app's processes.
 *
 *   node scripts/real-setup-run.mjs <web|desktop> <claude|codex> [Mako.app]
 *
 * The project is a small fixture that collides across copies: a fixed port
 * and a fixed data folder (and, for desktop, a fixed Electron userData and a
 * single-instance lock). Its "home" is a folder in the run's own root, so
 * nothing is written in the real home.
 *
 * While it runs, the run's root takes two files: `reply.txt` is sent to the
 * agent as the user's next message, and `stop` ends the run. The run also
 * ends by itself 20 minutes after the agent's last turn began without a
 * reply, or once the agent finished and `stop` exists.
 */
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import WebSocket from "ws"
import { threadDebugPort } from "./thread-debug-port.mjs"

const sourceFlag = process.argv.find((arg) => arg.startsWith("--source="))
const [kind, harness, appArg] = process.argv.slice(2).filter((arg) => arg !== sourceFlag)
assert.ok(kind === "web" || kind === "desktop", "kind is web or desktop")
assert.ok(harness === "claude" || harness === "codex", "harness is claude or codex")
/** A built checkout of Mako, run with its own Electron as a production host would, in place of the packaged app. */
const source = sourceFlag ? resolve(sourceFlag.slice("--source=".length)) : undefined
const app = source ?? resolve(appArg ?? "/Users/kashyab/.mako/thread-data/folder-f6c41fc142b185e0/pkg-oct3/mac-arm64/Mako.app")
const MAIN_CHECKOUT_ELECTRON = "/Users/kashyab/makomono/mako/node_modules/electron"
const TURN_LIMIT_MS = 20 * 60_000
/** Blocks the user's real Threads could take; the copy's Threads get one above them. */
const SEEDED_FIRST = 20_000
const SEEDED_LAST = 30_990

const root = await mkdtemp(join(tmpdir(), `mako-setup-run-${kind}-`))
const profile = join(root, "profile")
const home = join(root, "home")
const events = join(root, "events.ndjson")
const project = join(root, kind === "web" ? "tally" : "deskcount")
const started = Date.now()
const report = { kind, harness, app, root, project, startedAt: new Date(started).toISOString(), tools: [], recipeFiles: [], notes: [] }

function log(event, detail = {}) {
  const line = { at: new Date().toISOString(), sinceStartMs: Date.now() - started, event, ...detail }
  console.log(JSON.stringify(line))
  return appendFile(events, `${JSON.stringify(line)}\n`)
}

function sh(command, args, cwd, env) {
  return execFileSync(command, args, { cwd, env: env ?? process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

async function files(dir, entries) {
  for (const [path, text] of Object.entries(entries)) {
    await mkdir(join(dir, path, ".."), { recursive: true })
    await writeFile(join(dir, path), text)
  }
}

function commit(dir) {
  sh("git", ["init", "-q", "-b", "main"], dir)
  sh("git", ["add", "-A"], dir)
  sh("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "Initial commit"], dir)
}

/** The 2026-09-30 tally project: port 4310 and a visit counter in `<home>/.tally`. */
async function webFixture() {
  await files(project, {
    "package.json": `${JSON.stringify({ name: "tally", private: true, type: "module", scripts: { start: "node server.js", test: "node --test" } }, null, 2)}\n`,
    "home.js": `// The user's home folder, where tally keeps its data.\nexport const home = ${JSON.stringify(home)}\n`,
    "render.js": "export function render(count) {\n  const noun = count === 1 ? \"visit\" : \"visits\"\n  return `<!doctype html><title>Tally</title><h1>${count} ${noun}</h1>`\n}\n",
    "server.js": `import { createServer } from "node:http"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { home } from "./home.js"
import { render } from "./render.js"

const dataDir = join(home, ".tally")
const file = join(dataDir, "visits.json")
mkdirSync(dataDir, { recursive: true })

function read() {
  try {
    return JSON.parse(readFileSync(file, "utf8")).count
  } catch {
    return 0
  }
}

createServer((request, response) => {
  if (request.url !== "/") {
    response.writeHead(404).end()
    return
  }
  const count = read() + 1
  writeFileSync(file, JSON.stringify({ count }))
  response.writeHead(200, { "content-type": "text/html" }).end(render(count))
}).listen(4310, () => console.log("Tally on http://localhost:4310"))
`,
    "test/render.test.js": "import assert from \"node:assert/strict\"\nimport { test } from \"node:test\"\nimport { render } from \"../render.js\"\n\ntest(\"counts visits\", () => {\n  assert.match(render(1), /1 visit</)\n  assert.match(render(2), /2 visits</)\n})\n",
    "README.md": "# Tally\n\nCounts visits to its page.\n\n    npm start   # http://localhost:4310\n    npm test\n",
    ".gitignore": "node_modules\n",
  })
  commit(project)
}

/**
 * A desktop counter: `npm run web` serves its page on 4320 and keeps a count
 * in `<home>/.deskcount`; `npm start` opens an Electron window on that page
 * with a fixed userData folder and a single-instance lock. Electron comes
 * from a clone of the main checkout's, as a file dependency with nothing to
 * download.
 */
async function desktopFixture() {
  const vendor = join(root, "vendor", "electron")
  await mkdir(join(root, "vendor"), { recursive: true })
  sh("cp", ["-c", "-R", MAIN_CHECKOUT_ELECTRON, vendor])
  const manifest = JSON.parse(await readFile(join(vendor, "package.json"), "utf8"))
  delete manifest.dependencies
  delete manifest.scripts
  await writeFile(join(vendor, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  await files(project, {
    "package.json": `${JSON.stringify({
      name: "deskcount",
      private: true,
      main: "main.js",
      scripts: { start: "electron .", web: "node server.js", test: "node --test" },
      devDependencies: { electron: `file:${vendor}` },
    }, null, 2)}\n`,
    "home.js": `// The user's home folder, where deskcount keeps its data.\nexports.home = ${JSON.stringify(home)}\n`,
    "render.js": "exports.render = (count) => {\n  const noun = count === 1 ? \"visit\" : \"visits\"\n  return `<!doctype html><title>Deskcount</title><h1>${count} ${noun}</h1>`\n}\n",
    "server.js": `const { createServer } = require("node:http")
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs")
const { join } = require("node:path")
const { home } = require("./home.js")
const { render } = require("./render.js")

const dataDir = join(home, ".deskcount")
const file = join(dataDir, "visits.json")
mkdirSync(dataDir, { recursive: true })

function read() {
  try {
    return JSON.parse(readFileSync(file, "utf8")).count
  } catch {
    return 0
  }
}

createServer((request, response) => {
  if (request.url !== "/") {
    response.writeHead(404).end()
    return
  }
  const count = read() + 1
  writeFileSync(file, JSON.stringify({ count }))
  response.writeHead(200, { "content-type": "text/html" }).end(render(count))
}).listen(4320, () => console.log("Deskcount web on http://localhost:4320"))
`,
    "main.js": `const { app, BrowserWindow } = require("electron")
const { writeFileSync } = require("node:fs")
const { join } = require("node:path")
const { home } = require("./home.js")

// Keep the window's storage off the login keychain.
app.commandLine.appendSwitch("use-mock-keychain")
app.setPath("userData", join(home, "Library", "Application Support", "Deskcount"))

if (!app.requestSingleInstanceLock()) {
  console.log("Deskcount is already running")
  app.quit()
} else {
  app.whenReady().then(() => {
    const window = new BrowserWindow({ width: 420, height: 260, show: false })
    window.once("ready-to-show", () => window.showInactive())
    window.webContents.on("did-finish-load", () => {
      const opened = { title: window.getTitle(), at: new Date().toISOString() }
      writeFileSync(join(app.getPath("userData"), "last-opened.json"), JSON.stringify(opened))
      console.log(\`Deskcount window ready: "\${opened.title}" (data in \${app.getPath("userData")})\`)
    })
    window.webContents.on("did-fail-load", (_event, code, description) => console.log(\`Deskcount couldn't load its page: \${description} (\${code})\`))
    window.loadURL("http://127.0.0.1:4320/")
  })
  app.on("window-all-closed", () => app.quit())
}
`,
    "test/render.test.js": "const assert = require(\"node:assert/strict\")\nconst { test } = require(\"node:test\")\nconst { render } = require(\"../render.js\")\n\ntest(\"counts visits\", () => {\n  assert.match(render(1), /1 visit</)\n  assert.match(render(2), /2 visits</)\n})\n",
    "README.md": "# Deskcount\n\nA desktop window on a page that counts its visits.\n\n    npm install\n    npm run web   # serves http://localhost:4320\n    npm start     # opens the desktop window on that page; start the web server first\n    npm test\n",
    ".gitignore": "node_modules\n",
  })
  sh("npm", ["install", "--offline", "--no-audit", "--no-fund"], project)
  commit(project)
}

/** Any agent command that would make macOS ask for a permission on Mako's behalf fails instead. */
async function permissionShims() {
  const dir = join(root, "shims")
  await mkdir(dir, { recursive: true })
  for (const name of ["osascript", "screencapture"]) {
    await writeFile(join(dir, name), `#!/bin/sh\necho "${name} is unavailable in this run: it would ask for a macOS permission" >&2\nexit 1\n`)
    await chmod(join(dir, name), 0o755)
  }
  return dir
}

let child, socket, counter = 0
const callbacks = new Map()
function command(method, params = {}) {
  return new Promise((done, fail) => {
    const id = ++counter
    const timer = setTimeout(() => { callbacks.delete(id); fail(new Error(`Timed out: ${method}`)) }, 120_000)
    callbacks.set(id, (message) => {
      clearTimeout(timer)
      if (message.error) fail(new Error(JSON.stringify(message.error)))
      else done(message.result)
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const response = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails).slice(0, 2000))
  return response.result.value
}
const bridge = (name, args = []) => evaluate(`window.mako[${JSON.stringify(name)}](...${JSON.stringify(args)})`)
async function waitFor(read, label, timeout = 90_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (child?.exitCode !== null || child?.signalCode) throw new Error(`Mako exited during ${label}`)
    const value = await read().catch(() => undefined)
    if (value) return value
    await delay(250)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function startPackage(shims) {
  await rm(join(profile, "DevToolsActivePort"), { force: true })
  const env = { ...process.env, MAKO_BACKEND_URL: "http://127.0.0.1:9/api/mcp", MAKO_BACKEND_TOKEN: "", MAKO_STANDALONE: "1", MAKO_DATA_ROOT: profile, MAKO_CURSOR_SDK_ROOT: join(root, "cursor") }
  for (const key of Object.keys(env))
    if ((/^(MAKO_THREAD_|MAKO_CONTROL_|CLAUDE_|ELECTRON_)/.test(key) && key !== "CLAUDE_CONFIG_DIR") || ["VITE_DEV_SERVER_URL", "MAKO_WEB_SOCKET", "MAKO_HOST_ONLY", "MAKO_WEB_ONLY"].includes(key)) delete env[key]
  env.PATH = `${shims}:${env.PATH}`
  if (source) env.MAKO_PROD = "1"
  const port = await threadDebugPort()
  const executable = source
    ? join(source, "node_modules/electron/dist", (await readFile(join(source, "node_modules/electron/path.txt"), "utf8")).trim())
    : join(app, "Contents/MacOS/Mako")
  child = spawn(executable, [...(source ? [source] : []), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"], { cwd: project, env, detached: true, stdio: ["ignore", "ignore", "pipe"] })
  child.stderr.resume()
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === "page" && item.url.startsWith("mako-app:")), "renderer")
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, fail) => { socket.once("open", done); socket.once("error", fail) })
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString())
    if (message.id) { callbacks.get(message.id)?.(message); callbacks.delete(message.id) }
  })
  await waitFor(() => evaluate("Boolean(window.mako && document.querySelector('.composer-input'))"), "composer")
  return { pid: child.pid, debugPort: port }
}
async function stopPackage() {
  socket?.close()
  socket = undefined
  if (child && child.exitCode === null) {
    process.kill(-child.pid, "SIGTERM")
    await Promise.race([new Promise((done) => child.once("exit", done)), delay(8000)])
    try { process.kill(-child.pid, "SIGKILL") } catch { /* exited */ }
  }
  child = undefined
}

/** Every block the user's real Threads could hold is claimed in the copy's own store, so the copy's Threads take ports above them. */
function seedPorts() {
  const db = new DatabaseSync(join(profile, "threads.sqlite"))
  db.exec("PRAGMA busy_timeout = 5000")
  const device = db.prepare("SELECT value FROM store_meta WHERE key = 'device'").get().value
  const before = db.prepare("SELECT app, port FROM app_environments").all()
  db.exec("DELETE FROM app_environments")
  const insert = db.prepare("INSERT INTO app_environments VALUES (?, ?, ?, ?, ?, ?)")
  const now = Date.now()
  for (let port = SEEDED_FIRST; port <= SEEDED_LAST; port += 10)
    insert.run(`folder-${port.toString(16).padStart(16, "0")}`, device, `seed-${port}.thread.localhost`, port, now, now)
  db.close()
  return before
}

async function clickAt(selector) {
  const point = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
  assert.ok(point, `nothing at ${selector}`)
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await command("Input.dispatchMouseEvent", { type, button: "left", clickCount: type === "mouseMoved" ? 0 : 1, ...point })
}

async function recipeFiles() {
  const base = join(profile, "recipes")
  const found = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else found.push({ path: relative(base, path), mtimeMs: (await stat(path)).mtimeMs })
    }
  }
  await walk(base)
  return found
}

function summarizeTool(block) {
  const input = block.input === undefined ? undefined : JSON.stringify(block.input)
  return { id: block.id, name: block.name, title: block.title, toolKind: block.toolKind, status: block.status, input: input?.slice(0, 600) }
}

/** Every app the copy runs, the setup Thread's and any spare checkout's install, stopped through the copy. */
async function stopApps() {
  report.room = await bridge("threadAppRoom").catch((error) => ({ error: String(error) }))
  await log("room", { room: JSON.stringify(report.room).slice(0, 3000) })
  if (report.worktree) await bridge("stopThreadApp", [report.worktree]).catch((error) => log("stop-error", { error: String(error) }))
  const apps = (report.room?.apps ?? []).map((entry) => entry.app).filter(Boolean)
  if (apps.length) await bridge("stopThreadApps", [apps]).catch((error) => log("stop-error", { error: String(error) }))
  report.roomAfterStop = await bridge("threadAppRoom").catch((error) => ({ error: String(error) }))
}

async function realStoreMentions() {
  const hits = []
  for (const dir of [`${process.env.HOME}/.mako/recipes`, `${process.env.HOME}/.mako/thread-environments`]) {
    try { hits.push(...sh("grep", ["-rl", root, dir]).trim().split("\n").filter(Boolean)) } catch { /* grep exits 1 with no match */ }
  }
  return hits
}

try {
  await (kind === "web" ? webFixture() : desktopFixture())
  const shims = await permissionShims()
  await log("fixture", { project, home })
  await startPackage(shims)
  const permissions = await bridge("computerPermissions")
  await log("first-launch", { permissions })
  const prefs = await evaluate("localStorage.getItem('mako.prefs.v1')")
  await stopPackage()
  const claimedAtBoot = seedPorts()
  await log("ports-seeded", { claimedAtBoot, seeded: `${SEEDED_FIRST}-${SEEDED_LAST + 9}` })
  const launch = await startPackage(shims)
  await log("launched", launch)
  const stored = prefs ? JSON.parse(prefs) : {}
  stored.composerHarness = harness
  stored.providerModes = { ...stored.providerModes, claude: "bypassPermissions", codex: "access:full" }
  await evaluate(`localStorage.setItem('mako.prefs.v1', ${JSON.stringify(JSON.stringify(stored))}); location.reload(); true`).catch(() => {})
  await delay(1500)
  await waitFor(() => evaluate("Boolean(window.mako && document.querySelector('.composer-input'))"), "composer after reload")
  const control = await waitFor(() => evaluate(`(() => { const el = document.querySelector('[data-app-control]'); return el && el.getAttribute('data-app-control') === 'none' ? el.outerHTML.slice(0, 300) : null })()`), "the Not set up control")
  await log("control", { control })
  await clickAt('[data-app-control="none"]')
  const menu = await waitFor(() => evaluate(`(() => { const el = document.querySelector('[role="menu"] [data-app-action="set-up"]'); return el && el.innerText.replace(/\\s+/g, " ").trim() })()`), "the Set up menu")
  await log("menu", { row: menu, heading: await evaluate(`document.querySelector('[role="menu"]')?.innerText.replace(/\\s+/g, " ").slice(0, 300)`) })
  const clickedAt = Date.now()
  await clickAt('[role="menu"] [data-app-action="set-up"]')
  const conversationId = await waitFor(() => evaluate("document.querySelector('[data-live-conversation]')?.getAttribute('data-live-conversation')"), "the setup conversation", 60_000)
  report.conversationId = conversationId
  await log("setup-started", { conversationId, clickToConversationMs: Date.now() - clickedAt })

  const seen = new Map()
  const knownFiles = new Map()
  const requestsSeen = new Map()
  let lastTurnAt = Date.now()
  let finishedAt
  for (;;) {
    if (child?.exitCode !== null || child?.signalCode) throw new Error("Mako exited during the run")
    const snapshot = await bridge("liveSnapshot", [conversationId]).catch((error) => ({ error: String(error) }))
    if (snapshot && !snapshot.error) {
      report.worktree ??= snapshot.session?.cwd
      for (const block of snapshot.blocks ?? []) {
        if (block.type !== "tool") continue
        const summary = summarizeTool(block)
        const before = seen.get(block.id)
        if (!before) {
          const entry = { ...summary, firstSeenMs: Date.now() - clickedAt }
          seen.set(block.id, entry)
          report.tools.push(entry)
          await log("tool", entry)
        } else if (before.status !== summary.status) {
          before.status = summary.status
          before[`${summary.status}Ms`] = Date.now() - clickedAt
          await log("tool-status", { id: block.id, name: summary.name ?? summary.title, status: summary.status })
        }
      }
      for (const request of snapshot.requests ?? []) {
        if (requestsSeen.get(request.id) === request.status) continue
        requestsSeen.set(request.id, request.status)
        await log("request", { id: request.id, status: request.status, error: request.error })
      }
      if (snapshot.permissions?.length) await log("permission-waiting", { permissions: snapshot.permissions.map((item) => JSON.stringify(item).slice(0, 400)) })
      for (const key of ["questions", "humanInput"]) if (Array.isArray(snapshot[key]) && snapshot[key].length) await log("question-waiting", { key, value: JSON.stringify(snapshot[key]).slice(0, 2000) })
      const busy = (snapshot.requests ?? []).some((request) => !["completed", "failed", "interrupted", "uncertain"].includes(request.status))
      if (!busy && !finishedAt) {
        finishedAt = Date.now()
        const last = [...(snapshot.blocks ?? [])].reverse().find((block) => block.type === "text")
        await log("turn-finished", { sinceClickMs: finishedAt - clickedAt, lastText: last?.text?.slice(-4000) })
        await writeFile(join(root, `snapshot-${finishedAt}.json`), JSON.stringify(snapshot, null, 2))
      }
      if (busy) finishedAt = undefined
    }
    for (const file of await recipeFiles()) {
      if (knownFiles.get(file.path) === file.mtimeMs) continue
      knownFiles.set(file.path, file.mtimeMs)
      const text = await readFile(join(profile, "recipes", file.path), "utf8").catch(() => "")
      const entry = { path: file.path, sinceClickMs: Date.now() - clickedAt, text: text.slice(0, 6000) }
      report.recipeFiles.push(entry)
      await log("recipe-file", { path: file.path, sinceClickMs: entry.sinceClickMs })
    }
    if (existsSync(join(root, "reply.txt"))) {
      const text = (await readFile(join(root, "reply.txt"), "utf8")).trim()
      await rm(join(root, "reply.txt"))
      const id = crypto.randomUUID()
      await bridge("livePrompt", [conversationId, id, text, []])
      report.notes.push({ replied: text, sinceClickMs: Date.now() - clickedAt })
      lastTurnAt = Date.now()
      finishedAt = undefined
      await log("replied", { text })
    }
    if (existsSync(join(root, "stop")) && finishedAt) break
    if (Date.now() - lastTurnAt > TURN_LIMIT_MS && !existsSync(join(root, "hold"))) { await log("turn-limit"); break }
    await delay(1500)
  }

  await writeFile(join(root, "final-snapshot.json"), JSON.stringify(await bridge("liveSnapshot", [conversationId]), null, 2))
  await stopApps()
  report.realStoreMentions = await realStoreMentions()
  report.homeAfter = existsSync(home) ? sh("find", [home, "-maxdepth", "4"]).trim().split("\n") : []
  report.outcome = "finished"
} catch (error) {
  report.outcome = "failed"
  report.error = error instanceof Error ? error.stack : String(error)
  console.error(report.error)
  if (socket) await stopApps().catch(() => {})
  const shot = socket ? await command("Page.captureScreenshot", { format: "png" }).catch(() => null) : null
  if (shot) await writeFile(join(root, "failure.png"), Buffer.from(shot.data, "base64"))
} finally {
  await stopPackage()
  report.endedAt = new Date().toISOString()
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2))
  console.log(`Report: ${join(root, "report.json")}`)
}
