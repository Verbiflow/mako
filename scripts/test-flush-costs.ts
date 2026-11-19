import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { Executables, resolveExecutable } from "@mako/host/base/executable"
import { StdoutPace } from "@mako/host/harnesses/stdout-pace"
import { CodexRolloutTail } from "@mako/host/harnesses/codex/rollout-tail"
import { onlyDeltas } from "@mako/host/harnesses/codex-app-protocol"
import type { AgentsReportResult, AgentsStarted } from "@mako/host/contracts/agent-tools"
import type { AgentRefused } from "@mako/host/contracts/agents"
import { applyRosterPatch, rosteredLiveBatch, sharedFields, type CompactLiveBatch } from "@mako/host/contracts/live-conversations"
import { encodeRuntimeEvent, payloadFor } from "@mako/host/contracts/runtime-value"
import { COMPACT_LIVE_FORM, WINDOW_LIVE_FORM } from "@mako/protocol/live-form"
import type { NativeAgent, NativeAgentRoster } from "@mako/host/contracts/native-agents"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { WorkingSet, workingThreads, type WorkingSnapshot } from "@mako/host/conversations/cloud-handoffs"
import { HELD_BY_TABLE, heldBy, ThreadStore } from "@mako/host/threads/store"
import { readFileSync } from "node:fs"
import { SessionMemory } from "@mako/host/threads/session-memory"
import { DatabaseSync } from "node:sqlite"
import { atOnce } from "@mako/sessions/slices"
import { JournalReaders } from "@mako/host/conversations/journal-readers"
import { ColdJournal } from "@mako/host/conversations/live-journal"
import { writeLongJournal } from "./lib/host-load-trees.ts"
import { AgentsWorld } from "./lib/agents-world.ts"

/**
 * What a conversation's flush may cost (`npm run test:flush-costs`): work of that one conversation's change, never of
 * how many conversations or Fins there are. Each thing kept so (the working Threads, the store's look for other
 * processes' commits, the person's asks of a tree, a roster's unchanged entries) is held to what must still change it
 * at once, and to what must not. On 2026-11-17, 30 Fins at work among 370 conversations took the whole thread for these.
 */
const root = mkdtempSync(join(tmpdir(), "mako-flush-costs-"))
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
function kept<T extends object>(value: T | AgentRefused): T {
  assert.ok(!("refused" in value), JSON.stringify(value))
  return value
}

try {
  // The working Threads: a conversation enters as its own batch shows it working and leaves as one shows it doesn't,
  // with no reading of the others.
  {
    const running: WorkingSnapshot = { session: { harness: "codex", status: "running" }, permissions: [], requests: [] }
    const resting: WorkingSnapshot = { session: { harness: "codex", status: "ready" }, permissions: [], requests: [] }
    const snapshots = new Map<string, WorkingSnapshot>(Array.from({ length: 400 }, (_, index) => [`rest-${index}`, resting]))
    const placed = new Map<string, { thread: ReturnType<typeof ThreadIdSchema.parse>; session: ReturnType<typeof SessionIdSchema.parse> }>()
    const placement = (id: string) => placed.get(id) ?? placed.set(id, { thread: ThreadIdSchema.parse(randomUUID()), session: SessionIdSchema.parse(randomUUID()) }).get(id)!
    const reads = { listed: 0, held: 0 }
    const away = new Set<string>()
    const inCloud = new Set<string>()
    const sources = {
      live: {
        listed: () => { reads.listed += 1; return [...snapshots.keys()].map((id) => ({ session: { id } })) },
        held: (id: string) => { reads.held += 1; return snapshots.get(id) },
      },
      threads: { journalPlacement: placement, execution: (session: string) => ({ state: away.has(session) ? "elsewhere" as const : "here" as const }) },
      cloud: (id: string) => inCloud.has(id),
    }
    const working = new WorkingSet(sources)
    working.recount()
    assert.deepEqual(working.threads(), [])
    reads.listed = 0
    reads.held = 0
    snapshots.set("a", running)
    working.observe("a")
    assert.equal(reads.held, 1, "a conversation's change reads that conversation alone")
    assert.deepEqual(working.threads().map((thread) => thread.conversationId), ["a"])
    assert.equal(working.of("a")?.conversationId, "a")
    assert.equal(working.of("rest-1"), undefined)
    assert.equal(reads.listed, 0, "nothing a flush asks lists every conversation")
    assert.ok(reads.held < 10, `a flush read ${reads.held} conversations of 401`)
    // Two conversations of one Thread: the running one stands for it, whichever came first.
    snapshots.set("b", { ...resting, session: { harness: "codex", status: "ready", backgroundTasks: 1 } })
    placed.set("b", { ...placement("a") })
    working.observe("b")
    assert.deepEqual(working.threads().map((thread) => thread.conversationId), ["a"])
    assert.equal(working.of("b"), undefined)
    assert.deepEqual(working.threads(), workingThreads(sources), "the set says what a count of every conversation says")
    // Its turn ends: its own batch takes it out, and its Thread is counted by the one still working.
    snapshots.set("a", resting)
    working.observe("a")
    assert.deepEqual(working.threads().map((thread) => thread.conversationId), ["b"])
    assert.deepEqual(working.threads(true).map((thread) => thread.conversationId), ["b"], "background work is the agent's own")
    // What no batch says of a working conversation is seen at the next asking: it closed, went to the cloud, or its Session left.
    snapshots.delete("b")
    assert.deepEqual(working.threads(), [])
    snapshots.set("c", running)
    working.observe("c")
    inCloud.add("c")
    assert.deepEqual(working.threads(), [])
    inCloud.delete("c")
    assert.deepEqual(working.threads(), [], "one that left the set comes back by its own batch or a recount")
    working.recount()
    assert.deepEqual(working.threads().map((thread) => thread.conversationId), ["c"])
    away.add(placement("c").session)
    assert.equal(working.of("c"), undefined)
    assert.deepEqual(working.threads(), workingThreads(sources))
  }

  // The store's look for other processes' commits: once a turn of the loop for the host's reads, at once for a write.
  {
    const path = join(root, "version.sqlite")
    const host = new ThreadStore(path, { versionPerTurn: true })
    const other = new ThreadStore(path)
    const each = new ThreadStore(path)
    const place = (store: ThreadStore) => store.registerJournal({ conversationId: randomUUID(), createdAt: Date.now(), harness: "claude", bindings: [{ provider: "claude", nativeId: randomUUID() }] }, { kind: "service", name: "migration" })
    const first = place(other)
    await turn()
    const seen = host.moved()
    assert.ok(host.thread(first.thread), "a commit of an earlier turn is seen")
    place(other)
    assert.equal(host.moved(), seen, "within the turn that looked already, what the store holds waits for the next")
    const looked = each.moved()
    place(other)
    assert.notEqual(each.moved(), looked, "a store that looks at every read takes a commit in at once")
    // This host's write looks inside its own transaction.
    place(host)
    assert.notEqual(host.moved(), seen, "a write takes in other processes' commits before its own")
    const held = host.moved()
    place(other)
    assert.equal(host.moved(), held)
    await turn()
    assert.notEqual(host.moved(), held, "the next turn's first read looks again")
    // The stamp of reports and answers: a report kept by another process moves it, a commit of anything else doesn't.
    const before = host.asksStamp()
    place(other)
    await turn()
    assert.equal(host.asksStamp(), before, "a commit that kept no report or answer leaves the stamp")
    other.keepReport({ id: `report:${first.thread}:asked`, child: first.thread, status: "needs-input", summary: "Which base?", question: "Which base?", retainsQuestion: true, ownerGeneration: 1, at: Date.now() })
    await turn()
    assert.notEqual(host.asksStamp(), before, "a report another process kept moves the stamp")
    host.close()
    other.close()
    each.close()

    // A whole catalog placed with the loop turning between its batches: the same placements as in one go, and a row
    // served meanwhile is placed as it's served.
    const sliced = new ThreadStore(join(root, "sliced.sqlite")), whole = new ThreadStore(join(root, "whole.sqlite"))
    const refs = Array.from({ length: 900 }, (_, index) => ({ harness: "claude", nativeId: `native-${index}`, path: join(root, "sessions", `${index}.jsonl`) }))
    const catalog = { kind: "service" as const, name: "catalog" as const }
    let turns = 0
    const counting = setInterval(() => { turns += 1 }, 0)
    const placing = sliced.placeAll(refs, catalog)
    const served = sliced.placeMany([refs[899]!], catalog).get(refs[899]!.path)
    assert.ok(served, "a row served while the catalog is placed is placed at once")
    assert.equal(await placing, 899, "what was placed meanwhile is not placed again")
    clearInterval(counting)
    assert.ok(turns >= 3, `the loop turned ${turns} times while 900 rows were placed`)
    const once = whole.placeMany(refs, catalog)
    assert.equal(sliced.placeMany(refs, catalog).size, once.size)
    assert.equal(sliced.placeMany([refs[899]!], catalog).get(refs[899]!.path)?.thread, served.thread)
    sliced.close()
    whole.close()
  }

  // A roster of many entries, one of them new: told changed without writing the others out, and told the same when
  // every entry says what it said.
  {
    const entry = (index: number, title = `Fin ${index}`): NativeAgent => ({ nativeId: `mako-child:${index}`, title, work: "agent", background: true, stoppable: false, state: { kind: "completed" }, bindingId: "children", provider: "claude", observedAt: 1, startedAt: 1, detail: "x".repeat(4_000) })
    const agents = Array.from({ length: 226 }, (_, index) => entry(index))
    const held: NativeAgentRoster = { agents, limited: false }
    const moved: NativeAgentRoster = { agents: agents.map((agent, index) => index === 7 ? entry(7, "Fin 7, renamed") : agent), limited: false }
    const same: NativeAgentRoster = { agents: agents.map((agent, index) => index === 7 ? { ...agent } : agent), limited: false }
    const base = { requests: [], permissions: [] }
    assert.equal(sharedFields({ ...base, nativeAgents: held }, { ...base, nativeAgents: moved }).nativeAgents, moved, "an entry that changed is a changed roster")
    assert.equal(sharedFields({ ...base, nativeAgents: held }, { ...base, nativeAgents: same }).nativeAgents, held, "entries that say the same keep the roster held")
    const reordered = { ...base, nativeAgents: { limited: false, agents: agents.map((agent) => agent) } }
    assert.equal(sharedFields({ ...base, nativeAgents: held }, reordered).nativeAgents, held, "keys in another order say the same")
    const at = performance.now()
    for (let round = 0; round < 200; round += 1) sharedFields({ ...base, nativeAgents: held }, { ...base, nativeAgents: moved })
    const each = (performance.now() - at) / 200
    assert.ok(each < 4, `comparing a roster of 226 with one entry moved took ${each.toFixed(2)} ms; written whole it took 8`)

    // Its batch for the windows says the one entry, and makes the roster the host holds.
    const batch: CompactLiveBatch = { id: randomUUID(), revision: 2, form: COMPACT_LIVE_FORM, updates: [], nativeAgents: moved }
    const patch = rosteredLiveBatch(batch, held)?.rosterPatch
    assert.deepEqual(patch?.agents?.map((agent) => agent.title), ["Fin 7, renamed"])
    assert.deepEqual(patch && applyRosterPatch(held, patch), moved)
    assert.equal(rosteredLiveBatch({ ...batch, nativeAgents: { agents: [...agents.slice(1), agents[0]!], limited: false } }, held)?.rosterPatch, undefined, "entries that changed places are no patch of changed entries")

    // A batch's forms are written as a reader asks for each: a window on the newest form has the others unwritten.
    const event = encodeRuntimeEvent({ type: "live-batch", batch: { id: batch.id, revision: 2, updates: [] }, compact: batch, rostered: { ...batch, nativeAgents: undefined, rosterPatch: patch } })
    const unwritten = (form: "payload" | "compact" | "rostered") => Object.getOwnPropertyDescriptor(event, form)?.get !== undefined
    assert.ok(payloadFor(event, WINDOW_LIVE_FORM)?.includes("rosterPatch"))
    assert.deepEqual([unwritten("payload"), unwritten("compact"), unwritten("rostered")], [true, true, false], "only the form read was written")
    assert.equal(payloadFor(event, COMPACT_LIVE_FORM), JSON.stringify({ type: "live-batch", batch }))
    assert.equal(event.payload, JSON.stringify({ type: "live-batch", batch: { id: batch.id, revision: 2, updates: [] } }))
    assert.deepEqual(Object.keys({ ...event }).sort(), ["compact", "conversation", "payload", "rostered", "type"], "a copy of the event holds every form")
  }

  // The person's asks of a tree (`Agents.personAsk`): kept through what changes none of them, made again at once by
  // what does. The clock stands still, so nothing here is the kept walk running out.
  {
    const now = Date.now()
    const world = new AgentsWorld({ root: join(root, "asks"), now: () => now, script: () => "ok" })
    try {
      const apex = await world.apex("codex", "full")
      const fins: AgentsStarted[] = []
      for (const name of ["a", "b", "c"]) fins.push(kept(await world.agents.start(apex.caller, { name, clientKey: name, harness: "claude", brief: { objective: `Work on ${name}` }, cwd: root })))
      await world.settle(100)
      const caller = (index: number) => world.caller(fins[index]!.conversation!)
      const ask = async (index: number, key: string) => kept<Exclude<AgentsReportResult, AgentRefused>>(await world.agents.report(caller(index), { clientKey: key, status: "done", summary: `${key} is ready.`, question: `Merge ${key}?`, decides: "person" }))
      // Each walk reads every open Fin's report asks: how many times it walked.
      let walks = 0
      const openReportAsks = world.store.openReportAsks.bind(world.store)
      world.store.openReportAsks = (child) => { walks += 1; return openReportAsks(child) }
      const asked = () => { const before = walks; const found = world.agents.personAsk(apex.conversation); return { found, walked: walks > before } }

      assert.equal(asked().found, undefined)
      const first = await ask(0, "first")
      await world.settle(100)
      assert.equal(asked().found?.ask.id, first.id, "a report kept is asked at once")
      assert.equal(asked().walked, false, "asked again, the walk is kept")

      // A Fin's batch that asks nothing new: a map lookup.
      world.live.observe({ type: "live-update", id: fins[1]!.conversation!, update: { kind: "text", text: "Working on it. " } })
      world.live.snapshot(fins[1]!.conversation!)
      world.agents.moved(fins[1]!.conversation!)
      assert.deepEqual(asked(), { found: asked().found, walked: false }, "a Fin's token batch walks nothing")

        // A commit that kept no report, answer or edge, this host's and another's.
      world.store.registerJournal({ conversationId: randomUUID(), createdAt: now, harness: "claude", bindings: [{ provider: "claude", nativeId: randomUUID() }] }, { kind: "service", name: "migration" })
      assert.equal(asked().walked, false, "this host's unrelated commit walks nothing")
      const other = new ThreadStore(join(root, "asks", "threads.sqlite"))
      other.registerJournal({ conversationId: randomUUID(), createdAt: now, harness: "claude", bindings: [{ provider: "claude", nativeId: randomUUID() }] }, { kind: "service", name: "migration" })
      assert.equal(asked().walked, false, "another host's unrelated commit walks nothing")
      assert.equal(asked().found?.more, 0)

      // An ask another host's commit raised.
      const raised = other.keepReport({ id: `report:${fins[2]!.child!}:elsewhere`, child: ThreadIdSchema.parse(fins[2]!.child!), status: "done", summary: "Ready elsewhere.", question: "Merge it?", retainsQuestion: true, decides: "person", ownerGeneration: Number.MAX_SAFE_INTEGER, at: now })
      assert.ok(!("stale" in raised), "the other host's report is kept")
      other.close()
      assert.equal(asked().found?.more, 1, "an ask another host kept is counted at once")

      // An answer.
      kept(await world.agents.respond(apex.conversation, { fin: fins[0]!.child!, ask: first.id, answer: "Merge", request: randomUUID() }))
      const afterAnswer = asked().found
      assert.notEqual(afterAnswer?.ask.id, first.id, "an answered ask is gone at once")
      assert.equal(afterAnswer?.more, 0)

      // An edge closed: a stopped Fin's ask is hidden.
      const second = await ask(1, "second")
      assert.equal(asked().found?.more, 1, "another report is counted at once")
      kept(await world.agents.stop(apex.caller, { child: "b" }))
      await world.settle(100)
      const afterStop = asked().found
      assert.notEqual(afterStop?.ask.id, second.id, "a stopped Fin's ask is hidden at once")
      assert.equal(afterStop?.more, 0)

    // The edges this host's store holds: what a fresh read of the store says, after each kind of change, and read
      // again only for a change that can move them.
      {
        const path = join(root, "asks", "threads.sqlite")
        let reads = 0
        const sql = world.store["sql"].bind(world.store)
        world.store["sql"] = (text: string) => { if (text.startsWith("SELECT record FROM thread_parents ORDER BY")) reads += 1; return sql(text) }
        // With them, each Thread's record and conversations, held through the same commits.
        const said = (store: ThreadStore) => {
          const threads = store.edges().all.flatMap((edge) => [edge.parent, edge.child])
          return JSON.stringify([store.edges().all, [...store.threadConversations(threads)].sort(([left], [right]) => (left < right ? -1 : 1)), threads.map((thread) => store.thread(ThreadIdSchema.parse(thread))),
            [...store.childSessions()].sort(([left], [right]) => (left < right ? -1 : 1))])
        }
        const fresh = () => { const store = new ThreadStore(path); try { return said(store) } finally { store.close() } }
        const same = (after: string) => assert.equal(said(world.store), fresh(), `the edges and Threads held are the store's ${after}`)
        const d = kept(await world.agents.start(apex.caller, { name: "d", clientKey: "d", harness: "claude", brief: { objective: "Work on d" }, cwd: root }))
        const e = kept(await world.agents.start(apex.caller, { name: "e", clientKey: "e", harness: "claude", brief: { objective: "Work on e" }, cwd: root }))
        await world.settle(100)
        same("as the Fins started")
        const held = world.store.edges()
        reads = 0
        world.store.keepReport({ id: `report:${d.child!}:note`, child: ThreadIdSchema.parse(d.child!), status: "progress", summary: "Half way.", ownerGeneration: Number.MAX_SAFE_INTEGER, at: now })
        assert.equal(world.store.edges(), held, "a commit that writes no edge leaves the edges held")
        assert.equal(reads, 0, "and reads none of them")
        // A Session placed in a Thread of its own could have been a child's: read again, and the same edges still.
        world.store.registerJournal({ conversationId: randomUUID(), createdAt: now, harness: "claude", bindings: [] }, { kind: "service", name: "migration" })
        assert.equal(world.store.edges(), held)
        // A Session bound to a child's Thread is one of `childNative`'s: a claim moves the edges.
        const bound = randomUUID()
        assert.equal(world.store.edges().childNative("claude", bound), false)
        world.store.registerJournal({ conversationId: d.conversation!, createdAt: now, harness: "claude", bindings: [{ provider: "claude", nativeId: bound }] }, { kind: "service", name: "migration" })
        assert.equal(world.store.edges().childNative("claude", bound), true, "a child's new native session is seen at once")
        same("after a native claim")
        const stopped = kept(await world.agents.stop(apex.caller, { child: "e" }))
        assert.ok(stopped)
        await world.settle(100)
        assert.notEqual(world.store.edges().of(ThreadIdSchema.parse(e.child!))?.closedAt, undefined, "an edge closed is seen at once")
        same("after a Fin was stopped")
        const elsewhere = new ThreadStore(path)
        const edge = elsewhere.edges().of(ThreadIdSchema.parse(d.child!))!
        elsewhere.keepEdge({ ...edge, closedAt: now, closedReason: "stopped" })
        elsewhere.close()
        assert.notEqual(world.store.edges().of(edge.child)?.closedAt, undefined, "an edge another host closed is seen at once")
        same("after another host's commit")
        const renamed = ThreadIdSchema.parse(d.child!)
        world.store.renameThread({ operationId: randomUUID(), thread: renamed, title: "Renamed", actor: { kind: "service", name: "migration" } })
        assert.equal(world.store.thread(renamed)?.title, "Renamed", "a Thread renamed is read at once")
        same("after a Thread was renamed")
        // A store opened with the split on (one conversation a Thread), which writes on the connection itself as it
        // opens: what it holds once open is what a fresh read says.
        const split = new ThreadStore(path, { oneConversation: true })
        const afterSplit = said(split)
        split.close()
        const again = new ThreadStore(path, { oneConversation: true })
        assert.equal(afterSplit, said(again), "a store that split Threads as it opened holds what the store says")
        again.close()
        same("after another host split Threads")
        world.store["sql"] = sql
      }
    } finally {
      await world.close()
    }
  }
  // A long conversation opened where it lies: what its opening reads of every block comes from a reader's thread, and
  // nothing on this thread walks the blocks; a journal written since the scan is read here as before.
  {
    const data = join(root, "cold"), id = randomUUID()
    await writeLongJournal(data, { conversation: id, session: randomUUID(), path: join(data, "session.jsonl"), cwd: data, megabytes: 3 })
    const journals = join(data, "conversations")
    const readers = new JournalReaders()
    const prepare = DatabaseSync.prototype.prepare
    const walks: string[] = []
    try {
      const scan = await readers.scan(join(journals, `${id}.sqlite`))
      DatabaseSync.prototype.prepare = function (sql, ...rest) {
        if (/FROM blocks(?! WHERE id=)|FROM block_appends GROUP BY/.test(sql)) walks.push(sql)
        return prepare.call(this, sql, ...rest)
      }
      const scanned = atOnce(ColdJournal.opening(journals, id, scan))
      assert.ok(scanned && scanned.length === scan.count && scan.count > 100)
      const counts = scanned.before(scanned.length, 0)
      assert.deepEqual(walks, [], "with a reader's scan, the opening and its page counts walk no table here")
      scanned.close()
      const unscanned = atOnce(ColdJournal.opening(journals, id))
      assert.ok(unscanned)
      assert.deepEqual(unscanned.before(unscanned.length, 0), counts, "the same counts either way")
      assert.equal(unscanned.length, scanned.length)
      unscanned.close()
      walks.length = 0
      const stale = atOnce(ColdJournal.opening(journals, id, { ...scan, revision: scan.revision + 1, count: 1 }))
      assert.equal(stale?.length, scan.count, "a scan of another revision is not used")
      assert.ok(walks.length > 0)
      stale?.close()
    } finally {
      DatabaseSync.prototype.prepare = prepare
      await readers.stop()
    }
  }
  // What the store holds through a commit is decided by the table a statement writes, and every table says which:
  // one added to the schema without a line here fails, as does the connection used outside the store's opening,
  // where a write would pass `sql` unseen.
  {
    const source = ["store.ts", "thread-split.ts"].map((name) => readFileSync(new URL(`../packages/host/src/threads/${name}`, import.meta.url), "utf8"))
    const tables = new Set(source.flatMap((text) => [...text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)].map((found) => found[1]!)))
    tables.delete("background_agents")
    assert.ok(tables.size > 30)
    assert.deepEqual([...tables].filter((table) => !HELD_BY_TABLE.has(table)), [], "every table of the store says what its writes can change")
    assert.equal(heldBy("INSERT INTO a_table_added_later (id) VALUES (?)"), "both", "a table without a line drops everything held")
    assert.equal(heldBy("WITH moved AS (SELECT 1) UPDATE memberships SET thread_id = ?"), "both", "a statement that can't be read drops everything held")
    assert.equal(heldBy("INSERT OR IGNORE INTO thread_reports (id) VALUES (?)"), "neither")
    assert.equal(heldBy("UPDATE memberships SET thread_id = ? WHERE session_id = ?"), "both")
    assert.equal(heldBy("DELETE FROM sources WHERE session_id = ?"), "edges")
    assert.equal(heldBy("SELECT record FROM thread_parents ORDER BY created_at"), "neither")
    // The connection itself is used only while the store opens, and by what every write and read goes through.
    const opening = new Set(["constructor", "create", "migrate", "migrateBackgroundAgents", "keepOneWorktreePerThread", "closeInternalRuns", "checkReadable", "close", "sql", "meta", "syncVersion", "write"])
    let method = ""
    const direct = new Set<string>()
    for (const line of source[0]!.split("\n")) {
      const named = /^  (?:private |static |async |get |protected |override )*(#?[A-Za-z]+)(?:<[^>]*>)?\(/.exec(line)?.[1]
      if (named && !["if", "for", "while", "switch", "return"].includes(named)) method = named
      if (/\bthis\.db\b/.test(line)) direct.add(method)
    }
    assert.deepEqual([...direct].filter((name) => !opening.has(name)), [], "the store's connection is used directly only as it opens")
  }

  // Whether this host holds a session, asked at every flush: read from its row once, then answered from what was
  // read until a hold is written, by this host or another, and then at that same asking.
  {
    const path = join(root, "memory.sqlite")
    const mine = new SessionMemory(path, { pid: 500, startedAt: 5, label: "this host" }, { now: () => 100, alive: () => true })
    const other = new SessionMemory(path, { pid: 501, startedAt: 6, label: "another host" }, { now: () => 100, alive: () => false })
    let reads = 0
    const readHold = mine["readHold"].bind(mine)
    mine["readHold"] = (...args) => { reads += 1; return readHold(...args) }
    assert.equal(mine.owns("codex", "native-a", "conversation-a"), false)
    mine.hold("codex", "native-a", "conversation-a")
    assert.equal(mine.owns("codex", "native-a", "conversation-a"), true, "a hold this host took is its own at the next asking")
    reads = 0
    for (let flush = 0; flush < 100; flush += 1) assert.equal(mine.owns("codex", "native-a", "conversation-a"), true)
    assert.equal(reads, 0, "asked again with no hold written, the row isn't read")
    assert.equal(mine.owns("codex", "native-a", "conversation-b"), false, "another conversation of the session is asked of its row")
    // Another host takes the session (this one's process reads as gone to it): seen at the very next asking.
    other.hold("codex", "native-a", "conversation-elsewhere")
    assert.equal(mine.owns("codex", "native-a", "conversation-a"), false, "a hold another host took is seen at once")
    other.release("codex", "native-a")
    mine.holdRunning("codex", "native-a", "conversation-a")
    assert.equal(mine.owns("codex", "native-a", "conversation-a"), true)
    mine.release("codex", "native-a", "conversation-a")
    assert.equal(mine.owns("codex", "native-a", "conversation-a"), false, "a hold this host let go is gone at once")
    // A hold of another session written by this host leaves this one's answer standing: thirty Fins taking and
    // letting go of theirs sent every conversation back to its row.
    mine.hold("codex", "native-a", "conversation-a")
    assert.equal(mine.owns("codex", "native-a", "conversation-a"), true)
    mine.hold("codex", "native-b", "conversation-b")
    mine.release("codex", "native-b", "conversation-b")
    reads = 0
    assert.equal(mine.owns("codex", "native-a", "conversation-a"), true)
    assert.equal(reads, 0, "another session's hold written, this one's row isn't read")
    assert.equal(mine.owns("codex", "native-b", "conversation-b"), false, "and the one written is asked of its row")
    mine.releaseAll()
    assert.equal(mine.owns("codex", "native-a", "conversation-a"), false, "every hold let go at once is gone at once")
    // The host's own ledger looks for another host's commits once in a turn of the loop.
    const turnly = new SessionMemory(path, { pid: 502, startedAt: 7, label: "the host" }, { now: () => 100, alive: () => true, versionPerTurn: true })
    let pragmas = 0
    turnly.hold("codex", "native-c", "conversation-c")
    assert.equal(turnly.owns("codex", "native-c", "conversation-c"), true)
    const statement = turnly["versionRead"]!.statement
    const get = statement.get.bind(statement)
    statement.get = () => { pragmas += 1; return get() }
    for (let flush = 0; flush < 100; flush += 1) turnly.owns("codex", "native-c", "conversation-c")
    assert.equal(pragmas, 0, "asked again in the same turn, SQLite isn't called at all")
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(turnly.owns("codex", "native-c", "conversation-c"), true)
    assert.equal(pragmas, 1, "the next turn looks once")
    turnly.release("codex", "native-c", "conversation-c")
    assert.equal(turnly.owns("codex", "native-c", "conversation-c"), false, "its own write is seen within the turn")
    turnly.close()
    mine.close()
    other.close()
  }
  // Executables are found off the thread and kept: the same as the walk that waits finds, found again by asking
  // only whether it is still there, looked for whole once it is gone, and a command that isn't here never kept.
  {
    const first = join(root, "bin-first"), second = join(root, "bin-second"), home = join(root, "no-home")
    for (const folder of [first, second]) mkdirSync(folder)
    writeFileSync(join(second, "mako-test-tool"), "#!/bin/sh\n", { mode: 0o755 })
    writeFileSync(join(first, "unrunnable"), "", { mode: 0o644 })
    const env = { PATH: [first, second].join(delimiter) }
    const executables = new Executables()
    assert.equal(await executables.find("mako-test-tool", env, home), join(second, "mako-test-tool"))
    assert.equal(await executables.find("mako-test-tool", env, home), resolveExecutable("mako-test-tool", env, home), "as the walk on the thread finds it")
    assert.equal(await executables.find("unrunnable", env, home), resolveExecutable("unrunnable", env, home))
    assert.equal(await executables.find(join(second, "mako-test-tool"), env, home), join(second, "mako-test-tool"), "a path is itself")
    // One earlier on the path, installed since: the one kept is still there, so it is still the answer for this
    // host, as a launch already running from it would have it; gone, the walk finds the other.
    writeFileSync(join(first, "mako-test-tool"), "#!/bin/sh\n", { mode: 0o755 })
    assert.equal(await executables.find("mako-test-tool", env, home), join(second, "mako-test-tool"))
    rmSync(join(second, "mako-test-tool"))
    assert.equal(await executables.find("mako-test-tool", env, home), join(first, "mako-test-tool"), "one that went is looked for again")
    assert.equal(await executables.find("mako-test-absent", env, home), null)
    writeFileSync(join(second, "mako-test-absent"), "#!/bin/sh\n", { mode: 0o755 })
    assert.equal(await executables.find("mako-test-absent", env, home), join(second, "mako-test-absent"), "one not found is looked for each time")
    assert.equal(await executables.find("mako-test-tool", { PATH: second }, home), null, "what was found is kept for the folders it was looked for in")
  }
  // Processes' output is handled a turn's worth at a time: what the turn has no time for waits, paused, for the
  // next, each process's in its order, and a process that ends has all it said taken first.
  {
    const taken: string[] = [], paused = new Set<string>()
    const spin = (ms: number) => { for (const until = performance.now() + ms; performance.now() < until;) void 0 }
    const pace = new StdoutPace<string>({
      turnMs: 10,
      take: (source, chunk) => { taken.push(`${source}:${chunk.toString()}`); spin(6) },
      pause: (source) => void paused.add(source),
      resume: (source) => void paused.delete(source),
    })
    const turned = () => new Promise((resolve) => setImmediate(resolve))
    for (const source of ["a", "b", "c", "d"]) pace.read(source, Buffer.from("1"))
    assert.deepEqual(taken, ["a:1", "b:1"], "a turn takes what it has time for")
    assert.deepEqual([...paused], ["c", "d"])
    pace.read("c", Buffer.from("2"))
    pace.read("a", Buffer.from("2"))
    assert.deepEqual(taken, ["a:1", "b:1"], "and nothing more, whoever it is from")
    pace.flush("d")
    assert.deepEqual(taken, ["a:1", "b:1", "d:1"], "a process that ended is heard out at once")
    assert.deepEqual([...paused], ["c", "a"])
    await turned()
    assert.deepEqual(taken, ["a:1", "b:1", "d:1", "c:1", "a:2"], "the next turn takes a chunk of each waiting process in turn")
    await turned()
    await turned()
    assert.deepEqual(taken.slice(5), ["c:2"], "and each process's own in its order")
    assert.equal(paused.size, 0)
    pace.read("b", Buffer.from("2"))
    assert.equal(taken.at(-1), "b:2", "a turn with time takes output as it comes")
  }
  // A chunk whose handling needs something read first waits for it off the thread, and what its process says
  // meanwhile waits behind it in order; another process's output isn't held by it; a process that ends is heard out.
  {
    const taken: string[] = [], paused = new Set<string>(), asked: string[] = []
    const gates = new Map<string, () => void>()
    const pace = new StdoutPace<string>({
      turnMs: 50,
      take: (source, chunk) => void taken.push(`${source}:${chunk.toString()}`),
      pause: (source) => void paused.add(source),
      resume: (source) => void paused.delete(source),
      before: (source, chunk) => {
        if (!chunk.toString().startsWith("r")) return undefined
        asked.push(`${source}:${chunk.toString()}`)
        return new Promise<void>((resolve) => gates.set(`${source}:${chunk.toString()}`, resolve))
      },
    })
    const turned = async () => { for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setImmediate(resolve)) }
    pace.read("a", Buffer.from("r1"))
    pace.read("a", Buffer.from("2"))
    pace.read("a", Buffer.from("r3"))
    pace.read("b", Buffer.from("1"))
    assert.deepEqual(taken, ["b:1"], "another process's output goes on")
    assert.deepEqual(asked, ["a:r1"], "one read at a time for a process, for its first waiting chunk")
    assert.deepEqual([...paused], ["a"])
    gates.get("a:r1")!()
    await turned()
    assert.deepEqual(taken, ["b:1", "a:r1", "a:2"], "what waited behind it follows it, in order, up to the next that needs a read")
    assert.deepEqual(asked, ["a:r1", "a:r3"])
    gates.get("a:r3")!()
    await turned()
    assert.deepEqual(taken, ["b:1", "a:r1", "a:2", "a:r3"])
    assert.equal(paused.size, 0)
    pace.read("c", Buffer.from("r1"))
    pace.read("c", Buffer.from("2"))
    pace.flush("c")
    assert.deepEqual(taken.slice(4), ["c:r1", "c:2"], "a process that ends is heard out without the read")
    gates.get("c:r1")!()
    await turned()
    assert.deepEqual(taken.slice(4), ["c:r1", "c:2"], "and the read that comes back late takes nothing twice")
  }

  // A rollout read ahead off the thread gives the same records as reading it where it stands, and a read with
  // nothing loaded, or loaded from another place, goes to the file as it always did.
  {
    const path = join(root, "rollout.jsonl")
    const line = (n: number) => `${JSON.stringify({ type: "event", n })}\n`
    writeFileSync(path, line(0))
    const ahead = new CodexRolloutTail(path), plain = new CodexRolloutTail(path)
    appendFileSync(path, line(1) + line(2) + `{"type":"event","n":3`)
    await ahead.load()
    assert.deepEqual(ahead.read(), plain.read(), "loaded, as read")
    assert.equal(ahead.position, plain.position)
    appendFileSync(path, `}\n` + line(4))
    assert.deepEqual(ahead.read().map((read) => read.record.n), [3, 4], "with nothing loaded, the file is read")
    plain.read()
    appendFileSync(path, line(5))
    await ahead.load()
    appendFileSync(path, line(6))
    assert.deepEqual(ahead.read().map((read) => read.record.n), [5], "a load holds what was written before it")
    await ahead.load()
    assert.deepEqual(plain.read().map((read) => read.record.n), [5, 6])
    appendFileSync(path, line(7))
    assert.deepEqual(ahead.read().map((read) => read.record.n), [6], "what was loaded is taken first")
    assert.deepEqual(ahead.read().map((read) => read.record.n), [7])
    // Replaced by a shorter file: read from its start, loaded or not.
    writeFileSync(path, line(8))
    await ahead.load()
    assert.deepEqual(ahead.read().map((read) => read.record.n), [8])
    const [first, second] = [ahead.load(), ahead.load()]
    assert.notEqual(first, second, "a load asked for while one is under way begins after it")
    assert.equal(ahead.load(), second, "and every asking meanwhile shares that one")
    await Promise.all([first, second])
    rmSync(path)
    await ahead.load()
    assert.deepEqual(ahead.read(), [], "a rollout that isn't there reads as nothing")
    assert.equal(onlyDeltas(Buffer.from(`{"method":"item/agentMessage/delta","params":{}}\n{"method":"item/reasoning/summaryTextDelta","params":{}}\n`)), true)
    assert.equal(onlyDeltas(Buffer.from(`{"method":"item/agentMessage/delta","params":{}}\n{"method":"item/completed","params":{}}\n`)), false)
    assert.equal(onlyDeltas(Buffer.from(`{"method":"item/agentMessage/delta","params":{"te`)), false, "a chunk that ends inside a line isn't known to be")
    assert.equal(onlyDeltas(Buffer.from(`{"id":3,"result":{"note":"a delta"}}\n`)), false)
  }
  console.log("flush costs ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
