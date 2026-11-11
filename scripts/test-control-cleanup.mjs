import assert from "node:assert/strict"
import { constants } from "node:fs"
import { readFile } from "node:fs/promises"
import { stripTypeScriptTypes } from "node:module"
import { EventEmitter } from "node:events"
import { pathToFileURL } from "node:url"
import * as path from "node:path"
import { SourceTextModule, SyntheticModule, createContext } from "node:vm"

const startupOnly = process.argv.includes("--startup-only")
const sourceAt = process.argv.indexOf("--source")
const sources = sourceAt < 0 ? new URL("../packages/control-runtime/src/", import.meta.url) : pathToFileURL(path.resolve(process.argv[sourceAt + 1]) + path.sep)

// Actual runtime modules, with only filesystem/OS/IPC boundaries replaced.
// No real temp listing, socket connection, worker, or cleanup runs here.
async function fixture(options = {}) {
  let serial = 1
  const nodes = new Map()
  const handles = { opened: 0, closed: 0 }
  const reads = [], mutations = [], probes = [], pids = []
  const put = (name, type, mode, uid = 501) => {
    const node = { type, mode, uid, dev: 1, ino: serial++, nlink: 1 }
    nodes.set(name, node)
    return node
  }
  const root = "/tmp/" + (options.name ?? (options.legacy ? "mako-cli-ABC123" : "mako-cli-999999-ABC123"))
  put("/own", "directory", 0o700)
  put(root, "directory", options.mode ?? 0o700, options.uid ?? 501)
  put(root + "/session", options.sessionType ?? "directory", 0o700)
  put(root + "/session/session.json", "file", 0o600)
  put(root + "/session/session.sock", "socket", 0o600)
  put(root + "/mako-control", "file", 0o700)
  if (options.extra) put(root + "/unknown", "file", 0o600)
  options.setup?.({ nodes, root, put })
  const stat = (name) => {
    const node = nodes.get(name)
    if (!node) throw Object.assign(new Error("missing fixture entry"), { code: "ENOENT" })
    return { ...node, nlink: node.type === "directory" ? 2 + [...nodes].filter(([key, value]) => path.dirname(key) === name && value.type === "directory").length : node.nlink, isDirectory: () => node.type === "directory", isFile: () => node.type === "file", isSocket: () => node.type === "socket", isSymbolicLink: () => node.type === "link" }
  }
  const fs = {
    lstat: async (name) => { reads.push(["lstat", name]); options.onStat?.(name, nodes); return stat(name) },
    open: async (name, flags) => {
      reads.push(["open", name])
      assert.ok(flags & constants.O_NOFOLLOW)
      assert.ok(flags & constants.O_DIRECTORY)
      if (options.openFails) throw new Error("unsupported no-follow open")
      const info = stat(name)
      if (!info.isDirectory()) throw new Error("not a no-follow directory")
      handles.opened++
      return { stat: async () => info, close: async () => { handles.closed++ } }
    },
    readdir: async (name) => {
      reads.push(["readdir", name])
      options.onRead?.(name, nodes)
      // A vulnerable path-based read follows the synthetic nested link.
      return [...nodes.keys()].filter((key) => path.dirname(key) === name).map((key) => path.basename(key))
    },
    unlink: async (name) => { mutations.push(["unlink", name]); if (mutations.length === options.unlinkFailsAt) throw new Error("fixture unlink failure"); nodes.delete(name) },
    rmdir: async (name) => {
      mutations.push(["rmdir", name])
      if (nodes.get(name)?.type === "link") throw new Error("ENOTDIR")
      if ([...nodes.keys()].some((key) => path.dirname(key) === name)) throw new Error("ENOTEMPTY")
      nodes.delete(name)
    },
    mkdtemp: async (prefix) => { const name = prefix + "DEF456"; mutations.push(["mkdtemp", name]); put(name, "directory", 0o700); return name },
    mkdir: async (name) => { mutations.push(["mkdir", name]); put(name, "directory", 0o700) },
    chmod: async (name, mode) => { nodes.get(name).mode = mode },
    rename: async (from, to) => { nodes.set(to, nodes.get(from)); nodes.delete(from) },
    writeFile: async (name, _value, config) => { mutations.push(["writeFile", name]); put(name, "file", config.mode) },
    rm: async (name) => { mutations.push(["rm", name]); for (const key of nodes.keys()) if (key === name || key.startsWith(name + "/")) nodes.delete(key) },
  }
  const net = {
    createConnection: (name) => {
      probes.push(name)
      const socket = new EventEmitter()
      socket.destroy = () => {}
      queueMicrotask(() => options.unused || options.socketCode ? socket.emit("error", { code: options.socketCode ?? "ECONNREFUSED" }) : socket.emit("connect"))
      return socket
    },
    createServer: () => {
      const server = new EventEmitter()
      server.listen = (name, ready) => { put(name, "socket", 0o600); ready() }
      server.close = (done) => done?.()
      return server
    },
  }
  const context = createContext({ Buffer, URL, setTimeout, clearTimeout, setImmediate, queueMicrotask, console, Date: class extends Date { static now() { return 0 } }, process: {
    pid: 42, getuid: () => 501, execPath: "/fixture/node", env: {}, kill: (pid) => { pids.push(pid); if (!options.live && !(options.liveAfterFirst && pids.length > 1)) throw Object.assign(new Error("absent"), { code: options.killCode ?? "ESRCH" }) },
  } })
  // Use this realm's Error for processAbsent's instanceof check.
  context.Error = Error
  const external = {
    "node:fs/promises": fs, "node:fs": { constants }, "node:os": { tmpdir: () => "/own" }, "node:path": path,
    "node:url": { fileURLToPath: (url) => url.pathname }, "node:crypto": { randomUUID: () => "fixture-session" },
    "node:net": net, "./processes.js": { fork: () => { throw new Error("fixture must not start a worker") } },
    "@mako/control/control": { ControlFault: Error },
    "./control-session-protocol.js": { controlSessionBuild: async () => "fixture-build", CONTROL_SESSION_PROTOCOL: 1 },
    "./desktop-session-config.js": { DesktopWorkerReplySchema: {} },
    "./control-session-client.js": { invokeControlSession: () => { throw new Error("fixture must not dispatch") } },
    "./control-session-server.js": { refuseControlConnection: () => { throw new Error("fixture must not receive clients") } },
  }
  const cache = new Map()
  async function load(name) {
    if (cache.has(name)) return cache.get(name)
    let module
    if (external[name]) {
      const values = external[name]
      module = new SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value) }, { context })
    } else {
      assert.ok(["./launch-folders.js", "./private-socket.js", "./control-workers.js", "./desktop-session.js"].includes(name), name)
      const url = new URL(name.slice(2).replace(/\.js$/, ".ts"), sources)
      const source = stripTypeScriptTypes(await readFile(url, "utf8"))
      module = new SourceTextModule(source, { context, identifier: name, initializeImportMeta(meta) { meta.url = url.href } })
    }
    cache.set(name, module)
    await module.link(load)
    return module
  }
  async function api(name) { const m = await load(name); if (m.status !== "evaluated") await m.evaluate(); return m.namespace }
  return { root, nodes, reads, mutations, probes, pids, put, api, handles }
}

const rows = []
async function sweep(label, options, check) {
  const f = await fixture(options)
  const { sweepAbandonedLaunches } = await f.api("./launch-folders.js")
  await sweepAbandonedLaunches()
  check(f)
  assert.equal(f.handles.opened, f.handles.closed, "every successful no-follow open is closed")
  rows.push({ label, mutations: f.mutations, reads: f.reads, pids: f.pids, probes: f.probes })
}
const none = (f) => assert.deepEqual(f.mutations, [])

// Preserve the seven reviewer scenarios, with a faithful type-aware fake FS.
if (!startupOnly) {
await sweep("legitimate dead-PID launch", {}, (f) => assert.equal(f.mutations.length, 5))
for (const [label, options] of [["live PID", { live: true }], ["wrong UID", { uid: 502 }], ["wrong mode", { mode: 0o755 }], ["extra entry", { extra: true }], ["legacy live socket", { legacy: true }]]) await sweep(label, options, none)
await sweep("nested session link must not delete its target", { sessionType: "link" }, none)
await sweep("unknown launch name", { name: "mako-cli-0-ABC123" }, none)
await sweep("legacy without a socket", { legacy: true, setup: ({ nodes, root }) => nodes.delete(root + "/session/session.sock") }, none)
await sweep("empty dead-PID launch", { setup: ({ nodes, root }) => { for (const key of nodes.keys()) if (key.startsWith(root + "/")) nodes.delete(key) } }, (f) => assert.equal(f.mutations.length, 1))

for (const [label, target, patch] of [
  ["root link", "", { type: "link" }],
  ["session file", "/session", { type: "file" }],
  ["session wrong UID", "/session", { uid: 502 }],
  ["session wrong mode", "/session", { mode: 0o755 }],
  ["descriptor link", "/session/session.json", { type: "link" }],
  ["descriptor wrong UID", "/session/session.json", { uid: 502 }],
  ["descriptor wrong mode", "/session/session.json", { mode: 0o644 }],
  ["descriptor hard link", "/session/session.json", { nlink: 2 }],
  ["socket is regular file", "/session/session.sock", { type: "file" }],
  ["command link prevalidated before any deletion", "/mako-control", { type: "link" }],
  ["command wrong UID", "/mako-control", { uid: 502 }],
  ["command wrong mode", "/mako-control", { mode: 0o755 }],
]) await sweep(label, { setup: ({ nodes, root }) => Object.assign(nodes.get(root + target), patch) }, none)
await sweep("unknown nested entry", { setup: ({ put, root }) => put(root + "/session/foreign", "file", 0o600) }, none)
await sweep("unknown PID failure", { killCode: "EPERM" }, none)
await sweep("PID revived before mutation", { liveAfterFirst: true }, none)
await sweep("no no-follow support fails closed", { openFails: true }, none)
await sweep("legacy unknown socket error", { legacy: true, socketCode: "EACCES" }, none)
await sweep("legacy abandoned socket", { legacy: true, unused: true }, (f) => assert.equal(f.mutations.length, 5))
await sweep("root replaced during enumeration", { onRead: (name, nodes) => { if (name.endsWith("/session")) nodes.get(path.dirname(name)).ino++ } }, none)
await sweep("session replaced by link during enumeration", { onRead: (name, nodes) => { if (name.endsWith("/session")) Object.assign(nodes.get(name), { type: "link", ino: 999 }) } }, none)
let descriptorReads = 0
await sweep("file replaced before unlink", { onStat: (name, nodes) => { if (name.endsWith("/session.json") && ++descriptorReads === 2) nodes.get(name).ino++ } }, none)
await sweep("partial unlink failure stops without claiming rollback", { unlinkFailsAt: 2 }, (f) => {
  assert.equal(f.mutations.length, 2)
  assert.equal(f.nodes.has(f.root + "/session/session.json"), false)
  assert.equal(f.nodes.has(f.root + "/session/session.sock"), true)
  assert.equal(f.nodes.has(f.root + "/mako-control"), true)
})
await sweep("expected staging socket", { setup: ({ put, root }) => put(root + "/session/.ession.sock", "socket", 0o600) }, (f) => assert.equal(f.mutations.length, 6))
await sweep("bounded candidate checks", { setup: ({ put }) => { for (let n = 0; n < 140; n++) put(`/tmp/mako-cli-999999-${String(n).padStart(6, "0")}`, "directory", 0o700) } }, (f) => assert.equal(f.reads.filter(([op]) => op === "open").length, 129))
}

// Exercise actual ControlWorkers + startDesktopControlSession (no worker is
// taken until a client connects); do not mock their state or startup method.
for (const pooled of startupOnly ? [true] : [false, true]) {
  const f = await fixture()
  const { startDesktopControlSession } = await f.api("./desktop-session.js")
  const { ControlWorkers } = await f.api("./control-workers.js")
  const cleanup = { scope: "owned", root: "/own" }
  const workers = pooled ? new ControlWorkers({ spare: false, cleanup }) : undefined
  if (pooled) cleanup.root = "/foreign" // A caller cannot retarget an already configured pool.
  const owner = await startDesktopControlSession({ taskId: "owned-cleanup" }, workers ? { workers } : { cleanup })
  assert.equal(owner.pid, undefined)
  assert.ok(owner.launch.bin.startsWith("/own/"))
  assert.equal(f.nodes.get(owner.launch.sessionFile).mode, 0o600)
  assert.equal(f.reads.some(([op]) => op === "readdir"), false, "owned startup must not start either global sweep")
  assert.deepEqual(f.probes, [])
  assert.deepEqual(f.pids, [])
  await owner.close()
  await workers?.close()
  assert.equal(f.nodes.has(owner.launch.bin), false)
  assert.ok(f.mutations.every(([, name]) => name.startsWith("/own/")), "all startup and close mutations stay owned")
  assert.equal(f.handles.opened, f.handles.closed)
  rows.push({ label: pooled ? "actual pool owned startup and close" : "actual standalone owned startup and close" })
}
{
  const f = await fixture()
  const { ControlWorkers } = await f.api("./control-workers.js")
  const pool = new ControlWorkers({ spare: false })
  assert.equal(pool.cleanup.scope, "same-user-global")
  pool.sweepAbandonedLaunches()
  pool.sweepAbandonedLaunches()
  await new Promise(setImmediate)
  assert.equal(f.reads.filter(([op, name]) => op === "readdir" && name === "/tmp").length, 1)
  assert.equal(f.mutations.length, 5)
  await pool.close()
  assert.equal(f.handles.opened, f.handles.closed)
  rows.push({ label: "normal default global cleanup remains once per actual pool" })
}
{
  const f = await fixture()
  const sockets = await f.api("./private-socket.js")
  const long = "/owned/" + "x".repeat(120)
  f.put(long, "directory", 0o700)
  const cleanup = { scope: "owned", root: long }
  await assert.rejects(sockets.createControlDirectory("mako-cli-42-", cleanup), /too long/)
  await assert.rejects(sockets.createPrivateControlSocket(long, "session.sock", cleanup), /short owned root/)
  await assert.rejects(sockets.createPrivateControlSocket("/foreign", "session.sock", { scope: "owned", root: "/own" }), /inside/)
  assert.deepEqual(f.mutations, [])
  assert.deepEqual(f.probes, [])
  assert.ok(f.reads.every(([, name]) => name === long), "long owned paths never list/probe/fall back to global /tmp")
  rows.push({ label: "owned long and foreign socket paths refuse without global fallback" })
}
{
  const f = await fixture()
  const root = "/owned/" + "x".repeat(120)
  f.put(root, "directory", 0o700)
  const { ControlWorkers } = await f.api("./control-workers.js")
  const { startDesktopControlSession } = await f.api("./desktop-session.js")
  const pool = new ControlWorkers({ cleanup: { scope: "owned", root } })
  await assert.rejects(startDesktopControlSession({ taskId: "long-owned" }, { workers: pool }), /too long/)
  await pool.close()
  assert.deepEqual(f.mutations, [])
  assert.deepEqual(f.probes, [])
  assert.deepEqual(f.pids, [])
  assert.ok(f.reads.every(([, name]) => name === root))
  assert.equal(f.handles.opened, f.handles.closed)
  rows.push({ label: "actual pool long-root startup refuses before any global read or fallback" })
}
for (const patch of [{ type: "link" }, { uid: 502 }, { mode: 0o755 }]) {
  const f = await fixture()
  Object.assign(f.nodes.get("/own"), patch)
  const { createControlDirectory } = await f.api("./private-socket.js")
  await assert.rejects(createControlDirectory("mako-cli-42-", { scope: "owned", root: "/own" }))
  assert.deepEqual(f.mutations, [])
  rows.push({ label: "unverified owned root refuses", patch })
}

console.log(JSON.stringify({ passed: rows.length, rows }, null, 2))
