import assert from "node:assert/strict"
import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MessageChannel, Worker } from "node:worker_threads"
import {
  connectDaemon,
  connectDaemonPort,
  daemonMemoryUnsafe,
  MAX_DAEMON_RSS,
  serveCatalog,
  serveCatalogOnPort,
} from "../dist/daemon.js"
import { LineAssembler } from "../dist/daemon-wire.js"

assert.equal(daemonMemoryUnsafe(MAX_DAEMON_RSS), false)
assert.equal(daemonMemoryUnsafe(MAX_DAEMON_RSS + 1), true)

// Line assembly: several lines in one chunk, one line across many chunks, a
// multi-byte character split between chunks, and the frame limit.
{
  const lines = new LineAssembler(64)
  assert.deepEqual(lines.push(Buffer.from("a\nb\nc")), ["a", "b"])
  assert.deepEqual(lines.push(Buffer.from("d")), [])
  assert.deepEqual(lines.push(Buffer.from("e\n")), ["cde"])
  const shark = Buffer.from("🦈\n")
  assert.deepEqual(lines.push(shark.subarray(0, 2)), [])
  assert.deepEqual(lines.push(shark.subarray(2)), ["🦈"])
  assert.equal(lines.pendingBytes, 0)
  assert.deepEqual(lines.push(Buffer.from("x".repeat(60))), [])
  assert.equal(lines.pendingBytes, 60)
  assert.equal(lines.push(Buffer.from("y".repeat(5))), null, "a pending line past the limit is refused before it is joined")
  const tail = new LineAssembler(64)
  assert.equal(tail.push(Buffer.from("ok\n" + "z".repeat(65))), null, "an oversized remainder is refused at once")
}

const root = await mkdtemp(join(tmpdir(), "mako-daemon-test-"))
const socketPath = join(root, "syncd.sock")
const thread = {
  ref: {
    harness: "codex",
    nativeId: "slow",
    path: "/slow",
    cwd: "/project/packages/app",
    workspace: "/project",
  },
  entries: [{ kind: "user", text: "Still opens — café 中文 🦈" }],
}
const page = {
  ref: thread.ref,
  entries: thread.entries,
  start: 0,
  total: 1,
  hasEarlier: false,
}
let deliverEntries
let pageOptions
let blockAt
const catalog = {
  count: 0,
  list: () => [
    {
      harness: "codex",
      nativeId: "full",
      identity: "full:chats",
      path: "/full",
      model: "gpt-6-astra",
      settings: { model: "gpt-6-astra", options: { effort: "high" } },
      liveResume: false,
      workspaceMissing: true,
      accessMode: "access:full",
    },
  ],
  open: async () => {
    await new Promise((resolve) => setTimeout(resolve, 150))
    return thread
  },
  page: async (_path, _before, _limit, options) => {
    pageOptions = options
    return page
  },
  block: async (_path, at) => {
    blockAt = at
    return { type: "tool", name: "exec", output: "the whole output" }
  },
  follow: (_path, _fromByte, listener) => {
    deliverEntries = listener
    return () => {
      deliverEntries = undefined
    }
  },
  onEvent: () => () => {},
  stop: () => {},
}

await writeFile(`${socketPath}.lock`, "99999999")
const server = await serveCatalog(catalog, socketPath)
assert.equal((await stat(socketPath)).mode & 0o777, 0o600)
await assert.rejects(
  serveCatalog(catalog, socketPath),
  /already (?:running|starting)/
)
const client = await connectDaemon(socketPath, 100)
const refreshed = await client.refresh()
assert.equal(refreshed.pid, process.pid)
assert.ok((refreshed.rss ?? 0) > 0)
assert.equal(refreshed.script, process.argv[1], "a daemon names the script it runs so another build can retire it")
assert.equal(refreshed.runtime, process.execPath)
assert.deepEqual(await client.list(), catalog.list(), "every ref field crosses the wire")
assert.deepEqual(await client.open(thread.ref.path), thread)
assert.deepEqual(await client.page(thread.ref.path), page)
assert.deepEqual(pageOptions, { toolOutputChars: undefined, maxChars: undefined })
// A viewer page names how much tool output it wants; the option and the
// block address cross the wire, and a block comes back schema-checked.
await client.page(thread.ref.path, 40, 20, { toolOutputChars: 4_096, maxChars: 65_536 })
assert.deepEqual(pageOptions, { toolOutputChars: 4_096, maxChars: 65_536 })
assert.deepEqual(await client.block(thread.ref.path, { entry: 3, block: 7 }), {
  type: "tool",
  name: "exec",
  output: "the whole output",
})
assert.deepEqual(blockAt, { entry: 3, block: 7 })
// A thread carrying megabytes of tool output crosses the socket in the time
// the socket needs, not the time it takes to rescan the buffer per chunk.
const large = {
  ref: thread.ref,
  entries: Array.from({ length: 120 }, (_, i) => ({
    kind: "assistant",
    blocks: [{ type: "text", text: `${i} ` + "tool output café 🦈 ".repeat(6_000) }],
  })),
}
catalog.open = async () => large
const startedLarge = performance.now()
const roundTrip = await client.open(thread.ref.path)
const largeMs = performance.now() - startedLarge
assert.equal(roundTrip.entries.length, 120)
assert.equal(roundTrip.entries[119].blocks[0].text, large.entries[119].blocks[0].text)
const largeBytes = Buffer.byteLength(JSON.stringify(large))
assert.ok(largeMs < 1_000, `${(largeBytes / 1e6).toFixed(1)} MB thread took ${largeMs.toFixed(0)} ms to cross the socket`)
catalog.open = async () => {
  await new Promise((resolve) => setTimeout(resolve, 150))
  return thread
}
const streamed = new Promise((resolve) => {
  client.onEvent((event) => {
    if (event.event === "entries") resolve(event)
  })
})
await client.follow(thread.ref.path, 0)
deliverEntries?.([{ kind: "assistant", blocks: [{ type: "text", text: "Live" }] }], false)
assert.deepEqual(await streamed, {
  event: "entries",
  path: thread.ref.path,
  entries: [
    { kind: "assistant", blocks: [{ type: "text", text: "Live" }] },
  ],
  replace: false,
})
const oversized = createConnection(socketPath)
await new Promise((resolve, reject) => {
  oversized.once("connect", resolve)
  oversized.once("error", reject)
})
const rejected = new Promise((resolve) => oversized.once("close", resolve))
oversized.write("x".repeat(1024 * 1024 + 1))
await rejected
client.close()
await new Promise((resolve, reject) =>
  server.close((error) => (error ? reject(error) : resolve()))
)
for (let attempt = 0; attempt < 20; attempt += 1) {
  if (!(await access(`${socketPath}.lock`).then(() => true, () => false))) break
  await new Promise((resolve) => setTimeout(resolve, 10))
}
await assert.rejects(access(`${socketPath}.lock`))
const restarted = await serveCatalog(catalog, socketPath)
await new Promise((resolve, reject) =>
  restarted.close((error) => (error ? reject(error) : resolve()))
)
const racePath = join(root, "race.sock")
const raced = await Promise.allSettled([
  serveCatalog(catalog, racePath),
  serveCatalog(catalog, racePath),
])
const winner = raced.find((result) => result.status === "fulfilled")
assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1)
assert.ok(winner)
const retiring = await connectDaemon(racePath)
const retired = new Promise((resolve) => winner.value.once("close", resolve))
await retiring.retire()
await assert.rejects(connectDaemon(racePath, 200))
await retired
for (let attempt = 0; attempt < 20; attempt += 1) {
  if (!(await access(`${racePath}.lock`).then(() => true, () => false))) break
  await new Promise((resolve) => setTimeout(resolve, 10))
}
await assert.rejects(access(`${racePath}.lock`))
await rm(root, { recursive: true, force: true })

// The same protocol over a MessageChannel: what a host uses to reach the
// catalog on its own worker thread. Frames arrive whole, so the large thread
// costs one message, and closing either end closes the other.
let portMs
{
  const channel = new MessageChannel()
  const served = serveCatalogOnPort(catalog, channel.port2, { memoryGuard: false })
  const over = await connectDaemonPort(channel.port1, 500)
  assert.equal(over.stats.pid, process.pid)
  assert.deepEqual(await over.open(thread.ref.path), thread)
  catalog.open = async () => large
  const started = performance.now()
  const back = await over.open(thread.ref.path)
  portMs = performance.now() - started
  assert.equal(back.entries.length, 120)
  assert.equal(back.entries[119].blocks[0].text, large.entries[119].blocks[0].text)
  assert.ok(portMs < 500, `${(largeBytes / 1e6).toFixed(1)} MB thread took ${portMs.toFixed(0)} ms over the port`)
  const live = new Promise((resolve) => {
    over.onEvent((event) => {
      if (event.event === "entries") resolve(event)
    })
  })
  await over.follow(thread.ref.path, 0)
  deliverEntries?.([{ kind: "assistant", blocks: [{ type: "text", text: "Port" }] }], false)
  assert.equal((await live).entries[0].blocks[0].text, "Port")
  const serverClosed = new Promise((resolve) => served.onClose(resolve))
  const clientClosed = new Promise((resolve) => over.onClose(resolve))
  over.close()
  await Promise.all([serverClosed, clientClosed])
  assert.equal(deliverEntries, undefined, "closing the port unfollows")

  // A port that crosses into a real worker thread: retire from the client
  // side stops the service and closes the port.
  const across = new MessageChannel()
  const worker = new Worker(
    new URL("./daemon-port-worker.mjs", import.meta.url),
    { workerData: { port: across.port2 }, transferList: [across.port2] }
  )
  const exited = new Promise((resolve) => worker.once("exit", resolve))
  const remote = await connectDaemonPort(across.port1, 2_000)
  assert.equal((await remote.list()).length, 1)
  assert.equal((await remote.open("/remote")).entries[0].text, "from the worker")
  await remote.retire()
  assert.equal(await exited, 0)
}

console.log(`Daemon checks clean: locking, frame bounds, restart, long reads, live broadcasts and the worker port verified; a ${(largeBytes / 1e6).toFixed(1)} MB thread crossed the socket in ${largeMs.toFixed(0)} ms and the port in ${portMs.toFixed(0)} ms.`)
