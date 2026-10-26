import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { connect, createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { Git } from "@mako/git"
import type { ActivityMark, ReportedCall } from "@mako/protocol"
import { acquireHostLock } from "@mako/host/base/host-lock"
import { HostJobs } from "@mako/host/base/host-jobs"
import type { LiveBatch } from "@mako/host/contracts/live-conversations"
import { openAttribution, type Attribution, type TreeWatcher } from "@mako/host/attribution/index"
import { SHARED_FORMAT, SharedJournal, ownerAddress, sharedJournalFolder, type JournalWrites, type OwnedJournal } from "@mako/host/attribution/shared-journal"

/*
 * One record of changes per device: two hosts on one Mac (the installed app
 * and a dev profile) share one journal. The first to start owns it and runs
 * the watching; the other sends it its agents' work and reads the file. When
 * the owner exits, however it exits, the other takes over without losing a
 * turn that was running. Scratch repositories only.
 */

const git = new Git()

/** A scratch repository with one commit. */
function repository(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "mako-shared-journal-repo-")))
  const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" })
  run("init", "-q", "-b", "main")
  run("config", "user.email", "test@example.com")
  run("config", "user.name", "Test")
  writeFileSync(join(repo, "a.ts"), "export const a = 1\n")
  writeFileSync(join(repo, "b.ts"), "export const b = 1\n")
  writeFileSync(join(repo, "c.ts"), "export const c = 1\n")
  run("add", "-A")
  run("commit", "-q", "-m", "base")
  return repo
}

/** A watcher this process drives by hand: only the owner's tracker listens, as only it watches. */
function handWatcher() {
  const listeners = new Map<string, Set<(paths: string[]) => void>>()
  const watch: TreeWatcher = (root, changed) => {
    const set = listeners.get(root) ?? new Set()
    listeners.set(root, set)
    set.add(changed)
    return { ready: Promise.resolve(), close: () => set.delete(changed) }
  }
  const emit = (path: string) => {
    for (const [root, set] of listeners) if (path.startsWith(`${root}/`)) for (const changed of set) changed([path])
  }
  return { watch, emit }
}

/** A host: its own data folder, the shared user root, and the Thread its one conversation belongs to. */
function host(userRoot: string, repo: string, thread: string, watch: TreeWatcher, label: string) {
  const dataRoot = mkdtempSync(join(tmpdir(), `mako-shared-journal-${label}-`))
  const conversation = `${thread}-conversation`
  return openAttribution({
    dataRoot,
    userRoot,
    label,
    git,
    watch,
    jobs: new HostJobs(),
    stores: () => [],
    placement: (id) => (id === conversation ? { thread, session: `${thread}-session` } : undefined),
    session: (id) => (id === conversation ? { cwd: repo, harness: "claude", record: join(dataRoot, `${thread}.jsonl`) } : undefined),
  })
}

let revision = 0
const batch = (thread: string, fields: Partial<LiveBatch>): LiveBatch => ({ id: `${thread}-conversation`, revision: ++revision, updates: [], ...fields })

async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting: ${what}`)
    await new Promise((done) => setTimeout(done, 20))
  }
}

const authorOf = (journal: Attribution, repo: string, path: string) =>
  journal.hunks(repo).find((hunk) => hunk.path === path)?.writers.map((writer) => `${writer.certainty}${"thread" in writer && writer.thread ? `:${writer.thread}` : ""}`)

if (process.argv[2] === "owner-child") {
  // A host in its own process, to be killed outright.
  const [, , , userRoot, repo] = process.argv
  const journal = await host(userRoot!, repo!, "TC", handWatcher().watch, "child")
  process.stdout.write(`role:${journal.status().sharing.role}\n`)
  setInterval(() => undefined, 60_000)
} else {
  test("two hosts on one device keep one journal: a follower's agent is heard as its own, its Mako writes as Mako's, and the next owner keeps its running turn", async () => {
    const repo = repository()
    const userRoot = mkdtempSync(join(tmpdir(), "mako-shared-journal-user-"))
    const watcher = handWatcher()
    const owner = await host(userRoot, repo, "TA", watcher.watch, "installed")
    const follower = await host(userRoot, repo, "TB", watcher.watch, "dev")
    try {
      assert.equal(owner.status().sharing.role, "owner")
      assert.equal(follower.status().sharing.role, "follower")
      assert.equal(follower.status().sharing.owner?.label, "installed")
      await until("the owner hears its follower", () => owner.status().sharing.followers.some((one) => one.label === "dev"))

      // The follower's Thread edits a file; only the owner watches, so only the follower's word makes it TB's.
      const path = join(repo, "a.ts")
      follower.live(batch("TB", { sessionChanges: { status: "running" } }))
      await follower.track(repo)
      follower.live(batch("TB", { updates: [{ kind: "tool", id: "toolu_1", title: "Edit", name: "Edit", status: "in_progress", input: JSON.stringify({ file_path: path, old_string: "1", new_string: "2" }) }] }))
      writeFileSync(path, "export const a = 2\n")
      watcher.emit(path)
      follower.live(batch("TB", { updates: [{ kind: "tool-update", id: "toolu_1", status: "completed", output: "ok", effects: [{ kind: "modify", path, edits: [{ old: "1", new: "2" }] }] }] }))
      await follower.settled()
      assert.deepEqual(authorOf(owner, repo, "a.ts"), ["exact:TB"], "the owner's journal has TB's edit as TB's")
      assert.deepEqual(authorOf(follower, repo, "a.ts"), ["exact:TB"], "the follower reads the same from the file")
      assert.deepEqual(follower.partition(repo, "TB").files.map((file) => file.path), ["a.ts"], "a move of TB takes it")

      // A write of the follower's own Mako (a worktree move) is Mako's, not an agent's.
      const moved = join(repo, "b.ts")
      const writing = follower.mako({ kind: "move", operation: "worktree move", paths: [moved] })
      writeFileSync(moved, "export const b = 2\n")
      watcher.emit(moved)
      await follower.settled()
      writing.end()
      await follower.settled()
      assert.equal(owner.status().entries.byCertainty.mako, 1, "the follower's own write is Mako's")

      // The owner quits; the follower takes over, and TB's turn, still running, still counts.
      await owner.close()
      await until("the follower owns the journal", () => follower.status().sharing.role === "owner")
      const later = join(repo, "c.ts")
      writeFileSync(later, "export const c = 2\n")
      watcher.emit(later)
      await follower.settled()
      assert.deepEqual(authorOf(follower, repo, "c.ts"), ["window:TB"], "the new owner knows TB's turn is running")
      assert.deepEqual(authorOf(follower, repo, "a.ts"), ["exact:TB"], "and keeps what the last owner journaled")
    } finally {
      await owner.close()
      await follower.close()
      rmSync(repo, { recursive: true, force: true })
      rmSync(userRoot, { recursive: true, force: true })
    }
  })

  test("an owner killed outright: the kernel frees its lock, a follower takes over within a second, and its running turn goes on counting", async () => {
    const repo = repository()
    const userRoot = mkdtempSync(join(tmpdir(), "mako-shared-journal-user-"))
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "owner-child", userRoot, repo], { stdio: ["ignore", "pipe", "inherit"] })
    const watcher = handWatcher()
    let follower: Attribution | undefined
    try {
      let output = ""
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => { output += chunk })
      await until("the child owns the journal", () => output.includes("role:owner"), 20_000)
      follower = await host(userRoot, repo, "TB", watcher.watch, "dev")
      assert.equal(follower.status().sharing.role, "follower")
      follower.live(batch("TB", { sessionChanges: { status: "running" } }))
      await follower.track(repo)
      await follower.settled()

      const killed = Date.now()
      child.kill("SIGKILL")
      const journal = follower
      await until("the follower owns the journal", () => journal.status().sharing.role === "owner")
      const tookOver = Date.now() - killed
      assert.ok(tookOver < 2_000, `took over in ${tookOver} ms`)

      const path = join(repo, "a.ts")
      writeFileSync(path, "export const a = 3\n")
      watcher.emit(path)
      await journal.settled()
      assert.deepEqual(authorOf(journal, repo, "a.ts"), ["window:TB"], "the turn the dead owner knew of is still TB's running turn")
      console.log(`  took over ${tookOver} ms after the owner was killed`)
    } finally {
      child.kill("SIGKILL")
      await follower?.close()
      rmSync(repo, { recursive: true, force: true })
      rmSync(userRoot, { recursive: true, force: true })
    }
  })

  test("the first shared journal starts from a host's own from before sharing, keeping what it knew under a new id", async () => {
    const repo = repository()
    const before = mkdtempSync(join(tmpdir(), "mako-shared-journal-user-"))
    const watcher = handWatcher()
    const old = await host(before, repo, "TA", watcher.watch, "installed")
    old.live(batch("TA", { sessionChanges: { status: "running" } }))
    await old.track(repo)
    const path = join(repo, "a.ts")
    old.live(batch("TA", { updates: [{ kind: "tool", id: "toolu_9", title: "Edit", name: "Edit", status: "in_progress", input: JSON.stringify({ file_path: path, old_string: "1", new_string: "9" }) }] }))
    writeFileSync(path, "export const a = 9\n")
    watcher.emit(path)
    old.live(batch("TA", { updates: [{ kind: "tool-update", id: "toolu_9", status: "completed", output: "ok", effects: [{ kind: "modify", path, edits: [{ old: "1", new: "9" }] }] }] }))
    await old.settled()
    await old.close()
    // That journal, where a host kept its own before journals were shared.
    const legacyRoot = mkdtempSync(join(tmpdir(), "mako-shared-journal-legacy-"))
    mkdirSync(join(legacyRoot, "attribution"))
    const shared = join(sharedJournalFolder(before), "journal.sqlite")
    execFileSync("sqlite3", [shared, `VACUUM INTO '${join(legacyRoot, "attribution", "journal.sqlite")}'`])
    const oldId = execFileSync("sqlite3", [shared, "SELECT value FROM meta WHERE key = 'journal'"], { encoding: "utf8" }).trim()

    const userRoot = mkdtempSync(join(tmpdir(), "mako-shared-journal-user-"))
    const journal = await openAttribution({
      dataRoot: mkdtempSync(join(tmpdir(), "mako-shared-journal-dev-")),
      defaultDataRoot: legacyRoot,
      userRoot,
      label: "dev",
      git,
      watch: watcher.watch,
      jobs: new HostJobs(),
      stores: () => [],
      placement: () => undefined,
      session: () => undefined,
    })
    try {
      assert.equal(journal.status().sharing.role, "owner")
      assert.deepEqual(authorOf(journal, repo, "a.ts"), ["exact:TA"], "what the old journal knew is kept")
      await journal.close()
      const newId = execFileSync("sqlite3", [join(sharedJournalFolder(userRoot), "journal.sqlite"), "SELECT value FROM meta WHERE key = 'journal'"], { encoding: "utf8" }).trim()
      assert.match(newId, /^[0-9a-f-]{36}$/)
      assert.notEqual(newId, oldId, "under a new id, so no peer mixes the two histories")
    } finally {
      await journal.close()
      for (const folder of [repo, before, legacyRoot, userRoot]) rmSync(folder, { recursive: true, force: true })
    }
  })

  /** A journal that only remembers what it was told. */
  function recorder() {
    const heard: string[] = []
    const writes: JournalWrites = {
      activity: (mark) => heard.push(`${mark.kind} ${mark.id} ${mark.edge}`),
      reported: (call) => heard.push(`reported ${call.call}`),
      makoStart: (id) => heard.push(`mako ${id} start`),
      makoEnd: (id) => heard.push(`mako ${id} end`),
      makoWrote: () => heard.push("mako wrote"),
      moved: (move) => heard.push(`moved ${move.kind}`),
      chose: (choice) => heard.push(`chose ${choice.spelling} ${choice.path}`),
      counted: (summary) => heard.push(`counted ${summary.turn}`),
      sessions: (sessions) => heard.push(`sessions ${sessions.length}`),
      track: async () => undefined,
      settled: async () => undefined,
      readBack: async () => undefined,
      lost: async () => [],
      restore: async () => ({ path: "/restored" }),
      carry: async (history) => {
        heard.push(`carry ${history.thread} ${history.parts.reduce((sum, part) => sum + part.activity.length, 0)}`)
        return { thread: history.thread, taken: history.parts.map((part) => part.journal), left: [], choices: history.choices.length }
      },
    }
    const owned: OwnedJournal = { writes, close: async () => undefined }
    return { heard, owned }
  }

  test("a follower carries a Thread's history past a message's size to the owner through the journal's folder, and nothing else is read", async () => {
    const folder = mkdtempSync(join(tmpdir(), "mako-shared-journal-folder-"))
    const first = recorder()
    const second = recorder()
    const owner = await SharedJournal.open({ folder, host: { pid: process.pid, dataRoot: "/a", label: "a" }, own: async () => first.owned, follow: quiet, alone: async () => first.owned, log: quiet })
    const follower = await SharedJournal.open({ folder, host: { pid: process.pid, dataRoot: "/b", label: "b" }, own: async () => second.owned, follow: quiet, alone: async () => second.owned, log: quiet })
    try {
      assert.equal(follower.role().kind, "follower")
      const journal = "6f1c1f9e-3c9a-4d3e-9a43-0d6c0a1b2c3d"
      const activity = Array.from({ length: 120_000 }, (_, i) => ({
        session: "S1", kind: "call" as const, id: `call-${i}`, start: 1_800_000_000_000 + i, end: 1_800_000_000_100 + i,
        cwd: "/repo", named: [`/repo/src/module-${i % 997}/file-${i}.ts`],
      }))
      const history = { format: 1 as const, thread: "T1", from: journal, parts: [{ journal, device: "laptop", through: 9, at: 1_800_000_200_000, roots: [{ path: "/repo", repository: true }], activity, writes: [], names: [] }], choices: [{ spelling: "a.ts", path: "/repo/a.ts", at: 1 }] }
      assert.ok(JSON.stringify(history).length > 16 * 1024 * 1024, "more than one message may hold")
      const result = await follower.writes.carry(history, [])
      assert.deepEqual(result, { thread: "T1", taken: [journal], left: [], choices: 1 })
      assert.deepEqual(first.heard, ["carry T1 120000"], "the owner took it; the follower's own journal never did")
      assert.deepEqual(second.heard, [])
      assert.deepEqual(readdirSync(join(folder, "carry")), [], "and the file is gone once answered")

      // A request naming a file anywhere else is refused before anything is read.
      const outside = join(folder, "elsewhere.json")
      writeFileSync(outside, JSON.stringify({ history, map: [] }))
      const socket = await new Promise<Socket>((done, fail) => {
        const connection = connect(ownerAddress(folder), () => done(connection))
        connection.once("error", fail)
      })
      const replies: string[] = []
      socket.setEncoding("utf8")
      socket.on("data", (chunk: string) => replies.push(...chunk.split("\n").filter(Boolean)))
      socket.write(`${JSON.stringify({ t: "hello", format: SHARED_FORMAT, host: { pid: process.pid, dataRoot: "/c", label: "c" } })}\n`)
      await until("the owner welcomed the raw follower", () => replies.some((line) => line.includes('"welcome"')))
      socket.write(`${JSON.stringify({ t: "call", id: 1, m: { kind: "carry", file: outside } })}\n`)
      await until("the owner answered", () => replies.some((line) => line.includes('"reply"')))
      assert.match(replies.find((line) => line.includes('"reply"')) ?? "", /"ok":false.*own folder/)
      assert.deepEqual(first.heard, ["carry T1 120000"])
      socket.destroy()
    } finally {
      await follower.close()
      await owner.close()
      rmSync(folder, { recursive: true, force: true })
    }
  })

  const mark = (kind: ActivityMark["kind"], id: string, edge: ActivityMark["edge"]): ActivityMark => ({ kind, id, edge, at: Date.now(), thread: "T1", session: "T1-session" })
  const call = (id: string): ReportedCall => ({ thread: "T1", session: "T1-session", call: id, status: "completed", effects: [] })
  const quiet = () => undefined

  test("what an owner heard but never applied reaches the next owner, after what's still running, and a request waiting on it is answered", async () => {
    const folder = mkdtempSync(join(tmpdir(), "mako-shared-journal-folder-"))
    // An owner that welcomes and listens, but never applies anything.
    const lock = await acquireHostLock(folder, { purpose: "owner" })
    assert.equal(lock.kind, "held")
    const received: string[] = []
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.setEncoding("utf8")
      socket.on("data", (chunk: string) => {
        for (const line of chunk.split("\n").filter(Boolean)) {
          const message = z.object({ t: z.string(), format: z.string().optional() }).parse(JSON.parse(line))
          if (message.t === "hello") socket.write(`${JSON.stringify({ t: "welcome", format: message.format, host: { pid: 1, dataRoot: "/stuck", label: "stuck" } })}\n`)
          else received.push(message.t)
        }
      })
    })
    await new Promise<void>((done) => server.listen(ownerAddress(folder), done))
    const next = recorder()
    const shared = await SharedJournal.open({
      folder,
      host: { pid: process.pid, dataRoot: "/follower", label: "follower" },
      own: async () => next.owned,
      follow: quiet,
      alone: async () => next.owned,
      log: quiet,
      timing: { retryMs: 5, maxRetryMs: 20 },
    })
    try {
      assert.equal(shared.role().kind, "follower")
      shared.writes.activity(mark("turn", "t1", "start"))
      shared.writes.activity(mark("call", "c1", "start"))
      shared.writes.reported(call("c1"))
      shared.writes.activity(mark("call", "c1", "end"))
      shared.writes.chose({ thread: "T1", spelling: "a.ts", path: "/repo/a.ts", at: Date.now() })
      const waiting = shared.writes.settled()
      await until("the stuck owner heard everything", () => received.length === 6)
      assert.equal(shared.status().unsent, 5, "none of it applied, so all of it is kept")

      // The stuck owner goes; this host takes over and hears it all in order, the open turn first.
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done) => server.close(() => done()))
      if (lock.kind === "held") await lock.release()
      await until("this host owns the journal", () => shared.role().kind === "owner")
      assert.deepEqual(next.heard, ["turn t1 start", "call c1 start", "reported c1", "call c1 end", "chose a.ts /repo/a.ts"])
      await waiting
      assert.equal(shared.status().unsent, 0)
    } finally {
      await shared.close()
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test("a host that reads the journal another way keeps its own rather than share it", async () => {
    const folder = mkdtempSync(join(tmpdir(), "mako-shared-journal-folder-"))
    const first = recorder()
    const second = recorder()
    let alone = ""
    const owner = await SharedJournal.open({ folder, host: { pid: process.pid, dataRoot: "/a", label: "a" }, own: async () => first.owned, follow: quiet, alone: async () => first.owned, log: quiet })
    const other = await SharedJournal.open({
      folder,
      host: { pid: process.pid, dataRoot: "/b", label: "b" },
      own: async () => second.owned,
      follow: quiet,
      alone: async (why) => {
        alone = why
        return second.owned
      },
      log: quiet,
      format: "another-build",
    })
    try {
      assert.equal(owner.role().kind, "owner")
      assert.equal(other.role().kind, "private")
      assert.match(alone, /refused/)
      other.writes.activity(mark("turn", "t1", "start"))
      assert.deepEqual(second.heard, ["turn t1 start"], "it writes its own journal")
      assert.deepEqual(first.heard, [], "and never the shared one")
    } finally {
      await other.close()
      await owner.close()
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test("the shared journal's folder is named for its format, so another build keeps another", () => {
    const folder = sharedJournalFolder("/Users/someone/.mako")
    assert.match(folder, /^\/Users\/someone\/\.mako\/attribution\/[0-9a-f]{16}$/)
    assert.ok(Buffer.byteLength(ownerAddress(folder, "darwin")) <= 100)
    assert.match(ownerAddress(folder, "linux"), /^\0mako-attribution-[0-9a-f]{24}$/)
    const deep = join("/private/var/folders/xx/yyyyyyyyyyyyyyyyyyyyyyyyyyyy/T", "a".repeat(80), "attribution", "0123456789abcdef")
    assert.ok(Buffer.byteLength(ownerAddress(deep, "darwin")) <= 104, "a path too long for a socket falls back to a short one")
    mkdirSync(tmpdir(), { recursive: true })
  })
}
