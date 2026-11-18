import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentsReportResult, AgentsStarted } from "@mako/host/contracts/agent-tools"
import type { AgentRefused } from "@mako/host/contracts/agents"
import { sharedFields } from "@mako/host/contracts/live-conversations"
import type { NativeAgent, NativeAgentRoster } from "@mako/host/contracts/native-agents"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { WorkingSet, workingThreads, type WorkingSnapshot } from "@mako/host/conversations/cloud-handoffs"
import { ThreadStore } from "@mako/host/threads/store"
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
    } finally {
      await world.close()
    }
  }
  console.log("flush costs ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
