import assert from "node:assert/strict"
import { constants } from "node:fs"
import { readFile } from "node:fs/promises"
import { stripTypeScriptTypes } from "node:module"
import { EventEmitter } from "node:events"
import { pathToFileURL } from "node:url"
import * as path from "node:path"
import { SourceTextModule, SyntheticModule, createContext } from "node:vm"
import { finishControlFixture } from "./lib/packaged-control-cleanup.mjs"

const startupOnly = process.argv.includes("--startup-only")
const sourceAt = process.argv.indexOf("--source")
const sources = sourceAt < 0 ? new URL("../packages/control-runtime/src/", import.meta.url) : pathToFileURL(path.resolve(process.argv[sourceAt + 1]) + path.sep)

/** Construct/cache modules only in the linker. Node links the entire graph once from this root, including cycles. */
function fixtureGraph(context, entries, construct) {
  const cache = new Map()
  const load = (name) => {
    if (!cache.has(name)) cache.set(name, Promise.resolve().then(() => construct(name)))
    return cache.get(name)
  }
  const root = new SourceTextModule(entries.map((name) => `import ${JSON.stringify(name)}`).join("\n"), { context })
  let ready
  return async (name) => {
    await (ready ??= root.link(load).then(() => root.evaluate()))
    const module = await load(name)
    assert.equal(module.status, "evaluated", "only modules in this coherent root graph are exposed")
    return module.namespace
  }
}

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
      queueMicrotask(() => {
        options.onProbe?.(name, nodes)
        if (options.silentSocket) return
        if (options.unused || options.socketCode) socket.emit("error", { code: options.socketCode ?? "ECONNREFUSED" })
        else socket.emit("connect")
      })
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
  const entries = ["./launch-folders.js", "./private-socket.js", "./control-workers.js", "./desktop-session.js"]
  const api = fixtureGraph(context, entries, async (name) => {
    let module
    if (external[name]) {
      const values = external[name]
      module = new SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value) }, { context })
    } else {
      assert.ok(entries.includes(name), name)
      const url = new URL(name.slice(2).replace(/\.js$/, ".ts"), sources)
      const source = stripTypeScriptTypes(await readFile(url, "utf8"))
      module = new SourceTextModule(source, { context, identifier: name, initializeImportMeta(meta) { meta.url = url.href } })
    }
    return module
  })
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

// Delayed construction, shared dependencies and cycles are deterministic, not
// repetitions hoping to avoid the old recursive-link race.
for (const { order, delayed, cyclic } of [
  { order: ["entry", "left", "right"], delayed: "shared", cyclic: true },
  { order: ["right", "entry", "left"], delayed: "left", cyclic: true },
  { order: ["left", "right", "entry"], delayed: "right", cyclic: false },
]) {
  let release, entered
  const gate = new Promise((resolve) => { release = resolve })
  const constructing = new Promise((resolve) => { entered = resolve })
  const built = new Map()
  const context = createContext({ evaluations: 0 })
  const code = {
    entry: 'import {left} from "left"; import {right} from "right"; export function value(){return left()+right()}',
    left: 'import {read,token} from "shared"; export const label=5; export {token}; export function left(){return read()}',
    right: 'import {read,token} from "shared"; export {token}; export function right(){return read()+1}',
    shared: (cyclic ? 'import {label} from "left";' : 'const label=5;') + 'globalThis.evaluations++; export const token={}; export function read(){return label}',
  }
  const graph = fixtureGraph(context, order, async (name) => {
    built.set(name, (built.get(name) ?? 0) + 1)
    if (name === delayed) { entered(); await gate }
    return new SourceTextModule(code[name], { context, identifier: name })
  })
  let timer
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("deterministic fixture graph did not link")), 3000) })
  try {
    const loading = Promise.all([graph("entry"), graph("left"), graph("right")])
    await Promise.race([constructing, loading, deadline])
    release()
    const [entry, left, right] = await Promise.race([loading, deadline])
    assert.equal(entry.value(), 11)
    assert.equal(left.token, right.token, "shared dependency has one identity across the graph")
    assert.equal((await graph("shared")).token, left.token)
    assert.equal(context.evaluations, 1)
    assert.equal(built.size, 4)
    assert.ok([...built.values()].every((count) => count === 1))
    rows.push({ label: "one coherent delayed/shared/cyclic graph", order, delayed, cyclic })
  } finally {
    clearTimeout(timer)
  }
}

// Execute the actual fixture's declarations/start/catch/finally. Only its
// positive-test body and external resource boundaries are synthetic here.
const packagedFixture = await readFile(new URL("./test-packaged-control-cli.mjs", import.meta.url), "utf8")
const declarations = packagedFixture.indexOf("  let owner\n")
const bodyAt = packagedFixture.indexOf("    const adapter =", declarations)
const catchAt = packagedFixture.indexOf("  } catch (error) {", bodyAt)
assert.ok(declarations >= 0 && bodyAt > declarations && catchAt > bodyAt)
const fixtureCode = packagedFixture.slice(declarations, bodyAt) + "    await body(owner)\n" + packagedFixture.slice(catchAt, packagedFixture.lastIndexOf("\n}"))
const executeFixture = new (async () => {}).constructor("runtime", "workers", "source", "rm", "finishControlFixture", "body", "process", fixtureCode)
async function teardownCase(options = {}) {
  const calls = [], reports = [], logs = []
  const owner = {
    exited: options.exit ?? Promise.resolve("stopped"),
    close: () => { calls.push("owner-close"); return options.ownerClose?.() },
  }
  const workers = { close: () => { calls.push("workers-close"); return options.workersClose?.() } }
  let threw = false, thrown
  try {
    await executeFixture(
      { startDesktopControlSession: async () => { if (options.startFailed) throw options.primary; return owner } }, workers, "/synthetic/owned-root",
      async () => { calls.push("root-remove"); return options.remove?.() },
      (input) => finishControlFixture({ ...input, timeoutMs: 5, report: (result) => { reports.push(result); return input.report(result) } }),
      async () => { if (options.primaryFailed) throw options.primary },
      { stderr: { write: (text) => { logs.push(text); if (options.writerFailed) throw options.writerError } } }
    )
  } catch (error) {
    threw = true
    thrown = error
  }
  return { calls, reports, logs, threw, thrown }
}
let primaryFormatting = 0
const opaquePrimary = Object.freeze({ toString() { primaryFormatting++; throw new Error("must not format primary") } })
for (const [primaryKind, primary] of [["Error", new Error("primary fixture error")], ["null", null], ["undefined", undefined], ["zero", 0], ["false", false], ["empty string", ""], ["Symbol", Symbol("fixture primary")], ["opaque object", opaquePrimary]]) {
  const ownerError = new Error("owner close failed")
  const result = await teardownCase({ primaryFailed: true, primary, ownerClose: async () => { throw ownerError }, workersClose: async () => { throw 0 } })
  assert.equal(result.threw, true)
  assert.ok(Object.is(result.thrown, primary), "the exact primary rejection survives every cleanup failure")
  assert.deepEqual(result.calls, ["owner-close", "workers-close"])
  const report = result.reports[0]
  assert.equal(report.root, "retained")
  assert.equal(report.terminationKnown, true)
  assert.deepEqual(report.failures.map(({ stage }) => stage), ["owner-close", "workers-close"])
  assert.equal(report.failures[0].error, ownerError)
  assert.equal(report.failures[1].error, 0)
  assert.ok(!result.logs.join("").includes("owner close failed"), "fixed cleanup summary never formats resource error values")
  rows.push({ label: "actual fixture exact primary plus ordered independent cleanup failures", primaryKind })
}
assert.equal(primaryFormatting, 0)
{
  const result = await teardownCase({ ownerClose: async () => { throw undefined }, workersClose: async () => { throw null } })
  assert.ok(result.thrown instanceof AggregateError)
  assert.deepEqual(result.thrown.errors, [undefined, null])
  assert.deepEqual(result.calls, ["owner-close", "workers-close"])
  rows.push({ label: "cleanup-only failures are visible in resource order, even undefined/null" })
}
{
  let formatted = 0
  const fault = { get message() { formatted++; throw new Error("must not read resource error") }, toString() { formatted++; throw new Error("must not format resource error") } }
  const result = await teardownCase({ ownerClose: async () => { throw fault } })
  assert.ok(result.thrown instanceof AggregateError)
  assert.equal(result.thrown.errors[0], fault)
  assert.equal(result.reports[0].failures[0].error, fault)
  assert.equal(formatted, 0)
  rows.push({ label: "opaque cleanup error is retained without message access or coercion" })
}
for (const reason of ["stopped", "failed"]) {
  const result = await teardownCase({ exit: Promise.resolve(reason) })
  assert.equal(result.threw, false)
  assert.deepEqual(result.calls, ["owner-close", "workers-close", "root-remove"])
  assert.equal(result.reports[0].root, "removed")
  assert.deepEqual(result.reports[0].failures, [])
  rows.push({ label: "known original owner termination permits root cleanup", reason })
}
{
  const primary = new Error("original body failure")
  const result = await teardownCase({ primaryFailed: true, primary })
  assert.equal(result.thrown, primary)
  assert.equal(result.reports[0].root, "removed")
  assert.deepEqual(result.reports[0].failures, [])
  rows.push({ label: "primary error remains exact when all cleanup succeeds" })
}
{
  const fault = new Error("pool close failed")
  const result = await teardownCase({ workersClose: async () => { throw fault } })
  assert.ok(result.thrown instanceof AggregateError)
  assert.equal(result.thrown.errors[0], fault)
  assert.equal(result.reports[0].root, "retained")
  assert.ok(!result.calls.includes("root-remove"))
  rows.push({ label: "pool close failure alone retains root despite known owner exit" })
}
for (const pending of ["ownerClose", "workersClose", "exit"]) {
  let release
  const late = new Promise((resolve) => { release = resolve })
  const result = await teardownCase(pending === "exit" ? { exit: late } : { [pending]: () => late })
  assert.ok(result.thrown instanceof AggregateError)
  assert.equal(result.reports[0].root, "retained")
  assert.equal(result.reports[0].failures[0].kind, "timeout")
  assert.ok(result.calls.includes("workers-close"), "a pending owner close does not skip independent pool cleanup")
  assert.ok(!result.calls.includes("root-remove"))
  release("stopped")
  await new Promise(setImmediate)
  assert.ok(!result.calls.includes("root-remove"), "late settlement never schedules a later root deletion")
  rows.push({ label: "bounded pending cleanup retains root even after late settlement", pending })
}
for (const value of [undefined, 0, "unknown"]) {
  const result = await teardownCase({ exit: Promise.resolve(value) })
  assert.ok(result.thrown instanceof AggregateError)
  assert.equal(result.reports[0].terminationKnown, false)
  assert.equal(result.reports[0].root, "retained")
  assert.ok(!result.calls.includes("root-remove"), "a close acknowledgement without owner termination grants no deletion")
  rows.push({ label: "unknown exit is not a cleanup acknowledgement" })
}
{
  const result = await teardownCase({ exit: Promise.reject(null) })
  assert.ok(result.thrown instanceof AggregateError)
  assert.deepEqual(result.thrown.errors, [null])
  assert.equal(result.reports[0].root, "retained")
  assert.equal(result.reports[0].terminationKnown, false)
  rows.push({ label: "rejected owner exit preserves null failure and no termination acknowledgement" })
}
{
  const result = await teardownCase({ startFailed: true, primary: undefined })
  assert.equal(result.threw, true)
  assert.equal(result.thrown, undefined)
  assert.deepEqual(result.calls, ["workers-close"])
  assert.equal(result.reports[0].root, "retained")
  rows.push({ label: "failed startup without returned owner preserves undefined primary and retains unconfirmed context" })
}
{
  const fault = new Error("root removal failed")
  const result = await teardownCase({ remove: async () => { throw fault } })
  assert.ok(result.thrown instanceof AggregateError)
  assert.equal(result.thrown.errors[0], fault)
  assert.equal(result.reports[0].root, "removal-unconfirmed")
  rows.push({ label: "failed removal is unconfirmed, never a fake cleanup success" })
}
{
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const result = await teardownCase({ remove: () => pending })
  assert.ok(result.thrown instanceof AggregateError)
  assert.equal(result.reports[0].root, "removal-unconfirmed")
  assert.equal(result.reports[0].failures[0].kind, "timeout")
  assert.equal(result.calls.filter((call) => call === "root-remove").length, 1)
  release()
  await new Promise(setImmediate)
  assert.equal(result.reports[0].root, "removal-unconfirmed", "a late operation never rewrites the returned cleanup acknowledgement")
  assert.equal(result.calls.filter((call) => call === "root-remove").length, 1)
  rows.push({ label: "pending root removal remains explicitly unconfirmed, with no retry" })
}
{
  const writer = new Error("summary writer failed")
  const result = await teardownCase({ primaryFailed: true, primary: null, ownerClose: async () => { throw 0 }, writerFailed: true, writerError: writer })
  assert.equal(result.threw, true)
  assert.equal(result.thrown, null)
  assert.deepEqual(result.reports[0].failures.map(({ stage }) => stage), ["owner-close", "cleanup-report"])
  assert.equal(result.reports[0].failures[1].error, writer)
  rows.push({ label: "cleanup reporting failure cannot replace the exact primary" })
}

if (!startupOnly) {
// The supported pre-PID fixture binds a raw Unix socket without chmod. Model
// bind's permission bits under several umasks; never bind or probe a real socket.
const legacySocket = (mode) => ({ nodes, root }) => {
  nodes.delete(root + "/session/session.json")
  nodes.delete(root + "/mako-control")
  nodes.get(root + "/session/session.sock").mode = mode
}
for (const mask of [0o000, 0o022, 0o077, 0o177, 0o777]) {
  const mode = 0o777 & ~mask
  await sweep(`legacy raw socket, umask ${mask.toString(8)}`, { legacy: true, unused: true, setup: legacySocket(mode) }, (f) => {
    assert.equal(f.nodes.has(f.root), false, "a verified private legacy root with a dead raw socket remains sweepable")
    assert.equal(f.mutations.length, 3)
    assert.deepEqual(f.probes, [f.root + "/session/session.sock"])
  })
}
for (const [label, options] of [
  ["PID socket still needs exact private mode", { unused: true, setup: legacySocket(0o755) }],
  ["legacy live default-mode socket", { legacy: true, setup: legacySocket(0o755) }],
  ["legacy inaccessible default-mode socket", { legacy: true, socketCode: "EACCES", setup: legacySocket(0o755) }],
  ["legacy silent default-mode socket", { legacy: true, silentSocket: true, setup: legacySocket(0o755) }],
  ["legacy default-mode socket in public root", { legacy: true, unused: true, mode: 0o755, setup: legacySocket(0o755) }],
  ["legacy default-mode socket in foreign root", { legacy: true, unused: true, uid: 502, setup: legacySocket(0o755) }],
  ...[
    ["session wrong mode", "/session", { mode: 0o755 }],
    ["session wrong UID", "/session", { uid: 502 }],
    ["session link", "/session", { type: "link" }],
    ["root link", "", { type: "link" }],
    ["socket wrong UID", "/session/session.sock", { uid: 502 }],
    ["socket link", "/session/session.sock", { type: "link" }],
    ["socket regular file", "/session/session.sock", { type: "file" }],
    ["socket special mode bits", "/session/session.sock", { mode: 0o1755 }],
    ["socket setgid bit", "/session/session.sock", { mode: 0o2755 }],
    ["socket setuid bit", "/session/session.sock", { mode: 0o4755 }],
  ].map(([label, suffix, patch]) => [`legacy default-mode ${label}`, { legacy: true, unused: true, setup: (f) => { legacySocket(0o755)(f); Object.assign(f.nodes.get(f.root + suffix), patch) } }]),
  ["legacy staging socket still needs exact private mode", { legacy: true, unused: true, setup: (f) => { legacySocket(0o755)(f); f.put(f.root + "/session/.ession.sock", "socket", 0o755) } }],
  ["legacy descriptor still needs exact private mode", { legacy: true, unused: true, setup: (f) => { legacySocket(0o755)(f); f.put(f.root + "/session/session.json", "file", 0o644) } }],
  ["legacy command still needs exact private mode", { legacy: true, unused: true, setup: (f) => { legacySocket(0o755)(f); f.put(f.root + "/mako-control", "file", 0o755) } }],
  ["legacy unknown entry keeps whole root", { legacy: true, unused: true, extra: true, setup: legacySocket(0o755) }],
]) await sweep(label, options, none)
for (const [label, suffix, patch] of [
  ["root replaced after refusal", "", { ino: 999 }],
  ["session linked after refusal", "/session", { ino: 999, type: "link" }],
  ["socket replaced after refusal", "/session/session.sock", { ino: 999 }],
  ["socket UID changed after refusal", "/session/session.sock", { uid: 502 }],
  ["socket mode changed after refusal", "/session/session.sock", { mode: 0o777 }],
]) await sweep(`legacy ${label}`, { legacy: true, unused: true, setup: legacySocket(0o755), onProbe: (name, nodes) => Object.assign(nodes.get(path.dirname(path.dirname(name)) + suffix), patch) }, none)
}

console.log(JSON.stringify({ passed: rows.length, rows }, null, 2))
