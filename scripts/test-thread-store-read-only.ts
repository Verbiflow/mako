import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { ReadOnlyStoreError } from "@mako/sessions/read-only-sqlite"
import { SessionMemory } from "../electron/session-memory.js"
import { openThreadStore, ThreadStore, type SourceRef } from "../electron/thread-store.js"

/**
 * A fixture desk reads the user's Thread store and session ledger without
 * writing them: nothing is created, writes and cleanup are refused or
 * skipped, rows nobody placed stay unplaced, and what a writing host commits
 * later is read, including after the reader opened with no host running.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-thread-store-read-only-")))
const actor = { kind: "service", name: "catalog" } as const
const options = { realPath: (path: string) => path }
const ref = (name: string, parentNativeId?: string): SourceRef => {
  const source: SourceRef = { harness: "codex", nativeId: name, path: `/sessions/${name}.jsonl` }
  if (parentNativeId) source.parentNativeId = parentNativeId
  return source
}
const sides = (path: string) => [existsSync(`${path}-wal`), existsSync(`${path}-shm`)]
const rawCount = (path: string, sql: string) => {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return Number(db.prepare(sql).get()?.count)
  } finally {
    db.close()
  }
}

try {
  const missing = join(root, "missing", "threads.sqlite")
  const absent = openThreadStore(missing, { ...options, readOnly: true })
  assert.equal(absent.store, null)
  assert.match(absent.problem ?? "", /^Threads are off/, "a reader says why Threads are off")
  assert.equal(existsSync(dirname(missing)), false, "and creates no store")

  const path = join(root, "threads.sqlite")
  const writer = new ThreadStore(path, options)
  const first = writer.place(ref("first"), actor)
  const reader = new ThreadStore(path, { ...options, readOnly: true })
  assert.equal(reader.deviceId, writer.deviceId)
  assert.deepEqual(reader.place(ref("first"), actor), first, "a reader serves a placed row's Thread")
  const served = reader.placeMany([ref("first"), ref("unplaced")], actor)
  assert.deepEqual([...served.keys()], [ref("first").path], "a row no writer placed is served without a Thread")
  assert.equal(rawCount(path, "SELECT count(*) AS count FROM sources WHERE key = 'unplaced'"), 0, "and is not placed")
  const writes = [
    () => reader.renameThread({ operationId: randomUUID(), thread: first.thread, title: "Mine", actor: reader.person() }),
    () => reader.createSession({ operationId: randomUUID(), thread: first.thread, actor: reader.person() }),
    () => reader.registerJournal({ conversationId: "journal", createdAt: 1, harness: "codex", bindings: [] }, actor),
    () => reader.markPurpose(first.thread, "setup", "/project"),
  ]
  for (const write of writes) assert.throws(write, ReadOnlyStoreError, "every write is refused")
  assert.equal(writer.thread(first.thread)?.title, undefined)

  const second = writer.place(ref("second"), actor)
  assert.deepEqual(reader.placeMany([ref("second")], actor).get(ref("second").path), second, "a row another host places later is served with its Thread")
  assert.equal(reader.takeExternalChanges(), undefined)
  const adopter = new ThreadStore(path, options)
  const adopted = adopter.place(ref("second", "first"), actor)
  adopter.close()
  assert.equal(adopted.thread, first.thread)
  assert.deepEqual(reader.takeExternalChanges(), [second.session], "another host's regrouping reaches the reader")
  assert.deepEqual(reader.place(ref("second"), actor), adopted)
  writer.renameThread({ operationId: randomUUID(), thread: first.thread, title: "Shared", actor: writer.person() })
  assert.equal(reader.thread(first.thread)?.title, "Shared")
  reader.close()
  writer.close()

  const quiet = join(root, "quiet", "threads.sqlite")
  const creator = new ThreadStore(quiet, options)
  const one = creator.place(ref("one"), actor)
  creator.close()
  assert.deepEqual(sides(quiet), [false, false])
  const late = new ThreadStore(quiet, { ...options, readOnly: true })
  assert.deepEqual(late.place(ref("one"), actor), one, "a store no host has open is read as it is")
  assert.deepEqual(sides(quiet), [false, false], "without creating -wal or -shm")
  const host = new ThreadStore(quiet, options)
  const two = host.place(ref("two"), actor)
  assert.deepEqual(late.placeMany([ref("two")], actor).get(ref("two").path), two, "and is followed live once a host opens it")
  late.close()
  host.close()

  const ledger = join(root, "session-memory.sqlite")
  const launch = { dataRoot: root, executable: "/bin/mako", args: [], cwd: root, profile: "" }
  const alive = (pid: number) => pid === 100
  const installed = new SessionMemory(ledger, { pid: 100, startedAt: 1, label: "the installed Mako app", socket: "/installed.sock", launch }, { alive })
  installed.remember("codex", "native", { modeId: "auto" })
  installed.hold("codex", "native", "conversation")
  const raw = new DatabaseSync(ledger)
  raw.prepare("INSERT INTO holds VALUES ('codex', 'gone', 999, 9, 'a host that exited', 'old', 1, 1)").run()
  raw.close()
  const fixture = new SessionMemory(ledger, { pid: 200, startedAt: 2, label: "the fixture desk", socket: "/fixture.sock", launch }, { alive, readOnly: true })
  assert.equal(fixture.recall("codex", "native")?.modeId, "auto")
  assert.equal(fixture.heldBy("codex", "native")?.hostLabel, "the installed Mako app")
  assert.equal(fixture.heldBy("codex", "gone"), null, "a hold whose host exited reads as free")
  assert.equal(rawCount(ledger, "SELECT count(*) AS count FROM holds WHERE native_id = 'gone'"), 1, "and stays for a writing host to clear")
  assert.equal(rawCount(ledger, "SELECT count(*) AS count FROM runtime_hosts WHERE socket = '/fixture.sock'"), 0, "a reader registers no runtime")
  assert.throws(() => fixture.remember("codex", "native", { modeId: "plan" }), ReadOnlyStoreError)
  assert.throws(() => fixture.hold("codex", "other", "mine"), ReadOnlyStoreError)
  assert.throws(() => fixture.rememberJournal("mine"), ReadOnlyStoreError)
  fixture.startHeartbeat(1)
  fixture.heartbeat()
  await fixture.reconcileHolds()
  installed.remember("codex", "native", { modeId: "plan" })
  assert.equal(fixture.recall("codex", "native")?.modeId, "plan", "another host's later write is read")
  fixture.close()
  installed.close()
  assert.throws(() => new SessionMemory(join(root, "no-ledger.sqlite"), { pid: 1, startedAt: 1, label: "fixture" }, { readOnly: true }))
  assert.equal(existsSync(join(root, "no-ledger.sqlite")), false, "a reader creates no ledger")
  console.log("PASS: read-only Thread store and session ledger read live, create nothing, and refuse writes")
} finally {
  rmSync(root, { recursive: true, force: true })
}
