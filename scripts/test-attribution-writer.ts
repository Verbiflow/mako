import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { MessageChannel } from "node:worker_threads"
import { once } from "node:events"
import { postToWriter } from "@mako/host/attribution/writer-messages"
import { ToWriterSchema } from "@mako/host/attribution/writer-protocol"
import { Git } from "@mako/git"
import { HostJobs } from "@mako/host/base/host-jobs"
import { followHostLog } from "@mako/host/base/host-log"
import { HostStopping, HostStoppingError } from "@mako/host/base/host-stopping"
import { HostCallLifetime } from "@mako/host/transport/call-lifetime"
import { hostLifecycle } from "@mako/host/base/host-lifecycle"
import { AttributionWriter } from "@mako/host/attribution/writer-client"
import { JournalStore } from "@mako/host/attribution/journal-store"
import { openAttribution, type AttributionDeps, type TreeWatcher } from "@mako/host/attribution/index"
import { SharedJournal, sharedJournalFolder } from "@mako/host/attribution/shared-journal"

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "maw-")))
const git = new Git()

function dependencies(root: string, watch: TreeWatcher = () => ({ ready: Promise.resolve(), close() {} })): AttributionDeps {
  return { dataRoot: join(root, "data"), userRoot: join(root, "user"), label: "writer-test", git, watch, jobs: new HostJobs(), stores: () => [], placement: () => undefined, session: () => undefined }
}

function settings(deps: AttributionDeps) {
  return { dataRoot: deps.dataRoot, userRoot: deps.userRoot, label: deps.label, hostPid: process.pid, home: deps.dataRoot, temporary: [], own: [deps.dataRoot], history: false, children: false, catalogued: false, running: false }
}

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 10_000
  while (!check()) {
    assert.ok(Date.now() < end, "the worker reached its expected boundary")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function follower(writer: AttributionWriter, deps: AttributionDeps) {
  const state = await writer.ensure()
  return SharedJournal.open({
    folder: state.sharing.folder, host: { pid: process.pid, dataRoot: deps.dataRoot, label: deps.label },
    startOwner: async reason => (await writer.ensure(reason)).address,
    own: async () => { throw new Error("The host must not become a writing owner") },
    alone: async () => { throw new Error("The host must not write a private journal") },
    follow() {}, log() {},
  })
}

test("the host opens only committed read connections, even when it owns the journal", async () => {
  const root = scratch()
  const opened: boolean[] = []
  const original = JournalStore.open
  JournalStore.open = (path, options) => { opened.push(options?.readOnly === true); return original(path, options) }
  let journal: Awaited<ReturnType<typeof openAttribution>> | undefined
  try {
    journal = await openAttribution(dependencies(root))
    assert.equal(journal.status().sharing.role, "owner")
    assert.ok(opened.length > 0)
    assert.ok(opened.every(Boolean), "no host connection can write")
  } finally {
    JournalStore.open = original
    await journal?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("a SQLite function blocked in the actual writer leaves the host runnable and ACK waits for the commit", async () => {
  const root = scratch()
  const deps = dependencies(root)
  const started = join(root, "started")
  const release = join(root, "release")
  const expired = join(root, "expired")
  const entry = join(root, "gate.ts")
  const main = fileURLToPath(new URL("../packages/host/src/attribution/writer-main.ts", import.meta.url))
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }))
  writeFileSync(entry, `
    import { DatabaseSync } from "node:sqlite";
    import { threadId } from "node:worker_threads";
    import { existsSync, writeFileSync } from "node:fs";
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) {
      if (sql.startsWith("INSERT INTO activity")) {
        this.function("test_writer_gate", () => {
          writeFileSync(${JSON.stringify(started)}, JSON.stringify({ pid: process.pid, threadId }));
          const end = Date.now() + 5000;
          while (!existsSync(${JSON.stringify(release)})) {
            if (Date.now() > end) { writeFileSync(${JSON.stringify(expired)}, "timeout"); throw new Error("Host did not release SQLite"); }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
          return 1;
        });
        prepare.call(this, "SELECT test_writer_gate()").get();
      }
      return prepare.call(this, sql);
    };
    await import(${JSON.stringify(main)});
  `)
  const writer = new AttributionWriter(deps, settings(deps), { entry })
  let client: SharedJournal | undefined
  try {
    client = await follower(writer, deps)
    client.writes.activity({ kind: "turn", edge: "start", id: "turn", session: "session", thread: "thread", at: Date.now() })
    await until(() => existsSync(started))
    const identity = JSON.parse(readFileSync(started, "utf8"))
    assert.equal(identity.pid, process.pid, "the owner is a thread of the host process")
    assert.ok(identity.threadId > 0, "SQLite runs outside the host thread")
    assert.ok(client.status().unsent > 0, "a blocked write has not been acknowledged")
    await new Promise<void>(resolve => setImmediate(resolve))
    writeFileSync(release, "release")
    await client.writes.settled({ rescans: false })
    await until(() => client!.status().unsent === 0)
    assert.equal(existsSync(expired), false, "the host ran while SQLite was still blocked")
    const store = JournalStore.open(writer.snapshot()!.path, { device: "reader", readOnly: true })
    try { assert.equal(store.activityOfThread("thread").length, 1) } finally { store.close() }
  } finally {
    writeFileSync(release, "release")
    await client?.close()
    await writer.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("closing the writer ends a held watch wait and releases the subscription once, including late readiness", async () => {
  const root = scratch()
  let ready!: () => void
  let entered!: () => void
  let closed = 0
  const watching = new Promise<void>(resolve => { entered = resolve })
  const readiness = new Promise<void>(resolve => { ready = resolve })
  const deps = dependencies(root, () => { entered(); return { ready: readiness, close: () => { closed++ } } })
  const writer = new AttributionWriter(deps, settings(deps))
  let client: SharedJournal | undefined
  try {
    client = await follower(writer, deps)
    const tracking = client.writes.track(root)
    void tracking.catch(() => {})
    await watching
    await writer.close()
    await assert.rejects(tracking)
    assert.equal(closed, 1)
    ready()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(closed, 1, "late readiness cannot revive or close twice")
  } finally {
    ready()
    await client?.close()
    await writer.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("a stopping host commits a turn that ends while its calls drain", async () => {
  const root = scratch()
  const scope = new HostStopping()
  const calls = new HostCallLifetime(scope)
  const deps = { ...dependencies(root), placement: () => ({ thread: "drain-thread", session: "session" }) }
  const journal = await scope.run(() => openAttribution(deps))
  const path = journal.status().journal.path
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const running = new Promise<void>(resolve => { entered = resolve })
  let exitCode: number | undefined
  const lifecycle = hostLifecycle({
    async cleanup() {
      const draining = calls.close()
      await scope.stop()
      release()
      await draining
      await journal.close()
    },
    exit(code) { exitCode = code }, log() {}, failed: async error => { throw error },
  })
  const call = calls.run(async () => {
    journal.live({ id: "conversation", revision: 1, updates: [], sessionChanges: { status: "running" } })
    entered()
    await gate
    assert.ok(scope.signal.aborted, "turn-end marks arrive after outside cancellation")
    journal.live({ id: "conversation", revision: 2, updates: [], sessionChanges: { status: "ready" } })
  })
  void call.catch(() => {})
  try {
    await running
    await lifecycle.stop({ kind: "request", action: "quit" })
    await assert.rejects(call, HostStoppingError)
    assert.equal(exitCode, 0, "attribution closed without losing the drain's writes")
    const store = JournalStore.open(path, { device: "reader", readOnly: true })
    try {
      const activity = store.activityOfThread("drain-thread")
      assert.equal(activity.length, 1)
      assert.notEqual(activity[0]!.end, null, "the turn's end reached the committed journal")
    } finally { store.close() }
  } finally {
    release()
    await calls.close()
    await journal.close()
    await scope.stop()
    rmSync(root, { recursive: true, force: true })
  }
})


test("a worker lost after commit survives a failed restart and replays its unacknowledged message once", async () => {
  const root = scratch()
  const deps = dependencies(root)
  const marker = join(root, "committed")
  const restart = join(root, "restart-failed")
  const entry = join(root, "crash-after-commit.ts")
  const storeModule = fileURLToPath(new URL("../packages/host/src/attribution/journal-store.ts", import.meta.url))
  const main = fileURLToPath(new URL("../packages/host/src/attribution/writer-main.ts", import.meta.url))
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }))
  writeFileSync(entry, `
    import { existsSync, writeFileSync } from "node:fs";
    import { JournalStore } from ${JSON.stringify(storeModule)};
    if (existsSync(${JSON.stringify(marker)}) && !existsSync(${JSON.stringify(restart)})) {
      writeFileSync(${JSON.stringify(restart)}, "failed restart");
      throw new Error("test restart failure");
    }
    const saveActivity = JournalStore.prototype.saveActivity;
    JournalStore.prototype.saveActivity = function(activity) {
      const result = saveActivity.call(this, activity);
      if (activity.thread === "replay-thread" && !existsSync(${JSON.stringify(marker)})) {
        writeFileSync(${JSON.stringify(marker)}, "committed before ACK");
        process.exit(23);
      }
      return result;
    };
    await import(${JSON.stringify(main)});
  `)
  const writer = new AttributionWriter(deps, settings(deps), { entry })
  let client: SharedJournal | undefined
  try {
    client = await follower(writer, deps)
    client.writes.activity({ kind: "turn", edge: "start", id: "replayed-turn", session: "session", thread: "replay-thread", at: Date.now() })
    await until(() => existsSync(marker))
    await client.writes.settled({ rescans: false })
    await until(() => client!.status().unsent === 0)
    const store = JournalStore.open(writer.snapshot()!.path, { device: "reader", readOnly: true })
    try { assert.equal(store.activityOfThread("replay-thread").length, 1) } finally { store.close() }
  } finally {
    await client?.close()
    await writer.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("a private worker keeps the journal off the host and forwards its diagnostic lines", async () => {
  const root = scratch()
  const deps = dependencies(root)
  const writer = new AttributionWriter(deps, settings(deps))
  const lines: string[] = []
  const stop = followHostLog(line => { if (line.scope === "attribution") lines.push(line.message) })
  let client: SharedJournal | undefined
  try {
    const opened = await writer.ensure("test sharing unavailable")
    assert.equal(opened.role.kind, "private")
    assert.ok(opened.path.startsWith(join(deps.dataRoot, "attribution", "private")))
    client = await follower(writer, deps)
    client.writes.activity({ kind: "turn", edge: "start", id: "private-turn", session: "session", thread: "private-thread", at: Date.now() })
    await client.writes.settled({ rescans: false })
    const store = JournalStore.open(opened.path, { device: "reader", readOnly: true })
    try { assert.equal(store.activityOfThread("private-thread").length, 1) } finally { store.close() }
    assert.ok(lines.length > 0, "worker diagnostics reach the host's existing log topic")
  } finally {
    stop()
    await client?.close()
    await writer.close()
    rmSync(root, { recursive: true, force: true })
  }
})


test("Git byte views transfer only their span and keep the original reader buffer attached", async () => {
  for (const value of [Buffer.from("owned pooled bytes").subarray(2, 8), Buffer.alloc(1024 * 1024, 0x61).subarray(100, 356)]) {
    const original = [...value]
    const backing = value.buffer.byteLength
    const { port1, port2 } = new MessageChannel()
    try {
      const arrived = once(port2, "message")
      postToWriter(port1, { type: "host-reply", id: 1, ok: true, value, lagMs: 0 })
      const [raw] = await arrived
      const message = ToWriterSchema.parse(raw)
      assert.equal(message.type, "host-reply")
      if (message.type !== "host-reply") throw new Error("wrong reply type")
      assert.ok(message.value instanceof Uint8Array)
      assert.deepEqual([...message.value], original)
      assert.equal(message.value.buffer.byteLength, message.value.byteLength)
      assert.equal(value.buffer.byteLength, backing, "Git's shared input buffer was not detached")
      assert.deepEqual([...value], original)
    } finally { port1.close(); port2.close() }
  }
})


for (const fault of ["throws", "never-starts", "invalid-ready", "never-answers"] as const) {
  test(`the writing owner recovers from a worker that ${fault}, keeping its outbox`, { timeout: 20_000 }, async () => {
    const root = scratch()
    const deps = dependencies(root)
    const marker = join(root, "first-start")
    const entry = join(root, "fail-once.ts")
    const main = fileURLToPath(new URL("../packages/host/src/attribution/writer-main.ts", import.meta.url))
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }))
    writeFileSync(entry, `
      import { parentPort } from "node:worker_threads";
      import { existsSync, writeFileSync } from "node:fs";
      const first = !existsSync(${JSON.stringify(marker)});
      if (first) writeFileSync(${JSON.stringify(marker)}, "attempted");
      if (first && ${JSON.stringify(fault)} === "throws") throw new Error("test startup failure");
      if (first && ${JSON.stringify(fault)} === "never-starts") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      if (first && ${JSON.stringify(fault)} === "invalid-ready") {
        parentPort.on("message", () => { parentPort.postMessage({ type: "ready", snapshot: {} }); });
      } else {
        const send = parentPort.postMessage.bind(parentPort);
        parentPort.postMessage = (message, ...args) => {
          send(message, ...args);
          if (first && ${JSON.stringify(fault)} === "never-answers" && message.type === "ready") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        };
        await import(${JSON.stringify(main)});
      }
    `)
    const writer = new AttributionWriter(deps, settings(deps), { entry, timing: { startMs: 2_000, askMs: 300 } })
    let client: SharedJournal | undefined
    let attempts = 0
    try {
      client = await SharedJournal.open({
        folder: sharedJournalFolder(deps.userRoot), host: { pid: process.pid, dataRoot: deps.dataRoot, label: deps.label },
        timing: { retryMs: 40, maxRetryMs: 100, unansweredMs: 100 },
        startOwner: async reason => { attempts++; return (await writer.ensure(reason)).address },
        own: async () => { throw new Error("no main-thread writer") }, alone: async () => { throw new Error("no main-thread private writer") }, follow() {}, log() {},
      })
      assert.equal(client.role().kind, "failed", "startup and handshake failures are visible while recovery continues")
      assert.ok(client.status().failure)
      client.writes.activity({ kind: "turn", edge: "start", id: "recovering-turn", session: "session", thread: "recovering-thread", at: Date.now() })
      assert.equal(client.status().unsent, 1)
      await client.applied()
      assert.equal(client.role().kind, "follower")
      assert.equal(client.status().unsent, 0, "the bounded close drain joins recovery and its commit ACK")
      assert.ok(attempts >= 2)
      assert.equal(client.status().failure, undefined)
      const store = JournalStore.open(writer.snapshot()!.path, { device: "reader", readOnly: true })
      try { assert.equal(store.activityOfThread("recovering-thread").length, 1) } finally { store.close() }
    } finally {
      await client?.close()
      await writer.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test("owner retries back off, preserve failed status and stop when the client closes", async () => {
  const root = scratch()
  const attempts: number[] = []
  const client = await SharedJournal.open({
    folder: root, host: { pid: process.pid, dataRoot: root, label: "retry-test" }, timing: { retryMs: 40, maxRetryMs: 100 },
    startOwner: async () => { attempts.push(performance.now()); throw new Error("worker unavailable") },
    own: async () => { throw new Error("no main-thread writer") }, alone: async () => { throw new Error("no private writer") }, follow() {}, log() {},
  })
  try {
    await until(() => attempts.length >= 4)
    assert.equal(client.status().role, "failed")
    assert.equal(client.status().failure, "worker unavailable")
    for (let i = 1; i < attempts.length; i++) assert.ok(attempts[i]! - attempts[i - 1]! >= 30, "no tight startOwner retry loop")
    await client.close()
    const count = attempts.length
    await new Promise(resolve => setTimeout(resolve, 130))
    assert.equal(attempts.length, count, "close cancels the backoff and cannot start a late owner")
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }) }
})


test("closing during an owner restart rejects late recovery without a new connection or election", async () => {
  const root = scratch()
  let attempts = 0
  let release!: (address: string) => void
  const restarting = new Promise<string>(resolve => { release = resolve })
  const client = await SharedJournal.open({
    folder: root, host: { pid: process.pid, dataRoot: root, label: "late-retry-test" }, timing: { retryMs: 10, maxRetryMs: 20 },
    startOwner: async () => { if (++attempts === 1) throw new Error("first start failed"); return restarting },
    own: async () => { throw new Error("no main writer") }, alone: async () => { throw new Error("no private writer") }, follow() { throw new Error("late connection after close") }, log() {},
  })
  try {
    await until(() => attempts === 2)
    await client.close()
    release(join(root, "missing.socket"))
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(attempts, 2)
  } finally { release(join(root, "missing.socket")); await client.close(); rmSync(root, { recursive: true, force: true }) }
})
