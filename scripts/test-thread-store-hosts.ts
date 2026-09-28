import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import type { HostEvent } from "../electron/contracts/host-events-boot.js"
import { followOtherHosts } from "../electron/thread-groups-follow.js"
import { openThreadStore, ThreadStore, THREAD_STORE_SCHEMA } from "../electron/thread-store.js"

/**
 * Hosts sharing one Thread store: a regroup in one reaches the other's
 * windows, a host waiting on another's write lock gives up within a second
 * and keeps the placements it already had, a whole catalog is placed in
 * short batches with forks still joining their parents, and a damaged store
 * starts over and says so.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-thread-store-hosts-")))
const actor = { kind: "service", name: "catalog" } as const
const options = { realPath: (path: string) => path }
const ref = (name: string, parentNativeId?: string) => ({ harness: "codex", nativeId: name, path: `/sessions/${name}.jsonl`, ...(parentNativeId ? { parentNativeId } : {}) })

try {
  const path = join(root, "threads.sqlite")
  const installed = new ThreadStore(path, options)
  const development = new ThreadStore(path, options)
  const first = installed.place(ref("first"), actor)
  const second = installed.place(ref("second"), actor)
  assert.deepEqual(development.place(ref("second"), actor), second, "both hosts name the Session alike")
  assert.equal(development.takeExternalChanges(), undefined, "a new Session's first Thread isn't a change")

  const events: HostEvent[] = []
  const stop = followOtherHosts(development, (event) => events.push(event), 20)
  installed.joinThread({ operationId: randomUUID(), sessions: [second.session], thread: first.thread, actor: installed.person() })
  assert.equal(installed.takeExternalChanges(), undefined, "a host's own regroup isn't another host's")
  for (let tries = 0; tries < 100 && events.length < 2; tries++) await delay(20)
  stop()
  const regroup = events.find((event) => event.type === "thread-regroup")
  assert.ok(regroup?.type === "thread-regroup")
  assert.ok(regroup.regroup.placements.some((placed) => placed.session === second.session && placed.thread === first.thread), "the other host's windows learn where the Session went")
  const group = events.find((event) => event.type === "thread-group")
  assert.ok(group?.type === "thread-group")
  assert.equal(group.change.thread, first.thread)
  assert.deepEqual(group.change.group?.sessions.map((member) => member.id), [first.session, second.session], "and what the Thread's tabs are")
  assert.deepEqual(development.place(ref("second"), actor), { thread: first.thread, session: second.session }, "and serve the row in its new Thread")
  development.place(ref("first"), actor)

  // Another host holds the write lock, as a stuck one would.
  const blocker = new DatabaseSync(path)
  blocker.exec("BEGIN IMMEDIATE")
  const started = performance.now()
  const served = development.placeMany([ref("first"), ref("second"), ref("brand-new")], actor)
  const waited = performance.now() - started
  blocker.exec("ROLLBACK")
  blocker.close()
  assert.ok(waited < 2500, `a held lock stalls the host about a second, not five (waited ${Math.round(waited)} ms)`)
  assert.equal(served.get("/sessions/first.jsonl")?.thread, first.thread, "rows placed before keep their Thread")
  assert.equal(served.get("/sessions/second.jsonl")?.thread, first.thread)
  assert.equal(served.has("/sessions/brand-new.jsonl"), false, "a new row waits for its next serve")
  assert.ok(development.placeMany([ref("brand-new")], actor).get("/sessions/brand-new.jsonl"), "and is placed then")

  // A catalog larger than one batch, with the fork listed before its parent.
  const catalog = [ref("fork-of-last", "parent-last"), ...Array.from({ length: 1200 }, (_, index) => ref(`bulk-${index}`)), ref("parent-last")]
  const placed = installed.placeMany(catalog, actor)
  assert.equal(placed.size, catalog.length, "every row of a large catalog is placed")
  assert.equal(placed.get("/sessions/fork-of-last.jsonl")?.thread, placed.get("/sessions/parent-last.jsonl")?.thread, "a fork joins its parent even when they fall in different batches")
  installed.close()
  development.close()

  const broken = join(root, "broken", "threads.sqlite")
  rmSync(join(root, "broken"), { recursive: true, force: true })
  new ThreadStore(broken, options).close()
  writeFileSync(broken, "this is not a database, it was overwritten by something else entirely")
  const recovered = openThreadStore(broken, options)
  assert.ok(recovered.store, "a damaged store starts over")
  assert.match(recovered.problem ?? "", /damaged, so it started a new one/, "and says so")
  assert.ok(readdirSync(join(root, "broken")).some((name) => name.startsWith("threads.sqlite.damaged-")), "keeping the damaged file")
  assert.ok(recovered.store.place(ref("after"), actor), "the new store works")
  recovered.store.close()

  const newer = join(root, "newer", "threads.sqlite")
  new ThreadStore(newer, options).close()
  const database = new DatabaseSync(newer)
  database.prepare("UPDATE store_meta SET value = ? WHERE key = 'schema'").run(String(THREAD_STORE_SCHEMA + 1))
  database.close()
  const refused = openThreadStore(newer, options)
  assert.equal(refused.store, null, "a store from a newer Mako is left alone")
  assert.match(refused.problem ?? "", /^Threads are off: .*newer Mako/, "and the reason is kept for the window")
  assert.ok(existsSync(newer))
  console.log("thread store hosts: regroups reach other hosts, a held lock costs about a second and keeps placed rows, large catalogs placed in batches with forks by their parents, damaged stores start over, newer stores refused with a reason")
} finally {
  rmSync(root, { recursive: true, force: true })
}
