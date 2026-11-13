import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, mock, test } from "node:test"
import { Git } from "@mako/git"
import type { MoveCheckpoint } from "@mako/protocol/moves"
import type { Partition } from "@mako/host/attribution/queries"
import type { CloudRepository } from "@mako/host/contracts/cloud-threads"
import { CloudReadiness, type ReadinessAccount, type ReadinessLedger } from "@mako/host/conversations/cloud-readiness"
import type { WorkingThread } from "@mako/host/conversations/cloud-handoffs"
import type { ThreadCheckpoint, ThreadCheckpointInput } from "@mako/host/workspaces/thread-checkpoint"

/*
 * A Thread in the main checkout keeps its own changes in the cloud as it makes them (`CloudReadiness`): a capture
 * a moment after a tool call that wrote, one per burst; at most one per interval while its turn runs; one at once at
 * its turn's end; none when the record of changes reads as it did; none sent the cloud has already; one at a time,
 * with a change during it making one more after; a failed send leaving the last acknowledged checkpoint, which the
 * next try replaces; every repository of a project folder; and nothing while handing off on sleep is off.
 */

const AFTER_WRITE_MS = 40
const EVERY_MS = 300

/*
 * Time is the test's: `setTimeout` and `Date` run on node's mock clock, which `pass` moves a millisecond at a time,
 * waiting after each for the readiness's file work (`CloudReadiness.ioSettled`). So its timers fire at the times the
 * assertions name whatever the runner's load: on real time, a 40 ms window read late beside another suite on a 2-vCPU
 * runner (#635, 2026-11-13).
 */
beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 }))
afterEach(() => mock.timers.reset())
/** The readiness of the case running, whose file work each step of the clock waits for. */
let current: CloudReadiness | undefined
/** A fake's own wait (a slow capture or send), on the test's clock. */
const later = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** `ms` of the test's time pass, each millisecond's timers fired once what they set off has reached its next wait. */
async function pass(ms: number): Promise<void> {
  await current?.ioSettled()
  for (let at = 0; at < ms; at += 1) {
    mock.timers.tick(1)
    await current?.ioSettled()
  }
}
/** `work` settled, the test's time passing while it waits on it, a minute of it at most. */
async function settling<Value>(work: Promise<Value>): Promise<Value> {
  let done = false
  void work.then(() => (done = true), () => (done = true))
  for (let at = 0; !done && at < 60_000; at += 1) await pass(1)
  return work
}
const repository: CloudRepository = { url: "https://github.com/octocat/Hello-World" }

function world(options: { roots?: string[]; captureMs?: number; deaf?: boolean; sendMs?: number } = {}) {
  const roots = options.roots ?? ["/project/api"]
  const dir = mkdtempSync(join(tmpdir(), "mako-checkpoint-trigger-"))
  /** What the record of changes holds of the Thread's files, by repository: the test edits it. */
  const journal = new Map<string, string>(roots.map((root) => [root, "v0"]))
  /** What's on disk, which a capture reads: ahead of the journal while a write isn't heard yet. */
  const disk = new Map<string, string>(roots.map((root) => [root, "v0"]))
  /** Writes on disk the journal hears only once something waits for it (`heard`). */
  const unheard = new Map<string, string>()
  let heardCalls = 0
  const working: WorkingThread[] = [{ conversationId: "c-1", thread: "local-1", harness: "codex" }]
  const captures: { root: string; at: number; content: string }[] = []
  const sent: { cloudThread: string; sha256: string }[] = []
  let failSends = 0
  let enabled = true
  const hear = async () => {
    heardCalls += 1
    if (options.deaf) return
    for (const [root, content] of unheard) journal.set(root, content)
    unheard.clear()
  }
  const ledger: ReadinessLedger = {
    heard: hear,
    settled: hear,
    track: async () => {},
    head: () => "a".repeat(40),
    partition: async (root): Promise<Partition> => ({ checkout: root, thread: "local-1", roots: [{ root: "r", path: root, head: null }], files: [{ root: "r", path: "a.ts", move: "lines", current: `sha256:${journal.get(root)}`, thread: { kind: "text", text: journal.get(root)! }, remaining: { kind: "absent" } }], whole: [], uncertain: [], unattributed: [], ms: 0 }),
  }
  const capture = async (input: ThreadCheckpointInput): Promise<ThreadCheckpoint> => {
    // A capture reads the files: what's on disk, heard by the journal or not.
    const content = disk.get(input.repoRoot)!
    captures.push({ root: input.repoRoot, at: Date.now(), content })
    if (options.captureMs) await later(options.captureMs)
    const sha256 = createHash("sha256").update(`${input.repoRoot}\0${content}`).digest("hex")
    const file = join(input.folder, "checkpoint.bundle")
    writeFileSync(file, content)
    const checkpoint: MoveCheckpoint = { version: 1, sha256, bytes: content.length, head: "a".repeat(40), index: "b".repeat(40), work: sha256.slice(0, 40), branch: input.branch }
    return { checkpoint, file, took: ["a.ts"], versions: [{ path: "a.ts", ref: `sha256:${sha256}` }], left: [], unpushed: 2, ms: 1 }
  }
  const account: ReadinessAccount = {
    createThread: async () => ({ ready: false }),
    sendCheckpoint: async (cloudThread: string, checkpoint: Pick<MoveCheckpoint, "sha256">) => {
      if (failSends > 0) {
        failSends -= 1
        throw new Error("the gateway didn't answer")
      }
      if (options.sendMs) await later(options.sendMs)
      sent.push({ cloudThread, sha256: checkpoint.sha256 })
      return { sent: true }
    },
    threadRecords: async (threadId: string) => ({ id: threadId, base: `https://gateway.test/v1/threads/${threadId}/records`, authorization: "Bearer t" }),
  }
  const readiness = new CloudReadiness({
    file: join(dir, "ready.json"),
    git: new Git(),
    scratch: join(dir, "scratch"),
    account: () => account,
    enabled: async () => enabled,
    working: () => working,
    leaving: () => false,
    plan: async () => ({ thread: "local-1", folder: "/worktrees/fix", repository, paths: [], harness: "codex", planned: true, repositories: roots.map((root) => ({ root, branch: "mako/fix" })) }),
    sendRecords: async () => [],
    newCloudThread: () => "t-standby",
    ledger: () => ledger,
    capture,
    timing: { afterWriteMs: AFTER_WRITE_MS, everyMs: EVERY_MS, retryMs: 60 },
  })
  current = readiness
  /** The Thread writes `content` in `root`: journaled at once, or heard only when the journal is waited for. */
  const write = (root: string, content: string, heard = true) => {
    disk.set(root, content)
    if (heard) journal.set(root, content)
    else unheard.set(root, content)
  }
  return {
    readiness, journal, working, captures, sent, dir, write,
    heardCalls: () => heardCalls,
    failNext: (count: number) => (failSends = count),
    disable: () => (enabled = false),
    /** The turn ends: the conversation no longer works, and the host says it settled. */
    end: () => {
      working.length = 0
      readiness.settled("c-1")
    },
  }
}

test("a burst of writes makes one capture a moment later, and a write soon after waits for the interval", async () => {
  const w = world()
  const started = Date.now()
  for (let i = 0; i < 5; i++) w.readiness.wrote("c-1")
  await pass(AFTER_WRITE_MS / 2)
  assert.equal(w.captures.length, 0, "not at once: a burst makes one")
  await pass(AFTER_WRITE_MS * 2)
  assert.equal(w.captures.length, 1)
  assert.ok(w.captures[0]!.at - started >= AFTER_WRITE_MS)
  assert.deepEqual(w.sent, [{ cloudThread: "t-standby", sha256: w.sent[0]!.sha256 }], "sent to the cloud Thread standing by")
  w.write("/project/api", "v1")
  w.readiness.wrote("c-1")
  await pass(AFTER_WRITE_MS * 2)
  assert.equal(w.captures.length, 1, "within the interval: not yet")
  await pass(EVERY_MS)
  assert.equal(w.captures.length, 2, "once the interval is past")
  assert.ok(w.captures[1]!.at - w.captures[0]!.at >= EVERY_MS - 10)
  assert.equal(w.sent.length, 2)
})

test("the turn's end captures at once, the interval or not, and once", async () => {
  const w = world()
  w.readiness.wrote("c-1")
  await pass(AFTER_WRITE_MS * 2)
  w.write("/project/api", "v1")
  w.readiness.wrote("c-1")
  w.end()
  await pass(80)
  assert.equal(w.captures.length, 2, "the end didn't wait for the interval")
  assert.equal(w.captures[1]!.content, "v1")
  await pass(EVERY_MS + AFTER_WRITE_MS)
  assert.equal(w.captures.length, 2, "the write's capture went with the end")
  w.readiness.settled("c-1")
  await pass(100)
  assert.equal(w.captures.length, 2, "a settle after the end takes nothing more")
})

test("unchanged, a write's capture is skipped; the turn's end captures anyway; captured the same, nothing is sent again", async () => {
  const w = world()
  w.readiness.wrote("c-1")
  await pass(AFTER_WRITE_MS * 2)
  w.readiness.wrote("c-1")
  await pass(EVERY_MS + AFTER_WRITE_MS)
  assert.equal(w.captures.length, 1, "the record of changes read as it did: no capture for the write")
  w.end()
  await pass(100)
  assert.equal(w.captures.length, 2, "the turn's end captures whatever the fingerprint says")
  assert.equal(w.sent.length, 1, "the same checkpoint isn't sent again")
  // Another turn: the journal moves and comes back to what was sent; captured, but the cloud has it.
  w.working.push({ conversationId: "c-1", thread: "local-1", harness: "codex" })
  w.write("/project/api", "v1")
  w.readiness.wrote("c-1")
  w.write("/project/api", "v0")
  await pass(EVERY_MS + AFTER_WRITE_MS)
  assert.equal(w.sent.length, 1, "the cloud keeps it already")
  const ready = JSON.parse(readFileSync(join(w.dir, "ready.json"), "utf8"))
  assert.equal(ready.threads["local-1"].acknowledged.length, 1)
})

test("one capture at a time: a write while one runs makes one more after it", async () => {
  const w = world({ captureMs: 400 })
  w.readiness.wrote("c-1")
  await pass(AFTER_WRITE_MS + 30)
  assert.equal(w.captures.length, 1, "running")
  w.write("/project/api", "v1")
  w.end()
  w.readiness.settled("c-1")
  await pass(20)
  assert.equal(w.captures.length, 1, "the end waits for the capture running")
  await pass(900)
  assert.equal(w.captures.length, 2, "then one more, with what changed")
  assert.equal(w.captures[1]!.content, "v1")
  assert.equal(w.sent.length, 2)
})

test("a failed send keeps the last acknowledged checkpoint; the next try replaces it; unpushed commits are kept to be named", async () => {
  const w = world()
  w.readiness.wrote("c-1")
  await pass(AFTER_WRITE_MS * 2)
  const first = await settling(w.readiness.acknowledged("local-1"))
  assert.equal(first?.cloudThread, "t-standby")
  assert.equal(first?.acknowledged[0]?.unpushed, 2)
  w.write("/project/api", "v1")
  w.failNext(1)
  w.end()
  await pass(30)
  assert.equal(w.captures.length, 2)
  assert.deepEqual((await settling(w.readiness.acknowledged("local-1")))?.acknowledged[0]?.checkpoint, first?.acknowledged[0]?.checkpoint, "the last acknowledged stands")
  // Tried again on its own a moment later, with no write to ask.
  await pass(200)
  assert.equal(w.sent.length, 2)
  assert.notDeepEqual((await settling(w.readiness.acknowledged("local-1")))?.acknowledged[0]?.checkpoint, first?.acknowledged[0]?.checkpoint, "replaced once acknowledged")
})

test("a write the journal hasn't heard as the turn ends still goes: the end waits for the journal, then captures the files", async () => {
  const w = world()
  w.readiness.wrote("c-1")
  await pass(AFTER_WRITE_MS * 2)
  assert.equal(w.sent.length, 1)
  // The turn's last edit lands on disk; the journal hasn't heard it when the turn ends.
  w.write("/project/api", "v-last", false)
  w.end()
  await pass(100)
  assert.ok(w.heardCalls() >= 1, "the end waited for the journal to hear")
  assert.equal(w.captures.at(-1)?.content, "v-last")
  assert.equal(w.sent.length, 2, "the last edit went")
  const acknowledged = await settling(w.readiness.acknowledged("local-1"))
  assert.equal(acknowledged?.acknowledged[0]?.checkpoint.bytes, "v-last".length, "and is what a going-away names")
})

test("a write the journal never heard before the end: the end still captures the files on disk", async () => {
  const w = world({ deaf: true })
  w.readiness.wrote("c-1")
  await pass(AFTER_WRITE_MS * 2)
  w.write("/project/api", "v-last", false)
  w.end()
  await pass(100)
  assert.equal(w.captures.at(-1)?.content, "v-last", "the fingerprint read as before; the end captured anyway")
  assert.equal(w.sent.length, 2)
})

test("a project folder: each repository's own checkpoint, only the one that changed sent again", async () => {
  const w = world({ roots: ["/project/api", "/project/web"] })
  w.readiness.wrote("c-1")
  await pass(AFTER_WRITE_MS * 2)
  assert.deepEqual(w.captures.map((each) => each.root), ["/project/api", "/project/web"])
  w.write("/project/web", "v1")
  w.end()
  await pass(100)
  assert.deepEqual(w.captures.map((each) => each.root), ["/project/api", "/project/web", "/project/api", "/project/web"], "the end captures each repository")
  assert.equal(w.sent.length, 3, "only web's changed, so only web's went again")
  assert.deepEqual((await settling(w.readiness.acknowledged("local-1")))?.acknowledged.map((each) => each.root), ["/project/api", "/project/web"])
})

test("with handing off on sleep off, a write captures nothing", async () => {
  const w = world()
  w.disable()
  w.readiness.wrote("c-1")
  await pass(AFTER_WRITE_MS * 2)
  w.end()
  await pass(100)
  assert.equal(w.captures.length, 0)
  assert.equal(w.sent.length, 0)
})

test("going away: the last changes are captured and sent by the deadline, and the note names what the cloud acknowledged", async () => {
  const w = world()
  w.readiness.wrote("c-1")
  await pass(AFTER_WRITE_MS * 2)
  const working = [...w.working]
  w.write("/project/api", "v-away", false)
  w.working.length = 0
  await settling(w.readiness.flush(working, Date.now() + 2_000))
  assert.equal(w.captures.at(-1)?.content, "v-away", "the turn's last edit, heard or not")
  const named = await settling(w.readiness.noteCheckpoint("local-1"))
  assert.equal(named?.sha256, w.sent.at(-1)!.sha256)
  assert.equal(named?.standby, "t-standby")
  assert.ok(named?.head && named.index && named.work && named.branch === "mako/fix", "whole, as the arrival applies it")
})

test("going away waits no longer than its deadline for a slow capture", async () => {
  const w = world({ captureMs: 2_000 })
  const working = [...w.working]
  const began = Date.now()
  await settling(w.readiness.flush(working, Date.now() + 200))
  assert.ok(Date.now() - began < 600, `back in ${Date.now() - began} ms`)
  assert.equal(await settling(w.readiness.noteCheckpoint("local-1")), undefined, "nothing acknowledged yet: the note names none")
})

test("going away cut short mid-send names the last checkpoint the cloud holds, never the one still on its way", async () => {
  const w = world({ sendMs: 300 })
  w.readiness.wrote("c-1")
  await pass(AFTER_WRITE_MS + 450)
  const held = await settling(w.readiness.noteCheckpoint("local-1"))
  assert.ok(held, "v0 acknowledged")
  const working = [...w.working]
  w.write("/project/api", "v-late")
  w.working.length = 0
  // The flush's cap comes while v-late's send is still on its way.
  await settling(w.readiness.flush(working, Date.now() + 150))
  assert.equal(w.captures.at(-1)?.content, "v-late", "captured")
  assert.deepEqual(await settling(w.readiness.noteCheckpoint("local-1")), held, "the note names v0, which the cloud holds")
  await pass(400)
  assert.equal((await settling(w.readiness.noteCheckpoint("local-1")))?.sha256, w.sent.at(-1)!.sha256, "once its send answers, v-late")
})

