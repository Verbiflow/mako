import { z } from "zod"
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beginTrace, capped, openBy, probeApp, probeText, refreshTraces, systemPortsFrom, writingOutside, type ProbeInput } from "../electron/app-probe.js"
import type { AppProbeView } from "../electron/contracts/thread-app.js"
import { AppKeySchema } from "../electron/contracts/thread-environments.js"
import { portListening } from "../electron/thread-environment.js"
import { ThreadProcesses } from "../electron/thread-processes.js"
import { childHistory } from "../electron/watch-backend.js"

/**
 * The probe against a real app in a home of its own: the ports it listens
 * on, inside the Thread's block and outside it, the service it connects
 * to, files it holds open for writing outside its checkout, processes it
 * left outside its tree (and one in the checkout that isn't its), a change
 * deep in a folder it keeps state in, read from the file system's history
 * and missed by modification times, a container seen only through what it
 * holds open there, a read-only database's -wal, who had files open where,
 * what it registered with macOS, before and after it does, and the report
 * once it stopped, which ends at the stop.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-app-probe-")))
const records = join(root, "records")
const checkout = join(root, "checkout")
const home = join(root, "home")
const support = join(home, "Library", "Application Support")
const deep = join(support, "probe-app", "deep", "a", "b")
const cache = join(home, "Library", "Caches", "probe-cache")
const agents = join(home, "Library", "LaunchAgents")
const handlers = join(home, "Library", "Preferences", "com.apple.LaunchServices")
const container = join(home, "Library", "Containers", "com.example.sandboxed")
const bundle = join(root, "Probe.app")
for (const folder of [checkout, deep, join(support, "other-app"), cache, agents, handlers, join(bundle, "Contents", "MacOS")]) mkdirSync(folder, { recursive: true })
writeFileSync(join(deep, "state.json"), "{}")
// A database opened read-only: SQLite opens its -wal read-write anyway.
const readOnly = join(root, "read-only.db")
writeFileSync(readOnly, "")
writeFileSync(`${readOnly}-wal`, "")
const old = new Date(Date.now() - 3_600_000)
for (const path of [join(deep, "state.json"), deep, join(deep, ".."), join(deep, "..", ".."), join(support, "probe-app"), join(support, "other-app"), cache, agents, handlers])
  utimesSync(path, old, old)
const scheme = `makoprobe${process.pid}`
writeFileSync(join(bundle, "Contents", "Info.plist"), plist(`<key>CFBundleIdentifier</key><string>com.example.${scheme}</string><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>${scheme}</string></array></dict></array>`))
writeFileSync(join(bundle, "Contents", "MacOS", "probe"), "while :; do sleep 1; done\n")
const label = `com.mako.probe-test.${process.pid}`
const service = join(checkout, "service.sh")
writeFileSync(service, "#!/bin/sh\nexec sleep 300\n")
chmodSync(service, 0o755)
const shared = join(root, "shared.db")
const escaped = join(root, "escaped.pid")
const marked = join(root, "marked.pid")
const decoy = join(root, "decoy.pid")
const go = join(root, "register")
const release = join(root, "release")
const socket = `/tmp/mako-probe-${process.pid}.sock`
const stranger = `/tmp/mako-probe-stranger-${process.pid}`

function plist(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>\n`
}

const listener = createServer((socket) => socket.on("error", () => {}))
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
const PortAddress = z.object({ port: z.number().int().positive() })
const servicePort = PortAddress.parse(listener.address()).port

async function free(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = PortAddress.parse(server.address())
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
const port = await free()
const outside = await free()

const app = join(root, "app.cjs")
const settings = {
  port, outside, servicePort, shared, inside: join(checkout, "inside.log"), deep, cache: join(cache, "blob"), escaped, marked, bundle, go, release, root, socket, container: join(container, "Data"), readOnly,
  agent: join(agents, `${label}.agent.plist`),
  agentPlist: plist(`<key>Label</key><string>${label}.agent</string><key>ProgramArguments</key><array><string>${service}</string></array>`),
  handlers: join(handlers, "com.apple.launchservices.secure.plist"),
  handlersPlist: plist(`<key>LSHandlers</key><array><dict><key>LSHandlerURLScheme</key><string>${scheme}</string><key>LSHandlerRoleAll</key><string>com.example.${scheme}</string></dict></array>`),
  label, service,
}
writeFileSync(app, `
const fs = require("node:fs"), net = require("node:net"), { spawn, execFileSync } = require("node:child_process")
const s = JSON.parse(process.argv[2])
net.createServer().listen(s.port, "127.0.0.1")
net.createServer().listen(s.outside, "127.0.0.1")
net.connect(s.servicePort, "127.0.0.1").on("error", () => {})
net.createServer().listen(s.socket)
fs.openSync(s.shared, "a")
fs.openSync(s.inside, "a")
fs.writeFileSync(s.deep + "/state.json", '{"changed":true}')
fs.openSync(s.deep + "/held.log", "a")
fs.mkdirSync(s.container, { recursive: true })
fs.openSync(s.container + "/state.sqlite", "a")
fs.writeFileSync(s.container + "/closed.txt", "written and closed")
fs.openSync(s.readOnly, "r")
fs.openSync(s.readOnly + "-wal", "r+")
const blob = fs.openSync(s.cache, "w")
const away = (script, file, cwd) => spawn(process.execPath, ["-e", "const c = require('node:child_process').spawn(" + script + ", { detached: true, stdio: 'ignore', cwd: " + JSON.stringify(cwd) + " }); require('node:fs').writeFileSync(process.argv[1], String(c.pid)); c.unref()", file], { detached: true, stdio: "ignore" }).unref()
away("'sleep', ['60']", s.escaped, process.cwd())
away("process.execPath, ['-e', 'setInterval(() => {}, 1000)']", s.marked, s.root)
spawn("/bin/sh", [s.bundle + "/Contents/MacOS/probe"], { stdio: "ignore" })
let registered = false, released = false
setInterval(() => {
  if (!released && fs.existsSync(s.release)) { fs.closeSync(blob); released = true }
  if (registered || !fs.existsSync(s.go)) return
  registered = true
  fs.writeFileSync(s.agent, s.agentPlist)
  fs.writeFileSync(s.handlers, s.handlersPlist)
  execFileSync("launchctl", ["submit", "-l", s.label, "--", s.service])
}, 100)
`)

async function until<T>(what: string, read: () => Promise<T | undefined> | T | undefined, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const found = await read()
    if (found !== undefined) return found
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

const pidIn = (file: string) => Number(readFileSync(file, { encoding: "utf8", flag: "a+" })) || undefined

const history = childHistory()
const processes = new ThreadProcesses({ root: records, listening: portListening, cameUp: (folder, at) => beginTrace(folder, at, history, home) })
const key = AppKeySchema.parse("folder-0123456789abcdef")
const started: number[] = []
try {
  const run = await processes.start(key, [{ kind: "process", name: "web", command: ["node", app, JSON.stringify(settings)].map((part) => JSON.stringify(part)).join(" "), cwd: checkout, env: process.env, port }])
  assert.deepEqual(run.started, ["web"])
  const [status] = await processes.settle(key, ["process-web"], 15_000, 300)
  assert.equal(status?.state.kind, "running", readFileSync(status!.log, "utf8"))
  const leftover = await until("the app's escaped sleep", () => pidIn(escaped))
  const sure = await until("the app's escaped node", () => pidIn(marked))
  started.push(leftover, sure)

  // Someone else's process in the checkout, left behind the same way but without the app's mark.
  const env = { ...process.env }
  delete env.MAKO_APP_RUN
  spawn(process.execPath, ["-e", "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); require('node:fs').writeFileSync(process.argv[1], String(c.pid)); c.unref()", decoy], { cwd: checkout, env, detached: true, stdio: "ignore" }).unref()
  started.push(await until("the decoy", () => pidIn(decoy)))
  writeFileSync(join(support, "other-app", "x.json"), "{}")
  mkdirSync(join(support, "other-app", "x", "y"), { recursive: true })
  writeFileSync(join(support, "other-app", "x", "y", "z.txt"), "not the app")
  writeFileSync(stranger, "another program's scratch")

  const running = await processes.footprint(key, [checkout])
  assert.ok(running.pids.length > 0)
  assert.ok(!running.pids.includes(leftover), "the escaped process is outside the run's tree")
  const leftovers = new Map(running.leftovers.map((entry) => [entry.pid, entry]))
  assert.equal(leftovers.get(sure)?.sure, true, `a process carrying the app's mark counts wherever it works: ${JSON.stringify(running.leftovers)}`)
  assert.equal(leftovers.get(leftover)?.sure, false, "sleep's environment can't be read, so it counts by working in the checkout")
  assert.match(leftovers.get(leftover)!.command, /sleep 60/)
  assert.ok(!leftovers.has(started[2]!), "a process in the checkout whose environment shows no mark isn't the app's")
  assert.ok(running.since !== undefined && running.since <= Date.now())
  assert.ok(running.commands.some((command) => command.includes(join(bundle, "Contents", "MacOS", "probe"))), JSON.stringify(running.commands))

  const open = await openBy(running.pids)
  assert.deepEqual(open.listening.map((entry) => entry.port).sort((a, b) => a - b), [port, outside].sort((a, b) => a - b))
  assert.ok(open.connected.some((entry) => entry.port === servicePort && entry.local), JSON.stringify(open.connected))
  assert.ok(open.files.some((file) => file.path === `${readOnly}-wal`), "lsof shows the -wal")
  assert.deepEqual((await writingOutside(open, [checkout, records, home])).map((entry) => entry.path), [shared], "a -wal beside a database held read-only counts as read")

  const owner = await processes.portOwner(servicePort)
  assert.match(processes.ownerName(owner!, key), /which Mako didn't start/)
  assert.match(processes.ownerName((await processes.portOwner(port))!, key), /^this Thread: its process web/)

  // Mako looks while the app holds a cache file open; the app then closes it.
  await refreshTraces([{ folder: running.folder, pids: running.pids }], { history, home })
  writeFileSync(release, "")
  await until("the cache file to close", async () => ((await openBy(running.pids)).files.some((file) => file.path === join(cache, "blob")) ? undefined : true))

  const inputFor = async (more: Partial<ProbeInput> = {}): Promise<ProbeInput> => {
    const now = await processes.footprint(key, [checkout])
    const input: ProbeInput = {
      folder: now.folder,
      pids: now.pids,
      commands: now.commands,
      leftovers: now.leftovers,
      own: [checkout, now.records],
      skip: [checkout, now.records],
      ports: { first: port, last: port + 9 },
      owner: async (at) => {
        const found = await processes.portOwner(at)
        return found ? processes.ownerName(found, key) : "nothing listening now"
      },
      history,
      home,
      ...more,
    }
    if (now.since !== undefined) input.since = now.since
    return input
  }
  const folder = (view: AppProbeView, path: string) => view.changed.entries.find((entry) => entry.folder === path)
  const began = performance.now()
  const view = await until("the history to show the deep writes", async () => {
    const found = await probeApp(await inputFor())
    const entry = folder(found, join(support, "probe-app"))
    return entry?.paths.includes(join("deep", "a", "b", "state.json")) && folder(found, cache)?.paths.includes("blob") &&
      folder(found, join("/private", socket)) ? found : undefined
  })
  console.log(`probe with history: ${Math.round(performance.now() - began)} ms until the deep writes showed`)
  assert.equal(view.changedBy, "history")
  assert.ok(view.running)
  const state = folder(view, join(support, "probe-app"))!
  assert.ok(state.paths.includes(join("deep", "a", "b", "held.log")), JSON.stringify(state))
  assert.match(state.who, /^pid \d+ \(node\) has deep\/a\/b\/held\.log open for writing now\.$/, state.who)
  assert.match(folder(view, cache)!.who, /^pid \d+ \(node\) had blob open for writing when Mako looked at .+\.$/, folder(view, cache)!.who)
  const other = folder(view, join(support, "other-app"))
  assert.ok(other?.paths.includes(join("x", "y", "z.txt")), JSON.stringify(other))
  assert.match(other!.who, /what changed it is unknown/)
  assert.match(folder(view, join("/private", socket))!.who, new RegExp(`^pid \\d+ \\(node\\) has mako-probe-${process.pid}\\.sock open now\\.$`), "the app's socket in /tmp is named by the process bound to it")
  assert.ok(!folder(view, join("/private", stranger)), "another program's file in /tmp is left out")
  assert.match(view.notes.join("\n"), /other entr(y|ies) in \/private\/tmp changed since the app came up and (is|are) left out/)
  assert.ok(!view.changed.entries.some((entry) => entry.folder.startsWith(checkout) || entry.folder.startsWith(records)))
  const sandboxed = folder(view, container)
  assert.deepEqual(sandboxed?.paths, [join("Data", "state.sqlite")], `a container counts only from what the app holds open for writing there: ${JSON.stringify(sandboxed)}`)
  assert.match(sandboxed!.who, /^pid \d+ \(node\) has Data\/state\.sqlite open for writing now\.$/)
  assert.match(view.notes.join("\n"), /Library\/Containers and ~\/Library\/Group Containers, where macOS keeps sandboxed apps' data, only files the app held open for writing/)
  assert.deepEqual(new Set(view.writing.entries.map((entry) => entry.path)), new Set([shared, join(deep, "held.log"), join(container, "Data", "state.sqlite")]))
  assert.ok(view.connectsTo.some((entry) => entry.port === servicePort))
  assert.deepEqual(new Set(view.leftovers.map((entry) => entry.pid)), new Set([leftover, sure]))

  const none = view.registered.filter((entry) => entry.kind !== "url-scheme" && entry.kind !== "login-item")
  assert.deepEqual(none, [], "nothing is registered before the app registers anything")
  const declared = view.registered.find((entry) => entry.kind === "url-scheme")
  assert.equal(declared?.name, `${scheme}:`)
  assert.match(declared!.detail, new RegExp(`^Declared by ${bundle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, which the app runs\\. `))
  const text = probeText(view)
  assert.match(text, /changedFolders:/)
  assert.match(text, /held\.log/)

  // Without the history the same moment reads by modification times, which miss the change deep in an untouched folder.
  const untraced = await inputFor({ folder: join(root, "untraced") })
  delete untraced.history
  const timed = await probeApp(untraced)
  assert.equal(timed.changedBy, "times")
  assert.ok(!folder(timed, join(support, "probe-app")), "a write three levels down leaves the folder's times as they were")
  assert.ok(folder(timed, join(support, "other-app")), "a new entry directly in a folder shows by its time")
  assert.match(timed.notes.join("\n"), /modification times/)

  writeFileSync(go, "")
  await until("the app's registrations", () => (existsSync(settings.agent) && existsSync(settings.handlers) ? true : undefined))
  await until("the launchd service", () => {
    try {
      execFileSync("launchctl", ["print", `gui/${process.getuid!()}/${label}`], { stdio: "ignore" })
      return true
    } catch {
      return undefined
    }
  })
  const after = await probeApp(await inputFor())
  const named = (name: string) => after.registered.find((entry) => entry.name === name)
  assert.equal(named(label)?.kind, "service", JSON.stringify(after.registered))
  assert.match(named(label)!.detail, /^Loaded into launchd while the app ran; it runs .*service\.sh\. It points into this app's checkout/)
  assert.equal(named(`${label}.agent`)?.kind, "launch-agent")
  assert.match(named(`${label}.agent`)!.detail, /launchd loads it at the next login\. It points into this app's checkout/)
  assert.ok(after.registered.some((entry) => entry.kind === "url-scheme" && entry.name === `${scheme}:`))
  const handler = after.registered.find((entry) => entry.kind === "url-handler")
  assert.equal(handler?.name, `${scheme}:`)
  assert.match(handler!.detail, new RegExp(`^Links now open in com\\.example\\.${scheme}; it was set while the app ran\\.$`))
  assert.match(probeText(after), new RegExp(`${label}\\.agent: .*\\n.*${scheme}: Links now open in `))

  await processes.stop(key)
  const stopped = await processes.footprint(key, [checkout])
  assert.deepEqual(stopped.pids, [])
  assert.deepEqual(new Set(stopped.leftovers.map((entry) => entry.pid)), new Set([leftover, sure]), "the stop leaves the escaped processes, and the probe still finds them")
  assert.equal(stopped.since, running.since)

  // As app_stop does once nothing runs: the trace is closed, so what other programs do after the stop isn't the app's.
  await refreshTraces([{ folder: stopped.folder, pids: [], ended: true }], { history, home })
  mkdirSync(join(support, "after-stop"))
  writeFileSync(join(support, "after-stop", "late.json"), "{}")
  writeFileSync(join(agents, `${label}.late.plist`), plist(`<key>Label</key><string>${label}.late</string><key>ProgramArguments</key><array><string>/usr/bin/true</string></array>`))
  const down = await probeApp(await inputFor())
  assert.equal(down.running, false)
  assert.ok(down.stoppedAt !== undefined && down.stoppedAt >= running.since! && down.stoppedAt <= Date.now())
  assert.equal(down.changedBy, "history", "the history was read up to the stop")
  assert.ok(folder(down, join(support, "probe-app"))?.paths.includes(join("deep", "a", "b", "state.json")), "what changed while it ran still shows")
  assert.ok(!folder(down, join(support, "after-stop")), "a folder changed after the stop doesn't")
  assert.ok(down.registered.some((entry) => entry.name === `${label}.agent`), "an agent written while it ran still shows")
  assert.ok(!down.registered.some((entry) => entry.name === `${label}.late`), "one written after the stop doesn't")
  assert.match(down.notes[0]!, /^The app stopped .+, when Mako saw nothing of it running; changedFolders and registered cover only while it ran/)
  assert.match(probeText(down), /stoppedAt: /)
  const again = await probeApp(await inputFor())
  assert.deepEqual([again.stoppedAt, again.changed.entries.map((entry) => entry.folder)], [down.stoppedAt, down.changed.entries.map((entry) => entry.folder)], "a closed trace stays as it was")

  const picked = await systemPortsFrom()
  assert.ok(picked > 1024 && outside >= picked, "a port the system picked counts as one, so it isn't called fixed")
  assert.deepEqual(capped([1, 2, 3]), { entries: [1, 2, 3] })
  assert.equal(capped(Array.from({ length: 45 }, (_, index) => index)).more, 5)
  console.log("app probe: ports, a local service, a shared file but not a read-only database's -wal, leftovers by mark and by folder but not a stranger's, deep changes from history that times miss, a container only from what's held open there, who had files open now and earlier, registrations before and after, and a stopped app's report ending at its stop")
} finally {
  try { execFileSync("launchctl", ["remove", label], { stdio: "ignore" }) } catch { /* never registered */ }
  for (const pid of started) try { process.kill(pid, "SIGKILL") } catch { /* already gone */ }
  await processes.stop(key).catch(() => [])
  listener.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(socket, { force: true })
  rmSync(stranger, { force: true })
}
