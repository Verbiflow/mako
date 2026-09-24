import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { setImmediate as tick } from "node:timers/promises"
import { build } from "esbuild"

// Exercise the production threads owner; hold only its external startup/transport boundaries.
const root = await mkdtemp(join(tmpdir(), "mako-catalog-readiness-"))
const deferred = () => Promise.withResolvers()
const state = {
  root,
  lineage: deferred(),
  workers: [],
  clients: [],
  catalogs: [],
  reads: [],
  events: [],
  scan: deferred(),
  prepare: Promise.resolve(),
  daemonEnabled: false,
  sharedEnabled: false,
  list: null,
}
globalThis.__catalogReadinessTest = state
class Client {
  events = new Set()
  closes = new Set()
  closed = false
  stats = { pid: process.pid }
  onEvent(fn) {
    this.events.add(fn)
    return () => this.events.delete(fn)
  }
  onClose(fn) {
    this.closes.add(fn)
    return () => this.closes.delete(fn)
  }
  async list(_filter, onSnapshot) {
    const refs = state.list ? await state.list.promise : []
    onSnapshot?.(refs)
    return refs
  }
  async refresh() { return this.stats }
  async page(path) {
    state.reads.push(path)
    return path === "missing"
      ? null
      : {
          ref: { harness: path, path, nativeId: path },
          entries: [],
          start: 0,
          total: 0,
          hasEarlier: false,
        }
  }
  async open(path) {
    return this.page(path)
  }
  async block(path) {
    state.reads.push(path)
    return { type: "text", text: path }
  }
  async follow(path) {
    state.reads.push(`follow:${path}`)
  }
  async unfollow(path) {
    state.reads.push(`unfollow:${path}`)
  }
  close() {
    if (this.closed) return
    this.closed = true
    for (const fn of this.closes) fn()
  }
}
state.connect = async () => {
  const client = new Client()
  state.clients.push(client)
  return client
}
state.catalog = () => {
  const client = new Client()
  client.prepare = () => state.prepare
  client.scan = () => state.scan.promise
  client.list = () => []
  client.startWatching = () => {
    state.reads.push("watch")
  }
  client.stop = () => {
    client.closed = true
  }
  state.catalogs.push(client)
  return client
}
state.Worker = class extends EventEmitter {
  constructor() {
    super()
    state.workers.push(this)
  }
  async terminate() {
    this.emit("exit", 0)
    return 0
  }
}
const mocks = {
  "./catalog-connection.js": `export const connectOnDemandCatalog = async () => globalThis.__catalogReadinessTest.sharedEnabled ? globalThis.__catalogReadinessTest.connect() : null;`,
  electron: `export const app = { getPath: () => globalThis.__catalogReadinessTest.root };`,
  "node:worker_threads": `export class MessageChannel { port1 = { close() {} }; port2 = {} }; export const Worker = globalThis.__catalogReadinessTest.Worker;`,
  "@mako/sessions": `const s = globalThis.__catalogReadinessTest;
    export const connectDaemonPort = () => s.connect();
    export const defaultCatalog = () => s.catalog();
    export const PROTOCOL_VERSION = 31; export const threadIdentity = ref => ref.path;
    export const defaultCatalogIdentity = async () => ({});
    export const connectDaemon = () => s.connect();
    export const daemonMemoryUnsafe = () => false;
    export const renderTranscript = () => ''; export const renderTranscriptBundle = () => ({});`,
  "./daemon-login.js": `export const daemonLoginEnabled = async () => globalThis.__catalogReadinessTest.daemonEnabled;
    export const daemonLoginOwner = () => false; export const daemonLoginProcess = async () => null;
    export const daemonScript = () => ''; export const refreshDaemonLoginJob = async () => {};
    export const setDaemonLogin = async () => {};`,
  "./daemon-vintage.js": `export const daemonIsForeign = () => false;`,
  "./lineage.js": `export const loadLineage = () => globalThis.__catalogReadinessTest.lineage.promise; export const annotate = ref => ref;`,
  "./providers/index.js": `export const providerHost = { processProbes: { list: () => [] } };`,
  "./provider-activity-engine.js": `export class ProviderActivityEngine { onChange() {} start() {} stop() {} }`,
  "./host-log.js": `export const hostLog = () => {}; export const hostWarn = () => {};`,
  "./host-git.js": `export class WorkspaceGit {}`,
  "./host-workspace.js": `export class WorkspaceFiles {}`,
}
try {
  const outfile = join(root, "threads.mjs")
  await build({
    entryPoints: ["electron/threads.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    plugins: [
      {
        name: "catalog-boundaries",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) =>
            args.path in mocks
              ? { path: args.path, namespace: "fake" }
              : undefined
          )
          b.onLoad({ filter: /.*/, namespace: "fake" }, (args) => ({
            contents: mocks[args.path],
            loader: "js",
          }))
        },
      },
    ],
  })
  const threads = await import(pathToFileURL(outfile).href)
  const install = () =>
    threads.installThreads((event) => state.events.push(event))
  const listening = async () => {
    await tick()
    state.workers
      .at(-1)
      .emit("message", { type: "listening", sessions: 0, prepareMs: 0 })
    await tick()
  }
  install()
  let settled = false
  const pending = threads.pageThread("codex").finally(() => {
    settled = true
  })
  await tick()
  assert.equal(
    settled,
    false,
    "A read before catalog startup must wait, never report missing history"
  )
  assert.equal(threads.threadsReady(), false)
  state.lineage.resolve()
  await listening()
  assert.equal((await pending).ref.harness, "codex")
  assert.equal(threads.threadsReady(), true)
  assert.equal(
    await threads.pageThread("missing"),
    null,
    "A ready reader still reports an actually absent source"
  )
  threads.stopThreads()

  // The reader is shared by every harness, including extensions not in today's registry.
  state.lineage = deferred()
  state.list = deferred()
  install()
  const providers = [
    "claude",
    "codex",
    "cursor",
    "grok",
    "devin",
    "opencode",
    "future-provider",
  ]
  const pages = providers.map((provider) => threads.pageThread(provider))
  const opened = threads.openThread("claude")
  const block = threads.threadBlock("devin", { entry: 0, block: 0 })
  threads.followThread("stale-view", 0)
  threads.followThread("current-view", 0)
  state.lineage.resolve()
  await listening()
  assert.deepEqual(
    (await Promise.all(pages)).map((page) => page.ref.harness),
    providers
  )
  assert.equal((await opened).ref.harness, "claude")
  assert.equal((await block).text, "devin")
  assert.ok(state.reads.includes("follow:current-view"))
  assert.ok(!state.reads.includes("follow:stale-view"))
  assert.equal(threads.threadsReady(), false, "known paths do not wait for full discovery")
  const client = state.clients.at(-1)
  for (const listener of client.events) {
    listener({ event: "entries", path: "current-view", entries: [{ kind: "user", text: "during discovery" }], replace: false })
    listener({ event: "updated", ref: { harness: "codex", path: "updated", title: "new" } })
    listener({ event: "removed", path: "removed" })
  }
  assert.ok(state.events.some(e => e.type === "thread-entries" && e.path === "current-view"), "follow delivery is independent of list hydration")
  state.list.resolve([
    { harness: "codex", path: "updated", title: "newest snapshot" },
  ])
  await tick()
  assert.equal(threads.threadsReady(), true)
  assert.equal(threads.listThreads().find(ref => ref.path === "updated").title, "newest snapshot")
  assert.ok(!threads.listThreads().some(ref => ref.path === "removed"))
  state.list = null

  // Losing the worker temporarily removes the reader; requests share its one restart.
  const workersBefore = state.workers.length
  state.clients.at(-1).close()
  const recovering = threads.pageThread("opencode")
  await tick()
  assert.equal(state.workers.length, workersBefore + 1)
  await listening()
  assert.equal((await recovering).ref.harness, "opencode")

  // The fallback also serves known paths while discovery remains incomplete.
  state.scan = deferred()
  state.clients.at(-1).close()
  let fallbackSettled = false
  const fallback = threads.pageThread("grok").finally(() => {
    fallbackSettled = true
  })
  await tick()
  assert.equal(threads.threadsReady(), false)
  assert.equal(fallbackSettled, true)
  state.scan.resolve([])
  assert.equal((await fallback).ref.harness, "grok")
  await tick()
  assert.equal(threads.threadsReady(), true)
  threads.stopThreads()

  // A lost reader's delayed list cannot erase its replacement in the same lifetime.
  state.list = deferred()
  install()
  await listening()
  assert.equal((await threads.pageThread("codex")).ref.harness, "codex")
  const lostList = state.list
  state.list = null
  state.clients.at(-1).close()
  await listening()
  assert.equal(threads.threadsReady(), true)
  lostList.resolve([{ harness: "codex", path: "lost-reader" }])
  await tick()
  assert.ok(!threads.listThreads().some(ref => ref.path === "lost-reader"))
  assert.equal(threads.threadsReady(), true)
  threads.stopThreads()

  // Failed initialization is an error, including for subsequent reads; not absent history.
  state.lineage = deferred()
  install()
  const failed = assert.rejects(
    threads.pageThread("claude"),
    /fixture lineage failed/
  )
  state.lineage.reject(new Error("fixture lineage failed"))
  await failed
  await assert.rejects(threads.pageThread("codex"), /fixture lineage failed/)
  assert.equal(threads.threadsReady(), false)
  threads.stopThreads()

  // Stop settles waiters before a held operation finishes. Its late completion cannot install.
  state.lineage = deferred()
  install()
  const stopped = assert.rejects(threads.pageThread("cursor"), /reader stopped/)
  await tick()
  const staleLineage = state.lineage
  const beforeStop = state.workers.length
  threads.stopThreads()
  await stopped
  state.lineage = deferred()
  install()
  staleLineage.resolve()
  await tick()
  assert.equal(state.workers.length, beforeStop)
  assert.equal(threads.threadsReady(), false)
  state.lineage.resolve()
  await listening()
  assert.equal((await threads.pageThread("devin")).ref.harness, "devin")
  threads.stopThreads()

  // Stop while the worker itself is starting must not trigger an in-process fallback.
  install()
  const workerStopped = assert.rejects(
    threads.pageThread("codex"),
    /reader stopped/
  )
  await tick()
  const catalogsBefore = state.catalogs.length
  threads.stopThreads()
  await workerStopped
  await tick()
  assert.equal(state.catalogs.length, catalogsBefore)
  assert.equal(threads.threadsReady(), false)

  // Stop during a fallback scan; a late scan result cannot publish or restart watchers.
  state.scan = deferred()
  install()
  const scanRead = threads.pageThread("codex")
  await tick()
  state.workers
    .at(-1)
    .emit("message", { type: "failed", message: "fixture worker failure" })
  await tick()
  const watches = state.reads.filter((value) => value === "watch").length
  threads.stopThreads()
  assert.equal((await scanRead).ref.harness, "codex")
  state.scan.resolve([])
  await tick()
  assert.equal(threads.threadsReady(), false)
  assert.equal(state.catalogs.at(-1).closed, true)
  assert.equal(state.reads.filter((value) => value === "watch").length, watches)
  // Failed discovery does not turn a working known-path reader into missing history.
  state.scan = deferred()
  install()
  const brokenScan = threads.pageThread("claude")
  await tick()
  state.workers.at(-1).emit("message", { type: "failed", message: "fixture worker failure" })
  await tick()
  state.scan.reject(new Error("fixture scan failed"))
  assert.equal((await brokenScan).ref.harness, "claude")
  await tick()
  assert.equal(threads.threadsReady(), false)
  assert.equal(state.catalogs.at(-1).closed, false)
  assert.ok(state.events.some(e => e.type === "notice" && e.message.includes("fixture scan failed")))
  threads.stopThreads()

  // Preparation failure still rejects known-path reads and closes the failed reader.
  const preparation = deferred()
  state.prepare = preparation.promise
  install()
  const brokenPrepare = assert.rejects(threads.pageThread("codex"), /fixture preparation failed/)
  await tick()
  state.workers.at(-1).emit("message", { type: "failed", message: "fixture worker failure" })
  await tick()
  preparation.reject(new Error("fixture preparation failed"))
  await brokenPrepare
  assert.equal(state.catalogs.at(-1).closed, true)
  threads.stopThreads()
  state.prepare = Promise.resolve()

  // A detached daemon is not ready until its initial list is adopted.
  state.daemonEnabled = true
  state.list = deferred()
  install()
  const daemonRead = threads.pageThread("devin")
  await tick()
  assert.equal(threads.threadsReady(), false)
  assert.equal((await daemonRead).ref.harness, "devin")
  state.list.resolve([])
  await tick()
  assert.equal(threads.threadsReady(), true)
  state.list = null
  state.clients.at(-1).close()
  const reconnectRead = threads.pageThread("claude")
  await listening()
  assert.equal((await reconnectRead).ref.harness, "claude")
  threads.stopThreads()

  // A list reply from an older lifetime cannot erase a replacement catalog.
  state.list = deferred()
  install()
  const staleDaemon = threads.pageThread("codex")
  await tick()
  const oldList = state.list
  const oldClient = state.clients.at(-1)
  threads.stopThreads()
  assert.equal((await staleDaemon).ref.harness, "codex")
  state.list = null
  install()
  await threads.pageThread("new-catalog")
  oldList.resolve([{ harness: "codex", path: "old-catalog" }])
  await tick()
  assert.equal(oldClient.closed, true)
  assert.ok(!threads.listThreads().some(ref => ref.path === "old-catalog"))
  assert.equal(threads.threadsReady(), true)
  threads.stopThreads()

  // Login opt-out still shares an on-demand reader; disconnection recovers once.
  state.daemonEnabled = false
  state.sharedEnabled = true
  state.list = deferred()
  const workerCount = state.workers.length
  install()
  assert.equal((await threads.pageThread("cursor")).ref.harness, "cursor")
  assert.equal(threads.threadsReady(), false)
  assert.equal(state.workers.length, workerCount)
  const shared = state.clients.at(-1)
  const staleSharedList = state.list
  state.list = null
  shared.close()
  const recovered = await Promise.all(providers.map(provider => threads.pageThread(provider)))
  assert.deepEqual(recovered.map(page => page.ref.harness), providers)
  assert.equal(state.clients.at(-1).closed, false)
  assert.equal(state.workers.length, workerCount)
  staleSharedList.resolve([{harness:"codex",path:"stale-shared-reader"}])
  await tick()
  assert.ok(!threads.listThreads().some(ref => ref.path === "stale-shared-reader"))
  assert.equal(threads.threadsReady(), true)
  threads.stopThreads()
  assert.equal(state.clients.at(-1).closed, true)
  await tick()
  assert.equal(state.workers.length, workerCount, "stop does not start another reader")

  console.log(
    "Catalog readiness: all-six/future reads, missing source, follow replacement, recovery/fallback, failure and stop/reinstall passed"
  )
} finally {
  delete globalThis.__catalogReadinessTest
  await rm(root, { recursive: true, force: true })
}
