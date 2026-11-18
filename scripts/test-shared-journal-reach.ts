import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, realpathSync, rmSync, statSync } from "node:fs"
import { connect, createServer, type Socket } from "node:net"
import { join } from "node:path"
import { test } from "node:test"
import { z } from "zod"
import type { ActivityMark } from "@mako/protocol"
import { acquireHostLock } from "@mako/host/base/host-lock"
import { SharedJournal, ownerAddress, type JournalWrites, type OwnedJournal } from "@mako/host/attribution/shared-journal"
import { testScratch } from "./lib/test-scratch.mjs"

/*
 * The journal's owner can be reached, and a host that stops doesn't wait on one that can't be: an owner's socket
 * where the folder's path and the temporary folder's are both too long for one (the host load bench's world), an
 * owner reached only by its socket that fails to open when it can't listen, and `applied` ending on what the owner
 * does rather than on a clock.
 */

const quiet = () => undefined
const HelloSchema = z.object({ t: z.string(), format: z.string().optional() })

/** A journal that only remembers the activity it was told. */
function recorder() {
  const heard: string[] = []
  const writes: JournalWrites = {
    activity: (mark) => heard.push(`${mark.kind} ${mark.id} ${mark.edge}`),
    reported: quiet, makoStart: quiet, makoEnd: quiet, makoWrote: quiet, moved: quiet, chose: quiet, counted: quiet, sessions: quiet,
    track: async () => undefined, settled: async () => undefined, readBack: async () => undefined, lost: async () => [],
    restore: async () => ({ path: "/restored" }),
    carry: async (history) => ({ thread: history.thread, taken: [], left: [], choices: 0 }),
  }
  const owned: OwnedJournal = { writes, close: async () => undefined }
  return { heard, owned }
}

const mark = (id: string, edge: "start" | "end"): ActivityMark => ({ kind: "turn", id, edge, at: Date.now(), thread: "T1", session: "S1", turn: id })

async function until(what: string, done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`never: ${what}`)
}

/** A folder whose path is longer than a socket's may be. */
function longFolder(prefix: string): string {
  const folder = join(realpathSync(testScratch(prefix)), "a-folder-with-a-long-name-as-a-bench-world-has".repeat(2), "attribution", "0123456789abcdef")
  mkdirSync(folder, { recursive: true })
  return folder
}

test("the owner's address fits a socket wherever the journal and the temporary folder are", { skip: process.platform !== "darwin" }, () => {
  assert.equal(ownerAddress("/short/attribution/format"), "/short/attribution/format/owner.sock", "beside the lock where that fits")
  const long = `/${"long-folder/".repeat(12)}attribution/format`
  const inTemporary = ownerAddress(long, "darwin", "/scratch/xx/short/T")
  assert.match(inTemporary, /^\/scratch\/xx\/short\/T\/mako-attribution-[0-9a-f]{24}\.sock$/, "in the temporary folder where the journal's own path is too long, as before")
  const both = ownerAddress(long, "darwin", `/scratch/${"nested-scratch/".repeat(6)}tmp`)
  assert.ok(Buffer.byteLength(both) <= 103, `a path a socket can have (${Buffer.byteLength(both)} bytes)`)
  assert.notEqual(both, ownerAddress(`${long}-other`, "darwin", `/scratch/${"nested-scratch/".repeat(6)}tmp`), "one a journal")
  assert.equal(both, ownerAddress(long, "darwin", `/scratch/${"another-scratch/".repeat(6)}tmp`), "the same for every host of the journal, whatever its temporary folder")
})

test("an owner whose journal and temporary folder are both deep is listened to and followed", { skip: process.platform !== "darwin" }, async () => {
  const folder = longFolder("mako-journal-reach-")
  const temporary = join(longFolder("mako-journal-reach-tmp-"), "tmp")
  mkdirSync(temporary, { recursive: true })
  const before = process.env.TMPDIR
  process.env.TMPDIR = temporary
  const first = recorder(), second = recorder()
  const logged: string[] = []
  let owner: SharedJournal | undefined, follower: SharedJournal | undefined
  try {
    assert.ok(Buffer.byteLength(join(temporary, "mako-attribution-0123456789abcdef01234567.sock")) > 103, "the world of the bench: no socket fits in its temporary folder")
    owner = await SharedJournal.open({ folder, host: { pid: process.pid, dataRoot: "/a", label: "a" }, own: async () => first.owned, follow: quiet, alone: async () => first.owned, log: (message) => logged.push(message), socketOnly: true })
    assert.equal(owner.role().kind, "owner")
    assert.deepEqual(logged.filter((message) => message.includes("can't reach")), [])
    follower = await SharedJournal.open({ folder, host: { pid: process.pid + 1, dataRoot: "/b", label: "b" }, own: async () => second.owned, follow: quiet, alone: async () => second.owned, log: quiet, timing: { unansweredMs: 2_000 } })
    assert.equal(follower.role().kind, "follower", "the second host finds the owner at its address")
    follower.writes.activity(mark("t1", "start"))
    await follower.applied()
    assert.deepEqual(first.heard, ["turn t1 start"], "and its writes are applied and acknowledged")
    const socketFolder = statSync(join(ownerAddress(folder), ".."))
    assert.equal(socketFolder.mode & 0o077, 0, "the socket's folder is this user's alone")
  } finally {
    await follower?.close()
    await owner?.close()
    if (before === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = before
  }
})

/**
 * Take the owner's address so that nothing can listen there and nothing answers there; the returned function gives
 * it back. On macOS the address is a path: a folder with something in it sits there, which isn't a socket and can't
 * be removed as one. On Linux it is a name the kernel keeps, with no file to put in the way, and a name a server
 * listens on would be connected to and followed, not owned beside: so another process binds the name and never
 * listens, which refuses every connection and every other bind. Undefined where that can't be arranged.
 */
async function occupy(address: string): Promise<(() => Promise<void>) | undefined> {
  if (process.platform === "darwin") {
    mkdirSync(join(address, "in-the-way"), { recursive: true })
    return async () => rmSync(address, { recursive: true, force: true })
  }
  if (process.platform !== "linux" || spawnSync("python3", ["--version"]).status !== 0) return undefined
  const holder = spawn("python3", ["-c", "import socket, sys\ns = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\ns.bind(chr(0) + sys.argv[1])\nprint('bound', flush=True)\nsys.stdin.read()", address.slice(1)], { stdio: ["pipe", "pipe", "inherit"] })
  const gone = new Promise<void>((done) => holder.once("exit", () => done()))
  const bound = await new Promise<boolean>((done) => {
    holder.stdout.once("data", () => done(true))
    holder.once("exit", () => done(false))
  })
  const release = async () => {
    holder.kill()
    await gone
  }
  if (bound) return release
  await release()
  return undefined
}

test("an owner reached only by its socket fails to open when it can't listen, says why, and lets the journal go", async (t) => {
  const folder = realpathSync(testScratch("mako-journal-deaf-"))
  const address = ownerAddress(folder)
  const release = await occupy(address)
  if (!release) return t.skip("nothing here can hold the owner's address without answering on it")
  const one = recorder()
  const open = (socketOnly: boolean) => SharedJournal.open({ folder, host: { pid: process.pid, dataRoot: "/a", label: "a" }, own: async () => one.owned, follow: quiet, alone: async () => one.owned, log: quiet, socketOnly })
  let opened: SharedJournal | undefined
  let lock: Awaited<ReturnType<typeof acquireHostLock>> | undefined
  try {
    // Should it open after all, it is closed below.
    await assert.rejects(async () => { opened = await open(true) }, /can't listen at /)
    lock = await acquireHostLock(folder, { purpose: "owner" })
    assert.equal(lock.kind, "held", "the lock it took is released, for an owner that can listen")
    if (lock.kind === "held") await lock.release()
    lock = undefined
    // An owner in its host's own process still serves that host without a socket, as it did.
    opened = await open(false)
    assert.equal(opened.role().kind, "owner")
  } finally {
    await opened?.close()
    if (lock?.kind === "held") await lock.release()
    await release()
  }
})

test("a stopping host doesn't wait for an acknowledgement nobody can send", async () => {
  const folder = realpathSync(testScratch("mako-journal-applied-"))
  const none = recorder()
  // A host whose writing owner never starts: what it sends is kept, with nobody to apply it.
  const alone = await SharedJournal.open({
    folder, host: { pid: process.pid, dataRoot: "/a", label: "a" }, own: async () => none.owned, follow: quiet, alone: async () => none.owned, log: quiet,
    startOwner: async () => { throw new Error("The writer could not start.") }, timing: { retryMs: 60_000, maxRetryMs: 60_000 },
  })
  try {
    assert.equal(alone.role().kind, "failed")
    await alone.applied()
    alone.writes.activity(mark("t1", "start"))
    assert.equal(alone.status().unsent, 1)
    const began = performance.now()
    await assert.rejects(alone.applied(), /no owner connected/)
    assert.ok(performance.now() - began < 1_000, "at once, not after fifteen seconds")
  } finally {
    await alone.close()
  }
})

test("a host waiting on its owner's acknowledgement stops when the owner goes, and waits on while it acknowledges", async () => {
  const folder = realpathSync(testScratch("mako-journal-applied-owner-"))
  const lock = await acquireHostLock(folder, { purpose: "owner" })
  let shared: SharedJournal | undefined
  // An owner that welcomes a host and acknowledges only when told to.
  const sockets = new Set<Socket>()
  let heard = 0
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding("utf8")
    socket.on("error", quiet)
    socket.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const message = HelloSchema.parse(JSON.parse(line))
        if (message.t === "hello") socket.write(`${JSON.stringify({ t: "welcome", format: message.format, host: { pid: 1, dataRoot: "/owner", label: "owner" } })}\n`)
        else if (message.t === "send") heard++
      }
    })
  })
  const acknowledge = (n: number) => { for (const socket of sockets) socket.write(`${JSON.stringify({ t: "ack", n })}\n`) }
  const next = recorder()
  try {
    assert.equal(lock.kind, "held")
    await new Promise<void>((done, fail) => server.once("error", fail).listen(ownerAddress(folder), done))
    const opened = (shared = await SharedJournal.open({ folder, host: { pid: process.pid, dataRoot: "/follower", label: "follower" }, own: async () => next.owned, follow: quiet, alone: async () => next.owned, log: quiet, timing: { retryMs: 5, maxRetryMs: 20, appliedQuietMs: 300 } }))
    assert.equal(opened.role().kind, "follower")
    for (const id of ["t1", "t2", "t3"]) opened.writes.activity(mark(id, "start"))
    await until("the owner heard them", () => heard === 3)
    // Each acknowledgement starts the wait over: three, 200 ms apart, outlast one quiet stretch of 300 ms.
    let outcome = "waiting"
    const began = performance.now()
    const all = opened.applied().then(() => { outcome = "applied" }, (error: Error) => { outcome = error.message })
    for (const n of [1, 2, 3]) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(outcome, "waiting", `still waiting before acknowledgement ${n}`)
      acknowledge(n)
    }
    await all
    assert.equal(outcome, "applied")
    assert.ok(performance.now() - began >= 550, "it waited past one quiet stretch, on an owner that kept acknowledging")

    // A connected owner that says nothing is waited on for the quiet stretch, no longer.
    opened.writes.activity(mark("t4", "start"))
    await assert.rejects(opened.applied(), /did not acknowledge/)

    // The owner goes while a host waits: it hears that, and stops waiting.
    const waited = performance.now()
    const left = assert.rejects(opened.applied(), /owner left|no owner connected|closed before/)
    for (const socket of sockets) socket.destroy()
    await left
    assert.ok(performance.now() - waited < 250, "as the owner goes, not when a clock runs out")
  } finally {
    // The journal and every connection first: a server waits for its connections before it says it closed.
    await shared?.close()
    for (const socket of sockets) socket.destroy()
    if (server.listening) await new Promise<void>((done) => server.close(() => done()))
    if (lock.kind === "held") await lock.release()
  }
})

// Closed once it has begun opening the journal, and closed the instant the owner goes, while it is still finding out
// whether the lock is free: the second left a listening socket and a held lock behind, which on Linux kept this file's
// process alive after every test had passed.
for (const when of ["as it opens the journal", "at once"] as const) test(`a journal closed ${when}, taking over from an owner that left, leaves no socket and no lock behind`, async () => {
  const folder = realpathSync(testScratch("mako-journal-closing-"))
  const lock = await acquireHostLock(folder, { purpose: "owner" })
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding("utf8")
    socket.on("error", quiet)
    socket.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const message = HelloSchema.parse(JSON.parse(line))
        if (message.t === "hello") socket.write(`${JSON.stringify({ t: "welcome", format: message.format, host: { pid: 1, dataRoot: "/owner", label: "owner" } })}\n`)
      }
    })
  })
  const next = recorder()
  const opening = Promise.withResolvers<void>()
  let asked = false
  let shared: SharedJournal | undefined
  let after: Awaited<ReturnType<typeof acquireHostLock>> | undefined
  try {
    assert.equal(lock.kind, "held")
    await new Promise<void>((done, fail) => server.once("error", fail).listen(ownerAddress(folder), done))
    const own = async () => {
      asked = true
      await opening.promise
      return next.owned
    }
    const opened = (shared = await SharedJournal.open({ folder, host: { pid: process.pid, dataRoot: "/follower", label: "follower" }, own, follow: quiet, alone: own, log: quiet, timing: { retryMs: 5, maxRetryMs: 20 } }))
    assert.equal(opened.role().kind, "follower")
    // The owner goes for good; this host begins to take the journal over, and is closed before it has opened it.
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((done) => server.close(() => done()))
    if (lock.kind === "held") await lock.release()
    if (when === "as it opens the journal") await until("this host began opening the journal", () => asked)
    const closed = opened.close()
    opening.resolve()
    await closed
    // What an election still under way does after the close has had time to happen.
    await new Promise((resolve) => setTimeout(resolve, 100))
    after = await acquireHostLock(folder, { purpose: "owner" })
    assert.equal(after.kind, "held", "the lock it took while closing is released")
    const found = await new Promise<boolean>((done) => {
      const probe = connect(ownerAddress(folder))
      probe.once("connect", () => { probe.destroy(); done(true) })
      probe.once("error", () => done(false))
    })
    assert.equal(found, false, "and nothing listens at the owner's address")
  } finally {
    opening.resolve()
    await shared?.close()
    for (const socket of sockets) socket.destroy()
    if (server.listening) await new Promise<void>((done) => server.close(() => done()))
    if (lock.kind === "held") await lock.release()
    if (after?.kind === "held") await after.release()
  }
})
